'use strict';
// "Check Vetro setup": reads Vetro's own MQTT settings, remapper rules and remote-interception state and
// says, in plain words, why remote keys would not reach this Shard.
//
// It asks Vetro's HTTP service on the TV itself (127.0.0.1, no Origin header): Vetro lets programs on the
// TV use its API without pairing (docs/SIGN-IN.md). Read-only: GET /mqtt, GET /remap, GET /input. It runs
// only when someone presses the button, never on a timer: GET /input counts as "the Remote page is open",
// which would keep a forgotten "Start listening" from timing out.
//
// When Vetro runs a remote-key rule (app/service/main.js, physical input handler): only while Remote
// interception is on (mode "filter", helper connected), only for a key that interception blocked
// (decision "blocked"), and only on key down. A key seen while "Start listening" is active does not run
// rules, and listening pauses interception until it is stopped.
// Plain ES5.

var http = require('http');
var path = require('path');

var TIMEOUT_MS = 15000;   // the whole request; Vetro answers /input after a root command, which can queue
var MAX_RESPONSE = 2097152;
var LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
// The key names Vetro reports for the keys this Shard needs (from the remote's evdev key map).
var KEY_ACTION = { XF86AudioRaiseVolume: 'volume-up', XF86AudioLowerVolume: 'volume-down', XF86AudioMute: 'mute-toggle' };

// Vetro's port: VETRO_PORT, else the port its package was built with, else 8099 (app/service/main.js).
function vetroPort() {
    var env = Number(process.env.VETRO_PORT);
    if (env > 0 && env < 65536) return env;
    try {
        var main = require.main && require.main.filename;
        if (main) {
            var info = require(path.join(path.dirname(main), 'build-info.js'));
            if (info && info.port > 0 && info.port < 65536) return Number(info.port);
        }
    } catch (e) { /* not inside Vetro, or no build-info */ }
    return 8099;
}

function getJson(port, route) {
    return new Promise(function (resolve, reject) {
        var done = false, timer = null, req;
        function fail(e) { if (!done) { done = true; if (timer) clearTimeout(timer); reject(e); } }
        try {
            req = http.request({ host: '127.0.0.1', port: port, path: route, method: 'GET', agent: false,
                headers: { 'Accept': 'application/json', 'Connection': 'close' } }, function (res) {
                var chunks = [], size = 0;
                res.on('error', fail);
                res.on('data', function (c) {
                    size += c.length;
                    if (size > MAX_RESPONSE) { fail(new Error(route + ': answer too large')); res.destroy(); return; }
                    chunks.push(c);
                });
                res.on('end', function () {
                    if (done) return;
                    var text = Buffer.concat(chunks).toString('utf8'), body;
                    try { body = JSON.parse(text); } catch (e) { fail(new Error(route + ': not JSON (HTTP ' + res.statusCode + ')')); return; }
                    if (res.statusCode !== 200) { fail(new Error(route + ': ' + (body && body.error || 'HTTP ' + res.statusCode))); return; }
                    done = true;
                    if (timer) clearTimeout(timer);
                    resolve(body);
                });
            });
        } catch (e) { fail(e); return; }
        req.on('error', function (e) { fail(new Error('Cannot reach Vetro on port ' + port + ' (' + (e.code || e.message) + ')')); });
        // A timer for the whole request: req.setTimeout() does not cover connecting on Node 12 (see sonos.js).
        timer = setTimeout(function () {
            timer = null;
            fail(new Error(route + ': Vetro did not answer in time'));
            if (typeof req.destroy === 'function') req.destroy(); else req.abort();
        }, TIMEOUT_MS);
        req.end();
    });
}

// Each part is read separately, so one failure does not hide the others.
function read(port) {
    function part(route) {
        return getJson(port, route).then(function (body) { return { ok: true, body: body }; },
            function (e) { return { ok: false, error: String(e && e.message || e) }; });
    }
    return Promise.all([part('/mqtt'), part('/remap'), part('/input')]).then(function (r) {
        return { port: port, mqtt: r[0], remap: r[1], input: r[2] };
    });
}

function item(level, title, detail) { return { level: level, title: title, detail: detail || '' }; }

