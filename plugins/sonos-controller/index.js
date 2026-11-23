'use strict';
// Sonos controller: a Vetro Shard that turns remote-control key presses into Sonos volume and mute.
//
//   remote key -> Vetro remapper rule "Publish MQTT message" -> this Shard's MQTT receiver (127.0.0.1)
//              -> SOAP request to the Sonos speaker on the LAN (port 1400)
//
// Vetro gives a Shard no way to see key presses, but its rules can publish an MQTT message for a key, and
// its MQTT link can point at any broker. This Shard is that broker, cut down to receiving.
// Command topics: <prefix>/volume-up, volume-down, mute-toggle, mute, unmute (prefix vetro/sonos by default).
//
// Plain ES5, as the Vetro Shard guide asks (older TVs run Node 4.4). Every socket, timer and promise here
// handles its own errors: Vetro only guards start/stop/status/route, and an uncaught error elsewhere
// would stop the Shard or the whole Vetro service.

var fs = require('fs');
var path = require('path');
var Receiver = require('./mqtt-receiver.js').Receiver;
var sonos = require('./sonos.js');
var discovery = require('./discovery.js');
var vetroCheck = require('./vetro-check.js');

var VERSION = '0.2.4';
var ACTIONS = ['volume-up', 'volume-down', 'mute-toggle', 'mute', 'unmute'];
var DEFAULTS = {
    speaker: null,            // { uuid, name, address } of the room the remote controls
    target: 'room',           // 'room': that room only; 'group': every room grouped with it
    step: 2,                  // volume change per key press (Sonos scale 0-100)
    maxVolume: 100,           // volume up stops here; 100 = no limit
    unmuteOnVolume: true,     // a volume key also unmutes, like a TV
    brokerPort: 1883,         // where Vetro's MQTT link connects (127.0.0.1)
    topicPrefix: 'vetro/sonos',
    username: '',             // optional: require this user name and password from Vetro
    password: ''
};
var PREFIX_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
var KEY_NAMES = { 'volume-up': 'Volume up', 'volume-down': 'Volume down', 'mute-toggle': 'Mute', 'mute': 'Mute only', 'unmute': 'Unmute' };
var REQUIRED = ['volume-up', 'volume-down', 'mute-toggle'];
var UUID_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
var MAX_QUEUE = 16, MAX_LOG = 40, MAX_BODY = 16384, TOPOLOGY_TTL_MS = 30000;
var STALE_MS = 3000;          // a key press still waiting after this long is dropped, not applied late
var LOOKUP_TIMEOUT_MS = 2500, SEARCH_WINDOW_MS = 2500;

function noop() {}

function isInt(v, min, max) {
    return typeof v === 'number' && v === Math.floor(v) && v >= min && v <= max;
}

// Merges an update into the previous settings. Throws an Error whose message is shown to the user.
function validateSettings(input, previous) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object');
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = previous[k]; });
    function has(k) { return Object.prototype.hasOwnProperty.call(input, k); }

    if (has('speaker')) {
        var s = input.speaker;
        if (s === null) out.speaker = null;
        else {
            if (!s || typeof s !== 'object') throw new Error('Choose a speaker');
            var address = sonos.formatAddress(sonos.parseAddress(s.address));
            if (s.uuid != null && (typeof s.uuid !== 'string' || !UUID_RE.test(s.uuid))) throw new Error('Invalid speaker id');
            if (s.name != null && (typeof s.name !== 'string' || s.name.length > 64)) throw new Error('Invalid speaker name');
            out.speaker = { uuid: s.uuid || null, name: s.name || address, address: address };
        }
    }
    if (has('target')) {
        if (input.target !== 'room' && input.target !== 'group') throw new Error('Target must be room or group');
        out.target = input.target;
    }
    if (has('step')) {
        if (!isInt(input.step, 1, 10)) throw new Error('Step must be a whole number from 1 to 10');
        out.step = input.step;
    }
    if (has('maxVolume')) {
        if (!isInt(input.maxVolume, 1, 100)) throw new Error('Maximum volume must be a whole number from 1 to 100');
        out.maxVolume = input.maxVolume;
    }
    if (has('unmuteOnVolume')) {
        if (typeof input.unmuteOnVolume !== 'boolean') throw new Error('unmuteOnVolume must be true or false');
        out.unmuteOnVolume = input.unmuteOnVolume;
    }
    if (has('brokerPort')) {
        if (!isInt(input.brokerPort, 1, 65535)) throw new Error('Port must be a whole number from 1 to 65535');
        out.brokerPort = input.brokerPort;
    }
    if (has('topicPrefix')) {
        if (typeof input.topicPrefix !== 'string' || input.topicPrefix.length > 100 || !PREFIX_RE.test(input.topicPrefix)) {
            throw new Error('Topic prefix: letters, digits, . _ - and / between levels, up to 100 characters');
        }
        out.topicPrefix = input.topicPrefix;
    }
    if (has('username')) {
        if (typeof input.username !== 'string' || input.username.length > 64) throw new Error('User name: up to 64 characters');
        out.username = input.username;
    }
    if (has('password')) {
        if (typeof input.password !== 'string' || input.password.length > 128) throw new Error('Password: up to 128 characters');
        out.password = input.password;
    }
    if (!out.username) out.password = '';
    return out;
}

