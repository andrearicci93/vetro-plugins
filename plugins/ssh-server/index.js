'use strict';
// SSH server (in-process, pure JS): a real SSH-2 endpoint you reach with your normal ssh/scp/sftp client, implemented
// in JavaScript (ssh.js + sftp.js) and run inside Vetro's Node process. No binary, so it works on a Tizen TV that
// refuses unsigned native code (UEP). See README.md for the design and its limits.
//
// Why the shell is "line" not "PTY": the Vetro service runs as uid 5001 under Smack label User::Pkg::vetrotvapp, which
// has no execute access to system binaries (/bin/bash, /usr/bin/script are floor-labeled). So this process cannot spawn
// a shell or a PTY at all. Root is reachable only as one-shot commands through Vetro's agent (ctx.execute). Therefore:
//   * `ssh you@tv`              -> a ROOT line-shell: each command you type runs via the agent, cwd remembered, no PTY
//                                  (no top/vi/less -- use `top -b -n1`), no shell state beyond cwd
//   * `ssh root@tv '<command>'` -> the command runs as root through the agent (one-shot), output returned
//   * `sftp` / `scp`            -> file transfer in-process as the owner (uid 5001); reaches owner-readable files
//
// Everything that could throw asynchronously is wrapped: a plugin crash would take down the whole Vetro service.

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var DEFAULT_PORT = 2222;
var EXEC_TIMEOUT = 60000;          // Vetro's shared command queue caps a single root command
var EXIT = {};                     // sentinel queued to end a line-shell session

function strBytes(s) { return Buffer.from && Buffer.from !== Uint8Array.from ? Buffer.from(s) : new Buffer(s); }
function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function crlf(s) { return String(s).replace(/\r?\n/g, '\r\n'); }

