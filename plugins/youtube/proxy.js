'use strict';
// The proxy YouTube is started with (--proxy). Everything is a plain tunnel except www.youtube.com, which is opened with
// the plugin's own certificate (trusted only by the YouTube app this plugin starts) so the /tv page can get its script.
// Without a certificate or without the script it only tunnels: YouTube then runs unpatched instead of breaking.
// Listens on 127.0.0.2 (Chromium sends 127.0.0.1 around a proxy), or on every address when the app cannot reach loopback
// (see address.js); then opts.allow(remoteAddress) keeps everything but the TV itself out.
//
// This code runs inside Vetro's process, so nothing may throw out of an event handler: every callback goes through guard(),
// every socket has an error listener, every connection has a timeout, and the number of connections is capped.

var net = require('net');
var tls = require('tls');
var http = require('http');
var zlib = require('zlib');
var Duplex = require('stream').Duplex;
var client = require('./tls-client.js');
var inject = require('./inject.js');

var HAS_AUTO_FAMILY = typeof net.setDefaultAutoSelectFamily === 'function';
var NODE_MAJOR = +(process.versions && String(process.versions.node).split('.')[0]) || 0;
// Node < 12's JSStreamWrap spins at 100% CPU when tls.Server wraps a JS Duplex stream; only Node >= 12 supports prependSocket MITM.
var CAN_WRAP_DUPLEX = NODE_MAJOR >= 12;
var MAX_BODY = 8 * 1024 * 1024;
var MAX_CONNECTIONS = 300;
var IDLE_MS = 5 * 60 * 1000;           // a connection that carries nothing for this long is closed
var CONNECT_MS = 20 * 1000;            // time allowed to reach a host
var KEEP_ALIVE_MS = 65 * 1000;         // above Cobalt's keep-alive reuse window for InnerTube POSTs
var HEADERS_MS = 70 * 1000;
var MAX_HEADER_BYTES = 65536;
var PRELUDE_BUF = Buffer.from && Buffer.from !== Uint8Array.from ? Buffer.from(inject.PRELUDE_BODY, 'utf8') : new Buffer(inject.PRELUDE_BODY, 'utf8');

function decompressBody(buf, encoding) {
    var enc = String(encoding || '').trim().toLowerCase();
    if (!enc || enc === 'identity') return { ok: true, buf: buf };
    try {
        if (enc === 'gzip' || enc === 'x-gzip') return { ok: true, buf: zlib.gunzipSync(buf) };
        if (enc === 'deflate') {
            try { return { ok: true, buf: zlib.inflateSync(buf) }; }
            catch (e) { return { ok: true, buf: zlib.inflateRawSync(buf) }; }
        }
        if (enc === 'br' && typeof zlib.brotliDecompressSync === 'function') return { ok: true, buf: zlib.brotliDecompressSync(buf) };
    } catch (e) {
        return { ok: false, error: e };
    }
    return { ok: false, error: new Error('unsupported content-encoding: ' + enc) };
}

