'use strict';
// Vetro plugin "arc-fix" (API 1). Plain ES5: the TV runs Node 4.4 or 12.
// Switching the plugin on starts the ARC watcher; switching it off stops it. Settings live in ctx.config.

var ArcFix = require('./arc-fix.js').ArcFix;
var PAGE = require('./page.js');

var TICK_MS = 10000;          // how often the watcher is checked while the plugin is on
var BODY_MAX = 4096;

function json(res, body, code) {
    res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

function readJson(req, res, cb) {
    var chunks = [], size = 0, done = false;
    req.on('error', function () { done = true; });
    req.on('data', function (c) {
        if (done) return;
        size += c.length;
        if (size > BODY_MAX) { done = true; json(res, { error: 'Request body too large' }, 413); return; }
        chunks.push(c);
    });
    req.on('end', function () {
        if (done) return;
        var p;
        try { p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return json(res, { error: 'Invalid JSON' }, 400); }
        if (!p || typeof p !== 'object') return json(res, { error: 'Invalid JSON' }, 400);
        cb(p);
    });
}

module.exports = function (ctx) {
    var arc = new ArcFix({ execute: ctx.execute, store: ctx.config, dir: ctx.dir });
    var timer = null;

    function tick() { arc.supervise().catch(function () { /* the next round tries again */ }); }

    return {
        start: function () {
            if (timer) return;
            arc.begin().catch(function () { /* shown on the page; tick() retries */ });
            timer = setInterval(tick, TICK_MS);
            if (timer.unref) timer.unref();
        },
        stop: function () {
            if (timer) clearInterval(timer);
            timer = null;
            arc.end().catch(function () { /* best effort */ });
        },
        status: function () {
            var s = arc.readState();
            return { watching: arc.active, delaySeconds: s.delaySeconds, port: s.port, error: arc.lastError };
        },
        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(PAGE);
                return true;
            }
            if (sub === 'status' && req.method === 'GET') {
                arc.status().then(function (d) { json(res, d); }, function (e) { json(res, { error: e.message }, 503); });
                return true;
            }
            if (sub === 'action' && req.method === 'POST') {
                readJson(req, res, function (p) {
                    var t = p.action === 'configure' ? arc.configure(p) : p.action === 'trigger' ? arc.trigger(p) : Promise.reject(new Error('Invalid ARC action'));
                    t.then(function (d) { json(res, d); }, function (e) { json(res, { ok: false, error: e.message }, 409); });
                });
                return true;
            }
            return false;
        }
    };
};
