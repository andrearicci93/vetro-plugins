'use strict';
// Notification Center: queue notifications from any device on the LAN and show them as native TV banners
// through a small companion web app (see README). It talks only to Vetro on 127.0.0.1:8099 (to launch that app).
// Plain ES5: older TVs run Node 4.4.
var fs = require('fs');
var path = require('path');
var http = require('http');

var MAX_TITLE = 40, MAX_MESSAGE = 200, MAX_QUEUE = 5, MAX_RECENT = 20, MAX_BODY = 8192;
var DEFAULT_SECONDS = 30, MIN_SECONDS = 5, MAX_SECONDS = 300, OPEN_EVERY_MS = 10000;
var DEFAULT_APP = 'NotifCtr01.NotifCenter';   // the companion app (screen: full-screen card, native banner)
var SERVICE_APP = 'NotifCtr01.Svc';           // its background service (native banner over the running app, no app switch)
var LEVELS = { info: 1, ok: 1, warn: 1, alert: 1 };
var MIN_DURATION = 1, MAX_DURATION = 60, DEFAULT_DURATION = 8;
var MODES = { both: 1, banner: 1, full: 1 };   // banner (default) = native banner over the running app, from the background service; full = full-screen card; both = card + banner

module.exports = function (ctx) {
    var queue = [];      // active notifications (memory only)
    var recent = [];     // last ones sent, for the page (memory only)
    var seq = 0;
    var lastOpen = 0;

    // Display language of the app screen and the panel: 'en' (default) or 'pt'. The only thing kept in ctx.config.
    function getLang() { var c = ctx.config.get() || {}; return c.lang === 'pt' ? 'pt' : 'en'; }
    function appId() { return DEFAULT_APP; }   // fixed: nothing can point the Shard at another app
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

    // Asks Vetro to launch the companion app (at most once every 10 s), or its background service (every time: it is
    // headless, so launching it only makes it read the queue and post the banner).
    function openApp(service) {
        var now = Date.now();
        if (!service) {
            if (now - lastOpen < OPEN_EVERY_MS) { return 'skipped (less than 10 s since the last launch)'; }
            lastOpen = now;
        }
        var body = JSON.stringify({ appId: service ? SERVICE_APP : appId() });
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
            // duration = how long the notification stays on the TV screen (the app shows it, then returns to the previous app).
            var dur = parseInt(b.duration, 10);
            if (!(dur >= MIN_DURATION)) { dur = DEFAULT_DURATION; }
            if (dur > MAX_DURATION) { dur = MAX_DURATION; }
            if (secs < dur + 20) { secs = dur + 20; }
            prune();
            seq += 1;
            var note = {
                id: seq + '-' + Date.now().toString(36),
                title: clean(b.title, MAX_TITLE),
                icon: clean(b.icon, 8),
                message: message,
                level: LEVELS[b.level] ? b.level : 'info',
                mode: MODES[b.mode] ? b.mode : 'banner',
                duration: dur,
                expires: Date.now() + secs * 1000
            };
            queue.push(note);
            if (queue.length > MAX_QUEUE) { queue.shift(); }
            recent.unshift({ id: note.id, title: note.title, message: note.message, level: note.level, mode: note.mode, duration: note.duration, icon: note.icon, at: Date.now() });
            if (recent.length > MAX_RECENT) { recent.pop(); }
            var opened = b.open === false ? 'not requested' : openApp(note.mode === 'banner');
            sendJson(res, 200, { ok: true, id: note.id, open: opened });
        });
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
            if (sub === 'emoji' && req.method === 'GET') { sendFile(res, 'emoji.json', 'application/json; charset=utf-8'); return true; }
            if (sub === 'nt.js' && req.method === 'GET') { sendFile(res, 'nt.js', 'application/javascript; charset=utf-8'); return true; }
            if (sub === 'notify' && req.method === 'POST') { handleNotify(req, res); return true; }
            if (sub === 'notifications' && req.method === 'GET') {
                prune();
                var now = Date.now();
                var out = { lang: getLang(), notifications: queue.map(function (n) {
                    return { id: n.id, title: n.title, message: n.message, level: n.level, mode: n.mode, duration: n.duration, icon: n.icon, seconds: Math.ceil((n.expires - now) / 1000) };
                }) };
                if (wantsScript(req)) { sendScript(res, out); } else { sendJson(res, 200, out); }
                return true;
            }
            if (sub === 'lang' && req.method === 'GET') { sendJson(res, 200, { lang: getLang() }); return true; }
            if (sub === 'lang' && req.method === 'POST') {
                readBody(req, function (raw) {
                    var b;
                    try { b = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); }
                    if (!b || (b.lang !== 'en' && b.lang !== 'pt')) { return sendJson(res, 400, { error: 'lang must be en or pt' }); }
                    var c = ctx.config.get() || {};
                    c.lang = b.lang;
                    ctx.config.set(c);
                    sendJson(res, 200, { lang: b.lang });
                });
                return true;
            }
            if (sub === 'recent' && req.method === 'GET') { sendJson(res, 200, { recent: recent }); return true; }
            return false;
        }
    };
};
