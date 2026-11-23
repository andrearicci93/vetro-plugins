'use strict';
// The Home Assistant side of the Shard: the address, one small HTTP client for HA's REST API, and the table of what the card may
// switch. Plain ES5 (Node 4.4 on older TVs): no URL global, no Buffer.from, no Array.prototype.includes, no Promise.prototype.finally.
// Nothing here keeps a timer after a request ends, and abortAll() ends every request that is still open.

var http = require('http');
var https = require('https');
var urlLib = require('url');

// What the card may switch, by HA domain. "switch" kinds go on or off (turn_on / turn_off, never HA's toggle: a toggle after a stale read
// would flip the entity back). "run" kinds are fired and keep no state. Locks, covers (garage doors) and alarm panels are left out on
// purpose: a remote-control key press must not open a door.
var DOMAINS = {
    light: { kind: 'switch' },
    switch: { kind: 'switch' },
    input_boolean: { kind: 'switch' },
    fan: { kind: 'switch' },
    scene: { kind: 'run', service: 'turn_on', value: 'Scene' },
    script: { kind: 'run', service: 'turn_on', value: 'Script' },
    button: { kind: 'run', service: 'press', value: 'Button' },
    input_button: { kind: 'run', service: 'press', value: 'Button' }
};

var ENTITY_RE = /^([a-z_]+)\.[a-z0-9_]+$/;
var ID_MAX = 40;            // the longest row id the Control center takes
var NAME_MAX = 40;          // the longest row label the Control center takes
var MAX_ENTITIES = 7;       // the Control center shows 7 rows at most
var TOKEN_RE = /^[\x21-\x7e]{1,2048}$/;

// "192.168.1.20:8123", "http://homeassistant:8123" or "https://ha.example.org/sub": {protocol, hostname, port, base} or null. No credentials
// in the address, no query, no other scheme.
function parseAddress(text) {
    if (typeof text !== 'string') return null;
    var t = text.replace(/^\s+|\s+$/g, '');
    if (!t || t.length > 200) return null;
    if (t.indexOf('://') < 0) t = 'http://' + t;
    var u;
    try { u = urlLib.parse(t); } catch (e) { return null; }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.auth || u.search || u.hash) return null;
    if (/[^A-Za-z0-9.:_\-\[\]]/.test(u.hostname)) return null;
    var port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    if (!(port > 0 && port < 65536)) return null;
    var base = (u.pathname || '').replace(/\/+$/, '');
    if (/[^A-Za-z0-9._~\-\/]/.test(base)) return null;
    return { protocol: u.protocol, hostname: u.hostname, port: port, base: base, text: u.protocol + '//' + (u.hostname.indexOf(':') >= 0 ? '[' + u.hostname + ']' : u.hostname) + ':' + port + base };
}

function validToken(t) { return typeof t === 'string' && TOKEN_RE.test(t); }

// The id of an entity the card can switch: "light.living_room". Null for anything else (unknown domain, too long for a row id).
function entityDomain(id) {
    if (typeof id !== 'string' || id.length > ID_MAX) return null;
    var m = ENTITY_RE.exec(id);
    return m && DOMAINS[m[1]] && Object.prototype.hasOwnProperty.call(DOMAINS, m[1]) ? m[1] : null;
}

function plain(text, max) {
    var t = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/^\s+|\s+$/g, '');
    return t.length > max ? t.slice(0, max).replace(/\s+$/, '') : t;
}

// A short sentence for what went wrong, for the card and the page: no address, no token.
function reasonOf(e) {
    if (!e) return 'HA did not answer';
    if (e.reason) return e.reason;
    var c = e.code;
    if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'HA address not found';
    if (c && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(c)) return 'HA certificate not trusted';
    return 'HA did not answer';
}

function fail(reason, status) { var e = new Error(reason); e.reason = reason; e.status = status || 0; return e; }

function Client(getConfig) {
    this.getConfig = getConfig;
    this.open = [];            // requests under way: stop() aborts them
}

// request(method, path, body, ms, maxBytes) -> Promise of {status, json}. Always settles within ms (the timer is cleared as soon as it does).
// Rejects with an Error whose .reason is short readable text. Never throws.
Client.prototype.request = function (method, path, body, ms, maxBytes) {
    var self = this;
    return new Promise(function (resolve, reject) {
        var cfg = self.getConfig(), addr = parseAddress(cfg.url);
        if (!addr) return reject(fail('Home Assistant address not set'));
        if (!validToken(cfg.token)) return reject(fail('Access token not set'));
        var payload = body == null ? null : JSON.stringify(body);
        var done = false, timer = null, req = null;
        function finish(err, value) {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            var i = self.open.indexOf(abort);
            if (i >= 0) self.open.splice(i, 1);
            if (err) reject(err); else resolve(value);
        }
        function abort() { finish(fail('HA did not answer')); try { if (req) req.abort(); } catch (e) { /* already closed */ } }
        self.open.push(abort);
        timer = setTimeout(abort, ms);
        try {
            var headers = { Authorization: 'Bearer ' + cfg.token, Accept: 'application/json' };
            if (payload != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
            req = (addr.protocol === 'https:' ? https : http).request({
                method: method, hostname: addr.hostname, port: addr.port, path: addr.base + path, headers: headers, agent: false
            }, function (res) {
                var chunks = [], size = 0;
                res.setEncoding('utf8');
                res.on('data', function (c) {
                    size += c.length;
                    if (size > maxBytes) { finish(fail('HA answer is too large')); try { req.abort(); } catch (e) { /* closed */ } return; }
                    chunks.push(c);
                });
                res.on('error', function (e) { finish(fail(reasonOf(e))); });
                res.on('aborted', function () { finish(fail('HA did not answer')); });
                res.on('end', function () {
                    var s = res.statusCode;
                    if (s === 401 || s === 403) return finish(fail('Token refused', s));
                    if (s === 404) return finish(fail('Not found', s));
                    if (s >= 300 && s < 400) return finish(fail('HA redirected: use its final address', s));
                    if (s < 200 || s >= 300) return finish(fail('HA answered ' + s, s));
                    var json = null, text = chunks.join('');
                    if (text) { try { json = JSON.parse(text); } catch (e) { return finish(fail('HA sent something unreadable', s)); } }
                    finish(null, { status: s, json: json });
                });
            });
            req.on('error', function (e) { finish(fail(reasonOf(e))); });
            if (payload != null) req.write(payload);
            req.end();
        } catch (e) { finish(fail(reasonOf(e))); }
    });
};

Client.prototype.abortAll = function () {
    var list = this.open.slice();
    for (var i = 0; i < list.length; i++) { try { list[i](); } catch (e) { /* the request is gone anyway */ } }
    this.open = [];
};

module.exports = {
    DOMAINS: DOMAINS, ID_MAX: ID_MAX, NAME_MAX: NAME_MAX, MAX_ENTITIES: MAX_ENTITIES,
    parseAddress: parseAddress, validToken: validToken, entityDomain: entityDomain, plain: plain, reasonOf: reasonOf,
    Client: Client
};
