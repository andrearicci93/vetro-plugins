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
var NOT_FOUND = 'Database not found: ';

var DEFAULTS = { port: 8642, dbPath: '/opt/usr/home/owner/apps_rw/org.tizen.art-app/data/db/artapp.db', sqlite: '/usr/bin/sqlite3',
    cors: '*', timeoutMs: 10000, maxRows: 1000 };
// A result is written to a file in the Shard's folder and read from there (Vetro's agent returns at most 1 MiB of
// output); MAX_RESULT caps that file.
var MAX_RESULT = 32 * 1024 * 1024;
var MAX_TIMEOUT = 30000, MAX_ROWS = 5000, MAX_PENDING = 8, MAX_BODY = 65536, MAX_SOCKETS = 32, VERSION = '0.1.1';

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
    // phase: 'checking' while start() looks for sqlite3 and the database, then 'ready' (the API is listening) or
    // 'blocked' (something is missing: no port is opened and the page shows only why, until the Shard is restarted).
    var phase = 'checking', blockedBy = null, generation = 0;
    var sqliteVersion = null, probeError = null, checkedAt = null, lastError = null, listenError = null, counts = { queries: 0, errors: 0, denied: 0 };

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
    // The key lives in config.json. If that cannot be written, the key made for this run is kept in memory (so it does not
    // change from one request to the next), saving is retried, and the tab warns that it will change at the next start.
    var memKey = null, keyUnsaved = false;
    function apiKey() {
        var k = cfg().apiKey;
        if (k) { memKey = k; keyUnsaved = false; return k; }
        if (!memKey) memKey = newKey();
        try { save({ apiKey: memKey }); keyUnsaved = false; } catch (e) { keyUnsaved = true; }
        return memKey;
    }
    function replaceKey() { memKey = newKey(); try { save({ apiKey: memKey }); keyUnsaved = false; } catch (e) { keyUnsaved = true; } }

    // ---- running queries, one at a time ----
    // results/ in the Shard's folder: sqlite3 (root) writes each result there and this process reads it. If the
    // folder cannot be made, results come back over stdout, which the agent cuts at 1 MiB.
    var resultsDir = null;
    function setUpResults() {
        resultsDir = null;
        if (!ctx.dir) return;
        var d = path.join(ctx.dir, 'results');
        try {
            if (!fs.existsSync(d)) fs.mkdirSync(d, 448);   // 0700
            fs.readdirSync(d).forEach(function (f) { if (/\.json$/.test(f)) { try { fs.unlinkSync(path.join(d, f)); } catch (e) { /* next */ } } });
            resultsDir = d;
        } catch (e) { resultsDir = null; }
    }
    function tooLarge(what) { var e = new Error('The result is larger than ' + what + ': select fewer rows or columns'); e.status = 413; e.title = 'Result too large'; return e; }
    // Run sqlite3 and resolve the agent's answer with .stdout replaced by the result, whichever way it came.
    function exec(sqlText, timeoutMs) {
        var c = cfg(), file = resultsDir ? path.join(resultsDir, crypto.randomBytes(8).toString('hex') + '.json') : null;
        var out = file ? { file: file, uid: process.getuid ? process.getuid() : 5001, blocks: 131072 } : null;
        function drop() { if (file) { try { fs.unlinkSync(file); } catch (e) { /* not there */ } } }
        return Promise.resolve().then(function () { return ctx.execute(Q.command(c.sqlite, c.dbPath, sqlText, out), timeoutMs || c.timeoutMs); }).then(function (r) {
            r = r || {};
            try {
                if (!file) { if (Q.capped(r.stdout)) throw tooLarge('1 MiB'); return r; }
                var size = -1; try { size = fs.statSync(file).size; } catch (e) { /* none */ }
                if (size > MAX_RESULT || (r.exit_code !== 0 && size >= MAX_RESULT - 65536)) throw tooLarge(MAX_RESULT / 1048576 + ' MB');
                var res = {}; for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) res[k] = r[k];
                res.stdout = size > 0 ? fs.readFileSync(file, 'utf8') : '';
                if (size < 0 && r.exit_code === 0 && !r.timed_out) { var me = new Error('sqlite3 wrote no result file'); me.status = 500; throw me; }
                return res;
            } finally { drop(); }
        }, function (e) { drop(); throw e; });
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
                if (r.exit_code !== 0) throw failure(Q.cleanError(r.stderr || r.stdout), c);
                var rows;
                try { rows = Q.parseOutput(r.stdout, prep.first); } catch (e) { var pe = new Error('Could not read sqlite3 output: ' + e.message); pe.status = 500; throw pe; }
                var truncated = prep.wrapped && rows.length > limit; if (truncated) rows = rows.slice(0, limit);
                counts.queries++;
                // The file is evidently there now: drop a "not found" left by an earlier check.
                if (probeError && probeError.indexOf(NOT_FOUND) === 0) { probeError = null; checkedAt = Date.now(); }
                return { rows: rows, columns: Q.columnsOf(rows), truncated: truncated, sql: sqlText, params: prep.params, ms: Date.now() - t0 };
            });
        });
    }

    // What a failed sqlite3 run means. A missing file or a lock held by the Art app is not the client's fault: 503, and a
    // missing file also shows on the page at once, without waiting for the next check.
    function failure(msg, c) {
        var e = new Error(msg);
        if (/unable to open database/i.test(msg)) {
            probeError = NOT_FOUND + c.dbPath; checkedAt = Date.now();
            e.message = 'Database not found or not readable: ' + c.dbPath; e.status = 503; e.title = 'Database unavailable';
        } else if (/database is (locked|busy)/i.test(msg)) {
            e.status = 503; e.title = 'Database busy'; e.retryAfter = 2;
        } else { e.status = 400; e.title = 'Invalid SQL'; }
        return e;
    }

    // Is sqlite3 there, which version, and can root read the file? Runs at start, when the page opens, on Check sqlite3
    // and when the database path changes.
    function probe() {
        var c = cfg();
        var cmd = Q.shQuote(c.sqlite) + ' -version 2>&1; [ -r ' + Q.shQuote(c.dbPath) + ' ] && echo __READABLE__ || echo __MISSING__';
        return Promise.resolve().then(function () { return ctx.execute(cmd, 5000); }).then(function (r) {
            var out = String((r && r.stdout) || ''), m = /^(\d+)\.(\d+)\.(\d+)/m.exec(out);
            sqliteVersion = m ? m[0] : null;
            if (!m) probeError = 'sqlite3 not found at ' + c.sqlite;
            else if (+m[1] < 3 || (+m[1] === 3 && +m[2] < 33)) probeError = 'sqlite3 ' + m[0] + ' is too old (JSON output needs 3.33.0)';
            else if (out.indexOf('__READABLE__') < 0) probeError = NOT_FOUND + c.dbPath;
            else probeError = null;
        }, function (e) { probeError = 'Could not run sqlite3: ' + (e && e.message || e); }).then(function () { checkedAt = Date.now(); return state(); });
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
        if (e && e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
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

    function readable(p) {
        return Promise.resolve().then(function () { return ctx.execute('[ -r ' + Q.shQuote(p) + ' ] && echo __READABLE__ || echo __MISSING__', 5000); })
            .then(function (r) { return String((r && r.stdout) || '').indexOf('__READABLE__') >= 0; });
    }

    // Look for sqlite3 and the database first; open the port only if both are there. A newer start() or a stop() while
    // the check runs makes this one's result moot (generation).
    function begin() {
        var mine = ++generation;
        close(); phase = 'checking'; blockedBy = null;
        return probe().then(function () {
            if (mine !== generation || stopped) return;
            if (probeError) { phase = 'blocked'; blockedBy = probeError.indexOf(NOT_FOUND) === 0 ? 'The database does not exist: ' + cfg().dbPath : probeError; return; }
            phase = 'ready'; listen();
        });
    }

    function state() {
        var c = cfg();
        if (phase !== 'ready') return { phase: phase, problem: blockedBy, dbPath: c.dbPath };
        return { phase: phase, running: running, port: c.port, addresses: lanAddresses(), database: dbName(c.dbPath), dbPath: c.dbPath, cors: c.cors,
            timeoutMs: c.timeoutMs, maxRows: c.maxRows, apiKey: apiKey(), keyUnsaved: keyUnsaved, sqliteVersion: sqliteVersion, problem: listenError || probeError, checkedAt: checkedAt,
            lastError: lastError, queries: counts.queries, denied: counts.denied, pending: queue.length + (busy ? 1 : 0) };
    }
    function json(res, body, code) { res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }

    return {
        start: function () { stopped = false; page = loadPage(ctx); apiKey(); setUpResults(); begin(); },
        stop: function () {
            stopped = true; generation++; close(); page = null;
            var waiting = queue; queue = [];
            waiting.forEach(function (w) { var e = new Error('The Shard was switched off'); e.status = 503; w.reject(e); });
        },
        status: function () {
            var c = cfg();
            if (phase !== 'ready') return { phase: phase, running: false, problem: blockedBy || undefined };
            return { phase: phase, running: running, port: c.port, sqlite: sqliteVersion, queries: counts.queries, problem: listenError || probeError || undefined };
        },

        // The dashboard page and its settings. These routes are Vetro's (paired device or page token), not the API's.
        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page || loadPage(ctx)); return true; }
            if (sub === 'state' && req.method === 'GET') { json(res, state()); return true; }
            if (req.method !== 'POST') return false;
            if (phase !== 'ready') { json(res, { ok: false, error: blockedBy || 'Still checking for the database' }, 409); return true; }
            if (sub === 'probe') { probe().then(function (s) { json(res, s); }, function (e) { json(res, { ok: false, error: String(e && e.message || e) }, 500); }); return true; }
            if (sub === 'regen-key') { replaceKey(); json(res, state()); return true; }
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
                    // A path that does not exist is refused, not saved: saving it would leave the Shard blocked at every
                    // start, with a page that offers no way back.
                    var newPath = patch.dbPath && patch.dbPath !== before.dbPath;
                    (newPath ? readable(patch.dbPath) : Promise.resolve(true)).then(function (ok) {
                        if (!ok) return json(res, { ok: false, error: 'That file does not exist: ' + patch.dbPath + '. The database path was not changed.' }, 400);
                        try { save(patch); } catch (e) { return json(res, { ok: false, error: 'Settings could not be saved: ' + e.message }, 500); }
                        if (newPath) return begin().then(function () { json(res, state()); });
                        if (!stopped && patch.port && patch.port !== before.port) { close(); listen(); }
                        json(res, state());
                    }, function (e) { json(res, { ok: false, error: 'Could not check the file: ' + (e && e.message || e) }, 500); });
                });
                return true;
            }
            return false;
        }
    };
};
module.exports.VERSION = VERSION;
