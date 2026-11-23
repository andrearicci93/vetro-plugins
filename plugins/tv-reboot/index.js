'use strict';
// TV reboot: a Vetro Shard with one button that restarts the TV. Plain ES5: older TVs run Node 4.4.
// Nothing runs on start: the enabled state survives restarts, so running anything there would loop the boot.

module.exports = function (ctx) {
    // Vetro puts the next boot in safe mode if it did not stay up for 60 s; keep a margin.
    var MIN_UPTIME_S = 90;
    var DELAY_MS = 1500;
    // With Samsung Home (com.samsung.tv.csfs) disabled the boot script loops and the TV may never finish
    // starting (Vetro's RELEASE-0.5.0.md). Refuse unless the registry clearly says it is enabled.
    var CSFS = 'com.samsung.tv.csfs';
    var GUARD =
        'g=$(sqlite3 -readonly /opt/dbspace/.pkgmgr_parser.db ' +
        '"SELECT app_disable FROM package_app_info WHERE app_id=\'' + CSFS + '\';" 2>/dev/null); ' +
        'u=$(sqlite3 -readonly /opt/dbspace/user/5001/.pkgmgr_parser.db ' +
        '"SELECT is_disabled FROM package_app_info_for_uid WHERE app_id=\'' + CSFS + '\';" 2>/dev/null); ' +
        'if [ "$g" != "false" ]; then echo "Samsung Home state is \\"${g:-unreadable}\\": not rebooting"; exit 3; fi; ' +
        'case "$u" in *true*) echo "Samsung Home is disabled for the user: not rebooting"; exit 3;; esac';
    var CHECK = GUARD + '; echo ok';
    var REBOOT = GUARD + '; sync; systemctl reboot || reboot || reboot -f; echo "reboot command returned $?"; exit 1';

    var state = 'idle';        // idle | checking | rebooting | failed
    var message = '';
    var at = 0;

    var PAGE = '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<style>body{font:16px system-ui;margin:24px;max-width:36em}' +
        'button{font:inherit;padding:14px 28px;border-radius:10px;border:0;background:#c62828;color:#fff;cursor:pointer}' +
        'button.armed{background:#8e0000}button:disabled{opacity:.5;cursor:default}' +
        '#msg{margin-top:16px;white-space:pre-wrap}</style>' +
        '<h2>Reboot TV</h2><p>Restarts the whole TV. Vetro and its Shards come back on their own after the boot.</p>' +
        '<button id="b">Reboot TV</button><div id="msg"></div><script>' +
        'var b=document.getElementById("b"),m=document.getElementById("msg"),armed=0,t;' +
        'function show(d){m.textContent=d.message||"";var busy=d.state==="rebooting"||d.state==="checking";b.disabled=busy;' +
        'if(busy){b.textContent=d.state==="checking"?"Checking…":"Rebooting…";}else if(!armed){b.textContent="Reboot TV";}}' +
        'function get(){fetch("state").then(function(r){return r.json()}).then(show).catch(function(){m.textContent="TV is not answering (rebooting?)"})}' +
        'function disarm(){armed=0;b.classList.remove("armed");b.textContent="Reboot TV"}' +
        'b.onclick=function(){if(!armed){armed=1;b.classList.add("armed");b.textContent="Press again to reboot";t=setTimeout(disarm,5000);return}' +
        'clearTimeout(t);disarm();b.disabled=true;' +
        'fetch("reboot",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(r){return r.json()}).then(show).catch(function(){m.textContent="Request failed"})};' +
        'get();setInterval(get,2000);' +
        '</script>';

    function json(res, body, code) {
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }
    function snapshot() { return { state: state, message: message, at: at }; }
    function out(r) { return String((r && (r.stdout || r.stderr)) || '').trim(); }
    function fail(text) { state = 'failed'; message = text; }

    // Check first, then answer; the reboot itself runs after the reply has left.
    function reboot(res) {
        if (state === 'checking' || state === 'rebooting') { json(res, snapshot()); return; }
        var up = Math.floor(process.uptime());
        if (up < MIN_UPTIME_S) {
            fail('Vetro started ' + up + ' s ago. Wait ' + (MIN_UPTIME_S - up) + ' s more: a reboot this early puts the next start in safe mode.');
            json(res, snapshot());
            return;
        }
        state = 'checking'; message = ''; at = Date.now();
        ctx.execute(CHECK, 10000).then(function (r) {
            var text = out(r);
            if (r && r.exit_code === 0 && /ok$/.test(text)) {
                state = 'rebooting'; message = 'Rebooting… the TV goes dark in a few seconds.';
                json(res, snapshot());
                setTimeout(run, DELAY_MS);
            } else {
                fail(text || ('Check failed (exit ' + (r && r.exit_code) + ')'));
                json(res, snapshot());
            }
        }).catch(function (e) {
            fail('Check failed: ' + (e && e.message || e));
            if (!res.headersSent) json(res, snapshot());
        });
    }
    function run() {
        ctx.execute(REBOOT, 30000).then(function (r) {
            // Still here: the TV did not go down.
            fail(out(r) || ('Reboot did not happen (exit ' + (r && r.exit_code) + ')'));
        }).catch(function (e) {
            // The connection dropping as the TV goes down also lands here.
            if (state === 'rebooting') message = 'Rebooting… (' + (e && e.message || e) + ')';
        });
    }

    return {
        start: function () { state = 'idle'; message = ''; },
        stop: function () { /* nothing to release */ },
        status: function () { return snapshot(); },
        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(PAGE);
                return true;
            }
            if (sub === 'state' && req.method === 'GET') { json(res, snapshot()); return true; }
            if (sub === 'reboot' && req.method === 'POST') { reboot(res); return true; }
            return false;
        }
    };
};