module.exports = function (ctx) {
    var server = null, logLines = [], page = null;
    var fingerprint = null, unsupported = null, lastError = null, connections = 0;

    function log(m) { logLines.push(new Date().toISOString().slice(11, 19) + ' ' + m); if (logLines.length > 120) logLines.shift(); }
    function cfg() { try { var c = ctx.config.get(); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; } catch (e) { return {}; } }
    function saveCfg(patch) { var c = cfg(); for (var k in patch) if (patch.hasOwnProperty(k)) c[k] = patch[k]; try { ctx.config.set(c); return true; } catch (e) { log('config not saved: ' + e.message); return false; } }
    function port() { var p = cfg().port; return (typeof p === 'number' && p >= 1 && p <= 65535 && p % 1 === 0) ? p : DEFAULT_PORT; }
    function authText() { var a = cfg().authorizedKeys; return typeof a === 'string' ? a : ''; }
    function countKeys(text) { var n = 0; String(text || '').split('\n').forEach(function (l) { if (/^ssh-ed25519\s/.test(l.trim())) n++; }); return n; }

    // Run one command as root through Vetro's agent, carrying the working directory across commands (same idea as the
    // Shell Shard): the command runs in `cwd`, and the directory it ends in comes back after a marker with a per-call
    // nonce so a command's own output cannot fake it. cb(outputText, newCwd).
    function runAgent(cwd, cmd, cb) {
        var nonce = crypto.randomBytes(8).toString('hex'), marker = '__VCWD_' + nonce + '__';
        var script = 'cd ' + shQuote(cwd) + ' 2>/dev/null || cd /\n' + cmd + '\n__vs=$?\nprintf "\\n' + marker + '%s\\n" "$(pwd)" 2>/dev/null\nexit $__vs\n';
        var b64 = strBytes(script).toString('base64');
        // Decode the script into a variable and run it with -c, so the command's own stdin can be /dev/null (a command
        // that waits for input ends instead of holding Vetro's command queue). Piping the script to `sh </dev/null`
        // would feed sh an empty script.
        var wrapped = '__vscript="$(printf %s ' + b64 + ' | base64 -d)"; if command -v bash >/dev/null 2>&1; then exec bash -c "$__vscript" </dev/null; else exec sh -c "$__vscript" </dev/null; fi';
        var done = false;
        function finish(out, ncwd) { if (done) return; done = true; try { cb(out, ncwd); } catch (e) { log('shell cb error: ' + e.message); } }
        var p;
        try { p = ctx.execute(wrapped, EXEC_TIMEOUT); } catch (e) { return finish('vetro: ' + e.message + '\n', cwd); }
        p.then(function (r) {
            try {
                var out = String((r && r.stdout) || ''), mark = '\n' + marker, i = out.lastIndexOf(mark), ncwd = cwd;
                if (i >= 0) { var rest = out.slice(i + mark.length), nl = rest.indexOf('\n'), found = nl < 0 ? rest : rest.slice(0, nl); if (found.charAt(0) === '/') ncwd = found; out = out.slice(0, i); }
                if (r && r.stderr) out += String(r.stderr);
                if (r && r.timed_out) out += '\n[stopped after ' + (EXEC_TIMEOUT / 1000) + ' s: time limit]\n';
                finish(out, ncwd);
            } catch (e) { finish('vetro: ' + e.message + '\n', cwd); }
        }, function (e) { finish('vetro: ' + (e && e.message || e) + '\n', cwd); });
    }

    // Interactive ROOT line-shell on a channel with no PTY (we refuse pty-req, so the client is line-buffered with local
    // echo). We send output and prompts only; we never echo input.
    function rootLineShell(ch) {
        var cwd = '/', buf = '', busy = false, queue = [], closed = false, eofSeen = false;
        function prompt() { return 'root@tv:' + cwd + '# '; }
        function endSession() { if (closed) return; closed = true; try { ch.exit(0); } catch (e) {} }
        try {
            ch.write('Vetro root shell — each command runs as root via Vetro\'s agent.\r\n');
            ch.write('No PTY: full-screen programs (top, vi, less) will not work; use e.g. `top -b -n1`. `exit` to quit.\r\n');
            ch.write(prompt());
        } catch (e) {}
        function pump() {
            if (busy || closed) return;
            if (!queue.length) { if (eofSeen) endSession(); return; }   // drain the queue before honoring EOF
            var line = queue.shift();
            if (line === EXIT) { try { ch.write('bye\r\n'); } catch (e) {} return endSession(); }
            if (line === '') { try { ch.write(prompt()); } catch (e) {} return pump(); }
            busy = true;
            runAgent(cwd, line, function (out, ncwd) {
                cwd = ncwd;
                try { if (out) ch.write(crlf(out)); ch.write(prompt()); } catch (e) {}
                busy = false; pump();
            });
        }
        ch.on('data', function (d) {
            try {
                buf += d.toString('utf8');
                var m;
                while ((m = /\r\n|\n|\r/.exec(buf))) {
                    var line = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
                    line = line.replace(/\x03/g, '');            // drop ^C bytes
                    var t = line.replace(/^\s+|\s+$/g, '');
                    if (t === 'exit' || t === 'logout') queue.push(EXIT);
                    else if (t === '') queue.push('');
                    else queue.push(line);
                }
                if (buf.length > 1 << 20) buf = '';               // runaway line without newline: drop it
                pump();
            } catch (e) { try { ch.write('shell error: ' + e.message + '\r\n'); } catch (x) {} }
        });
        ch.on('eof', function () { eofSeen = true; pump(); });   // exit once the queue has drained
        ch.on('close', function () { closed = true; });
    }

    // `ssh ... '<command>'` -> one-shot root command (output returned, then the channel closes).
    function runExec(ch, cmd) {
        runAgent('/', cmd, function (out) {
            try { if (out) ch.write(out); ch.exit(0); } catch (e) {}
        });
    }

    function wire(ssh, sftp) {
        server.on('connection', function (conn) { connections++; log('client connected'); conn.on('end', function () { if (connections > 0) connections--; }); });
        server.on('shell', function (ch) { try { rootLineShell(ch); } catch (e) { log('shell error: ' + e.message); try { ch.exit(1); } catch (x) {} } });
        server.on('exec', function (ch, cmd) { log('root exec: ' + String(cmd).slice(0, 60)); try { runExec(ch, cmd); } catch (e) { try { ch.exit(1); } catch (x) {} } });
        server.on('subsystem', function (ch, name) { try { if (name === 'sftp') sftp.serve(ch, { log: log }); else ch.close(); } catch (e) { log('sftp error: ' + e.message); try { ch.close(); } catch (x) {} } });
    }

    function startServer() {
        var ssh, sftp;
        try { ssh = require('./ssh.js'); sftp = require('./sftp.js'); }
        catch (e) { unsupported = 'This TV\'s Node is too old for the SSH module (needs Node 10+): ' + e.message; log(unsupported); return; }
        try {
            var c = cfg();
            server = ssh.createServer({ hostKeyPem: c.hostKeyPem, authorizedKeys: authText(), allowPty: false, log: log });
            if (!c.hostKeyPem) saveCfg({ hostKeyPem: server.hostKeyPem() });
            fingerprint = 'SHA256:' + crypto.createHash('sha256').update(server.hostKey.blob).digest('base64').replace(/=+$/, '');
            wire(ssh, sftp);
            server.listen(port(), '0.0.0.0', function () { lastError = null; log('listening on 0.0.0.0:' + port()); });
        } catch (e) { unsupported = 'Could not start the SSH server: ' + e.message; lastError = e.message; log(unsupported); server = null; }
    }
    function stopServer() { if (server) { try { server.close(); } catch (e) {} server = null; } connections = 0; }

    function loadPage() {
        var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
        for (var i = 0; i < places.length; i++) { try { return fs.readFileSync(places[i], 'utf8'); } catch (e) {} }
        return '<!doctype html><meta charset="utf-8"><p>Page file missing: reinstall this Shard.</p>';
    }
    function json(res, body, code) { res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
    function readJson(req, cb) {
        var chunks = [], size = 0, done = false;
        req.on('data', function (c) { size += c.length; if (size > 65536) { if (!done) { done = true; cb(new Error('Request too large')); } req.destroy && req.destroy(); return; } chunks.push(c); });
        req.on('end', function () { if (done) return; done = true; var p; try { p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return cb(new Error('Invalid JSON')); } if (!p || typeof p !== 'object' || Array.isArray(p)) return cb(new Error('Invalid JSON')); cb(null, p); });
        req.on('error', function (e) { if (!done) { done = true; cb(e); } });
    }
    function state() {
        return { running: !!server, port: port(), fingerprint: fingerprint, unsupported: unsupported, lastError: lastError,
            connections: connections, keyCount: countKeys(authText()), log: logLines };
    }

    return {
        start: function () { page = loadPage(); unsupported = null; lastError = null; try { startServer(); } catch (e) { log('start error: ' + e.message); } },
        stop: function () { try { stopServer(); } catch (e) {} page = null; },
        status: function () { return { running: !!server, port: port(), connections: connections, unsupported: unsupported ? true : undefined }; },

        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page || loadPage()); return true; }
            if (sub === 'state' && req.method === 'GET') { json(res, state()); return true; }
            if (req.method !== 'POST') return false;

            if (sub === 'authkeys') {
                readJson(req, function (err, p) {
                    if (err) return json(res, { ok: false, error: err.message }, 400);
                    var keys = typeof p.keys === 'string' ? p.keys : '';
                    if (keys.length > 16384) return json(res, { ok: false, error: 'authorized_keys too large' }, 400);
                    if (/\S/.test(keys) && !/^ssh-ed25519\s/m.test(keys)) return json(res, { ok: false, error: 'Only ssh-ed25519 public keys are supported in v1' }, 400);
                    saveCfg({ authorizedKeys: keys });
                    if (server) server.setAuthorizedKeys(keys);
                    log('authorized_keys updated (' + countKeys(keys) + ' key(s))');
                    json(res, state());
                });
                return true;
            }
            if (sub === 'port') {
                readJson(req, function (err, p) {
                    if (err) return json(res, { ok: false, error: err.message }, 400);
                    if (typeof p.port !== 'number' || p.port < 1 || p.port > 65535 || p.port % 1 !== 0) return json(res, { ok: false, error: 'port must be 1-65535' }, 400);
                    saveCfg({ port: p.port });
                    if (server) { stopServer(); startServer(); }
                    json(res, state());
                });
                return true;
            }
            if (sub === 'regen-hostkey') {
                saveCfg({ hostKeyPem: null });
                if (server) { stopServer(); startServer(); }
                log('host key regenerated');
                json(res, state());
                return true;
            }
            return false;
        }
    };
};
