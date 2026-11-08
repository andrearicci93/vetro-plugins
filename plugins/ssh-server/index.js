'use strict';
// SSH server (in-process, pure JS): a real SSH-2 endpoint you reach with your normal ssh/scp/sftp client, implemented
// in JavaScript (ssh.js + sftp.js) and run inside Vetro's Node process. It needs no binary, so it works on a Tizen TV
// that refuses unsigned native executables (UEP). See README.md for the design and its limits.
//
// What you get (because the Vetro service runs as uid 5001, not root, and root is only reachable as one-shot commands
// through Vetro's agent):
//   * `ssh you@tv`              -> interactive PTY shell as the owner (uid 5001), via the signed `script` binary
//   * `ssh root@tv '<command>'` -> the command runs as ROOT through Vetro's agent (one-shot), output returned
//   * `sftp` / `scp`            -> file transfer as the owner (uid 5001)
//
// Lifecycle: start() opens the listener while the Shard is switched on; stop() closes it and kills any shells. No
// timers are used. ssh.js/sftp.js are required lazily inside start() so this module still loads on a Node too old to
// run them (the server just reports "unsupported" there).

var crypto = require('crypto');
var cp = require('child_process');
var fs = require('fs');
var path = require('path');

var DEFAULT_PORT = 2222;
var EXEC_TIMEOUT = 60000;        // Vetro's shared command queue caps a single root command; keep it bounded

module.exports = function (ctx) {
    var server = null, children = [], logLines = [], page = null;
    var fingerprint = null, unsupported = null, lastError = null, connections = 0;

    function log(m) { logLines.push(new Date().toISOString().slice(11, 19) + ' ' + m); if (logLines.length > 120) logLines.shift(); }
    function cfg() { try { var c = ctx.config.get(); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; } catch (e) { return {}; } }
    function saveCfg(patch) { var c = cfg(); for (var k in patch) if (patch.hasOwnProperty(k)) c[k] = patch[k]; try { ctx.config.set(c); return true; } catch (e) { log('config not saved: ' + e.message); return false; } }
    function port() { var p = cfg().port; return (typeof p === 'number' && p >= 1 && p <= 65535 && p % 1 === 0) ? p : DEFAULT_PORT; }
    function authText() { var a = cfg().authorizedKeys; return typeof a === 'string' ? a : ''; }
    function remove(arr, x) { var i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); }

    // --- interactive owner shell (uid 5001) via the signed util-linux `script`, which gives a real PTY ---
    function spawnShell(ch) {
        var child = null;
        try { child = cp.spawn('/usr/bin/script', ['-qc', 'exec bash -il', '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch (e) { child = null; }
        if (!child) { try { child = cp.spawn('/bin/bash', ['-il'], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e2) { ch.writeStderr('no shell on this TV\r\n'); ch.exit(1); return; } }
        children.push(child);
        if (ch.pty && ch.pty.rows && ch.pty.cols) { try { child.stdin.write('stty rows ' + (ch.pty.rows | 0) + ' cols ' + (ch.pty.cols | 0) + ' 2>/dev/null\n'); } catch (e) {} }
        ch.on('data', function (d) { try { child.stdin.write(d); } catch (e) {} });
        ch.on('eof', function () { try { child.stdin.end(); } catch (e) {} });
        ch.on('resize', function (c, r) { try { child.stdin.write('stty rows ' + (r | 0) + ' cols ' + (c | 0) + ' 2>/dev/null\n'); } catch (e) {} });
        child.stdout.on('data', function (d) { if (ch.write(d) === false) child.stdout.pause(); });
        child.stderr.on('data', function (d) { ch.write(d); });   // a PTY has no separate stderr; merge
        ch.on('drain', function () { try { child.stdout.resume(); } catch (e) {} });
        child.on('exit', function (code) { remove(children, child); ch.exit(code || 0); });
        child.on('error', function (e) { ch.writeStderr('shell error: ' + e.message + '\r\n'); ch.exit(1); });
        ch.on('close', function () { try { child.kill('SIGHUP'); } catch (e) {} remove(children, child); });
    }

    // --- `ssh ... '<command>'` runs as root through Vetro's agent (one-shot) ---
    function runRoot(ch, cmd) {
        ctx.execute(cmd, EXEC_TIMEOUT).then(function (r) {
            if (r && r.stdout) ch.write(r.stdout);
            if (r && r.stderr) ch.writeStderr(r.stderr);
            ch.exit(r && r.timed_out ? 124 : (r && r.exit_code) || 0);
        }, function (e) { ch.writeStderr('vetro: ' + (e && e.message || e) + '\n'); ch.exit(1); });
    }

    function wire(ssh, sftp) {
        server.on('connection', function (conn) { connections++; log('client connected'); conn.on('end', function () { connections--; }); });
        server.on('shell', function (ch) { spawnShell(ch); });
        server.on('exec', function (ch, cmd) { log('root exec: ' + cmd.slice(0, 60)); runRoot(ch, cmd); });
        server.on('subsystem', function (ch, name) { if (name === 'sftp') sftp.serve(ch, { log: log }); else ch.close(); });
    }

    function startServer() {
        var ssh, sftp;
        try { ssh = require('./ssh.js'); sftp = require('./sftp.js'); }
        catch (e) { unsupported = 'This TV\'s Node is too old for the SSH module (needs Node 10+): ' + e.message; log(unsupported); return; }
        try {
            var c = cfg();
            server = ssh.createServer({ hostKeyPem: c.hostKeyPem, authorizedKeys: authText(), log: log });
            if (!c.hostKeyPem) saveCfg({ hostKeyPem: server.hostKeyPem() });   // persist the host key so clients don't warn after a restart
            fingerprint = 'SHA256:' + crypto.createHash('sha256').update(server.hostKey.blob).digest('base64').replace(/=+$/, '');
            wire(ssh, sftp);
            server.net.on('error', function (e) { lastError = e.message; log('server error: ' + e.message); });
            server.listen(port(), '0.0.0.0', function () { lastError = null; log('listening on 0.0.0.0:' + port()); });
        } catch (e) { unsupported = 'Could not start the SSH server: ' + e.message; lastError = e.message; log(unsupported); server = null; }
    }
    function stopServer() {
        for (var i = 0; i < children.length; i++) { try { children[i].kill('SIGKILL'); } catch (e) {} }
        children = [];
        if (server) { try { server.close(); } catch (e) {} server = null; }
    }

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
        return {
            running: !!server, port: port(), fingerprint: fingerprint, unsupported: unsupported, lastError: lastError,
            connections: connections, hasKeys: /\S/.test(authText()), keyCount: countKeys(authText()), log: logLines
        };
    }
    function countKeys(text) { var n = 0; String(text || '').split('\n').forEach(function (l) { if (/^(ssh-ed25519)\s/.test(l.trim())) n++; }); return n; }

    return {
        start: function () { page = loadPage(); unsupported = null; lastError = null; startServer(); },
        stop: function () { stopServer(); page = null; },
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
                    if (/\S/.test(keys) && !/^(ssh-ed25519)\s/m.test(keys)) return json(res, { ok: false, error: 'Only ssh-ed25519 public keys are supported in v1' }, 400);
                    saveCfg({ authorizedKeys: keys });
                    if (server) server.setAuthorizedKeys(keys);           // applies to new connections immediately
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
                    if (server) { stopServer(); startServer(); }           // rebind (drops open sessions)
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
