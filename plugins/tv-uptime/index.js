'use strict';
// Reads /proc/uptime through the agent. Needs the "exec" permission: without it
// ctx.execute rejects and the page says so.

module.exports = function (ctx) {
    var PAGE = '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">' +
        '<body style="font:16px system-ui;margin:24px"><h2>TV uptime</h2><p id="u">Reading…</p><button id="b">Refresh</button><script>' +
        'function get(){fetch("uptime").then(function(r){return r.json()}).then(function(d){document.getElementById("u").textContent=d.error?d.error:"On for "+d.text})}' +
        'document.getElementById("b").onclick=get;get();</script></body>';

    function json(res, body, code) {
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }

    function format(seconds) {
        var d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
        return (d ? d + ' d ' : '') + h + ' h ' + m + ' min';
    }

    return {
        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(PAGE);
                return true;
            }
            if (sub === 'uptime' && req.method === 'GET') {
                ctx.execute('cat /proc/uptime', 5000).then(function (r) {
                    var s = parseFloat(String(r.stdout || '').split(' ')[0]);
                    if (isNaN(s)) return json(res, { error: 'Could not read the uptime' }, 502);
                    json(res, { seconds: s, text: format(s) });
                }).catch(function (e) { json(res, { error: String(e.message || e) }, 503); });
                return true;
            }
            return false;
        }
    };
};