// What is saved may be from an older version or edited by hand: keep what is valid, default the rest.
function normalize(stored) {
    var out = validateSettings({}, DEFAULTS);
    if (!stored || typeof stored !== 'object') return out;
    Object.keys(DEFAULTS).forEach(function (k) {
        if (!Object.prototype.hasOwnProperty.call(stored, k)) return;
        var one = {};
        one[k] = stored[k];
        try { out = validateSettings(one, out); } catch (e) { /* keep the default */ }
    });
    return out;
}

function publicSettings(cfg) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { if (k !== 'password') out[k] = cfg[k]; });
    out.hasPassword = !!cfg.password;
    return out;
}

function isVolume(action) { return action === 'volume-up' || action === 'volume-down'; }

function unique(list) {
    var seen = {}, out = [];
    list.forEach(function (x) { if (x && !seen[x]) { seen[x] = true; out.push(x); } });
    return out;
}

module.exports = function (ctx) {
    var cfg = normalize(null);
    var running = false, receiver = null, search = null;
    var queue = [], busy = false;
    var topo = null;                       // { at, data } from the last GetZoneGroupState
    var log = [];
    var state = { volume: null, muted: null, readAt: null, lastCommand: null, lastError: null, commands: 0 };
    var remote = { presses: 0, lastAt: null, lastTopic: null, ignored: 0, lastIgnored: null };
    var lastCheck = null, checking = null;

    function note(level, text) {
        log.push({ at: Date.now(), level: level, text: String(text).slice(0, 300) });
        if (log.length > MAX_LOG) log.shift();
    }

    function save() {
        try { ctx.config.set(cfg); } catch (e) { note('error', 'Could not save the settings: ' + e.message); }
    }

    // ---- MQTT receiver -------------------------------------------------------------------------------

    function startReceiver() {
        stopReceiver();
        receiver = new Receiver({
            port: cfg.brokerPort,
            host: '127.0.0.1',
            username: cfg.username || null,
            password: cfg.password || null,
            onMessage: onMessage,
            onEvent: function (type, text) { note(type === 'error' ? 'error' : 'info', text); }
        });
        receiver.start();
    }

    function stopReceiver() {
        if (receiver) receiver.stop();
        receiver = null;
    }

    // Vetro's own traffic: telemetry and availability under <prefix>/<its client id>/..., and Home Assistant
    // discovery records. Everything else that is not a command is most likely a mistyped rule topic: say so.
    function isVetroTraffic(msg) {
        if (msg.topic.indexOf('homeassistant/') === 0) return true;
        var identity = encodeURIComponent(msg.clientId || '').replace(/%/g, '_');
        var parts = msg.topic.split('/');
        return !!identity && parts.length >= 3 && parts[1] === identity;
    }

    function ignore(msg, why) {
        remote.ignored++;
        remote.lastIgnored = { topic: msg.topic, at: Date.now(), why: why };
        note('warn', 'Ignored a message on ' + msg.topic + ': ' + why);
    }

    function onMessage(msg) {
        var prefix = cfg.topicPrefix + '/';
        if (msg.topic.indexOf(prefix) !== 0) {
            if (!isVetroTraffic(msg)) ignore(msg, 'not a command topic (they start with ' + prefix + ')');
            return;
        }
        var action = msg.topic.slice(prefix.length);
        if (ACTIONS.indexOf(action) < 0) { ignore(msg, 'unknown command'); return; }
        if (msg.retained) { ignore(msg, 'retained messages are not key presses'); return; }
        remote.presses++;
        remote.lastAt = Date.now();
        remote.lastTopic = msg.topic;
        enqueue(action, 'remote');
    }

    // ---- Finding the speaker -------------------------------------------------------------------------

    // Asks each address in turn; resolves to { at, data, from } for the first that answers, or null.
    function firstTopology(addresses) {
        var i = 0;
        function next() {
            if (i >= addresses.length) return Promise.resolve(null);
            var text = addresses[i++], address;
            try { address = sonos.parseAddress(text); } catch (e) { return next(); }
            return sonos.getTopology(address, LOOKUP_TIMEOUT_MS).then(function (data) {
                return { at: Date.now(), data: data, from: text };
            }, function () { return next(); });
        }
        return next();
    }

    function discoverAddresses() {
        if (search) search.cancel();
        var mine = discovery.search(SEARCH_WINDOW_MS);
        search = mine;
        return mine.promise.then(function (found) {
            if (search === mine) search = null;
            return found.map(sonos.formatAddress);
        });
    }

    // The rooms and groups, cached for 30 s. force: the speaker did not answer, so ask every other player
    // we know of first and finally search the network.
    function topology(force) {
        if (!force && topo && Date.now() - topo.at < TOPOLOGY_TTL_MS) return Promise.resolve(topo.data);
        var own = cfg.speaker ? cfg.speaker.address : null;
        // The player that answered last time first, then the other rooms we know of.
        var known = topo ? [topo.from].concat(topo.data.rooms.map(function (r) { return r.address; })) : [];
        var order = force ? unique(known.filter(function (a) { return a !== own; }).concat([own])) : unique([own].concat(known));
        return firstTopology(order).then(function (found) {
            if (found || !force) return found;
            return discoverAddresses().then(function (list) {
                return firstTopology(list.filter(function (a) { return order.indexOf(a) < 0; }));
            });
        }).then(function (found) {
            if (!found) throw new Error('No Sonos speaker answered');
            topo = found;
            return found.data;
        });
    }

    function findRoom(data, uuid) {
        for (var i = 0; i < data.rooms.length; i++) if (data.rooms[i].uuid === uuid) return data.rooms[i];
        return null;
    }

    // -> { address, mode, name }: where to send the next command.
    function resolveTarget(force) {
        if (!cfg.speaker) return Promise.reject(new Error('Choose a speaker in the Sonos tab first'));
        var speaker = cfg.speaker;
        if (!force && cfg.target === 'room') {
            return Promise.resolve({ address: sonos.parseAddress(speaker.address), mode: 'room', name: speaker.name });
        }
        if (!speaker.uuid) {
            if (force) return Promise.reject(new Error('The speaker at ' + speaker.address + ' does not answer'));
            return Promise.reject(new Error('Look the speaker up again in the Sonos tab to control its group'));
        }
        return topology(force).then(function (data) {
            var room = findRoom(data, speaker.uuid);
            if (!room) throw new Error('The room ' + speaker.name + ' is not in the Sonos system any more');
            if (room.address !== speaker.address || room.name !== speaker.name) {
                note('info', room.name + ' is now at ' + room.address);
                cfg.speaker = { uuid: room.uuid, name: room.name, address: room.address };
                save();
            }
            if (cfg.target === 'group') {
                var coordinator = findRoom(data, room.coordinator) || room;
                return { address: sonos.parseAddress(coordinator.address), mode: 'group', name: room.name };
            }
            return { address: sonos.parseAddress(room.address), mode: 'room', name: room.name };
        });
    }

    // Runs fn(address, mode); if the speaker cannot be reached, finds it again and retries once.
    function withSpeaker(fn) {
        return resolveTarget(false).then(function (t) {
            return fn(t.address, t.mode).then(null, function (e) {
                if (!e || !e.network) throw e;
                note('warn', e.message + '; looking for the speaker again');
                return resolveTarget(true).then(function (t2) {
                    if (t2.address.host === t.address.host && t2.address.port === t.address.port) throw e;
                    return fn(t2.address, t2.mode);
                });
            });
        });
    }

    // ---- Commands --------------------------------------------------------------------------------------

    function nextVolume(current, delta) {
        if (delta > 0) return current >= cfg.maxVolume ? current : Math.min(current + delta, cfg.maxVolume);
        return Math.max(0, current + delta);
    }

    function changeVolume(delta) {
        var unmute = cfg.unmuteOnVolume;
        return withSpeaker(function (address, mode) {
            return sonos.getVolume(address, mode).then(function (current) {
                return (unmute ? sonos.getMute(address, mode) : Promise.resolve(null)).then(function (muted) {
                    var target = nextVolume(current, delta);
                    var set = target !== current ? sonos.setVolume(address, mode, target) : Promise.resolve(current);
                    return set.then(function (volume) {
                        if (muted) return sonos.setMute(address, mode, false).then(function () { return { volume: volume, muted: false }; });
                        return { volume: volume, muted: muted };
                    });
                });
            });
        });
    }

    function changeMute(action) {
        return withSpeaker(function (address, mode) {
            var wanted = action === 'mute' ? Promise.resolve(true)
                : action === 'unmute' ? Promise.resolve(false)
                    : sonos.getMute(address, mode).then(function (m) { return !m; });
            return wanted.then(function (m) { return sonos.setMute(address, mode, m); }).then(function (m) { return { muted: m }; });
        });
    }

    function readState() {
        return withSpeaker(function (address, mode) {
            return sonos.getVolume(address, mode).then(function (volume) {
                return sonos.getMute(address, mode).then(function (muted) { return { volume: volume, muted: muted }; });
            });
        });
    }

    function remember(result) {
        if (result && typeof result.volume === 'number') state.volume = result.volume;
        if (result && typeof result.muted === 'boolean') state.muted = result.muted;
        state.readAt = Date.now();
        state.lastError = null;
    }

    function snapshot(ok, error) {
        return { ok: ok, error: error || null, volume: state.volume, muted: state.muted };
    }

    // Commands run one at a time. Volume presses that arrive while one is running are added together, so a
    // burst of presses becomes one change instead of a backlog.
    function enqueue(action, source) {
        return new Promise(function (resolve) {
            if (!running) { resolve(snapshot(false, 'The Sonos controller is not running')); return; }
            if (queue.length >= MAX_QUEUE) queue.shift().resolve(snapshot(false, 'Too many commands at once'));
            queue.push({ action: action, source: source, resolve: resolve, at: Date.now() });
            pump();
        });
    }

    // Presses that waited too long (a slow or missing speaker) are dropped: applied late they would land
    // all at once, many seconds after the person pressed.
    function dropStale() {
        var now = Date.now(), dropped = 0;
        while (queue.length && now - queue[0].at > STALE_MS) {
            dropped++;
            queue.shift().resolve(snapshot(false, 'Dropped: waited too long for the speaker'));
        }
        if (dropped) note('warn', 'Dropped ' + dropped + ' key press' + (dropped > 1 ? 'es' : '') + ' that waited too long');
    }

    function pump() {
        if (busy || !running) return;
        dropStale();
        if (!queue.length) return;
        busy = true;
        var batch = [queue.shift()], first = batch[0].action;
        if (isVolume(first)) while (queue.length && isVolume(queue[0].action)) batch.push(queue.shift());
        var delta = 0;
        batch.forEach(function (c) { if (c.action === 'volume-up') delta += cfg.step; if (c.action === 'volume-down') delta -= cfg.step; });
        var label = batch.length > 1 ? first + ' x' + batch.length : first, started = Date.now(), work;
        try { work = isVolume(first) ? changeVolume(delta) : changeMute(first); } catch (e) { work = Promise.reject(e); }
        work.then(function (result) {
            remember(result);
            state.commands += batch.length;
            state.lastCommand = { action: label, source: batch[0].source, ok: true, at: Date.now(), ms: Date.now() - started };
            note('info', label + ' from ' + batch[0].source + ': volume ' + state.volume + (state.muted ? ', muted' : ''));
            return snapshot(true);
        }, function (e) {
            var message = String(e && e.message || e);
            state.lastError = message;
            state.lastCommand = { action: label, source: batch[0].source, ok: false, at: Date.now(), error: message };
            note('error', label + ' failed: ' + message);
            return snapshot(false, message);
        }).then(function (result) {
            busy = false;
            batch.forEach(function (c) { try { c.resolve(result); } catch (e) { /* nothing to do */ } });
            pump();
        }).then(null, noop);
    }

    // ---- HTTP routes (/plugins/sonos-controller/api/<sub>) ---------------------------------------------

    function json(res, body, code) {
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }

    function readBody(req, cb) {
        var chunks = [], size = 0, done = false;
        function finish(err, value) { if (!done) { done = true; cb(err, value); } }
        req.on('error', function (e) { finish(e); });
        req.on('data', function (c) {
            size += c.length;
            if (size > MAX_BODY) { finish(new Error('Request too large')); return; }
            chunks.push(c);
        });
        req.on('end', function () {
            var text = Buffer.concat(chunks).toString('utf8');
            if (!text) { finish(null, {}); return; }
            var value;
            try { value = JSON.parse(text); } catch (e) { finish(new Error('Invalid JSON')); return; }
            finish(null, value);
        });
    }

    // Answers a POST whose work returns a promise; errors become 400 (bad input) or 502 (speaker trouble).
    function post(req, res, work) {
        readBody(req, function (err, body) {
            if (err) { json(res, { ok: false, error: err.message }, 400); return; }
            var p;
            try { p = Promise.resolve(work(body || {})); } catch (e) { json(res, { ok: false, error: e.message }, 400); return; }
            p.then(function (out) { json(res, out); }, function (e) {
                json(res, { ok: false, error: String(e && e.message || e) }, e && e.badInput ? 400 : 502);
            }).then(null, noop);
        });
    }

    function bad(message) { var e = new Error(message); e.badInput = true; return e; }

    function fullState() {
        return {
            version: VERSION,
            running: running,
            settings: publicSettings(cfg),
            receiver: receiver ? receiver.status() : null,
            speaker: {
                volume: state.volume, muted: state.muted, readAt: state.readAt,
                lastCommand: state.lastCommand, lastError: state.lastError, commands: state.commands
            },
            topics: ACTIONS.map(function (a) { return { action: a, topic: cfg.topicPrefix + '/' + a }; }),
            remote: remote,
            check: lastCheck,
            checking: !!checking,
            searching: !!search,
            log: log.slice().reverse()
        };
    }

    function roomsFrom(data) {
        return data.rooms.map(function (r) {
            var group = [];
            data.rooms.forEach(function (o) { if (o.groupId === r.groupId && o.uuid !== r.uuid) group.push(o.name); });
            return { uuid: r.uuid, name: r.name, address: r.address, groupedWith: group };
        });
    }

    // Reads Vetro's settings (see vetro-check.js). One at a time; the result stays on the page.
    function runCheck() {
        if (checking) return checking;
        var wanted = ACTIONS.map(function (a) {
            return { action: a, topic: cfg.topicPrefix + '/' + a, key: KEY_NAMES[a], required: REQUIRED.indexOf(a) >= 0 };
        });
        var port = vetroCheck.vetroPort();
        checking = vetroCheck.read(port).then(function (data) {
            var result = vetroCheck.analyze(data, cfg, wanted);
            if (receiver && !receiver.status().listening) {
                result.items.unshift({ level: 'bad', title: 'This Shard is not listening', detail: receiver.status().error || '' });
                result.level = 'bad';
            }
            if (remote.lastIgnored) {
                result.items.push({ level: 'warn', title: 'Last ignored message: ' + remote.lastIgnored.topic, detail: remote.lastIgnored.why });
                if (result.level === 'ok') result.level = 'warn';
            }
            lastCheck = result;
            note(result.level === 'ok' ? 'info' : 'warn', 'Checked Vetro\u2019s setup: ' + (result.level === 'ok' ? 'all good' :
                result.items.filter(function (i) { return i.level !== 'ok'; }).map(function (i) { return i.title; }).join('; ')));
            return { ok: true, check: result };
        }, function (e) {
            return { ok: false, error: String(e && e.message || e) };
        });
        var mine = checking;
        mine.then(function () { if (checking === mine) checking = null; }, function () { if (checking === mine) checking = null; });
        return mine;
    }

    var page = null;
    function uiPage() {
        if (page) return page;
        var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
        for (var i = 0; i < places.length; i++) {
            try { page = fs.readFileSync(places[i], 'utf8'); return page; } catch (e) { /* next */ }
        }
        return '<!doctype html><meta charset="utf-8"><p>ui.html is missing from the Shard folder.</p>';
    }

    function applySettings(update) {
        var before = cfg, next;
        try { next = validateSettings(update, cfg); } catch (e) { throw bad(e.message); }
        cfg = next;
        save();
        if (before.brokerPort !== next.brokerPort || before.username !== next.username || before.password !== next.password) {
            note('info', 'Receiver settings changed: restarting it');
            if (running) startReceiver();
        }
        var a = before.speaker, b = next.speaker;
        if (!a || !b || a.uuid !== b.uuid || a.address !== b.address || before.target !== next.target) {
            state.volume = null; state.muted = null; state.readAt = null; state.lastError = null;
            if (b && (!a || a.uuid !== b.uuid || a.address !== b.address)) note('info', 'Speaker set to ' + b.name + ' (' + b.address + ')');
        }
        return fullState();
    }

    function route(req, res, sub) {
        var method = req.method;
        if (sub === 'ui' && method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(uiPage());
            return true;
        }
        if (sub === 'state' && method === 'GET') { json(res, fullState()); return true; }
        if (method !== 'POST') return false;
        if (sub === 'settings') { post(req, res, applySettings); return true; }
        if (sub === 'command') {
            post(req, res, function (body) {
                if (ACTIONS.indexOf(body.action) < 0) throw bad('Unknown action');
                return enqueue(body.action, 'dashboard');
            });
            return true;
        }
        if (sub === 'refresh') {
            post(req, res, function () {
                return readState().then(function (r) { remember(r); return snapshot(true); }, function (e) {
                    state.lastError = String(e && e.message || e);
                    return snapshot(false, state.lastError);
                });
            });
            return true;
        }
        if (sub === 'lookup') {
            post(req, res, function (body) {
                var address;
                try { address = sonos.parseAddress(body.address); } catch (e) { throw bad('Type the IP address of a Sonos speaker, like 192.168.1.20'); }
                return sonos.getTopology(address, LOOKUP_TIMEOUT_MS).then(function (data) {
                    topo = { at: Date.now(), data: data, from: sonos.formatAddress(address) };
                    return { ok: true, rooms: roomsFrom(data) };
                });
            });
            return true;
        }
        if (sub === 'check') {
            post(req, res, function () { return runCheck(); });
            return true;
        }
        if (sub === 'discover') {
            post(req, res, function () {
                return discoverAddresses().then(function (found) {
                    return firstTopology(found).then(function (answer) {
                        if (!answer) return { ok: true, rooms: [], found: found.length };
                        topo = answer;
                        return { ok: true, rooms: roomsFrom(answer.data), found: found.length };
                    });
                });
            });
            return true;
        }
        return false;
    }

    return {
        start: function () {
            cfg = normalize(ctx.config.get());
            running = true;
            busy = false;
            startReceiver();
            note('info', 'Started (version ' + VERSION + ')');
        },
        stop: function () {
            running = false;
            stopReceiver();
            if (search) search.cancel();
            search = null;
            var pending = queue;
            queue = [];
            pending.forEach(function (c) { try { c.resolve(snapshot(false, 'Stopped')); } catch (e) { /* ignore */ } });
        },
        status: function () {
            var r = receiver ? receiver.status() : null;
            return {
                speaker: cfg.speaker ? cfg.speaker.name : null,
                target: cfg.target,
                receiver: r ? (r.listening ? '127.0.0.1:' + r.port : 'not listening') : 'off',
                vetroConnected: !!(r && r.clients.length),
                remotePresses: remote.presses,
                volume: state.volume,
                muted: state.muted,
                lastError: state.lastError || (r && r.error) || null
            };
        },
        route: route
    };
};

// For the tests.
module.exports.validateSettings = validateSettings;
module.exports.normalize = normalize;
module.exports.DEFAULTS = DEFAULTS;
module.exports.ACTIONS = ACTIONS;
