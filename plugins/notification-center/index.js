'use strict';
// Notification Center: queue notifications from any device on the LAN and show them as native TV banners
// through a small companion web app (see README). It talks only to Vetro on 127.0.0.1:8099 (to launch that app).
// Plain ES5: older TVs run Node 4.4.
var fs = require('fs');
var path = require('path');
var http = require('http');

var MAX_TITLE = 40, MAX_MESSAGE = 200, MAX_QUEUE = 5, MAX_RECENT = 20, MAX_BODY = 8192;
var DEFAULT_SECONDS = 30, MIN_SECONDS = 5, MAX_SECONDS = 300, OPEN_EVERY_MS = 10000;
var APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var DEFAULT_APP = 'NotifCtr01.NotifCenter';

module.exports = function (ctx) {
    var queue = [];      // active notifications (memory only)
    var recent = [];     // last ones sent, for the page (memory only)
    var seq = 0;
    var lastOpen = 0;

    function appId() {
        var c = ctx.config.get() || {};
        return APP_ID.test(c.appId || '') ? c.appId : DEFAULT_APP;
    }
    function send(res, code, type, body) {
        res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(body);
    }
    function sendJson(res, code, obj) { send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }
    // The companion app can read the queue as a <script> when the TV's web runtime blocks cross-origin XHR.
    function sendScript(res, obj) {
        var json = JSON.stringify(obj).replace(/</g, '\\u003c');
        json = json.split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
        send(res, 200, 'application/javascript; charset=utf-8', 'window.__ncNotes&&window.__ncNotes(' + json + ');');
    }
    function wantsScript(req) { return /[?&]js=1(&|$)/.test(String(req.url || '')); }
    function readBody(req, cb) {
        var s = '';
        req.on('data', function (d) { s += d; if (s.length > MAX_BODY) { req.destroy(); } });
        req.on('end', function () { cb(s); });
    }
    function clean(text, max) {
        return String(text == null ? '' : text).replace(/[\x00-\x1f]/g, ' ').slice(0, max).trim();
    }
    function prune() {
        var now = Date.now();
        queue = queue.filter(function (n) { return n.expires > now; });
    }

    // Asks Vetro to launch the companion app (at most once every 10 s).
    function openApp() {
        var now = Date.now();
        if (now - lastOpen < OPEN_EVERY_MS) { return 'skipped (less than 10 s since the last launch)'; }
        lastOpen = now;
        var body = JSON.stringify({ appId: appId() });
        try {
            var rq = http.request({
                host: '127.0.0.1', port: 8099, path: '/apps/launch', method: 'POST', timeout: 5000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, function (r) { r.resume(); });
            rq.on('error', function () { /* Vetro busy or app not installed */ });
            rq.on('timeout', function () { rq.destroy(); });
            rq.write(body);
            rq.end();
            return 'requested';
        } catch (e) { return 'error'; }
    }

    function handleNotify(req, res) {
        readBody(req, function (raw) {
            var b;
            try { b = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); }
            b = b || {};
            var message = clean(b.message, MAX_MESSAGE);
            if (!message) { return sendJson(res, 400, { error: 'message is required' }); }
            var secs = parseInt(b.seconds, 10);
            if (!(secs >= MIN_SECONDS)) { secs = DEFAULT_SECONDS; }
            if (secs > MAX_SECONDS) { secs = MAX_SECONDS; }
            prune();
            seq += 1;
            var note = {
                id: seq + '-' + Date.now().toString(36),
                title: clean(b.title, MAX_TITLE),
                message: message,
                expires: Date.now() + secs * 1000
            };
            queue.push(note);
            if (queue.length > MAX_QUEUE) { queue.shift(); }
            recent.unshift({ id: note.id, title: note.title, message: note.message, at: Date.now() });
            if (recent.length > MAX_RECENT) { recent.pop(); }
            var opened = b.open === false ? 'not requested' : openApp();
            sendJson(res, 200, { ok: true, id: note.id, open: opened });
        });
    }

    function handleConfig(req, res) {
        if (req.method === 'GET') { sendJson(res, 200, { appId: appId(), defaultAppId: DEFAULT_APP }); return true; }
        readBody(req, function (raw) {
            var b;
            try { b = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); }
            var id = b && b.appId;
            if (!APP_ID.test(id || '')) { return sendJson(res, 400, { error: 'invalid appId' }); }
            ctx.config.set({ appId: id });
            sendJson(res, 200, { appId: id });
        });
        return true;
    }

    function sendFile(res, name, type) {
        fs.readFile(path.join(__dirname, name), 'utf8', function (err, text) {
            if (err) { return sendJson(res, 500, { error: name + ' is missing' }); }
            send(res, 200, type, text);
        });
    }

    return {
        start: function () {},
        stop: function () { queue = []; recent = []; },
        status: function () { prune(); return { queued: queue.length, appId: appId() }; },
        route: function (req, res, sub) {
            sub = String(sub || '').split('?')[0].replace(/^\/+|\/+$/g, '');
            if (sub === 'ui' && req.method === 'GET') { sendFile(res, 'ui.html', 'text/html; charset=utf-8'); return true; }
            if (sub === 'nt.js' && req.method === 'GET') { sendFile(res, 'nt.js', 'application/javascript; charset=utf-8'); return true; }
            if (sub === 'notify' && req.method === 'POST') { handleNotify(req, res); return true; }
            if (sub === 'notifications' && req.method === 'GET') {
                prune();
                var now = Date.now();
                var out = { notifications: queue.map(function (n) {
                    return { id: n.id, title: n.title, message: n.message, seconds: Math.ceil((n.expires - now) / 1000) };
                }) };
                if (wantsScript(req)) { sendScript(res, out); } else { sendJson(res, 200, out); }
                return true;
            }
            if (sub === 'recent' && req.method === 'GET') { sendJson(res, 200, { recent: recent }); return true; }
            if (sub === 'config' && (req.method === 'GET' || req.method === 'POST')) { return handleConfig(req, res); }
            return false;
        }
    };
};
