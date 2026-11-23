'use strict';

// Vetro Shard: Keyboard & Remote
//
// Dual input architecture:
//   1. Navigation, control keys & ASCII typing: executed directly on the TV via
//      /usr/bin/input_keyevent (ctx.execute).
//   2. Full Unicode (all languages): sent via Samsung Remote API WebSocket
//      (wss://<tvIp>:8002) directly from the browser using pre-paired token.
//
// Continuous Key Repeat:
//   - WebSocket mode: uses Samsung Remote "Press" and "Release" commands.
//   - HTTP mode: sends a single input_keyevent down/up pair (letting the TV handle
//     native key repeat and cursor acceleration) with a 6 s auto-release safety cap.

var fs = require('fs');
var path = require('path');
var os = require('os');

var LATIN_MAP = {
    ' ': 'space',
    '.': 'period',
    ',': 'comma',
    '-': 'minus',
    '=': 'equal',
    '/': 'slash',
    ';': 'semicolon',
    "'": 'apostrophe',
    '[': 'bracketleft',
    ']': 'bracketright',
    '\\': 'backslash',
    '`': 'grave'
};

var SHIFT_MAP = {
    '!': '1',
    '@': '2',
    '#': '3',
    '$': '4',
    '%': '5',
    '^': '6',
    '&': '7',
    '*': '8',
    '(': '9',
    ')': '0',
    '_': 'minus',
    '+': 'equal',
    '~': 'grave',
    '{': 'bracketleft',
    '}': 'bracketright',
    '|': 'backslash',
    ':': 'semicolon',
    '"': 'apostrophe',
    '<': 'comma',
    '>': 'period',
    '?': 'slash'
};

function loadPage(ctx) {
    var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
    for (var i = 0; i < places.length; i++) {
        try { return fs.readFileSync(places[i], 'utf8'); } catch (e) { /* next */ }
    }
    return '<!doctype html><meta charset="utf-8"><p>Page file missing: reinstall this Shard.</p>';
}

function getTvIp() {
    try {
        var ifaces = os.networkInterfaces();
        for (var name in ifaces) {
            var list = ifaces[name];
            if (!list) continue;
            for (var i = 0; i < list.length; i++) {
                var addr = list[i];
                if (addr.family === 'IPv4' && !addr.internal && addr.address !== '127.0.0.1') {
                    return addr.address;
                }
            }
        }
    } catch (e) {}
    return null;
}

function readJson(req, maxBytes, callback) {
    var limit = maxBytes || 4096;
    var body = '';
    var done = false;

    function finish(err, res) {
        if (done) return;
        done = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        callback(err, res);
    }

    function onError(err) {
        finish(err || new Error('Request error'), null);
    }

    function onData(chunk) {
        if (done) return;
        body += chunk;
        if (body.length > limit) {
            finish(new Error('Payload too large'), null);
        }
    }

    function onEnd() {
        if (done) return;
        var parsed;
        try {
            parsed = JSON.parse(body);
        } catch (e) {
            return finish(new Error('Invalid JSON'), null);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return finish(new Error('Invalid JSON object'), null);
        }
        finish(null, parsed);
    }

    req.on('error', onError);
    req.on('data', onData);
    req.on('end', onEnd);
}