function describeTrigger(t) {
    if (!t) return 'no trigger';
    if (t.type === 'physical') return 'remote key ' + t.value;
    if (t.type === 'mqtt') return 'MQTT message on "' + t.value + '"';
    if (t.type === 'http') return 'HTTP trigger "' + t.value + '"';
    return t.type + ' "' + t.value + '"';
}

// data: the result of read(). cfg: { brokerPort, topicPrefix, username }. wanted: [{ action, topic, key, required }].
// Returns { level: 'ok'|'warn'|'bad', items: [...], keys: [...recent key events], codes: { action: code } }.
function analyze(data, cfg, wanted) {
    var items = [], codes = {}, physicalCodes = [];

    // 1. MQTT link.
    if (!data.mqtt.ok) items.push(item('bad', 'Could not read Vetro’s MQTT settings', data.mqtt.error));
    else {
        var c = data.mqtt.body.config || {}, st = data.mqtt.body.status || {};
        var hostOk = LOCAL_HOSTS.indexOf(String(c.host || '').toLowerCase()) >= 0;
        if (c.enabled === false || !c.host) items.push(item('bad', 'Vetro’s MQTT link is switched off', 'In Vetro’s MQTT page set broker 127.0.0.1, port ' + cfg.brokerPort + ', enable it and save.'));
        else if (!hostOk) items.push(item('bad', 'Vetro’s MQTT link points at ' + c.host, 'This Shard only listens on the TV itself: set the broker to 127.0.0.1.'));
        else if (Number(c.port) !== cfg.brokerPort) items.push(item('bad', 'Vetro’s MQTT link uses port ' + c.port, 'This Shard listens on port ' + cfg.brokerPort + '.'));
        else if (c.tls) items.push(item('bad', 'TLS is on in Vetro’s MQTT settings', 'This Shard does not speak TLS: switch it off.'));
        else if (!data.mqtt.body.connected) items.push(item('bad', 'Vetro’s MQTT link is not connected', st.lastError ? 'Vetro says: ' + st.lastError : 'It retries every 10 seconds.'));
        else items.push(item('ok', 'Vetro’s MQTT link is connected to this Shard', '127.0.0.1:' + c.port));
    }

    // 2. Rules.
    if (!data.remap.ok) items.push(item('bad', 'Could not read Vetro’s rules', data.remap.error));
    else {
        var rules = Array.isArray(data.remap.body.rules) ? data.remap.body.rules : [];
        var ours = {}, used = {};
        wanted.forEach(function (w) { ours[w.topic] = w; });
        rules.forEach(function (r) {
            (r.actions || []).forEach(function (a) {
                if (!a || a.type !== 'mqtt') return;
                var w = ours[a.topic];
                if (!w) {
                    // A message to a topic this Shard does not know: probably a typo.
                    if (/sonos|volume|mute/i.test(a.topic)) {
                        items.push(item('bad', 'A rule publishes to "' + a.topic + '"', 'That is not one of this Shard’s topics (' + describeTrigger(r.trigger) +
                            '). Use exactly: ' + wanted.filter(function (x) { return x.required; }).map(function (x) { return x.topic; }).join(', ') + '.'));
                    }
                    return;
                }
                used[w.topic] = true;
                if (r.enabled === false) { items.push(item('warn', 'The rule for ' + w.key + ' is switched off', describeTrigger(r.trigger) + ' → ' + a.topic)); return; }
                if (!r.trigger || r.trigger.type !== 'physical') {
                    items.push(item('bad', 'The rule for ' + w.key + ' is not triggered by a remote key',
                        'It runs on ' + describeTrigger(r.trigger) + '. Delete it and add it again with trigger type “Physical key” and the key code.'));
                    return;
                }
                codes[w.action] = r.trigger.value;
                physicalCodes.push(String(r.trigger.value));
                items.push(item('ok', w.key + ': remote key ' + r.trigger.value + ' → ' + a.topic));
            });
        });
        wanted.forEach(function (w) {
            if (w.required && !used[w.topic]) items.push(item('bad', 'No rule for ' + w.key, 'Add a rule: trigger type “Physical key”, the key’s code, action “Publish MQTT message” to ' + w.topic + '.'));
        });
    }

    // 3. Remote interception.
    var keys = [];
    if (!data.input.ok) items.push(item('bad', 'Could not read Vetro’s remote settings', data.input.error));
    else {
        var s = data.input.body.status || {}, policy = s.policy || {}, pref = s.preference || {};
        var err = data.input.body.error || s.error;
        keys = (s.events || []).filter(function (e) { return e && e.action === 'down'; }).slice(-8).reverse().map(function (e) {
            return { code: e.code, key: e.key || '', decision: e.decision || '', mode: e.mode || policy.mode || '' };
        });
        // A rule whose code is not the one the remote sends for that key (e.g. volume down set up as 69 while
        // the remote sends 67). Vetro names the keys it sees, so the codes can be checked against them. Only
        // flagged when no press of that key carried the rule's code: another remote may send other codes.
        var seen = {};
        (s.events || []).forEach(function (e) {
            if (!e || e.action !== 'down' || !KEY_ACTION[e.key]) return;
            var a = KEY_ACTION[e.key], list = seen[a] || (seen[a] = []);
            if (!list.some(function (x) { return x.code === String(e.code); })) list.push({ code: String(e.code), key: e.key, device: e.device || '' });
        });
        wanted.forEach(function (w) {
            var list = seen[w.action];
            if (!list || codes[w.action] == null) return;
            var ruleCode = String(codes[w.action]);
            if (list.some(function (x) { return x.code === ruleCode; })) return;
            items.push(item('bad', 'The rule for ' + w.key + ' uses key ' + ruleCode + ', but your remote sends ' + list.map(function (x) { return x.code; }).join(' or '),
                'Vetro saw ' + list[0].key + ' as key ' + list[0].code + (list[0].device ? ' on ' + list[0].device : '') +
                '. In the MQTT page, change that rule’s key code to ' + list[0].code + ' (trigger type Physical key) and save.'));
        });
        if (policy.mode === 'observe') {
            items.push(item('bad', 'Vetro is listening to the remote', 'Listening (Remote page) pauses interception, so no rule runs. Select “Stop listening”.'));
        } else if (!pref.enabled) {
            items.push(item('bad', 'Remote interception is off', 'In Vetro’s Remote page, first choose your remote in the device menu (not “Detect automatically”, which only listens), then turn on “Remote interception”. Without it, rules for remote keys never run.'));
        } else if (policy.mode !== 'filter' || !policy.connected) {
            items.push(item('bad', 'Remote interception is on but not running', err ? 'Vetro says: ' + err + (/queue|MQTT|disconnected|failed/i.test(err) ? ' (after a failed action Vetro gives the keys back to the TV for a minute)' : '') : 'Vetro restarts it within a few seconds; check again.'));
        } else {
            var blocked = (policy.blocked || []).map(String);
            var missing = physicalCodes.filter(function (code) { return blocked.indexOf(code) < 0; });
            if (missing.length) items.push(item('warn', 'Interception does not include key ' + missing.join(', ') + ' yet', 'Vetro restarts interception a few seconds after rules are saved; check again.'));
            else items.push(item('ok', 'Remote interception is running', (policy.device || '') + (blocked.length ? ' · keys ' + blocked.join(', ') : '')));
            var passed = keys.filter(function (k) { return k.mode === 'filter' && k.decision === 'native' && physicalCodes.indexOf(String(k.code)) >= 0; });
            if (passed.length) items.push(item('warn', 'Key ' + passed[0].code + ' went to the TV', 'Pressed before interception included it, or by another remote.'));
        }
        if (pref.enabled && pref.device && policy.device && pref.device !== policy.device && policy.mode === 'filter') {
            items.push(item('warn', 'Interception runs on ' + policy.device, 'The saved remote is ' + pref.device + '.'));
        }
    }

    var level = items.some(function (i) { return i.level === 'bad'; }) ? 'bad' : items.some(function (i) { return i.level === 'warn'; }) ? 'warn' : 'ok';
    return { level: level, items: items, keys: keys, codes: codes, at: Date.now(), port: data.port };
}

module.exports = { read: read, analyze: analyze, vetroPort: vetroPort };
