'use strict';
// Notification Center: queue notifications from any device on the LAN and show them as native TV banners
// through a small companion web app (see README). It talks to Vetro on 127.0.0.1:8099 (to launch that app); the one other thing it does on the
// network is to fetch an http(s) image URL when a sender gives an `image` or `wallpaper` (at most 2 at a time, 10 s each, 3 MB).
// Everything that arrives from the LAN is untrusted JSON: values are type-checked (str/num/has from rules.js) before they are used.
// Plain ES5: older TVs run Node 4.4.
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var urlmod = require('url');
var os = require('os');
var rules = require('./rules.js');

var MAX_HOOK_BODY = 65536;
// The tunes: [milliseconds from the start, sound]. We Will Rock You: stomp, stomp, clap (81 beats per minute). Beethoven's 5th: short, short, short, LONG (twice, then again).
var SONGS = { rock: { title: 'We Will Rock You', steps: [] }, fate: { title: "Beethoven's 5th", steps: [] } };
(function () {
    var i, bar;
    for (bar = 0; bar < 4; bar++) { for (i = 0; i < 3; i++) { SONGS.rock.steps.push([bar * 2960 + i * 740, i < 2 ? 'soft' : 'success']); } }
    [0, 3400, 6800].forEach(function (base, n) {
        [0, 280, 560].forEach(function (d) { SONGS.fate.steps.push([base + d, n === 1 ? 'chime' : 'success']); });
        SONGS.fate.steps.push([base + 840, n === 1 ? 'alert' : 'rotation']);
    });
}());
var SOUND_DIR = '/usr/share/feedback/sound/operation/', SOUND_GAP_MS = 800;
// The TV's system sounds are quiet: the volume the user sets (10-100 %) is multiplied by this to get the paplay volume (100 % = 3.0, about +9.5 dB).
var SOUND_BOOST = 3;
// The sound waits for the banner: Vetro needs a few seconds to start the banner service, which then records the id in this file (see app/service.js).
// If the id never shows up there, the sound plays after SOUND_WAIT_MS anyway.
var SEEN_FILE = '/tmp/notification-center-seen.json', SOUND_WAIT_MS = 10000, SOUND_POLL_MS = 50, MAX_WAITING_SOUNDS = 8;   // at most 8 sounds wait for their banner at once; more are skipped
// The TV's system sounds a request can choose (the names are the closed list in rules.js).
var SOUND_FILES = { chime: 'normal_noti.wav', soft: 'select.wav', reward: 'vi_reward.wav', success: 'vi_success.wav', alert: 'vi_fail.wav', rotation: 'p_rotation_fail.wav', open: 'home_open.wav', poweron: 'power_on.wav' };
var MAX_TITLE = 40, MAX_MESSAGE = 200, MAX_QUEUE = 5, MAX_RECENT = 20, MAX_BODY = 8192, MAX_ICON = 16;
var DEFAULT_SECONDS = 30, MIN_SECONDS = 5, MAX_SECONDS = 300, MIN_RELAUNCH_MS = 2000, APP_ACTIVE_MS = 3500;
// The banner service reads the queue from this file, so it needs no network and no Vetro key (it still works with pairing on).
var QUEUE_FILE = '/tmp/notification-center-queue.json';
var DEFAULT_APP = 'NotifCtr01.NotifCenter';   // the companion app (screen: full-screen card, native banner)
var SERVICE_APP = 'NotifCtr01.Svc';           // its background service (native banner over the running app, no app switch)
var LEVELS = { info: 1, ok: 1, warn: 1, alert: 1 };
var MIN_DURATION = 1, MAX_DURATION = 60, DEFAULT_DURATION = 8;
var MODES = { both: 1, banner: 1, full: 1 };   // banner (default) = native banner over the running app, from the background service; full = full-screen card; both = card + banner