module.exports = function (ctx) {

    var page = null;
    var activeHoldTimer = null;
    var activeHoldKey = null;
    var activeHoldDownPromise = null;
    var mouseHeldNode = null;
    var mouseHoldTimer = null;
    var mouseHoldStarted = 0;

    function findMouseNode() {
        try {
            var txt = fs.readFileSync('/proc/bus/input/devices', 'utf8');
            var blocks = txt.split(/\n\s*\n/);
            var fallback = null;
            for (var i = 0; i < blocks.length; i++) {
                var b = blocks[i];
                var hm = /^H:\s*Handlers=(.*)$/m.exec(b);
                if (!hm || !/\bmouse\d+\b/.test(hm[1])) continue;
                var em = /\bevent(\d{1,2})\b/.exec(hm[1]);
                if (!em) continue;
                var node = '/dev/input/event' + em[1];
                if (/Remote-Input\(Mouse\)|SMART_VIEW/i.test(b)) return node;
                if (!fallback) fallback = node;
            }
            return fallback;
        } catch (e) {
            return null;
        }
    }

    function buildJumpCmds(x, y) {
        var cmds = [
            '/usr/bin/enlightenment_info -mousegen --axis=-2000,-2000',
            '/usr/bin/enlightenment_info -mousegen --axis=-2000,-2000'
        ];
        if (x < 36 && y < 36 && (x > 0 || y > 0)) {
            cmds.push('/usr/bin/enlightenment_info -mousegen --axis=100,100');
            cmds.push('/usr/bin/enlightenment_info -mousegen --axis=' + Math.round((x - 200) / 2) + ',' + Math.round((y - 200) / 2));
        } else if (x > 0 || y > 0) {
            cmds.push('/usr/bin/enlightenment_info -mousegen --axis=' + Math.round(x / 2) + ',' + Math.round(y / 2));
        }
        return cmds;
    }

    function clearMouseHoldTimer() {
        if (mouseHoldTimer) {
            clearTimeout(mouseHoldTimer);
            mouseHoldTimer = null;
        }
    }

    function startMouseHoldTimer(node, isRefresh) {
        clearMouseHoldTimer();
        var now = Date.now();
        if (!isRefresh || !mouseHoldStarted) {
            mouseHoldStarted = now;
        }
        var remaining = 30000 - (now - mouseHoldStarted);
        if (remaining <= 0) {
            stopMouseHold();
            return;
        }
        mouseHeldNode = node;
        mouseHoldTimer = setTimeout(function () {
            mouseHoldTimer = null;
            try {
                stopMouseHold();
            } catch (e) {}
        }, Math.min(6000, remaining));
    }

    function stopMouseHold() {
        clearMouseHoldTimer();
        mouseHoldStarted = 0;
        if (mouseHeldNode) {
            var n = mouseHeldNode;
            mouseHeldNode = null;
            var relCmd = "sh -c '/usr/bin/enlightenment_info -init_device --node=" + n + " >/dev/null 2>&1; /usr/bin/enlightenment_info -mousegen --btn=0 --state=up >/dev/null 2>&1; /usr/bin/enlightenment_info -deinit_device >/dev/null 2>&1'";
            ctx.execute(relCmd, 2000).catch(function () {});
        }
    }

    function stopHold() {
        if (activeHoldTimer) {
            clearTimeout(activeHoldTimer);
            activeHoldTimer = null;
        }
        if (activeHoldKey) {
            var k = activeHoldKey;
            var pendingDown = activeHoldDownPromise;
            activeHoldKey = null;
            activeHoldDownPromise = null;
            var sendUp = function () {
                try {
                    ctx.execute('/usr/bin/input_keyevent ' + k + ' up', 2000).catch(function () {});
                } catch (e) {}
            };
            if (pendingDown && typeof pendingDown.then === 'function') {
                pendingDown.then(sendUp, sendUp);
            } else {
                sendUp();
            }
        }
    }

    function startHold(key) {
        stopHold();
        activeHoldKey = key;
        var downPromise = null;
        try {
            downPromise = ctx.execute('/usr/bin/input_keyevent ' + key + ' down', 2000).catch(function () {});
        } catch (e) {}
        activeHoldDownPromise = downPromise;
        if (downPromise && typeof downPromise.then === 'function') {
            downPromise.then(function () {
                if (activeHoldDownPromise === downPromise) {
                    activeHoldDownPromise = null;
                }
            }, function () {
                if (activeHoldDownPromise === downPromise) {
                    activeHoldDownPromise = null;
                }
            });
        }
        activeHoldTimer = setTimeout(function () {
            activeHoldTimer = null;
            stopHold();
        }, 6000);
    }

    function getCfg() {
        var c = ctx.config.get();
        return (c && typeof c === 'object') ? c : {};
    }

    function saveCfg(c) {
        ctx.config.set(c);
    }

    function unlinkFile(filePath) {
        fs.unlink(filePath, function (err) {
            if (err && err.code !== 'ENOENT') {
                try {
                    ctx.execute("rm -f '" + filePath + "'", 2000).catch(function () {});
                } catch (e) {}
            }
        });
    }

    return {
        start: function () {
            page = loadPage(ctx);
        },

        stop: function () {
            stopHold();
            stopMouseHold();
            page = null;
        },

        status: function () {
            var cfg = getCfg();
            return { paired: !!(cfg && cfg.token) };
        },

        route: function (req, res, sub) {

            // GET api/ui
            if (sub === 'ui' && req.method === 'GET') {
                if (!page) page = loadPage(ctx);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(page || '');
                return true;
            }

            // GET api/status
            if (sub === 'status' && req.method === 'GET') {
                var cfg0 = getCfg();
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'cache-control': 'no-store'
                });
                res.end(JSON.stringify({
                    ok: true,
                    paired: !!(cfg0 && cfg0.token),
                    tvIp: getTvIp()
                }));
                return true;
            }

            // GET api/token — returns saved Samsung Remote pairing token to the sandboxed Shard page
            if (sub === 'token' && req.method === 'GET') {
                var cfgTok = getCfg();
                var tok = (typeof cfgTok.token === 'string' && cfgTok.token.length > 0) ? cfgTok.token : null;
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'cache-control': 'no-store'
                });
                res.end(JSON.stringify({ ok: true, token: tok }));
                return true;
            }

            // POST api/savetoken
            if (sub === 'savetoken' && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }
                    try {
                        var c2 = getCfg();
                        if (typeof parsed.token === 'string' && parsed.token.length > 0 && parsed.token.length < 256) {
                            c2.token = parsed.token;
                        } else if (parsed.reset || parsed.token === null) {
                            delete c2.token;
                        }
                        saveCfg(c2);
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));
                    } catch (e) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'failed to save configuration' }));
                    }
                });
                return true;
            }

            // POST api/key — inject single keysym or manage hold action
            if (sub === 'key' && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }
                    var key = parsed.key;
                    var action = parsed.action;
                    var isShift = !!parsed.shift;
                    var isCtrl = !!parsed.ctrl;

                    if (!key || typeof key !== 'string' || !/^[A-Za-z0-9_]+$/.test(key)) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'invalid key name' }));
                        return;
                    }

                    if (action === 'down') {
                        startHold(key);
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, holding: true }));
                        return;
                    }

                    if (action === 'up') {
                        stopHold();
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, holding: false }));
                        return;
                    }

                    // Single tap / click
                    stopHold();

                    if (/^[A-Z]$/.test(key)) {
                        key = key.toLowerCase();
                        isShift = true;
                    }

                    var cmd;
                    if (isCtrl) {
                        cmd = 'sh -c "/usr/bin/input_keyevent Control_L down; /usr/bin/input_keyevent ' + key + '; /usr/bin/input_keyevent Control_L up"';
                    } else if (isShift) {
                        cmd = 'sh -c "/usr/bin/input_keyevent Shift_L down; /usr/bin/input_keyevent ' + key + '; /usr/bin/input_keyevent Shift_L up"';
                    } else {
                        cmd = '/usr/bin/input_keyevent ' + key;
                    }

                    ctx.execute(cmd, 5000).then(function (r) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: r.exit_code === 0, stderr: r.stderr }));
                    }, function (e) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                });
                return true;
            }

            // POST api/type — inject ASCII string via input_keyevent sequence
            if (sub === 'type' && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }
                    var text = parsed.text;
                    if (!text || typeof text !== 'string') {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'missing text' }));
                        return;
                    }
                    var truncated = false;
                    if (text.length > 200) {
                        text = text.slice(0, 200);
                        truncated = true;
                    }
                    var cmds = [];
                    var dropped = [];
                    for (var i = 0; i < text.length; i++) {
                        var ch = text[i];
                        if (/^[a-z0-9]$/.test(ch)) {
                            cmds.push('/usr/bin/input_keyevent ' + ch);
                        } else if (/^[A-Z]$/.test(ch)) {
                            cmds.push('/usr/bin/input_keyevent Shift_L down; /usr/bin/input_keyevent ' + ch.toLowerCase() + '; /usr/bin/input_keyevent Shift_L up');
                        } else if (SHIFT_MAP[ch]) {
                            cmds.push('/usr/bin/input_keyevent Shift_L down; /usr/bin/input_keyevent ' + SHIFT_MAP[ch] + '; /usr/bin/input_keyevent Shift_L up');
                        } else if (LATIN_MAP[ch]) {
                            cmds.push('/usr/bin/input_keyevent ' + LATIN_MAP[ch]);
                        } else {
                            dropped.push(ch);
                        }
                    }
                    if (cmds.length === 0) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({
                            ok: true,
                            dropped: dropped.length > 0 ? dropped : undefined,
                            truncated: truncated || undefined
                        }));
                        return;
                    }
                    var cmd = "sh -c '" + cmds.join('; sleep 0.04; ') + "'";
                    ctx.execute(cmd, 15000).then(function (r) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({
                            ok: r.exit_code === 0,
                            dropped: dropped.length > 0 ? dropped : undefined,
                            truncated: truncated || undefined,
                            stderr: r.stderr
                        }));
                    }, function (e) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                });
                return true;
            }

            // POST api/mouse — fallback cursor jump/click/drag and scroll wheel via enlightenment_info
            if (sub === 'mouse' && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }
                    var action = String(parsed.action || 'click');
                    var node = findMouseNode();
                    if (!node) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'no mouse device node' }));
                        return;
                    }
                    var hasXY = (typeof parsed.x === 'number' && typeof parsed.y === 'number' && isFinite(parsed.x) && isFinite(parsed.y));
                    var x = hasXY ? Math.max(0, Math.min(1919, Math.round(parsed.x))) : 0;
                    var y = hasXY ? Math.max(0, Math.min(1079, Math.round(parsed.y))) : 0;
                    var cmds = ['/usr/bin/enlightenment_info -init_device --node=' + node];

                    if (action === 'move' && hasXY) {
                        cmds = cmds.concat(buildJumpCmds(x, y));
                    } else if (action === 'click' && hasXY) {
                        cmds = cmds.concat(buildJumpCmds(x, y));
                        cmds.push('/usr/bin/enlightenment_info -mousegen --btn=0');
                    } else if (action === 'clickInPlace') {
                        cmds.push('/usr/bin/enlightenment_info -mousegen --btn=0');
                    } else if (action === 'dblclick' && hasXY) {
                        cmds = cmds.concat(buildJumpCmds(x, y));
                        cmds.push('/usr/bin/enlightenment_info -mousegen --btn=0');
                        cmds.push('usleep 60000');
                        cmds.push('/usr/bin/enlightenment_info -mousegen --btn=0');
                    } else if (action === 'rightclick' && hasXY) {
                        cmds = cmds.concat(buildJumpCmds(x, y));
                        cmds.push('/usr/bin/enlightenment_info -mousegen --btn=1');
                    } else if (action === 'down' && hasXY) {
                        cmds = cmds.concat(buildJumpCmds(x, y));
                        cmds.push('/usr/bin/enlightenment_info -mousegen --btn=0 --state=down');
                        startMouseHoldTimer(node, false);
                    } else if (action === 'drag') {
                        if (mouseHeldNode) {
                            startMouseHoldTimer(mouseHeldNode, true);
                        }
                        var dx = Math.max(-2000, Math.min(2000, Math.round(Number(parsed.dx) || 0)));
                        var dy = Math.max(-2000, Math.min(2000, Math.round(Number(parsed.dy) || 0)));
                        if (dx === 0 && dy === 0) {
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: true }));
                            return;
                        }
                        cmds.push('/usr/bin/enlightenment_info -mousegen --axis=' + dx + ',' + dy + ' --state=move');
                    } else if (action === 'up') {
                        cmds.push('/usr/bin/enlightenment_info -mousegen --btn=0 --state=up');
                        clearMouseHoldTimer();
                        mouseHeldNode = null;
                        mouseHoldStarted = 0;
                    } else if (action === 'wheel') {
                        var w = Math.max(-5, Math.min(5, Math.round(Number(parsed.delta) || 0)));
                        if (w === 0) w = -1;
                        if (hasXY) cmds = cmds.concat(buildJumpCmds(x, y));
                        cmds.push('/usr/bin/enlightenment_info -mousegen --wheel=' + w);
                    } else {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'invalid mouse action' }));
                        return;
                    }

                    cmds.push('/usr/bin/enlightenment_info -deinit_device');
                    var shCmd = "sh -c '" + cmds.join(' >/dev/null 2>&1; ') + " >/dev/null 2>&1'";
                    ctx.execute(shCmd, 5000).then(function (r) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: r.exit_code === 0, stderr: r.stderr }));
                    }, function (e) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                });
                return true;
            }

            // GET api/screenshot — captures 1080p frame buffer from Enlightenment WM
            if (sub === 'screenshot' && req.method === 'GET') {
                var shotId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
                var shotPath = '/tmp/shot_' + shotId + '.png';
                var shotCmd = "dbus-send --system --print-reply --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.info.dump_screen string:'" + shotPath + "'";

                ctx.execute(shotCmd, 10000).then(function (r) {
                    if (r.exit_code !== 0) {
                        unlinkFile(shotPath);
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: r.stderr || 'Screenshot capture failed' }));
                        return;
                    }
                    fs.readFile(shotPath, function (err, data) {
                        unlinkFile(shotPath);
                        if (err) {
                            res.writeHead(500, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: err.message }));
                            return;
                        }
                        res.writeHead(200, {
                            'content-type': 'image/png',
                            'cache-control': 'no-store, must-revalidate',
                            'content-length': data.length
                        });
                        res.end(data);
                    });
                }, function (e) {
                    unlinkFile(shotPath);
                    res.writeHead(500, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                });
                return true;
            }

            return false;
        }
    };
};
