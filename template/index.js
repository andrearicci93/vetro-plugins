'use strict';
// My plugin: starting point for a Vetro plugin. Plain ES5 (var, function, no arrow functions, no
// let/const/async/classes): older TVs run Node 4.4. Keep it readable: no minified code, no eval, no
// code downloaded at run time. docs/what-a-plugin-can-do.md says what a plugin may and may not do.
//
// Everything the plugin owns goes through `ctx`:
//   ctx.id, ctx.dir            its id and its own folder
//   ctx.config.get() / .set()  its own config.json (the only thing kept when the plugin is updated)
//   ctx.execute(cmd, ms)       shell command on the TV as root; Promise; needs "exec" in permissions

module.exports = function (ctx) {
    var count = 0;

    // The page shown in the dashboard (manifest "ui"). It runs in a sandboxed frame: relative URLs
    // only, no cookies, no storage. A POST is sent as text/plain so it works on every Vetro version.
    var PAGE = '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">' +
        '<body style="font:16px system-ui;margin:24px"><h2>My plugin</h2>' +
        '<p>Presses: <b id="n">…</b></p><button id="b">Press</button><script>' +
        'function show(d){document.getElementById("n").textContent=d.count}' +
        'function get(){fetch("count").then(function(r){return r.json()}).then(show)}' +
        'document.getElementById("b").onclick=function(){' +
        'fetch("press",{method:"POST",headers:{"Content-Type":"text/plain"},body:"{}"})' +
        '.then(function(r){return r.json()}).then(show)};get();' +
        '</script></body>';

    function json(res, body, code) {
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }

    return {
        // Switched on. Open timers and sockets here, and close them in stop().
        start: function () { count = ctx.config.get().count || 0; },

        // Switched off (also called if start() throws). Release everything you opened.
        stop: function () { /* nothing to release */ },

        // Shown by the dashboard as the plugin's `detail`. Keep it small and fast.
        status: function () { return { count: count }; },

        // Served under /plugins/<id>/api/<sub>. Return false for anything you do not handle.
        // Errors thrown here are counted (3 in a row switch the plugin off). Errors thrown later,
        // inside timers or promises you started, are NOT caught by the host: catch them yourself.
        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(PAGE);
                return true;
            }
            if (sub === 'count' && req.method === 'GET') { json(res, { count: count }); return true; }
            if (sub === 'press' && req.method === 'POST') {
                count++;
                ctx.config.set({ count: count });
                json(res, { count: count });
                return true;
            }
            return false;
        }
    };
};