module.exports = function (ctx) {
    // Where Vetro listens. Only a test passes ctx.vetro; on the TV it is always 127.0.0.1:8099.
    var vetro = ctx.vetro && typeof ctx.vetro === 'object' ? ctx.vetro : {};
    var VHOST = typeof vetro.host === 'string' ? vetro.host : '127.0.0.1', VPORT = typeof vetro.port === 'number' ? vetro.port : 8099;
    var soundLast = null, soundAt = 0, soundTrace = null;   // soundTrace: when the last banner sound started and when its banner was seen (for the panel)
    var queueFile = QUEUE_FILE, seenFile = SEEN_FILE, soundWaitMs = SOUND_WAIT_MS, waitingSounds = {}, songScale = 1;   // waitingSounds: notification id -> {fire, timer}
    if (typeof ctx.queueFile === 'string') { queueFile = ctx.queueFile; }   // only a test changes this (each test Shard gets its own file)
    if (typeof ctx.sound === 'object' && ctx.sound) {   // only a test changes these
        if (typeof ctx.sound.gapMs === 'number') { SOUND_GAP_MS = ctx.sound.gapMs; }
        if (typeof ctx.sound.waitMs === 'number') { soundWaitMs = ctx.sound.waitMs; }
        if (typeof ctx.sound.seenFile === 'string') { seenFile = ctx.sound.seenFile; }
        if (typeof ctx.sound.songScale === 'number') { songScale = ctx.sound.songScale; }
    }
    var queue = [];      // active notifications (memory only)
    var recent = [];     // last ones sent, for the page; kept in ctx.config so they survive a restart or an update
    try { var saved = (ctx.config.get() || {}).recent; if (Array.isArray(saved)) { recent = saved.slice(0, MAX_RECENT); } } catch (e) { recent = []; }
    function saveRecent() { try { var c = ctx.config.get() || {}; c.recent = recent; ctx.config.set(c); } catch (e) { /* storage unavailable */ } }
    var seq = 0;
    var lastOpen = 0, appPoll = 0;   // appPoll: when the app screen last asked for the queue (0 = it is closed)

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
    // The body is collected as bytes and decoded once at the end, so a multi-byte character split between two chunks stays intact.
    function toBuf(d) { return Buffer.isBuffer(d) ? d : (Buffer.from && Buffer.from !== Uint8Array.from ? Buffer.from(String(d), 'utf8') : new Buffer(String(d), 'utf8')); }
    function readBody(req, cb, max) {
        var chunks = [], n = 0, limit = max || MAX_BODY, over = false;
        req.on('data', function (d) {
            if (over) { return; }
            var b = toBuf(d);
            n += b.length;
            if (n > limit) {
                // Too large: answer 413 and drop the rest of the body without buffering it.
                over = true; chunks = [];
                if (cb.res) { try { sendJson(cb.res, 413, { error: 'request body too large' }); } catch (e) { /* already answered */ } }
                return;
            }
            chunks.push(b);
        });
        req.on('end', function () { if (!over) { cb(Buffer.concat(chunks).toString('utf8')); } });
    }
    // A body handler that throws must never take the Shard down: answer 500 instead of letting the exception reach Vetro.
    function guard(res, fn) {
        var f = function (raw) {
            try { fn(raw); } catch (e) { try { sendJson(res, 500, { error: 'internal error' }); } catch (e2) { /* the answer was already sent */ } }
        };
        f.res = res;   // readBody answers 413 on this response when the body is too large
        return f;
    }
    function readBodyG(req, res, cb, max) { readBody(req, guard(res, cb), max); }
    var limiter = rules.makeLimiter(), groups = {};   // per-source rate windows and recently seen repeats (memory only)
    var str = rules.str, num = rules.num, has = rules.has;
    function cfgGet() { return ctx.config.get() || {}; }
    // Drops the grouping entries older than the window, and keeps at most MAX_GROUPS (the oldest go first). It walks the map only once it has grown past
    // 50 entries, so a flood of distinct notifications cannot make every request slower.
    var MAX_GROUPS = 200;
    function pruneGroups(now, windowMs) {
        var keys = Object.keys(groups);
        if (keys.length <= 50) { return; }
        keys.forEach(function (k) { if (now - groups[k].at >= windowMs) { delete groups[k]; } });
        keys = Object.keys(groups);
        if (keys.length > MAX_GROUPS) {
            keys.sort(function (x, y) { return groups[x].at - groups[y].at; }).slice(0, keys.length - MAX_GROUPS).forEach(function (k) { delete groups[k]; });
        }
    }
    function soundVolume(v) { return rules.clampVolume(v); }
    function settingsNow() { return rules.sanitizeSettings(cfgGet().settings, {}); }
    function clean(text, max) {
        return str(text).replace(/[\x00-\x1f]/g, ' ').slice(0, max).trim();
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
            // The app screen announces itself while it is open (it polls every 2 s and says goodbye when it leaves), so a notification
            // queued while it is open is simply picked up, and one queued while it is closed launches it again right away.
            if (now - appPoll < APP_ACTIVE_MS) { return 'app is open: it will pick it up'; }
            if (now - lastOpen < MIN_RELAUNCH_MS) { return 'skipped (launched less than 2 s ago)'; }
            lastOpen = now;
        }
        var body = JSON.stringify({ appId: service ? SERVICE_APP : appId() });
        try {
            var rq = http.request({
                host: VHOST, port: VPORT, path: '/apps/launch', method: 'POST', timeout: 5000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, function (r) { r.resume(); });
            rq.on('error', function () { /* Vetro busy or app not installed */ });
            rq.setTimeout(5000);   // the timeout option alone is ignored before Node 6.8
            rq.on('timeout', function () { rq.destroy(); });
            rq.write(body);
            rq.end();
            return 'requested';
        } catch (e) { return 'error'; }
    }

    // The app may only load resources from the addresses its config.xml declares, so the Shard fetches the picture and serves it itself.
    // Only a notification's own `image` / `wallpaper` URL is ever fetched (there is no route that fetches an arbitrary URL). Limits: 2 fetches at once
    // (the others wait, at most 8 waiting, then "busy"), 10 s in total per fetch however slowly the server sends, 3 MB, 3 redirects; stop() aborts them all.
    var imgCache = {}, MAX_IMG = 3000000, MAX_FETCHES = 2, MAX_WAITING = 8, FETCH_DEADLINE_MS = 10000;
    var running = [], waiting = [];
    function pump() {
        while (running.length < MAX_FETCHES && waiting.length) { var w = waiting.shift(); startFetch(w.url, w.cb); }
    }
    function fetchImage(url, cb) {
        if (running.length >= MAX_FETCHES) {
            if (waiting.length >= MAX_WAITING) { return cb('busy: too many picture downloads'); }
            waiting.push({ url: url, cb: cb });
            return;
        }
        startFetch(url, cb);
    }
    function startFetch(url, cb) {
        var job = { reqs: [], done: false, timer: null };
        function end(e, r) {
            if (job.done) { return; }
            job.done = true;
            clearTimeout(job.timer);
            job.reqs.forEach(function (q) { try { q.destroy(); } catch (x) { /* already closed */ } });
            running = running.filter(function (j) { return j !== job; });
            try { cb(e, r); } catch (x) { /* the caller's answer failed: nothing to do */ }
            pump();
        }
        job.end = end;
        running.push(job);
        job.timer = setTimeout(function () { end('timeout (10 s)'); }, FETCH_DEADLINE_MS);
        get(url, 0);
        function get(u0, hops) {
            var u = urlmod.parse(u0), lib = u.protocol === 'https:' ? https : http;
            try {
                var rq = lib.get({ host: u.hostname, port: u.port, path: u.path, headers: { 'User-Agent': 'vetro-notification-center', 'Accept': 'image/*' }, timeout: 8000 }, function (r) {
                    if (job.done) { r.resume(); return; }
                    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 3) {
                        r.resume();
                        return get(urlmod.resolve(u0, r.headers.location), hops + 1);
                    }
                    var type = str(r.headers['content-type']).split(';')[0];
                    if (r.statusCode !== 200 || !/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(type)) { r.resume(); return end('not an image (http ' + r.statusCode + ' ' + type + ')'); }
                    var chunks = [], n = 0;
                    r.on('data', function (d) { n += d.length; if (n > MAX_IMG) { r.destroy(); end('image is larger than 3 MB'); } else { chunks.push(d); } });
                    r.on('end', function () { end(null, { type: type, buf: Buffer.concat(chunks) }); });
                    r.on('error', function () { end('download failed'); });
                });
                job.reqs.push(rq);
                rq.on('error', function (e) { end(str(e && e.code || e && e.message)); });
                rq.setTimeout(8000);
                rq.on('timeout', function () { end('timeout'); });
            } catch (e) { end('request failed'); }
        }
    }
    function abortFetches() {
        var w = waiting; waiting = [];
        running.slice().forEach(function (j) { j.end('stopped'); });
        w.forEach(function (x) { try { x.cb('stopped'); } catch (e) { /* ignore */ } });
    }

    // Sound: plays one of the TV's own system sounds. This Shard has the `exec` permission for exactly ONE command shape:
    //     paplay --volume=<integer> /usr/share/feedback/sound/operation/<one of the fixed files above>
    // The sound comes from a closed list and the volume is a clamped integer, so no text from a request ever reaches the command.
    // At most one sound every 0.8 s (a flood of requests cannot make the TV play a flood of sounds).
    function playSound(name, volume) {
        if (typeof name !== 'string' || !has(SOUND_FILES, name)) { return 'none'; }
        var now = Date.now();
        if (now - soundAt < SOUND_GAP_MS) { return 'skipped'; }
        soundAt = now;
        return execSound(name, volume, now);
    }
    // The only place that runs a command.
    function execSound(name, volume, now) {
        var v = Math.round(65536 * (volume >= 10 && volume <= 100 ? volume : 100) / 100 * settingsNow().soundVolume / 100 * SOUND_BOOST), job;
        try { job = ctx.execute('paplay --volume=' + v + ' ' + SOUND_DIR + SOUND_FILES[name], 8000); } catch (e) { soundLast = { at: now, ok: false, error: 'exec failed' }; return 'requested'; }
        if (!job || typeof job.then !== 'function') { soundLast = { at: now, ok: false, error: 'exec unavailable' }; return 'requested'; }
        job.then(function (r) {
            soundLast = r && r.exit_code ? { at: now, ok: false, error: 'paplay exit ' + r.exit_code + (r.stderr ? ': ' + str(r.stderr).slice(0, 120) : '') } : { at: now, ok: true };
        }, function (e) { soundLast = { at: now, ok: false, error: str(e && e.message).slice(0, 160) || 'exec failed' }; });
        return 'requested';
    }

    // Goodie: about 10 seconds of a well-known tune made only of the notification sounds. The sounds have fixed pitches, so the tunes are recognised by their
    // rhythm. The songs are fixed lists in the code (a request only picks a name), every step runs the same paplay command, one song at a time, at most 12 s.
    var songTimers = [], songEnd = null;
    function playSong(name) {
        if (!has(SONGS, name)) { return 'unknown'; }
        if (songEnd) { return 'busy'; }
        var steps = SONGS[name].steps, last = 0;
        steps.forEach(function (s) {
            last = s[0] > last ? s[0] : last;
            songTimers.push(setTimeout(function () { execSound(s[1], 100, Date.now()); }, Math.round(s[0] * songScale)));
        });
        songEnd = setTimeout(function () { songTimers = []; songEnd = null; }, Math.round((last + 2500) * songScale));
        return 'playing';
    }
    function stopSong() {
        songTimers.forEach(function (x) { clearTimeout(x); });
        songTimers = []; clearTimeout(songEnd); songEnd = null;
    }

    // The sound goes with the banner. The banner appears some seconds after the request (Vetro has to start the banner service) and the Shard cannot see
    // when: the service has no permission to write back. So the sound starts `soundDelayMs` after the request (a setting you tune by ear, with the test in the
    // Testing tab); if the banner service did record the id in the file the Shard can read (other TVs), the sound starts as soon as it is seen.
    // Full and both: the sound plays when the app screen asks for the queue. open:false notifications (never shown) play at once.
    function scheduleSound(note) {
        if (Object.keys(waitingSounds).length >= MAX_WAITING_SOUNDS) { return false; }
        var entry = { timer: null, done: false, fired: false }, started = Date.now();
        var fireAt = started + Math.min(settingsNow().soundDelayMs, soundWaitMs);
        var trace = { id: note.id, mode: note.mode, plannedMs: fireAt - started, startedMs: null, seenMs: null };
        soundTrace = trace;
        function fire() { if (!entry.fired) { entry.fired = true; trace.startedMs = Date.now() - started; playSound(note.sound, note.volume); } }
        function finish() { entry.done = true; clearTimeout(entry.timer); delete waitingSounds[note.id]; }
        entry.fire = function () { fire(); finish(); };
        waitingSounds[note.id] = entry;
        function shown() { try { return has(JSON.parse(fs.readFileSync(seenFile, 'utf8')), note.id); } catch (e) { return false; } }
        function tick() {
            if (entry.done) { return; }
            var now = Date.now();
            if (note.mode === 'banner') {
                if (shown()) { trace.seenMs = now - started; fire(); return finish(); }
                if (!entry.fired && now >= fireAt) { fire(); }
                if (now - started > soundWaitMs + 3000) { return finish(); }
            } else if (now - started >= soundWaitMs) { fire(); return finish(); }
            entry.timer = setTimeout(tick, SOUND_POLL_MS);
        }
        entry.timer = setTimeout(tick, SOUND_POLL_MS);
        return true;
    }
    function cancelSounds() { Object.keys(waitingSounds).forEach(function (id) { var e = waitingSounds[id]; e.done = true; clearTimeout(e.timer); }); waitingSounds = {}; }
    function soundAvailable() { return typeof ctx.execute === 'function'; }

    // Installation status for the panel: is the companion app (and its service) installed, is Vetro pairing on, which Shard version.
    function statusInfo(cb) {
        var out = { version: '', app: false, appVersion: '', service: false, pairing: 'unknown', handoff: false, sound: soundAvailable() }, left = 2;
        try { out.handoff = fs.existsSync(queueFile); } catch (e) { /* unknown */ }
        try { out.version = require('./manifest.json').version; } catch (e) { /* manifest not readable */ }
        function once() { var d = false; return function () { if (!d) { d = true; left -= 1; if (!left) { cb(out); } } }; }
        var d1 = once(), d2 = once();
        try {
            var rq = http.get({ host: VHOST, port: VPORT, path: '/apps', timeout: 5000 }, function (r) {
                var s = '';
                r.setEncoding('utf8');
                r.on('data', function (d) { s += d; if (s.length > 3000000) { r.destroy(); } });
                r.on('end', function () {
                    try {
                        var j = JSON.parse(s), list = Array.isArray(j) ? j : (j.apps || []), i;
                        for (i = 0; i < list.length; i++) {
                            if (list[i].appId === DEFAULT_APP) { out.app = true; out.appVersion = str(list[i].version); }
                            if (list[i].appId === SERVICE_APP) { out.service = true; }
                        }
                    } catch (e) { /* leave unknown */ }
                    d1();
                });
            });
            rq.on('error', d1);
            rq.setTimeout(5000);
            rq.on('timeout', function () { rq.destroy(); });
        } catch (e) { d1(); }
        // Pairing: ask this TV on its own LAN address without a key; 401 means pairing is on.
        var ip = null, ifs = os.networkInterfaces(), k, j2;
        for (k in ifs) { if (ifs.hasOwnProperty(k)) { for (j2 = 0; j2 < ifs[k].length; j2++) { if (ifs[k][j2].family === 'IPv4' && !ifs[k][j2].internal && !ip) { ip = ifs[k][j2].address; } } } }
        if (!ip) { return d2(); }
        try {
            var rq2 = http.get({ host: ip, port: 8099, path: '/plugins/notification-center/api/lang', timeout: 4000 }, function (r) {
                r.resume();
                out.pairing = r.statusCode === 401 ? 'on' : r.statusCode === 200 ? 'off' : 'unknown';
                d2();
            });
            rq2.on('error', d2);
            rq2.setTimeout(4000);
            rq2.on('timeout', function () { rq2.destroy(); });
        } catch (e) { d2(); }
    }

    function serveImage(req, res) {
        var m = /[?&]id=([^&]+)/.exec(String(req.url || '')), id = '', info = /[?&]info=1(&|$)/.test(String(req.url || '')), note = null, i;
        try { id = m ? decodeURIComponent(m[1]) : ''; } catch (e) { id = ''; }
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

    // Self-description of the API, built from the same constants that validate the requests, so it cannot drift from the code.
    // Keep it in step with API.md: every new field, mode or route is added in code, here, and in API.md together.
    function describe() {
        var ver = '';
        try { ver = require('./manifest.json').version; } catch (e) { /* manifest not readable */ }
        return {
            name: 'notification-center', version: ver, apiVersion: 1,
            base: '/plugins/notification-center/api/',
            auth: 'Same as the rest of Vetro: no key with pairing off; with pairing on, other devices send "Authorization: Bearer <key>". Shards on the same TV call http://127.0.0.1:8099 and need no key.',
            enums: { level: Object.keys(LEVELS), mode: Object.keys(MODES), sound: Object.keys(rules.SOUNDS) },
            limits: { title: MAX_TITLE, message: MAX_MESSAGE, queue: MAX_QUEUE, recent: MAX_RECENT, durationSeconds: [MIN_DURATION, MAX_DURATION], queueSeconds: [MIN_SECONDS, MAX_SECONDS], image: '3 MB, png/jpeg/gif/webp/bmp, http(s) URL up to 290 characters', relaunchAfterSeconds: MIN_RELAUNCH_MS / 1000 },
            fields: {
                message: { type: 'string', required: true, max: MAX_MESSAGE, note: 'The text of the notification.' },
                title: { type: 'string', max: MAX_TITLE },
                level: { type: 'string', enum: Object.keys(LEVELS), default: 'info', note: 'Colours the card and the panel; the native banner shows the level emoji.' },
                mode: { type: 'string', enum: Object.keys(MODES), default: 'banner', note: 'banner = native Samsung banner over the running app (no app switch); full = full-screen card; both = card and banner.' },
                duration: { type: 'integer', min: MIN_DURATION, max: MAX_DURATION, default: DEFAULT_DURATION, note: 'Seconds on screen.' },
                icon: { type: 'string', max: MAX_ICON, note: 'One emoji (or an emoji sequence) in front of the title; default by level. Cut at whole emoji, never in the middle of one.' },
                image: { type: 'url', note: 'http/https picture under the message on the full-screen card. The Shard fetches it.' },
                wallpaper: { type: 'url', note: 'http/https full-screen background behind the card. The Shard fetches it.' },
                seconds: { type: 'integer', min: MIN_SECONDS, max: MAX_SECONDS, default: DEFAULT_SECONDS, note: 'How long it waits in the queue (always at least duration + 20).' },
                open: { type: 'boolean', default: true, note: 'false only queues it, without launching the app or its service.' },
                sound: { type: 'string', enum: Object.keys(rules.SOUNDS), note: 'Plays one of the TV system sounds with the notification. Empty = no sound; one sound at most every 0.8 s. Not played for a notification held back by quiet hours or merged as a repeat.' },
                volume: { type: 'integer', min: 10, max: 100, default: 100, note: 'Volume of the sound, in percent.' },
                group: { type: 'boolean', default: true, note: 'false = never merge this notification with an identical recent one (the panel sends false for Resend and the test buttons). Merging only happens while the setting groupSeconds is above 0.' },
                source: { type: 'string', max: 32, note: 'Who is sending (a-z, 0-9, . _ -), or the header X-NC-Source. If a profile with that name exists, its icon, level, mode and duration fill in what you leave out, and its key (header X-NC-Key), enabled flag and rate limit apply.' }
            },
            endpoints: [
                { method: 'POST', path: 'notify', summary: 'Send a notification (JSON body with the fields above). With quiet hours it may answer {ok, id, suppressed}; a repeat inside the grouping window answers {ok, id, merged:true, count}.', returns: '{ok, id, open, sound}' },
                { method: 'POST', path: 'ntfy', summary: 'ntfy-compatible publish: body = message; headers Title, Priority (5 alert, 4 warning), Tags; or JSON {message,title,priority,tags}.', returns: '{ok, id, open}' },
                { method: 'GET', path: 'notifications', summary: 'The active queue (used by the app and its service); add ?js=1 for the script form.', returns: '{lang, notifications:[...]}' },
                { method: 'GET', path: 'recent', summary: 'The last notifications sent.', returns: '{recent:[...]}' },
                { method: 'GET', path: 'img?id=<id>[&kind=wallpaper][&info=1]', summary: 'The picture of a queued notification, fetched and served by the Shard; info=1 returns {ok,type,bytes}.', returns: 'image bytes or JSON' },
                { method: 'GET', path: 'status', summary: 'Installation status: companion app, its service, Vetro pairing, Shard version.', returns: '{version, app, appVersion, service, pairing, sound}' },
                { method: 'GET', path: 'lang', summary: 'Display language (en or pt).', returns: '{lang}' },
                { method: 'POST', path: 'lang', summary: 'Set the display language.', body: '{lang: "en"|"pt"}', returns: '{lang}' },
                { method: 'GET', path: 'profiles', summary: 'The sources (profiles): defaults per sender. Keys are never returned, only hasKey.', returns: '{profiles:{<source>:{enabled,icon,level,mode,duration,rate,hasKey}}, max}' },
                { method: 'POST', path: 'profiles', summary: 'Create, change or delete a source.', body: '{source, icon?, level?, mode?, duration?, rate? (per minute, 0 = no limit), enabled?, key? ("" clears), genKey? (true returns a new key once), delete?}', returns: '{ok, source, profile, key?}' },
                { method: 'GET', path: 'settings', summary: 'Quiet hours, grouping of repeats and strict mode.', returns: '{settings:{quiet:{enabled,from,to,allow},groupSeconds,strict,soundVolume,soundDelayMs}}' },
                { method: 'POST', path: 'settings', summary: 'Change those settings (send only what changes).', body: '{quiet?:{enabled,from:"22:00",to:"07:00",allow:"alert"|"warn"|"none"}, groupSeconds? (0 = off), strict? (true rejects unknown sources), soundVolume? (10-100 %, the volume of every sound, default 100), soundDelayMs? (0-10000, how long after the request the sound starts, default 3000)}', returns: '{ok, settings}' },
                { method: 'GET', path: 'hooks', summary: 'The webhooks (templates that turn any JSON into a notification).', returns: '{hooks, max, base}' },
                { method: 'POST', path: 'hooks', summary: 'Create, change or delete a webhook.', body: '{name, message (template), title?, level?, icon?, mode?, duration?, source?, delete?}; templates use {{a.b.0.c}} from the posted JSON', returns: '{ok, name, hook, url}' },
                { method: 'POST', path: 'hook/<name>', summary: 'Send any JSON (up to 64 KB) to a webhook; its templates build the notification. Non-JSON bodies are available as {{text}}.', returns: 'same as notify' },
                { method: 'POST', path: 'play', summary: 'Play one of the sounds without a notification, or a 10-second tune made of them (song). The sound volume setting applies. Answers 429 if another sound was played less than 0.8 s ago.', body: '{sound, volume?} or {song:"rock"|"fate"|"stop"}', returns: '{ok, sound:"requested"} or {ok, song:"playing"}' },
                { method: 'GET', path: 'sounds', summary: 'The sounds a request can choose, whether this Shard can play sounds (exec granted), the volume and timing settings, the timing of the last banner sound (trace) and the result of the last attempt.', returns: '{sounds:[...], songs:[{name,title}], available, volume, delayMs, trace, last}' },
                { method: 'GET', path: 'emoji', summary: 'The bundled emoji list used by the icon picker.', returns: '{source, groups, list}' },
                { method: 'GET', path: 'api', summary: 'This description.', returns: 'JSON' }
            ],
            docs: 'API.md in the Shard folder'
        };
    }

    // Hands the queue to the banner service through a file (world-readable: the service runs as another user). Written before the service is launched.
    // Written under a new name with 'wx' (fails if the name exists, never follows a planted symlink) and then renamed over the target,
    // so a symlink left at the target path is replaced, not written through.
    function writeQueueFile() {
        var tmp = queueFile + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), notifications: queue.map(function (n) {
                return { id: n.id, title: n.title, message: n.message, level: n.level, mode: n.mode, duration: n.duration, icon: n.icon, expires: n.expires };
            }) }), { mode: 420, flag: 'wx' });
            fs.renameSync(tmp, queueFile);
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to remove */ }
            /* /tmp not writable: the service falls back to asking the Shard over the network */
        }
    }

    // An emoji or emoji sequence of at most MAX_ICON UTF-16 units. It is cut only between whole characters (never inside a surrogate pair) and never
    // left ending on a joiner or variation selector that belonged to a sequence that did not fit.
    function cleanIcon(v) {
        var t = str(v).replace(/[\x00-\x1f]/g, '').replace(/^\s+|\s+$/g, ''), out = '', i = 0, step, c;
        while (i < t.length) {
            c = t.charCodeAt(i);
            step = (c >= 0xD800 && c <= 0xDBFF && i + 1 < t.length) ? 2 : 1;
            if (out.length + step > MAX_ICON) { break; }
            out += t.substr(i, step);
            i += step;
        }
        if (i < t.length) {
            while (out.length && /[\u200D\uFE0F]$/.test(out)) { out = out.slice(0, -1); }
        }
        return out;
    }

    // Image for the full-screen card: an http(s) URL only.
    function cleanUrl(u) { u = str(u).trim(); return /^https?:\/\/[^\s"'<>]{4,290}$/.test(u) ? u : ''; }

    // ntfy-compatible publish: POST .../ntfy with the message as the body (headers Title, Priority, Tags) or JSON {message,title,priority,tags}.
    var NTFY_TAGS = { warning: '\u26A0\uFE0F', rotating_light: '\uD83D\uDEA8', white_check_mark: '\u2705', heavy_check_mark: '\u2714\uFE0F', tada: '\uD83C\uDF89',
        fire: '\uD83D\uDD25', soccer: '\u26BD', bell: '\uD83D\uDD14', skull: '\uD83D\uDC80', house: '\uD83C\uDFE0', package: '\uD83D\uDCE6', sunny: '\u2600\uFE0F' };
    function handleNtfy(req, res) {
        readBody(req, guard(res, function (raw) {
            var b = {}, h = req.headers || {}, j = null, i, t;
            if (/json/i.test(str(h['content-type']))) { try { j = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); } }
            if (rules.isObj(j)) { b.message = j.message; b.title = j.title; } else { b.message = raw; j = null; }
            b.title = b.title || h.title || h.t;
            var p = j ? num(j.priority) : NaN, tags;
            if (!(p >= 0)) { p = num(str(h.priority || h.p)); }
            tags = j && j.tags != null ? j.tags : (h.tags || h.ta || '');
            // Never loop over something the sender controls: only a real array, or a comma list, and at most 10 entries.
            tags = (Array.isArray(tags) ? tags : str(tags).split(',')).slice(0, 10);
            b.level = p >= 5 ? 'alert' : p === 4 ? 'warn' : 'info';
            for (i = 0; i < tags.length; i++) {
                t = str(tags[i]).trim().toLowerCase();
                if (has(NTFY_TAGS, t)) {
                    b.icon = NTFY_TAGS[t];
                    if (t === 'rotating_light' || t === 'skull') { b.level = 'alert'; }
                    else if (t === 'warning' && b.level === 'info') { b.level = 'warn'; }
                    else if ((t === 'white_check_mark' || t === 'heavy_check_mark' || t === 'tada') && b.level === 'info') { b.level = 'ok'; }
                    break;
                }
            }
            b.sound = j ? j.sound : h.sound; b.volume = j ? j.volume : h.volume;
            submit(b, h, res);
        }));
    }

    function handleNotify(req, res) {
        readBody(req, guard(res, function (raw) {
            var b;
            try { b = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); }
            submit(b, req.headers || {}, res);
        }));
    }

    // Play a sound without a notification (the panel's sound tests; any app can use it too). Only names from the closed list.
    function handlePlay(req, res) {
        readBodyG(req, res, function (raw) {
            var b;
            try { b = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); }
            b = rules.isObj(b) ? b : {};
            if (b.song !== undefined) {
                if (b.song === 'stop') { stopSong(); return sendJson(res, 200, { ok: true, song: 'stopped' }); }
                if (!has(SONGS, b.song)) { return sendJson(res, 400, { error: 'song must be one of: ' + Object.keys(SONGS).join(', ') + ', stop' }); }
                var played = playSong(b.song);
                return sendJson(res, played === 'busy' ? 409 : 200, played === 'busy' ? { ok: false, error: 'a song is already playing (song: "stop" stops it)' } : { ok: true, song: played });
            }
            if (!has(rules.SOUNDS, b.sound)) { return sendJson(res, 400, { error: 'sound must be one of: ' + Object.keys(rules.SOUNDS).join(', ') }); }
            var st = playSound(b.sound, soundVolume(b.volume));
            sendJson(res, st === 'skipped' ? 429 : 200, st === 'skipped' ? { ok: false, error: 'too soon: one sound every 0.8 s' } : { ok: true, sound: st });
        });
    }

    // Webhook: POST hook/<name> with any JSON. The hook's templates turn it into a notification ({{a.b}} = that value of the posted JSON).
    function handleHook(req, res, rawName) {
        var name = rules.cleanHookName(rawName), hooks = cfgGet().hooks || {}, hook = name && has(hooks, name) ? hooks[name] : null;
        if (!hook) { return sendJson(res, 404, { error: 'no such hook' }); }
        readBody(req, guard(res, function (raw) {
            var data;
            try { data = JSON.parse(raw); } catch (e) { data = { text: raw }; }
            if (!data || typeof data !== 'object') { data = { text: raw }; }
            submit(rules.buildFromHook(hook, data), req.headers || {}, res, hook.source || name);
        }), MAX_HOOK_BODY);
    }

    // The one way into the queue: applies the source's profile (key, enabled, rate, defaults), then validates, then quiet hours and grouping.
    function submit(b, headers, res, forcedSource) {
        b = rules.isObj(b) ? b : {};
        {
            var settings = settingsNow(), profiles = cfgGet().profiles || {};
            var source = forcedSource || rules.cleanSource(b.source || headers['x-nc-source']);
            var profile = source && has(profiles, source) ? profiles[source] : null;
            if (settings.strict && !profile) { return sendJson(res, 403, { error: source ? 'unknown source' : 'source is required' }); }
            if (profile) {
                if (profile.enabled === false) { return sendJson(res, 403, { error: 'source is disabled' }); }
                if (profile.key && !rules.sameKey(headers['x-nc-key'] || b.key, profile.key)) { return sendJson(res, 403, { error: 'invalid key for this source' }); }
                if (!limiter(source, profile.rate, Date.now())) { return sendJson(res, 429, { error: 'rate limit for this source' }); }
            }
            b = rules.applyProfile(b, profile);
            var message = clean(b.message, MAX_MESSAGE);
            if (!message) { return sendJson(res, 400, { error: 'message is required' }); }
            var secs = num(b.seconds);
            if (!(secs >= MIN_SECONDS)) { secs = DEFAULT_SECONDS; }
            if (secs > MAX_SECONDS) { secs = MAX_SECONDS; }
            // duration = how long the notification stays on the TV screen (the app shows it, then returns to the previous app).
            var dur = num(b.duration);
            if (!(dur >= MIN_DURATION)) { dur = DEFAULT_DURATION; }
            if (dur > MAX_DURATION) { dur = MAX_DURATION; }
            if (secs < dur + 20) { secs = dur + 20; }
            prune();
            seq += 1;
            var note = {
                id: seq + '-' + Date.now().toString(36),
                title: clean(b.title, MAX_TITLE),
                icon: cleanIcon(b.icon),
                image: cleanUrl(b.image),
                wallpaper: cleanUrl(b.wallpaper),
                message: message,
                level: has(LEVELS, b.level) ? b.level : 'info',
                mode: has(MODES, b.mode) ? b.mode : 'banner',
                duration: dur,
                source: source,
                sound: has(rules.SOUNDS, b.sound) ? b.sound : '',
                volume: soundVolume(b.volume),
                expires: Date.now() + secs * 1000
            };
            var entry = { id: note.id, title: note.title, message: note.message, level: note.level, mode: note.mode, duration: note.duration, icon: note.icon, image: note.image, wallpaper: note.wallpaper, source: source, sound: note.sound, volume: note.volume, at: Date.now() };
            // Quiet hours: below the allowed level the notification is only recorded, never shown.
            if (rules.isQuiet(settings, note.level, new Date())) {
                entry.suppressed = true;
                recent.unshift(entry); if (recent.length > MAX_RECENT) { recent.pop(); } saveRecent();
                return sendJson(res, 200, { ok: true, id: note.id, suppressed: 'quiet hours' });
            }
            // Grouping: the same source, title, message and level within the window is counted, not shown again. It is skipped when it is off
            // (groupSeconds 0) and for a request that says group:false (the panel's Resend and test buttons). The map only holds entries younger than the window.
            if (settings.groupSeconds && b.group !== false) {
                var sig = [source, note.title, note.message, note.level].join(String.fromCharCode(1)), nowMs = Date.now(), g = has(groups, sig) ? groups[sig] : null, r;
                if (g && nowMs - g.at < settings.groupSeconds * 1000) {
                    g.count += 1;
                    for (r = 0; r < recent.length; r++) { if (recent[r].id === g.id) { recent[r].count = g.count; } }
                    saveRecent();
                    return sendJson(res, 200, { ok: true, id: g.id, merged: true, count: g.count });
                }
                groups[sig] = { at: nowMs, id: note.id, count: 1 };
                pruneGroups(nowMs, settings.groupSeconds * 1000);
            }
            queue.push(note);
            if (queue.length > MAX_QUEUE) { queue.shift(); }
            writeQueueFile();
            recent.unshift(entry);
            if (recent.length > MAX_RECENT) { recent.pop(); }
            saveRecent();
            var opened = b.open === false ? 'not requested' : openApp(note.mode === 'banner');
            // The sound is asked for only now: not for a notification held back by quiet hours or merged as a repeat.
            var soundState = 'none';
            if (note.sound) {
                if (b.open === false || soundWaitMs <= 0) { soundState = playSound(note.sound, note.volume); } else { soundState = scheduleSound(note) ? 'requested' : 'skipped'; }
            }
            sendJson(res, 200, { ok: true, id: note.id, open: opened, sound: soundState });
        }
    }

    // Sources (profiles), settings (quiet hours, grouping, strict) and webhooks are kept in ctx.config. Keys are never returned.
    function saveCfg(mut) { var c = cfgGet(); mut(c); ctx.config.set(c); }
    function handleProfiles(req, res) {
        if (req.method === 'GET') {
            var out = {}, ps = cfgGet().profiles || {};
            Object.keys(ps).forEach(function (k) { out[k] = rules.publicProfile(ps[k]); });
            return sendJson(res, 200, { profiles: out, max: rules.MAX_SOURCES });
        }
        readBodyG(req, res, function (raw) {
            var b, source, ps, p, genKey = '';
            try { b = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); }
            source = rules.cleanSource(b && b.source);
            if (!source) { return sendJson(res, 400, { error: 'source must be 1-32 characters: a-z, 0-9, . _ -' }); }
            ps = cfgGet().profiles || {};
            if (b.delete === true) { saveCfg(function (c) { c.profiles = c.profiles || {}; delete c.profiles[source]; }); return sendJson(res, 200, { ok: true, deleted: source }); }
            if (!has(ps, source) && Object.keys(ps).length >= rules.MAX_SOURCES) { return sendJson(res, 400, { error: 'at most ' + rules.MAX_SOURCES + ' sources' }); }
            if (b.genKey === true) { genKey = require('crypto').randomBytes(16).toString('hex'); b.key = genKey; }
            p = rules.sanitizeProfile(b, cleanIcon, has(ps, source) ? ps[source] : null);
            if (p.error) { return sendJson(res, 400, { error: p.error }); }
            saveCfg(function (c) { c.profiles = c.profiles || {}; c.profiles[source] = p; });
            sendJson(res, 200, genKey ? { ok: true, source: source, profile: rules.publicProfile(p), key: genKey } : { ok: true, source: source, profile: rules.publicProfile(p) });
        });
    }
    function handleSettings(req, res) {
        if (req.method === 'GET') { return sendJson(res, 200, { settings: settingsNow() }); }
        readBodyG(req, res, function (raw) {
            var b;
            try { b = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); }
            var s = rules.sanitizeSettings(b && b.settings || b, settingsNow());
            saveCfg(function (c) { c.settings = s; });
            sendJson(res, 200, { ok: true, settings: s });
        });
    }
    function handleHooks(req, res) {
        if (req.method === 'GET') { return sendJson(res, 200, { hooks: cfgGet().hooks || {}, max: rules.MAX_HOOKS, base: 'hook/<name>' }); }
        readBodyG(req, res, function (raw) {
            var b, name, hs;
            try { b = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); }
            name = rules.cleanHookName(b && b.name);
            if (!name) { return sendJson(res, 400, { error: 'name must be 1-24 characters: a-z, 0-9, -' }); }
            hs = cfgGet().hooks || {};
            if (b.delete === true) { saveCfg(function (c) { c.hooks = c.hooks || {}; delete c.hooks[name]; }); return sendJson(res, 200, { ok: true, deleted: name }); }
            if (!has(hs, name) && Object.keys(hs).length >= rules.MAX_HOOKS) { return sendJson(res, 400, { error: 'at most ' + rules.MAX_HOOKS + ' hooks' }); }
            var h = rules.sanitizeHook(b);
            if (!h.message) { return sendJson(res, 400, { error: 'message template is required' }); }
            saveCfg(function (c) { c.hooks = c.hooks || {}; c.hooks[name] = h; });
            sendJson(res, 200, { ok: true, name: name, hook: h, url: 'hook/' + name });
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
        stop: function () { abortFetches(); cancelSounds(); stopSong(); queue = []; writeQueueFile(); },
        status: function () { prune(); return { queued: queue.length, appId: appId() }; },
        route: function (req, res, sub) {
            sub = String(sub || '').split('?')[0].replace(/^\/+|\/+$/g, '');
            try {
            if (sub === 'ui' && req.method === 'GET') { sendFile(res, 'ui.html', 'text/html; charset=utf-8'); return true; }
            if (sub === 'api' && req.method === 'GET') { sendJson(res, 200, describe()); return true; }
            if (sub === 'status' && req.method === 'GET') { statusInfo(function (o) { sendJson(res, 200, o); }); return true; }
            if (sub === 'img' && req.method === 'GET') { serveImage(req, res); return true; }
            if (sub === 'ntfy' && req.method === 'POST') { handleNtfy(req, res); return true; }
            if (sub === 'play' && req.method === 'POST') { handlePlay(req, res); return true; }
            if (sub === 'sounds' && req.method === 'GET') { sendJson(res, 200, { sounds: Object.keys(rules.SOUNDS), songs: Object.keys(SONGS).map(function (k) { return { name: k, title: SONGS[k].title }; }), available: soundAvailable(), volume: settingsNow().soundVolume, delayMs: settingsNow().soundDelayMs, trace: soundTrace, last: soundLast }); return true; }
            if (sub === 'profiles' && (req.method === 'GET' || req.method === 'POST')) { handleProfiles(req, res); return true; }
            if (sub === 'settings' && (req.method === 'GET' || req.method === 'POST')) { handleSettings(req, res); return true; }
            if (sub === 'hooks' && (req.method === 'GET' || req.method === 'POST')) { handleHooks(req, res); return true; }
            if (/^hook\/[^\/]+$/.test(sub) && req.method === 'POST') { handleHook(req, res, sub.slice(5)); return true; }
            if (sub === 'emoji' && req.method === 'GET') { sendFile(res, 'emoji.json', 'application/json; charset=utf-8'); return true; }
            if (sub === 'nt.js' && req.method === 'GET') { sendFile(res, 'nt.js', 'application/javascript; charset=utf-8'); return true; }
            if (sub === 'notify' && req.method === 'POST') { handleNotify(req, res); return true; }
            if (sub === 'notifications' && req.method === 'GET') {
                if (/[?&]src=app(&|$)/.test(String(req.url || ''))) {
                    appPoll = /[?&]bye=1(&|$)/.test(String(req.url || '')) ? 0 : Date.now();
                    if (appPoll) { queue.forEach(function (n) { if (n.mode !== 'banner' && has(waitingSounds, n.id)) { waitingSounds[n.id].fire(); } }); }
                }
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
                readBodyG(req, res, function (raw) {
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
            } catch (e) { try { sendJson(res, 500, { error: 'internal error' }); } catch (e2) { /* the answer was already sent */ } return true; }
        }
    };
};
