'use strict';
// EFL leak fix: a Vetro Shard. Plain ES5: older TVs run Node 4.4.
//
// On some Samsung firmware msf-server (the Multiscreen / SmartThings remote server) spawns
// /usr/bin/pw-show-lastset every second. Each run saves the Elementary config
// (~/share/.elementary/config/tv/base.cfg) with the same content, every EFL app on the TV
// (tv-viewer, menu, YouTube, ScreenMirroring, ...) reloads its config and fonts and leaks heap,
// and after a few hours the UI stops answering while video and sound keep playing.
//
// The fix binds /bin/true over the helper in the init mount namespace, so msf-server still runs
// but the helper does nothing. A bind mount does not survive a reboot, so the Shard applies it
// once the root agent answers and checks it every 10 minutes. Switching it off removes the bind.

var TARGET = '/usr/bin/pw-show-lastset';
var BOUND = 'grep -q " ' + TARGET + ' " /proc/1/mountinfo';
var CHECK = 'if [ ! -e ' + TARGET + ' ]; then echo absent; elif ' + BOUND + '; then echo bound; else echo free; fi';
var APPLY = '[ -e ' + TARGET + ' ] && ! ' + BOUND + ' && nsenter -t 1 -m mount --bind /bin/true ' + TARGET + '; ' + CHECK;
var UNDO = 'n=0; while ' + BOUND + ' && [ $n -lt 5 ]; do nsenter -t 1 -m umount ' + TARGET + ' || break; n=$((n+1)); done; ' + CHECK;

var RETRY_MS = 15000, RETRY_MAX = 80, CHECK_MS = 600000;

module.exports = function (ctx) {
    var timer = null, tries = 0, busy = false, running = false;
    var st = { state: 'idle', result: null, lastCheck: null, lastError: null };

    function run(cmd) {
        return ctx.execute(cmd, 15000).then(function (r) {
            var out = String(r && r.stdout || '').trim();
            if (r && (r.exit_code || r.timed_out)) throw new Error(String(r && r.stderr || out || 'command failed').trim());
            return out.split('\n').pop();
        });
    }

    function schedule(ms) {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!running) return;
        timer = setTimeout(tick, ms);
        if (timer.unref) timer.unref();
    }

    function record(out) {
        st.result = out; st.lastCheck = new Date().toISOString();
    }

    function tick() {
        timer = null;
        if (!running) return;
        if (busy) { schedule(RETRY_MS); return; }
        busy = true;
        run(APPLY).then(function (out) {
            record(out);
            if (out === 'bound') {
                st.state = 'active'; st.lastError = null; tries = 0;
                schedule(CHECK_MS);
            } else if (out === 'absent') {
                // This firmware has no helper: nothing to do, look again later (an update may add it).
                st.state = 'not needed'; st.lastError = null; tries = 0;
                schedule(CHECK_MS);
            } else {
                throw new Error('Bind is not in place (' + out + ')');
            }
        }).catch(function (e) {
            st.lastError = String(e && e.message || e);
            // The root agent does not answer for the first minute or two after a boot.
            if (++tries <= RETRY_MAX) { st.state = 'waiting'; schedule(RETRY_MS); }
            else { st.state = 'failed'; tries = 0; schedule(CHECK_MS); }
        }).then(function () { busy = false; });
    }

    function json(res, body, code) {
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }

    var PAGE = '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<style>body{font:16px system-ui;margin:24px;max-width:40em}pre{white-space:pre-wrap}' +
        'button{font:inherit;padding:10px 20px;border-radius:8px}</style>' +
        '<h2>EFL leak fix</h2>' +
        '<p>Keeps <code>' + TARGET + '</code> switched off, so msf-server stops rewriting the Elementary ' +
        'config every second and the TV apps stop leaking memory. <b>active</b> means the fix is in place; ' +
        '<b>not needed</b> means this firmware has no such helper.</p>' +
        '<pre id="s">Reading…</pre><button id="b">Check now</button><script>' +
        'var s=document.getElementById("s");' +
        'function show(d){s.textContent=JSON.stringify(d,null,2)}' +
        'function get(){fetch("state").then(function(r){return r.json()}).then(show).catch(function(){s.textContent="No answer"})}' +
        'document.getElementById("b").onclick=function(){s.textContent="Checking…";' +
        'fetch("check",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(r){return r.json()}).then(show).catch(function(){s.textContent="Request failed"})};' +
        'get();</script>';

    return {
        start: function () { running = true; tries = 0; st.state = 'waiting'; schedule(2000); },
        stop: function () {
            running = false;
            if (timer) { clearTimeout(timer); timer = null; }
            st.state = 'off';
            return run(UNDO).then(record, function () {});
        },
        status: function () { return { state: st.state, result: st.result, lastCheck: st.lastCheck, lastError: st.lastError }; },
        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(PAGE);
                return true;
            }
            if (sub === 'state' && req.method === 'GET') { json(res, st); return true; }
            if (sub === 'check' && req.method === 'POST') {
                if (!running) { json(res, st); return true; }
                run(APPLY).then(function (out) {
                    record(out);
                    if (out === 'bound') { st.state = 'active'; st.lastError = null; }
                    else if (out === 'absent') st.state = 'not needed';
                    json(res, st);
                }, function (e) { st.lastError = String(e && e.message || e); json(res, st, 503); });
                return true;
            }
            return false;
        }
    };
};
