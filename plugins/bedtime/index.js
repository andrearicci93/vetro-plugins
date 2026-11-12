'use strict';
// Bedtime: turn the TV off at set times or after a sleep timer, or open an app on a schedule.
// Commands (through ctx.execute, as root), the same ones Vetro itself uses:
//   /usr/bin/input_keyevent XF86PowerOff   a discrete "power off" key, never a toggle
//   app_launcher -s <appId>                open an app (the id is validated)
//   app_launcher -l                        list the installed apps, for the picker
// A rule fires at most once a day, within two minutes of its time; a time missed while the TV was off is not caught
// up later. The schedule uses the TV's local time. Plain ES5: older TVs run Node 4.4.
var fs = require('fs'), path = require('path');
var TICK_MS = 15000, WINDOW_MIN = 2, MAX_RULES = 20, MAX_LOG = 20, MAX_BODY = 16384, APPS_CACHE_MS = 300000;
var APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, TIME = /^([01]\d|2[0-3]):([0-5]\d)$/, RULE_ID = /^[a-z0-9]{1,16}$/;
var OFF = '/usr/bin/input_keyevent XF86PowerOff';

function pad(n) { return (n < 10 ? '0' : '') + n; }
function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

// Returns a clean rule or throws. days: 0 = Sunday … 6 = Saturday, as Date#getDay.
function validRule(r, i) {
    if (!r || typeof r !== 'object') throw new Error('Rule ' + (i + 1) + ' is not an object');
    var out = { id: RULE_ID.test(r.id || '') ? r.id : Math.random().toString(36).slice(2, 10), enabled: r.enabled !== false };
    if (!TIME.test(r.time || '')) throw new Error('Rule ' + (i + 1) + ': time must be HH:MM');
    out.time = r.time;
    if (!Array.isArray(r.days) || !r.days.length) throw new Error('Rule ' + (i + 1) + ': pick at least one day');
    var days = [];
    r.days.forEach(function (d) { if (d !== Math.floor(d) || d < 0 || d > 6) throw new Error('Rule ' + (i + 1) + ': invalid day'); if (days.indexOf(d) < 0) days.push(d); });
    out.days = days.sort();
    if (r.action === 'off') out.action = 'off';
    else if (r.action === 'launch') {
        if (!APP_ID.test(r.appId || '')) throw new Error('Rule ' + (i + 1) + ': invalid app');
        out.action = 'launch'; out.appId = r.appId;
        if (typeof r.appName === 'string') out.appName = r.appName.slice(0, 60);
    } else throw new Error('Rule ' + (i + 1) + ': action must be off or launch');
    return out;
}
function validRules(list) {
    if (!Array.isArray(list)) throw new Error('rules must be a list');
    if (list.length > MAX_RULES) throw new Error('At most ' + MAX_RULES + ' rules');
    return list.map(validRule);
}

// Which rules are due now: enabled, today is one of its days, now is within WINDOW_MIN minutes after its time, and
// it has not fired today.
function due(rules, lastFired, now) {
    var d = new Date(now), minutes = d.getHours() * 60 + d.getMinutes(), today = dayKey(d);
    return rules.filter(function (r) {
        if (!r.enabled || r.days.indexOf(d.getDay()) < 0 || lastFired[r.id] === today) return false;
        var m = TIME.exec(r.time), at = Number(m[1]) * 60 + Number(m[2]);
        return minutes >= at && minutes < at + WINDOW_MIN;
    });
}

// The next time each rule fires, for the page (searches the next 8 days).
function nextRun(r, now) {
    if (!r.enabled) return null;
    var m = TIME.exec(r.time);
    for (var i = 0; i < 8; i++) {
        var d = new Date(now); d.setDate(d.getDate() + i); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
        if (r.days.indexOf(d.getDay()) >= 0 && d.getTime() > now - WINDOW_MIN * 60000) return d.getTime();
    }
    return null;
}

function command(action) { return action.action === 'off' ? OFF : 'app_launcher -s ' + action.appId; }

function parseApps(out) {
    var apps = [], seen = {};
    String(out || '').split('\n').forEach(function (line) {
        var m = /^\s*'([^']*)'\s+'([^']+)'\s*$/.exec(line);
        if (m && APP_ID.test(m[2]) && !seen[m[2]]) { seen[m[2]] = true; apps.push({ name: m[1], appId: m[2] }); }
    });
    return apps.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
}

function json(res, body, code) {
    res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}
function readJson(req, cb) {
    var chunks = [], size = 0, done = false;
    req.on('data', function (c) { size += c.length; if (size > MAX_BODY) { if (!done) { done = true; cb(new Error('Request too large')); } return; } chunks.push(c); });
    req.on('end', function () { if (done) return; done = true; var p; try { p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return cb(new Error('Invalid JSON')); } if (!p || typeof p !== 'object' || Array.isArray(p)) return cb(new Error('Invalid JSON')); cb(null, p); });
    req.on('error', function (e) { if (!done) { done = true; cb(e); } });
}
// The page ships next to this file; a test harness may give an empty ctx.dir. start() never fails over it.
function loadPage(ctx) {
    var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
    for (var i = 0; i < places.length; i++) { try { return fs.readFileSync(places[i], 'utf8'); } catch (e) { /* next */ } }
    return '<!doctype html><meta charset="utf-8"><p>Page file missing: reinstall this Shard.</p>';
}

