'use strict';
// Notification Center: queue notifications from any device on the LAN and show them as native TV banners
// through a small companion web app (see README). It talks only to Vetro on 127.0.0.1:8099 (to launch that app).
// Plain ES5: older TVs run Node 4.4.
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var urlmod = require('url');

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
        var keep = {};
        queue.forEach(function (n) { keep[n.id] = 1; });
        Object.keys(imgCache).forEach(function (k) { if (!keep[k.split(':')[0]]) { delete imgCache[k]; } });
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

    // The app may only load resources from the addresses its config.xml declares, so the Shard fetches the picture and serves it itself.
    var imgCache = {}, MAX_IMG = 3000000;
    function fetchImage(url, cb, hops) {
        var u = urlmod.parse(url), lib = u.protocol === 'https:' ? https : http, done = false;
        function end(e, r) { if (!done) { done = true; cb(e, r); } }
        try {
            var rq = lib.get({ host: u.hostname, port: u.port, path: u.path, headers: { 'User-Agent': 'vetro-notification-center', 'Accept': 'image/*' }, timeout: 8000 }, function (r) {
                if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (hops || 0) < 3) {
                    r.resume();
                    return fetchImage(urlmod.resolve(url, r.headers.location), end, (hops || 0) + 1);
                }
                var type = String(r.headers['content-type'] || '').split(';')[0];
                if (r.statusCode !== 200 || !/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(type)) { r.resume(); return end('not an image (http ' + r.statusCode + ' ' + type + ')'); }
                var chunks = [], n = 0;
                r.on('data', function (d) { n += d.length; if (n > MAX_IMG) { r.destroy(); end('image is larger than 3 MB'); } else { chunks.push(d); } });
                r.on('end', function () { end(null, { type: type, buf: Buffer.concat(chunks) }); });
            });
            rq.on('error', function (e) { end(String(e && e.code || e && e.message || e)); });
            rq.on('timeout', function () { rq.destroy(); end('timeout'); });
        } catch (e) { end('request failed'); }
    }
    function serveImage(req, res) {
        var m = /[?&]id=([^&]+)/.exec(String(req.url || '')), id = m && decodeURIComponent(m[1]), info = /[?&]info=1(&|$)/.test(String(req.url || '')), note = null, i;
        for (i = 0; i < queue.length; i++) { if (queue[i].id === id) { note = queue[i]; } }
        var kind = /[?&]kind=wallpaper(&|$)/.test(String(req.url || '')) ? 'wallpaper' : 'image', src = note && note[kind], key = id + ':' + kind;
        if (!src) { return sendJson(res, 404, { error: 'no ' + kind + ' for that notification' }); }
        function out(hit) {
            if (info) { return sendJson(res, 200, { ok: true, type: hit.type, bytes: hit.buf.length }); }
            res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': hit.buf.length });
            res.end(hit.buf);
        }
        if (imgCache[key]) { return out(imgCache[key]); }
        fetchImage(src, function (err, hit) {
            if (err) { return sendJson(res, 502, { ok: false, error: err }); }
            imgCache[key] = hit;
            out(hit);
        });
    }

    // Image for the full-screen card: an http(s) URL only.
    function cleanUrl(u) { u = String(u == null ? '' : u).trim(); return /^https?:\/\/[^\s"'<>]{4,290}$/.test(u) ? u : ''; }

    // ntfy-compatible publish: POST .../ntfy with the message as the body (headers Title, Priority, Tags) or JSON {message,title,priority,tags}.
    var NTFY_TAGS = { warning: '\u26A0\uFE0F', rotating_light: '\uD83D\uDEA8', white_check_mark: '\u2705', heavy_check_mark: '\u2714\uFE0F', tada: '\uD83C\uDF89',
        fire: '\uD83D\uDD25', soccer: '\u26BD', bell: '\uD83D\uDD14', skull: '\uD83D\uDC80', house: '\uD83C\uDFE0', package: '\uD83D\uDCE6', sunny: '\u2600\uFE0F' };
    function handleNtfy(req, res) {
        readBody(req, function (raw) {
            var b = {}, h = req.headers || {}, j = null, i, t;
            if (/json/i.test(String(h['content-type'] || ''))) { try { j = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); } }
            if (j && typeof j === 'object') { b.message = j.message; b.title = j.title; } else { b.message = raw; }
            b.title = b.title || h.title || h.t;
            var p = parseInt((j && j.priority) || h.priority || h.p, 10), tags = (j && j.tags) || h.tags || h.ta || '';
            if (typeof tags === 'string') { tags = tags.split(','); }
            b.level = p >= 5 ? 'alert' : p === 4 ? 'warn' : 'info';
            for (i = 0; i < tags.length; i++) {
                t = String(tags[i]).trim().toLowerCase();
                if (NTFY_TAGS.hasOwnProperty(t)) {
                    b.icon = NTFY_TAGS[t];
                    if (t === 'rotating_light' || t === 'skull') { b.level = 'alert'; }
                    else if (t === 'warning' && b.level === 'info') { b.level = 'warn'; }
                    else if ((t === 'white_check_mark' || t === 'heavy_check_mark' || t === 'tada') && b.level === 'info') { b.level = 'ok'; }
                    break;
                }
            }
            handleNotify({ on: function (ev, f) { if (ev === 'data') { f(JSON.stringify(b)); } if (ev === 'end') { f(); } } }, res);
        });
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
                image: cleanUrl(b.image),
                wallpaper: cleanUrl(b.wallpaper),
                message: message,
                level: LEVELS[b.level] ? b.level : 'info',
                mode: MODES[b.mode] ? b.mode : 'banner',
                duration: dur,
                expires: Date.now() + secs * 1000
            };
            queue.push(note);
            if (queue.length > MAX_QUEUE) { queue.shift(); }
            recent.unshift({ id: note.id, title: note.title, message: note.message, level: note.level, mode: note.mode, duration: note.duration, icon: note.icon, image: note.image, at: Date.now() });
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
            if (sub === 'img' && req.method === 'GET') { serveImage(req, res); return true; }
            if (sub === 'ntfy' && req.method === 'POST') { handleNtfy(req, res); return true; }
            if (sub === 'emoji' && req.method === 'GET') { sendFile(res, 'emoji.json', 'application/json; charset=utf-8'); return true; }
            if (sub === 'nt.js' && req.method === 'GET') { sendFile(res, 'nt.js', 'application/javascript; charset=utf-8'); return true; }
            if (sub === 'notify' && req.method === 'POST') { handleNotify(req, res); return true; }
            if (sub === 'notifications' && req.method === 'GET') {
                prune();
                var now = Date.now();
                var out = { lang: getLang(), notifications: queue.map(function (n) {
                    return { id: n.id, title: n.title, message: n.message, level: n.level, mode: n.mode, duration: n.duration, icon: n.icon, image: n.image, wallpaper: n.wallpaper, seconds: Math.ceil((n.expires - now) / 1000) };
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
