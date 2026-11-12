'use strict';
// Art SQL API: a read-only HTTP API over the Samsung Art app's database (artapp.db), so another app on the network
// can send SQL and get JSON back. The URLs and JSON follow a subset of Datasette's JSON API (it is not Datasette).
//
// How a query runs: this Shard listens on its own port (Vetro's /plugins/<id>/api routes need a paired device or the
// page's session token, which another app does not have), checks the API key, checks the SQL (sql.js), then runs the
// TV's own /usr/bin/sqlite3 with -readonly as root through ctx.execute, because the file sits in the Art app's
// sandbox. One query at a time: every Vetro command shares one queue. Plain ES5: older TVs run Node 4.4.

var http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os');
var querystring = require('querystring');
var Q = require('./sql.js');

var DEFAULTS = { port: 8642, dbPath: '/opt/usr/home/owner/apps_rw/org.tizen.art-app/data/db/artapp.db', sqlite: '/usr/bin/sqlite3',
    cors: '*', timeoutMs: 10000, maxRows: 1000 };
var MAX_TIMEOUT = 30000, MAX_ROWS = 5000, MAX_PENDING = 8, MAX_BODY = 65536, MAX_SOCKETS = 32, VERSION = '0.1.0';

function validPath(p) { return typeof p === 'string' && p.charAt(0) === '/' && p.length <= 1024 && /^[A-Za-z0-9._\/-]+$/.test(p) && !/(^|\/)\.\.(\/|$)/.test(p); }
function validOrigin(o) { return o === '*' || o === '' || (typeof o === 'string' && o.length <= 200 && /^https?:\/\/[A-Za-z0-9.:\[\]-]+$/.test(o)); }
function dbName(p) { return path.basename(p).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]/g, '_') || 'db'; }
// Constant-time compare without crypto.timingSafeEqual (Node 6.6+).
function sameKey(a, b) { a = String(a || ''); b = String(b || ''); if (!a || a.length !== b.length) return false; var d = 0; for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function newKey() { return crypto.randomBytes(24).toString('hex'); }

function readBody(req, cb) {
    var chunks = [], size = 0, done = false;
    req.on('data', function (c) { size += c.length; if (size > MAX_BODY) { if (!done) { done = true; cb(new Error('Request too large')); } if (req.destroy) req.destroy(); return; } chunks.push(c); });
    req.on('end', function () { if (!done) { done = true; cb(null, Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', function (e) { if (!done) { done = true; cb(e); } });
}
function parseJsonObject(text) { var p = JSON.parse(text || '{}'); if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Body must be a JSON object'); return p; }

function lanAddresses() {
    var out = [];
    try { var ifs = os.networkInterfaces(); Object.keys(ifs).forEach(function (k) { (ifs[k] || []).forEach(function (a) { if (a.family === 'IPv4' || a.family === 4) { if (!a.internal) out.push(a.address); } }); }); } catch (e) { /* none */ }
    return out;
}

function loadPage(ctx) {
    var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
    for (var i = 0; i < places.length; i++) { try { return fs.readFileSync(places[i], 'utf8'); } catch (e) { /* next */ } }
    return '<!doctype html><meta charset="utf-8"><p>Page file missing: reinstall this Shard.</p>';
}

module.exports = function (ctx) {
    var server = null, sockets = [], page = null, running = false, queue = [], busy = false, stopped = true;
    var sqliteVersion = null, probeError = null, lastError = null, listenError = null, counts = { queries: 0, errors: 0, denied: 0 };

    function cfg() {
        var c; try { c = ctx.config.get(); } catch (e) { c = {}; }
        if (!c || typeof c !== 'object' || Array.isArray(c)) c = {};
        var out = {};
        Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
        if (typeof c.port === 'number' && c.port >= 1024 && c.port <= 65535 && c.port % 1 === 0) out.port = c.port;
        if (validPath(c.dbPath)) out.dbPath = c.dbPath;
        if (validPath(c.sqlite)) out.sqlite = c.sqlite;   // not on the page: only for a TV that keeps sqlite3 elsewhere
        if (validOrigin(c.cors)) out.cors = c.cors;
        if (typeof c.timeoutMs === 'number' && c.timeoutMs >= 1000 && c.timeoutMs <= MAX_TIMEOUT) out.timeoutMs = Math.round(c.timeoutMs);
        if (typeof c.maxRows === 'number' && c.maxRows >= 1 && c.maxRows <= MAX_ROWS) out.maxRows = Math.round(c.maxRows);
        out.apiKey = typeof c.apiKey === 'string' && /^[0-9a-f]{32,}$/.test(c.apiKey) ? c.apiKey : null;
        return out;
    }
    function save(patch) {
        var c; try { c = ctx.config.get(); } catch (e) { c = {}; }
        if (!c || typeof c !== 'object' || Array.isArray(c)) c = {};
        Object.keys(patch).forEach(function (k) { c[k] = patch[k]; });
        ctx.config.set(c);
    }
    function apiKey() { var k = cfg().apiKey; if (!k) { k = newKey(); try { save({ apiKey: k }); } catch (e) { /* keep it for this run */ } } return k; }

    // ---- running queries, one at a time ----
    function exec(sqlText, timeoutMs) {
        var c = cfg();
        return Promise.resolve().then(function () { return ctx.execute(Q.command(c.sqlite, c.dbPath, sqlText), timeoutMs || c.timeoutMs); });
    }
    function enqueue(job) {
        return new Promise(function (resolve, reject) {
            if (queue.length >= MAX_PENDING) { var e = new Error('Too many queries waiting; try again shortly'); e.status = 429; e.title = 'Busy'; return reject(e); }
            queue.push({ job: job, resolve: resolve, reject: reject }); pump();
        });
    }
    function pump() {
        if (busy || !queue.length) return;
        var item = queue.shift(); busy = true;
        var p; try { p = item.job(); } catch (e) { p = Promise.reject(e); }
        p.then(function (v) { busy = false; item.resolve(v); pump(); }, function (e) { busy = false; item.reject(e); pump(); });
    }
    // Check, run and parse one query. Resolves { rows, columns, truncated, sql, params, ms }.
    function query(sqlText, params, maxRows) {
        var c = cfg(), limit = maxRows || c.maxRows, prep;
        try { prep = Q.prepare(sqlText, params, limit); } catch (e) { return Promise.reject(e); }
        return enqueue(function () {
            var t0 = Date.now();
            return exec(prep.sql).then(function (r) {
                r = r || {};
                if (r.timed_out) { var te = new Error('Query took longer than ' + (c.timeoutMs / 1000) + ' s'); te.status = 400; te.title = 'Query timed out'; throw te; }
                if (r.exit_code !== 0) { var se = new Error(Q.cleanError(r.stderr || r.stdout)); se.status = 400; se.title = 'Invalid SQL'; throw se; }
                var rows;
                try { rows = Q.parseOutput(r.stdout, prep.first); } catch (e) { var pe = new Error('Could not read sqlite3 output: ' + e.message); pe.status = 500; throw pe; }
                var truncated = prep.wrapped && rows.length > limit; if (truncated) rows = rows.slice(0, limit);
                counts.queries++;
                return { rows: rows, columns: Q.columnsOf(rows), truncated: truncated, sql: sqlText, params: prep.params, ms: Date.now() - t0 };
            });
        });
    }

    // Is sqlite3 there, which version, and can root read the file? Runs at start and from the page.
    function probe() {
        var c = cfg();
        var cmd = Q.shQuote(c.sqlite) + ' -version 2>&1; [ -r ' + Q.shQuote(c.dbPath) + ' ] && echo __READABLE__ || echo __MISSING__';
        return Promise.resolve().then(function () { return ctx.execute(cmd, 5000); }).then(function (r) {
            var out = String((r && r.stdout) || ''), m = /^(\d+)\.(\d+)\.(\d+)/m.exec(out);
            sqliteVersion = m ? m[0] : null;
            if (!m) probeError = 'sqlite3 not found at ' + c.sqlite;
            else if (+m[1] < 3 || (+m[1] === 3 && +m[2] < 33)) probeError = 'sqlite3 ' + m[0] + ' is too old (JSON output needs 3.33.0)';
            else if (out.indexOf('__READABLE__') < 0) probeError = 'Database not found: ' + c.dbPath;
            else probeError = null;
        }, function (e) { probeError = 'Could not run sqlite3: ' + (e && e.message || e); }).then(function () { return state(); });
    }

    // ---- HTTP ----
    function cors(res) {
        var o = cfg().cors;
        if (!o) return;
        res.setHeader('Access-Control-Allow-Origin', o);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
        if (o !== '*') res.setHeader('Vary', 'Origin');
    }
    function send(res, code, body, nl) {
        var text = nl ? body.map(function (r) { return JSON.stringify(r); }).join('\n') + (body.length ? '\n' : '') : JSON.stringify(body);
        res.writeHead(code, { 'content-type': nl ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(text);
    }
    function sendError(res, e) {
        var status = e && e.status || 500;
        if (status >= 500) counts.errors++;
        lastError = String(e && e.message || e);
        send(res, status, { ok: false, error: lastError, status: status, title: e && e.title || (status === 401 ? 'Unauthorized' : 'Error') });
    }
    // Datasette's _shape: default (objects plus metadata), array, arrays, objects; _nl=on with array for NDJSON.
    function shaped(res, q, d, extra) {
        var shape = q._shape || '';
        if (shape === 'array') return send(res, 200, d.rows, q._nl === 'on');
        if (shape === 'arrays') return send(res, 200, { ok: true, columns: d.columns, rows: d.rows.map(function (r) { return d.columns.map(function (k) { return r[k]; }); }), truncated: d.truncated });
        if (shape === 'objects') return send(res, 200, { ok: true, rows: d.rows, truncated: d.truncated });
        var body = { ok: true, database: dbName(cfg().dbPath), query: { sql: d.sql, params: d.params }, columns: d.columns, rows: d.rows, truncated: d.truncated, query_ms: d.ms };
        if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
        send(res, 200, body);
    }
    function authorized(req, q) {
        var h = String(req.headers.authorization || ''), m = /^Bearer\s+(\S+)$/i.exec(h), given = m ? m[1] : (q._key || req.headers['x-api-key']);
        return sameKey(given, apiKey());
    }
    function paramsFrom(q) { var p = {}; Object.keys(q).forEach(function (k) { if (k !== 'sql' && k.charAt(0) !== '_') p[k] = [].concat(q[k])[0]; }); return p; }

    function handle(req, res) {
        try {
            cors(res);
            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
            var raw = String(req.url || '/'), qi = raw.indexOf('?'), q = querystring.parse(qi < 0 ? '' : raw.slice(qi + 1)), p;
            try { p = decodeURIComponent(qi < 0 ? raw : raw.slice(0, qi)); } catch (e) { return send(res, 400, { ok: false, error: 'Bad URL', status: 400 }); }
            if (!authorized(req, q)) {
                counts.denied++;
                res.setHeader('WWW-Authenticate', 'Bearer');
                return send(res, 401, { ok: false, error: 'Missing or wrong API key: send "Authorization: Bearer <key>"', status: 401, title: 'Unauthorized' });
            }
            var name = dbName(cfg().dbPath), m;
            if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, error: 'GET or POST only', status: 405 });
            if (p === '/' || p === '/.json') {
                var dbs = {}; dbs[name] = { name: name, path: '/' + name, is_mutable: false };
                return send(res, 200, dbs);
            }
            if (p === '/-/versions.json' || p === '/-/versions') return send(res, 200, { sqlite: { version: sqliteVersion }, shard: { name: 'art-sql', version: VERSION }, datasette_compatible: 'JSON API subset' });
            if (p === '/' + name || p === '/' + name + '.json') {
                if (req.method === 'POST') {
                    return readBody(req, function (err, text) {
                        if (err) return sendError(res, err);
                        var b; try { b = parseJsonObject(text); } catch (e) { e.status = 400; return sendError(res, e); }
                        var bq = { _shape: b._shape || q._shape, _nl: b._nl || q._nl };
                        query(b.sql, b.params && typeof b.params === 'object' ? b.params : {}).then(function (d) { shaped(res, bq, d); }, function (e) { sendError(res, e); });
                    });
                }
                if (q.sql != null) return query([].concat(q.sql)[0], paramsFrom(q)).then(function (d) { shaped(res, q, d); }, function (e) { sendError(res, e); });
                return query(Q.SCHEMA_SQL, {}, MAX_ROWS).then(function (d) {
                    send(res, 200, { ok: true, database: name, tables: Q.schemaOf(d.rows) });
                }, function (e) { sendError(res, e); });
            }
            if ((m = new RegExp('^/' + name + '/(.+?)(\\.json)?$').exec(p))) {
                var t = Q.tableQuery(m[1], q, cfg().maxRows);
                return query(t.sql, t.params, t.size + 1).then(function (d) {
                    var more = d.rows.length > t.size; if (more) d.rows = d.rows.slice(0, t.size);
                    var next = more ? String(t.offset + t.size) : null, nq = {};
                    if (next) { Object.keys(q).forEach(function (k) { if (k !== '_key') nq[k] = q[k]; }); nq._next = next; }
                    d.truncated = false;
                    shaped(res, q, d, { table: m[1], next: next, next_url: next ? p + '?' + querystring.stringify(nq) : null });
                }, function (e) { sendError(res, e); });
            }
            send(res, 404, { ok: false, error: 'Not found. Try /' + name + '.json?sql=select+1', status: 404, title: 'Not found' });
        } catch (e) {
            try { sendError(res, e); } catch (x) { try { res.end(); } catch (y) { /* gone */ } }
        }
    }

    function listen() {
        var c = cfg();
        listenError = null;
        try {
            var srv = server = http.createServer(handle);
            srv.maxConnections = MAX_SOCKETS;
            srv.timeout = MAX_TIMEOUT + 30000;
            srv.on('connection', function (s) { sockets.push(s); s.on('close', function () { var i = sockets.indexOf(s); if (i >= 0) sockets.splice(i, 1); }); });
            srv.on('error', function (e) { if (srv !== server) return; listenError = String(e && e.message || e); running = false; try { srv.close(); } catch (x) { /* not open */ } });
            srv.on('listening', function () { if (srv === server) running = true; });
            srv.listen(c.port, '0.0.0.0');
        } catch (e) { listenError = String(e && e.message || e); server = null; }
    }
    function close() {
        running = false;
        if (server) { try { server.close(); } catch (e) { /* already closed */ } server = null; }
        sockets.slice().forEach(function (s) { try { s.destroy(); } catch (e) { /* gone */ } });
        sockets = [];
    }

    function state() {
        var c = cfg();
        return { running: running, port: c.port, addresses: lanAddresses(), database: dbName(c.dbPath), dbPath: c.dbPath, cors: c.cors,
            timeoutMs: c.timeoutMs, maxRows: c.maxRows, apiKey: apiKey(), sqliteVersion: sqliteVersion, problem: listenError || probeError,
            lastError: lastError, queries: counts.queries, denied: counts.denied, pending: queue.length + (busy ? 1 : 0) };
    }
    function json(res, body, code) { res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }

    return {
        start: function () {
            stopped = false; page = loadPage(ctx); apiKey(); listen();
            probe().then(null, function () { /* recorded in probeError */ });
        },
        stop: function () {
            stopped = true; close(); page = null;
            var waiting = queue; queue = [];
            waiting.forEach(function (w) { var e = new Error('The Shard was switched off'); e.status = 503; w.reject(e); });
        },
        status: function () { var c = cfg(); return { running: running, port: c.port, sqlite: sqliteVersion, queries: counts.queries, problem: listenError || probeError || undefined }; },

        // The dashboard page and its settings. These routes are Vetro's (paired device or page token), not the API's.
        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page || loadPage(ctx)); return true; }
            if (sub === 'state' && req.method === 'GET') { json(res, state()); return true; }
            if (req.method !== 'POST') return false;
            if (sub === 'probe') { probe().then(function (s) { json(res, s); }, function (e) { json(res, { ok: false, error: String(e && e.message || e) }, 500); }); return true; }
            if (sub === 'regen-key') { try { save({ apiKey: newKey() }); json(res, state()); } catch (e) { json(res, { ok: false, error: e.message }, 500); } return true; }
            if (sub === 'settings' || sub === 'query') {
                readBody(req, function (err, text) {
                    var b;
                    try { if (err) throw err; b = parseJsonObject(text); } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
                    if (sub === 'query') {
                        return query(b.sql, b.params && typeof b.params === 'object' ? b.params : {}).then(function (d) {
                            json(res, { ok: true, columns: d.columns, rows: d.rows, truncated: d.truncated, query_ms: d.ms });
                        }, function (e) { json(res, { ok: false, error: String(e && e.message || e) }, e && e.status || 500); });
                    }
                    var patch = {}, bad = null, before = cfg();
                    if (b.port != null) { if (typeof b.port === 'number' && b.port >= 1024 && b.port <= 65535 && b.port % 1 === 0) patch.port = b.port; else bad = 'Port must be 1024-65535'; }
                    if (b.dbPath != null) { if (validPath(b.dbPath)) patch.dbPath = b.dbPath; else bad = 'Database path must be absolute, letters, digits, . _ - / only'; }
                    if (b.cors != null) { if (validOrigin(b.cors)) patch.cors = b.cors; else bad = 'CORS origin must be *, empty, or like http://host:port'; }
                    if (b.timeoutMs != null) { if (typeof b.timeoutMs === 'number' && b.timeoutMs >= 1000 && b.timeoutMs <= MAX_TIMEOUT) patch.timeoutMs = b.timeoutMs; else bad = 'Time limit must be 1-30 s'; }
                    if (b.maxRows != null) { if (typeof b.maxRows === 'number' && b.maxRows >= 1 && b.maxRows <= MAX_ROWS) patch.maxRows = b.maxRows; else bad = 'Row limit must be 1-' + MAX_ROWS; }
                    if (bad) return json(res, { ok: false, error: bad }, 400);
                    try { save(patch); } catch (e) { return json(res, { ok: false, error: 'Settings could not be saved: ' + e.message }, 500); }
                    if (!stopped && patch.port && patch.port !== before.port) { close(); listen(); }
                    if (patch.dbPath && patch.dbPath !== before.dbPath) return probe().then(function (s) { json(res, s); });
                    json(res, state());
                });
                return true;
            }
            return false;
        }
    };
};
module.exports.VERSION = VERSION;