module.exports = function (ctx, deps) {
    deps = deps || {};
    var clock = deps.now || function () { return Date.now(); };
    var timer = null, page = null, apps = null, appsAt = 0, running = false;
    // config.json: { rules: [...], sleepAt: ms or null, lastFired: { ruleId: 'YYYY-MM-DD' }, log: [...] }
    function load() { try { var c = ctx.config.get(); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; } catch (e) { return {}; } }
    function save(c) { try { ctx.config.set(c); return true; } catch (e) { return false; } }
    function rules(c) { try { return validRules(c.rules || []); } catch (e) { return []; } }
    function log(c, entry) { c.log = (Array.isArray(c.log) ? c.log : []).concat([entry]).slice(-MAX_LOG); }
    function act(action, why) {
        return ctx.execute(command(action), 15000).then(function (r) {
            return { ok: r.exit_code === 0 && !r.timed_out, error: r.exit_code === 0 ? null : String(r.stderr || r.stdout || 'exit ' + r.exit_code).trim().slice(0, 200) };
        }, function (e) { return { ok: false, error: String(e && e.message || e) }; }).then(function (res) {
            var c = load();
            log(c, { at: clock(), why: why, action: action.action, appId: action.appId || null, ok: res.ok, error: res.error });
            save(c);
            return res;
        });
    }
    function tick() {
        if (running) return;
        var c = load(), now = clock(), work = [];
        if (typeof c.sleepAt === 'number' && now >= c.sleepAt) {
            c.sleepAt = null; save(c);
            work.push([{ action: 'off' }, 'sleep timer']);
        }
        var list = due(rules(c), c.lastFired || {}, now);
        if (list.length) {
            c = load(); c.lastFired = c.lastFired || {};
            list.forEach(function (r) { c.lastFired[r.id] = dayKey(new Date(now)); });
            save(c);
            // App launches before power off when both are due in the same minute.
            list.sort(function (a, b) { return (a.action === 'off') - (b.action === 'off'); });
            list.forEach(function (r) { work.push([r, 'rule ' + r.time]); });
        }
        if (!work.length) return;
        running = true;
        work.reduce(function (p, w) { return p.then(function () { return act(w[0], w[1]); }); }, Promise.resolve())
            .then(function () { running = false; }, function () { running = false; });
    }
    function state() {
        var c = load(), now = clock(), list = rules(c), d = new Date(now);
        return {
            now: now, tzOffsetMinutes: -d.getTimezoneOffset(),
            rules: list.map(function (r) { var o = JSON.parse(JSON.stringify(r)); o.next = nextRun(r, now); return o; }),
            sleepAt: typeof c.sleepAt === 'number' && c.sleepAt > now ? c.sleepAt : null,
            log: (Array.isArray(c.log) ? c.log : []).slice().reverse()
        };
    }
    function listApps() {
        if (apps && clock() - appsAt < APPS_CACHE_MS) return Promise.resolve(apps);
        return ctx.execute('app_launcher -l', 20000).then(function (r) {
            var list = parseApps(r.stdout);
            if (!list.length) throw new Error('App list unavailable');
            apps = list; appsAt = clock(); return list;
        });
    }
    return {
        start: function () { page = loadPage(ctx); timer = (deps.every || setInterval)(tick, TICK_MS); if (timer && timer.unref) timer.unref(); },
        stop: function () { (deps.clear || clearInterval)(timer); timer = null; page = null; },
        status: function () { var s = state(); return { rules: s.rules.length, sleepAt: s.sleepAt }; },
        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page || ''); return true; }
            if (sub === 'state' && req.method === 'GET') { json(res, state()); return true; }
            if (sub === 'apps' && req.method === 'GET') { listApps().then(function (l) { json(res, { apps: l }); }, function (e) { json(res, { ok: false, error: e.message }, 503); }); return true; }
            if (req.method !== 'POST' || ['rules', 'sleep', 'run', 'reset'].indexOf(sub) < 0) return false;
            readJson(req, function (err, p) {
                if (err) return json(res, { ok: false, error: err.message }, 400);
                if (sub === 'reset') {
                    // Back to a fresh install: no rules, no sleep timer, no history.
                    if (!save({})) return json(res, { ok: false, error: 'Reset could not be saved' }, 500);
                    return json(res, state());
                }
                var c = load();
                if (sub === 'rules') {
                    try { c.rules = validRules(p.rules); } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
                    // Saving does not make an edited rule fire again today if its new time already passed.
                    if (!save(c)) return json(res, { ok: false, error: 'Rules could not be saved' }, 500);
                    return json(res, state());
                }
                if (sub === 'sleep') {
                    if (p.minutes === null) c.sleepAt = null;
                    else if (p.minutes === Math.floor(p.minutes) && p.minutes >= 1 && p.minutes <= 600) c.sleepAt = clock() + p.minutes * 60000;
                    else return json(res, { ok: false, error: 'minutes must be 1–600, or null to cancel' }, 400);
                    if (!save(c)) return json(res, { ok: false, error: 'Sleep timer could not be saved' }, 500);
                    return json(res, state());
                }
                // run: try an action now from the page ("Test")
                var action;
                try { action = validRule({ time: '00:00', days: [0], action: p.action, appId: p.appId }, 0); } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
                act(action, 'test').then(function (r) { json(res, { ok: r.ok, error: r.error, state: state() }, r.ok ? 200 : 502); });
            });
            return true;
        }
    };
};
module.exports.validRules = validRules;
module.exports.due = due;
module.exports.nextRun = nextRun;
module.exports.parseApps = parseApps;
module.exports.command = command;
module.exports.OFF = OFF;