// opts: host, port, allow(remoteAddress) -> boolean (optional), log(msg), leaf() -> {key, cert} | null, script() -> {body, version} | null, onPage({injected, bytes}), maxConnections
function createProxy(opts) {
    var server = null, ready = false, tlsServer = null, httpServer = null, leafCert = null, tunnels = 0, opened = 0, live = 0, relayed = 0, refused = 0, accepted = 0, foreign = 0, loggedFirst = false, loggedOdd = false;
    var socks = {}, nextId = 1, waiters = [];                // every open socket, so that close(true) can end them
    var cap = opts.maxConnections || MAX_CONNECTIONS;
    var canWrapDuplex = opts && opts.canWrapDuplex != null ? !!opts.canWrapDuplex : CAN_WRAP_DUPLEX;

    function guard(fn, onError) {
        return function () {
            try { return fn.apply(this, arguments); }
            catch (e) { try { opts.log('internal error: ' + (e && e.message)); if (onError) onError(e); } catch (x) { /* nothing more to do */ } }
        };
    }
    function drop(sock) { try { if (sock) sock.destroy(); } catch (e) { /* closed */ } }
    // When a client pipelines TLS ClientHello bytes in the same TCP read as CONNECT, TLSSocket wrapping a raw
    // net.Socket would attach to sock._handle directly and miss any bytes pushed back with sock.unshift().
    // On Node >= 12, wrapping in a JS Duplex feeds `head` first and then bridges the underlying socket seamlessly.
    function prependSocket(sock, head) {
        var closed = false, closeEmitted = false, eofPushed = false;
        var d = new Duplex({
            emitClose: true,
            read: function () { if (!closed) sock.resume(); },
            write: function (chunk, enc, cb) {
                if (closed || sock.destroyed || !sock.writable) { cb(); return; }
                sock.write(chunk, enc, cb);
            }
        });
        function pushEof() {
            if (eofPushed) return;
            eofPushed = true;
            try { d.push(null); } catch (e) { /* closed */ }
        }
        d.on('error', function () { /* handled by TLS or close */ });
        d.remoteAddress = sock.remoteAddress;
        d.remotePort = sock.remotePort;
        d.setTimeout = function (ms, fn) { sock.setTimeout(ms, fn); return d; };
        var origDestroy = d.destroy;
        function finishClose() {
            if (closeEmitted) return;
            closeEmitted = true;
            pushEof();
            d.emit('close');
        }
        d.destroy = function (err) {
            closed = true;
            drop(sock);
            if (typeof origDestroy === 'function') return origDestroy.call(d, err);
            finishClose();
            return d;
        };
        d.on('finish', function () { try { if (!sock.destroyed) sock.end(); } catch (e) { /* closed */ } });
        d.on('close', function () { closed = true; closeEmitted = true; drop(sock); });
        sock.on('data', function (chunk) { if (!closed && !d.push(chunk)) sock.pause(); });
        sock.on('end', function () { if (!closed) pushEof(); });
        sock.on('error', function (e) { if (!closed) d.emit('error', e); });
        sock.on('close', function () {
            if (closed) return;
            closed = true;
            if (typeof origDestroy === 'function') origDestroy.call(d);
            else finishClose();
        });
        d.push(head);
        return d;
    }
    function replyErrorAndClose(sock, statusLine) {
        try {
            if (sock && !sock.destroyed && sock.writable) {
                sock.end(statusLine + '\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
                var t = setTimeout(function () { drop(sock); }, 250);
                if (t && t.unref) t.unref();
            } else {
                drop(sock);
            }
        } catch (e) { drop(sock); }
    }
    function track(sock, count, skipTimeout) {
        if (count) live++;
        var gone = false, id = nextId++;
        socks[id] = sock;
        sock.on('close', function () { if (!gone) { gone = true; if (count) live--; delete socks[id]; } });
        sock.on('error', function () { /* the close that follows is handled */ });
        if (!skipTimeout) sock.setTimeout(IDLE_MS, function () { drop(sock); });
    }

    function handle(req, res) {
        var abortUpstream = null, cleanupPipe = null, gone = false;
        function teardown() {
            gone = true;
            if (cleanupPipe) { cleanupPipe(); cleanupPipe = null; }
            if (abortUpstream) { abortUpstream(); abortUpstream = null; }
        }
        res.on('error', teardown);
        req.on('error', teardown);
        res.on('close', teardown);
        var fail = function () {
            try {
                if (!res.headersSent) res.writeHead(502, { 'content-length': 0 });
                if (!res.finished) res.end();
            } catch (e) { drop(res.socket || req.socket); }
        };

        var host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
        if (!inject.MITM_HOSTS[host]) { res.writeHead(421, { 'content-length': 0 }); res.end(); return; }
        if (req.url.split('?')[0] === inject.PRELUDE_PATH) {
            var ps = opts.script();
            if (req.method !== 'GET' || !ps) { res.writeHead(404, { 'content-length': 0 }); res.end(); return; }
            res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'content-length': PRELUDE_BUF.length, 'cache-control': 'no-store' });
            res.end(PRELUDE_BUF);
            return;
        }
        if (req.url.split('?')[0] === inject.SCRIPT_PATH) {
            var s = opts.script();
            if (req.method !== 'GET' || !s) { res.writeHead(404, { 'content-length': 0 }); res.end(); return; }
            res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'content-length': s.body.length, 'cache-control': 'no-store' });
            res.end(s.body);
            return;
        }
        var tv = req.method === 'GET' && inject.isTvPage(req.url) && !!opts.script();
        var chunks = [], size = 0, over = false;
        req.on('data', function (c) {
            if (over || gone) return;
            size += c.length;
            if (size > MAX_BODY) {
                over = true;
                chunks = [];
                if (req.resume) req.resume();
                if (!res.headersSent) {
                    res.writeHead(413, { 'content-length': 0, 'connection': 'close' });
                    res.end(function () { drop(req.socket); });
                    var closeTimer = setTimeout(function () { drop(req.socket); }, 250);
                    if (closeTimer && closeTimer.unref) closeTimer.unref();
                } else {
                    drop(req.socket);
                }
                return;
            }
            chunks.push(c);
        });
        req.on('end', guard(function () {
            if (over || gone || res.finished) return;
            var h = client.request({ host: host, method: req.method, path: req.url, headers: req.headers, identity: tv, noCache: tv }, Buffer.concat(chunks), guard(function (err, r) {
                if (gone || res.finished) return;
                if (err) { opts.log('upstream ' + host + ' failed: ' + err.message); fail(); return; }
                var type = String(r.headers['content-type'] || '').toLowerCase();
                if (!tv || r.status !== 200 || type.indexOf('text/html') < 0) {
                    res.writeHead(r.status, inject.passHeaders(r.headers));
                    cleanupPipe = function () { try { r.body.unpipe(res); } catch (e) { /* closed */ } };
                    r.body.on('error', function () { if (cleanupPipe) cleanupPipe(); drop(res.socket); });
                    r.body.pipe(res);
                    return;
                }
                var parts = [], total = 0, bodyFailed = false;
                r.body.on('data', function (c) { total += c.length; if (total <= MAX_BODY) parts.push(c); });
                r.body.on('error', function () {
                    if (bodyFailed || gone) return;
                    bodyFailed = true;
                    fail();
                });
                r.body.on('end', guard(function () {
                    if (bodyFailed || gone || res.headersSent) return;
                    if (total > MAX_BODY) { fail(); return; }
                    var raw = Buffer.concat(parts);
                    var s2 = opts.script();
                    if (!s2) {
                        res.writeHead(200, inject.passHeaders(r.headers));
                        res.end(raw);
                        return;
                    }
                    var dec = decompressBody(raw, r.headers['content-encoding']);
                    if (!dec.ok || dec.buf.length > MAX_BODY) {
                        opts.log('TV page not rewritten (' + (dec.ok ? 'decompressed body too large' : dec.error.message) + ')');
                        res.writeHead(200, inject.passHeaders(r.headers));
                        res.end(raw);
                        return;
                    }
                    var page = inject.rewritePage(dec.buf.toString('utf8'), inject.scriptTag(s2.version), inject.preludeTag(s2.version));
                    var out = Buffer.from && Buffer.from !== Uint8Array.from ? Buffer.from(page.html, 'utf8') : new Buffer(page.html, 'utf8');
                    res.writeHead(200, inject.pageHeaders(r.headers, out.length));
                    res.end(out);
                    opts.log('TV page rewritten (' + out.length + ' bytes' + (page.injected ? '' : ', no </body>: tag appended') + ')');
                    if (opts.onPage) opts.onPage({ injected: true, bytes: out.length });
                }, fail));
            }, fail));
            abortUpstream = function () { h.abort(); };
        }, fail));
    }

    // One shared TLS and HTTP server for every opened connection; rebuilt when the certificate changes.
    function ensureTls() {
        var leaf = opts.leaf();
        if (!leaf) return null;
        if (tlsServer && leafCert === leaf.cert) return tlsServer;
        try {
            var nextHttp = typeof http.maxHeaderSize === 'number'
                ? http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, guard(handle, null))
                : http.createServer(guard(handle, null));
            nextHttp.keepAliveTimeout = KEEP_ALIVE_MS;
            nextHttp.headersTimeout = HEADERS_MS;
            nextHttp.requestTimeout = 0;
            nextHttp.on('clientError', function (e, sock) {
                if (!(e && e.code === 'ERR_HTTP_REQUEST_TIMEOUT' && (!sock || !sock.bytesRead))) {
                    opts.log('client error: ' + (e && e.code || e));
                }
                drop(sock);
            });
            var nextTls = tls.createServer({ key: leaf.key, cert: leaf.cert });
            nextTls.on('secureConnection', guard(function (s) { track(s, false, false); nextHttp.emit('connection', s); }));
            nextTls.on('tlsClientError', function (e) { opts.log('TLS refused by the app: ' + (e && e.message)); });
            nextTls.on('error', function () { /* per connection errors are on the sockets */ });
            httpServer = nextHttp;
            tlsServer = nextTls;
            leafCert = leaf.cert;
            return tlsServer;
        } catch (e) {
            opts.log('TLS cert load failed: ' + (e && e.message));
            return tlsServer;
        }
    }

    var HEAD_MAX = 8192;

    function onConnection(c) {
        if (opts.allow && !opts.allow(c.remoteAddress)) {
            if (!foreign++) opts.log('refused a connection from outside the TV');
            c.on('error', function () { /* closed */ });
            drop(c); return;
        }
        if (live >= cap) {
            refused++;
            c.on('error', function () { /* closed */ });
            replyErrorAndClose(c, 'HTTP/1.1 502 Bad Gateway');
            return;
        }
        accepted++;
        if (!loggedFirst) { loggedFirst = true; opts.log('first connection from the app, from ' + c.remoteAddress); }
        track(c, true, false);
        var buf = Buffer.alloc ? Buffer.alloc(0) : new Buffer(0), started = false;
        c.on('data', guard(function onData(d) {
            if (started) return;
            buf = Buffer.concat([buf, d]);
            var end = buf.indexOf('\r\n\r\n');
            if (end < 0) {
                if (buf.length > HEAD_MAX) { started = true; replyErrorAndClose(c, 'HTTP/1.1 400 Bad Request'); }
                return;                                    // the rest of the request has not arrived yet
            }
            started = true;
            c.removeListener('data', onData);
            c.pause();
            var rest = buf.slice(end + 4);
            var head = buf.slice(0, end).toString('binary');
            connect(c, head.split('\r\n')[0], rest, head);
        }, function () { drop(c); }));
    }

    // The YouTube app also sends plain requests to the TV's own web server through the proxy (it posts the cast data to
    // http://localhost:8080/ws/apps/YouTube/dial_data, which the phone reads to match the cast target with the app).
    // Only that server is reachable this way: loopback, port 8080, one request per connection. Anything else is refused.
    var LOCAL_PORT = opts.localPort || 8080;           // opts.localPort is for tests only
    function relayLocal(c, head, rest) {
        var lines = head.split('\r\n');
        var m = /^([A-Z]{3,7}) http:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})(\/[^ ]*) HTTP\/1\.[01]$/.exec(lines[0]);
        if (!m || parseInt(m[2], 10) !== LOCAL_PORT) return false;
        var kept = lines.slice(1).filter(function (l) { return !/^(proxy-)?connection:/i.test(l); });
        var out = [m[1] + ' ' + m[3] + ' HTTP/1.1'].concat(kept, ['Connection: close', '', '']).join('\r\n');
        relayed++;
        if (relayed === 1) opts.log('relaying the app\u2019s requests to the TV\u2019s web server (port ' + LOCAL_PORT + ')');
        var established = false;
        var up = net.connect(LOCAL_PORT, '127.0.0.1');
        track(up, false, true);
        function cleanup() {
            try { c.unpipe(up); } catch (e) { /* closed */ }
            try { up.unpipe(c); } catch (e) { /* closed */ }
            drop(up);
            drop(c);
        }
        function failRelay() {
            if (established) { cleanup(); return; }
            established = true;
            drop(up);
            replyErrorAndClose(c, 'HTTP/1.1 502 Bad Gateway');
        }
        up.setTimeout(CONNECT_MS, guard(function () {
            if (!established) failRelay();
            else cleanup();
        }, cleanup));
        up.on('connect', guard(function () {
            if (established) { drop(up); return; }
            established = true;
            up.setTimeout(IDLE_MS);
            up.write(out, 'binary');
            if (rest.length) up.write(rest);
            c.pipe(up); up.pipe(c);
            c.resume();
        }, cleanup));
        up.on('error', failRelay);
        c.on('error', cleanup);
        c.on('close', function () { established = true; cleanup(); });
        up.on('close', function () {
            if (!established) { failRelay(); return; }
            try { c.end(); } catch (e) { drop(c); }
        });
        return true;
    }

    function connect(c, line, rest, head) {
        var m = /^CONNECT (?:\[([0-9a-fA-F:]+)\]|([^ :\[\]]+)):(\d{1,5}) HTTP\/1\.[01]$/.exec(line);
        if (!m && head && relayLocal(c, head, rest)) return;
        if (!m) { if (!loggedOdd) { loggedOdd = true; opts.log('not a CONNECT request: ' + line.slice(0, 60)); } replyErrorAndClose(c, 'HTTP/1.1 502 Bad Gateway'); return; }
        if (m[1] && net.isIP(m[1]) !== 6) { replyErrorAndClose(c, 'HTTP/1.1 400 Bad Request'); return; }
        var host = (m[1] || m[2]).toLowerCase(), port = parseInt(m[3], 10);
        if (port < 1 || port > 65535) { replyErrorAndClose(c, 'HTTP/1.1 400 Bad Request'); return; }
        if (port === 443 && inject.MITM_HOSTS[host] && opts.script() && (!rest.length || canWrapDuplex)) {
            var t = ensureTls();
            if (t) {
                opened++;
                c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (rest.length) {
                    t.emit('connection', prependSocket(c, rest));
                } else {
                    t.emit('connection', c);
                }
                c.resume();
                return;
            }
        }
        tunnels++;
        var established = false;
        var connectOpts = { host: host, port: port };
        if (HAS_AUTO_FAMILY) connectOpts.autoSelectFamily = true;
        var up = net.connect(connectOpts);
        track(up, false, true);
        function cleanup() {
            try { c.unpipe(up); } catch (e) { /* closed */ }
            try { up.unpipe(c); } catch (e) { /* closed */ }
            drop(up);
            drop(c);
        }
        function failConnect() {
            if (established) { cleanup(); return; }
            established = true;
            drop(up);
            replyErrorAndClose(c, 'HTTP/1.1 502 Bad Gateway');
        }
        up.setTimeout(CONNECT_MS, guard(function () {
            if (!established) failConnect();
            else cleanup();
        }, cleanup));
        up.on('connect', guard(function () {
            if (established) { drop(up); return; }
            established = true;
            up.setTimeout(IDLE_MS);
            c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (rest.length) up.write(rest);
            c.pipe(up); up.pipe(c);
            c.resume();
        }, cleanup));
        up.on('error', failConnect);
        c.on('error', cleanup);
        c.on('close', function () { established = true; cleanup(); });
        up.on('close', function () { if (established) cleanup(); else failConnect(); });
    }

    return {
        listen: function (cb) {
            if (server) { if (ready) cb(null); else waiters.push(cb); return; }
            var s = net.createServer(guard(onConnection)), done = false;
            server = s; ready = false;
            s.on('error', function (e) { if (!done) { done = true; cb(e); waiters.splice(0).forEach(function (w) { w(e); }); } else opts.log('proxy error: ' + e.message); if (server === s) { server = null; ready = false; } });
            s.on('close', function () { if (server === s) { server = null; ready = false; } });
            s.listen(opts.port, opts.host, function () { if (!done && server === s) { done = true; ready = true; cb(null); waiters.splice(0).forEach(function (w) { w(null); }); } else if (!done) { done = true; try { s.close(); } catch (e) { /* closed */ } var err = new Error('closed while starting'); cb(err); waiters.splice(0).forEach(function (w) { w(err); }); } });
        },
        // Stops listening. Connections that are already open are left to finish on their own (a YouTube that is running keeps
        // working), unless `hard` is set: then they are cut as well.
        close: function (hard) {
            var s = server;
            server = null; ready = false;
            if (s) { try { s.close(); } catch (e) { /* closed */ } }
            tlsServer = null; httpServer = null; leafCert = null;
            if (hard) Object.keys(socks).forEach(function (id) { drop(socks[id]); });
        },
        listening: function () { return !!server && ready; },
        stats: function () { return { tunnels: tunnels, relayed: relayed, opened: opened, live: live, refused: refused, accepted: accepted, foreign: foreign }; }
    };
}

module.exports = { createProxy: createProxy, MAX_CONNECTIONS: MAX_CONNECTIONS };
