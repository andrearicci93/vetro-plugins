'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var net = require('node:net');
var os = require('node:os');
var path = require('node:path');
var stream = require('node:stream');

var pluginFactory = require('../plugins/keyboard/index.js');

function createTempFiles(t) {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'vetro-kbd-test-'));
    var arpFile = path.join(root, 'arp');
    var inputFile = path.join(root, 'devices');
    fs.writeFileSync(arpFile, [
        'IP address       HW type     Flags       HW address            Mask     Device',
        '192.168.1.10     0x1         0x2         aa:bb:cc:dd:ee:01     *        wlan0',
        '192.168.1.20     0x1         0x2         aa:bb:cc:dd:ee:02     *        wlan0',
        '192.168.1.30     0x1         0x0         00:00:00:00:00:00     *        wlan0'
    ].join('\n') + '\n', 'utf8');
    fs.writeFileSync(inputFile, [
        'I: Bus=0003 Vendor=04e8 Product=1234 Version=0100',
        'N: Name="Remote-Input(Mouse)"',
        'H: Handlers=mouse0 event3',
        '',
        'I: Bus=0003 Vendor=0001 Product=0002 Version=0100',
        'N: Name="Other Mouse"',
        'H: Handlers=mouse1 event5',
        ''
    ].join('\n'), 'utf8');
    if (t && typeof t.after === 'function') {
        t.after(function () {
            try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
        });
    }
    return { root: root, arpFile: arpFile, inputFile: inputFile };
}

function createPluginHarness(t, opts) {
    opts = opts || {};
    var files = opts.files || createTempFiles(t);
    var cfgData = opts.initialConfig ? JSON.parse(JSON.stringify(opts.initialConfig)) : {};
    var execLog = [];
    var configWrites = 0;
    var dummyDotnet = path.join(files.root, 'dotnet');
    if (opts.dotnetExists) {
        fs.writeFileSync(dummyDotnet, '#!/bin/sh\n', 'utf8');
    }

    var ctx = {
        id: 'keyboard',
        dir: files.root,
        _arpPath: files.arpFile,
        _inputDevicesPath: files.inputFile,
        _dotnetPath: dummyDotnet,
        _hwUnit: 'vetro-kbd-test',
        config: {
            get: function () { return cfgData; },
            set: function (val) {
                configWrites++;
                cfgData = JSON.parse(JSON.stringify(val));
            }
        },
        execute: function (cmd, timeoutMs) {
            execLog.push({ cmd: cmd, timeoutMs: timeoutMs });
            if (typeof opts.onExecute === 'function') {
                return Promise.resolve(opts.onExecute(cmd, timeoutMs, execLog));
            }
            return Promise.resolve({ exit_code: 0, stdout: '', stderr: '' });
        }
    };

    var p = pluginFactory(ctx);
    p.start();
    if (t && typeof t.after === 'function') {
        t.after(function () {
            try { p.stop(); } catch (e) {}
        });
    }

    return {
        plugin: p,
        ctx: ctx,
        files: files,
        execLog: execLog,
        getConfig: function () { return cfgData; },
        getConfigWrites: function () { return configWrites; }
    };
}

function invokeRoute(plugin, opts) {
    return new Promise(function (resolve) {
        var req = new stream.PassThrough();
        req.method = opts.method || 'GET';
        req.url = opts.url || ('/' + opts.sub);
        req.headers = opts.headers || {};
        req.socket = { remoteAddress: opts.remoteAddress || '::ffff:192.168.1.10' };

        var statusCode = 200;
        var resHeaders = {};
        var chunks = [];
        var finished = false;
        var listeners = { finish: [], close: [] };

        var res = {
            headersSent: false,
            writableEnded: false,
            finished: false,
            writeHead: function (code, hdrs) {
                statusCode = code;
                this.headersSent = true;
                if (hdrs) {
                    var ks = Object.keys(hdrs);
                    for (var i = 0; i < ks.length; i++) {
                        resHeaders[ks[i].toLowerCase()] = hdrs[ks[i]];
                    }
                }
            },
            setHeader: function (k, v) { resHeaders[String(k).toLowerCase()] = v; },
            write: function (chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
            once: function (ev, fn) { if (listeners[ev]) listeners[ev].push(fn); },
            on: function (ev, fn) { if (listeners[ev]) listeners[ev].push(fn); },
            removeListener: function () {},
            emit: function () {},
            end: function (chunk) {
                if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                if (finished) return;
                finished = true;
                this.writableEnded = true;
                this.finished = true;
                var fl = listeners.finish.slice();
                for (var fi = 0; fi < fl.length; fi++) fl[fi]();
                var fullBuf = Buffer.concat(chunks);
                var raw = fullBuf.toString('utf8');
                var json = null;
                try { json = JSON.parse(raw); } catch (e) {}
                resolve({ handled: true, status: statusCode, headers: resHeaders, body: raw, rawBuffer: fullBuf, json: json });
            }
        };

        var handled = plugin.route(req, res, opts.sub);
        if (!handled) {
            resolve({ handled: false, status: 404, headers: resHeaders, body: '', json: null });
            return;
        }

        if (opts.body !== undefined) {
            process.nextTick(function () {
                var buf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
                req.end(buf);
            });
        } else if (req.method === 'POST') {
            process.nextTick(function () { req.end(); });
        }
    });
}

function createStreamViewer(plugin, url) {
    var req = new stream.PassThrough();
    req.method = 'GET';
    req.url = url || '/stream';
    req.headers = {};
    req.socket = { remoteAddress: '::ffff:192.168.1.10' };

    var chunks = [];
    var ended = false;
    var statusCode = null;
    var headers = {};
    var closeHandlers = [];

    var res = {
        headersSent: false,
        finished: false,
        socket: {
            writable: true,
            bufferSize: 0,
            setNoDelay: function () {},
            destroy: function () { this.writable = false; }
        },
        writeHead: function (code, hdrs) {
            statusCode = code;
            this.headersSent = true;
            if (hdrs) {
                var ks = Object.keys(hdrs);
                for (var i = 0; i < ks.length; i++) {
                    headers[ks[i].toLowerCase()] = hdrs[ks[i]];
                }
            }
        },
        write: function (chunk, cb) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            if (typeof cb === 'function') cb();
            return true;
        },
        on: function (ev, fn) {
            if (ev === 'close') closeHandlers.push(fn);
        },
        end: function (chunk) {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            ended = true;
            this.finished = true;
        }
    };

    var handled = plugin.route(req, res, 'stream');
    return {
        handled: handled,
        req: req,
        res: res,
        disconnect: function () { req.emit('close'); },
        getStatus: function () { return statusCode; },
        getHeaders: function () { return headers; },
        getData: function () { return Buffer.concat(chunks); },
        isEnded: function () { return ended; }
    };
}

function connectProducer(port) {
    return new Promise(function (resolve, reject) {
        var sock = net.connect(port, '127.0.0.1', function () { resolve(sock); });
        sock.on('error', reject);
    });
}

function extractStreamPort(cmd) {
    var m = /tcpclientsink host=127\.0\.0\.1 port=(\d+)/.exec(cmd || '');
    return m ? parseInt(m[1], 10) : 0;
}

function waitUntil(fn, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 2000);
    return new Promise(function (resolve, reject) {
        function step() {
            var val = fn();
            if (val) return resolve(val);
            if (Date.now() > deadline) return reject(new Error('waitUntil timed out'));
            setTimeout(step, 10);
        }
        step();
    });
}

// ==================== 1. STREAM STATE MACHINE ====================

test('stream pipeline serves MJPEG frames, caps viewers at 4, recovers on 1 drop, and handles listen() disconnect race', async function (t) {
    var launches = [];
    var stops = 0;
    var failNextLaunch = false;
    var h = createPluginHarness(t, {
        onExecute: function (cmd) {
            if (cmd.indexOf('gst-launch-1.0') >= 0) {
                launches.push(cmd);
                if (failNextLaunch) {
                    failNextLaunch = false;
                    return { exit_code: 1, stdout: '', stderr: 'gst failed' };
                }
            } else if (cmd.indexOf('rm -f /tmp/vetro-keyboard-stream.pid') >= 0) {
                stops++;
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });

    // A. Disconnect-before-listen() race: connect v0 and immediately close req BEFORE srv.listen returns
    var vRace = createStreamViewer(h.plugin);
    assert.equal(vRace.handled, true);
    assert.equal(vRace.getStatus(), 200);
    vRace.disconnect();

    await new Promise(function (r) { setTimeout(r, 40); });
    assert.equal(launches.length, 0, 'cancelled viewer must not launch gst-launch-1.0');

    // Connecting a new viewer after the cancelled listen() must cleanly recover and bind a new port
    var v1 = createStreamViewer(h.plugin);
    assert.equal(v1.getStatus(), 200);
    await waitUntil(function () { return launches.length === 1; });
    var port1 = extractStreamPort(launches[0]);
    assert.ok(port1 > 0, 'expected ephemeral loopback port > 0');

    var prod1 = await connectProducer(port1);
    t.after(function () { try { prod1.destroy(); } catch (e) {} });

    var jpeg1 = Buffer.from([0xFF, 0xD8, 0x01, 0x02, 0x03, 0xFF, 0xD9]);
    prod1.write(jpeg1);
    await waitUntil(function () { return v1.getData().indexOf(jpeg1) >= 0; });
    var out1 = v1.getData();
    assert.ok(out1.toString('ascii').indexOf('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpeg1.length) >= 0);

    // B. Cap at MAX_STREAM_CLIENTS = 4 (5th viewer gets 503)
    var v2 = createStreamViewer(h.plugin);
    var v3 = createStreamViewer(h.plugin);
    var v4 = createStreamViewer(h.plugin);
    var v5 = createStreamViewer(h.plugin);
    assert.equal(v2.getStatus(), 200);
    assert.equal(v3.getStatus(), 200);
    assert.equal(v4.getStatus(), 200);
    assert.equal(v5.getStatus(), 503);
    assert.equal(v5.json ? v5.json.error : JSON.parse(v5.getData().toString('utf8')).error, 'too many stream viewers');

    // C. Invalid stream_preset returns 400; valid preset persists & triggers restart while viewers active
    var badPreset = await invokeRoute(h.plugin, { method: 'POST', sub: 'stream_preset', body: { preset: 'ultra', quality: 'bad' } });
    assert.equal(badPreset.status, 400);

    var launchesBeforePreset = launches.length;
    var okPreset = await invokeRoute(h.plugin, { method: 'POST', sub: 'stream_preset', body: { preset: 'hd', quality: 80 } });
    assert.equal(okPreset.status, 200);
    assert.equal(okPreset.json.preset, 'hd');
    assert.equal(okPreset.json.width, 1280);
    assert.equal(okPreset.json.height, 720);
    assert.equal(okPreset.json.quality, 80);
    assert.equal(h.getConfig().streamPreset, 'hd');
    assert.equal(h.getConfig().streamQuality, 80);

    await waitUntil(function () { return launches.length > launchesBeforePreset; });
    var restartCmd = launches[launches.length - 1];
    assert.ok(restartCmd.indexOf('width=1280,height=720') >= 0);
    assert.ok(restartCmd.indexOf('quality=80') >= 0);

    // D. Producer disconnect recovery: 1st unexpected drop restarts (restores pipeline); failing launch closes viewers
    var portAfterPreset = extractStreamPort(restartCmd);
    var prod2 = await connectProducer(portAfterPreset);
    t.after(function () { try { prod2.destroy(); } catch (e) {} });
    await new Promise(function (r) { setTimeout(r, 30); });

    var launchesBeforeDrop = launches.length;
    prod2.destroy();
    await waitUntil(function () { return launches.length > launchesBeforeDrop; });
    assert.equal(v1.isEnded(), false, 'first producer drop should restart instead of closing viewers');

    // Trigger another preset restart whose launch fails with exit_code: 1 -> closes all viewers & stops pipeline
    failNextLaunch = true;
    var failPreset = await invokeRoute(h.plugin, { method: 'POST', sub: 'stream_preset', body: { preset: 'fast', quality: 45 } });
    assert.equal(failPreset.status, 200);
    await waitUntil(function () { return v1.isEnded() && v2.isEnded() && v3.isEnded() && v4.isEnded(); });
    assert.ok(stops >= 1);
});

// ==================== 2. PER-DEVICE PAIRING ISOLATION ====================

test('per-device pairing isolates tokens via salted ARP HMAC, migrates legacy token, and enforces 16-device LRU cap', async function (t) {
    var h = createPluginHarness(t, {
        initialConfig: { token: 'legacy-tok-000' }
    });

    // Legacy single token migrates transparently on first read when tokens map is empty
    var legRes = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.10' });
    assert.equal(legRes.status, 200);
    assert.equal(legRes.json.token, 'legacy-tok-000');
    assert.equal(legRes.json.legacy, true);
    assert.ok(legRes.json.deviceTag);

    // Device A saves its own token -> clears legacy token, isolates Device B
    var saveA = await invokeRoute(h.plugin, {
        method: 'POST',
        sub: 'savetoken',
        remoteAddress: '::ffff:192.168.1.10',
        body: { token: 'tok-device-A' }
    });
    assert.equal(saveA.status, 200);
    assert.equal(h.getConfig().token, undefined);

    var tokA = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.10' });
    var tokB = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.20' });
    assert.equal(tokA.json.token, 'tok-device-A');
    assert.equal(tokB.json.token, null, 'unpaired Device B must receive null');
    assert.notEqual(tokA.json.deviceTag, tokB.json.deviceTag);

    // Config JSON must never store raw MAC addresses or client IPs
    var rawCfgStr = JSON.stringify(h.getConfig());
    assert.equal(rawCfgStr.indexOf('aa:bb:cc:dd:ee:01'), -1);
    assert.equal(rawCfgStr.indexOf('192.168.1.10'), -1);

    // Device B saves its own token -> both devices coexist & status() hides raw tokens
    var saveB = await invokeRoute(h.plugin, {
        method: 'POST',
        sub: 'savetoken',
        remoteAddress: '::ffff:192.168.1.20',
        body: { token: 'tok-device-B' }
    });
    assert.equal(saveB.status, 200);

    var tokAAgain = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.10' });
    var tokBAgain = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.20' });
    assert.equal(tokAAgain.json.token, 'tok-device-A');
    assert.equal(tokBAgain.json.token, 'tok-device-B');

    assert.deepEqual(h.plugin.status(), { paired: true });
    var statusB = await invokeRoute(h.plugin, { method: 'GET', sub: 'status', remoteAddress: '::ffff:192.168.1.20' });
    assert.equal(statusB.json.paired, true);
    assert.equal(JSON.stringify(statusB.json).indexOf('tok-device-B'), -1);

    // Device A reset deletes only Device A while preserving Device B
    var resetA = await invokeRoute(h.plugin, {
        method: 'POST',
        sub: 'savetoken',
        remoteAddress: '::ffff:192.168.1.10',
        body: { reset: true }
    });
    assert.equal(resetA.status, 200);
    var afterResetA = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.10' });
    var afterResetB = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.20' });
    assert.equal(afterResetA.json.token, null);
    assert.equal(afterResetB.json.token, 'tok-device-B');

    // Enforce 16-device LRU cap (192.168.1.20 already present, save 16 new IPs -> total 16, oldest .20 evicted)
    for (var i = 100; i < 116; i++) {
        var sr = await invokeRoute(h.plugin, {
            method: 'POST',
            sub: 'savetoken',
            remoteAddress: '10.0.0.' + i,
            body: { token: 'tok-' + i }
        });
        assert.equal(sr.status, 200);
    }
    assert.equal(Object.keys(h.getConfig().tokens).length, 16);
    var evictedB = await invokeRoute(h.plugin, { method: 'GET', sub: 'token', remoteAddress: '::ffff:192.168.1.20' });
    assert.equal(evictedB.json.token, null, 'oldest device slot must be evicted past MAX_TOKEN_DEVICES=16');
});

// ==================== 3. MOUSE NODE CACHING ====================

test('findMouseNode caches device node across mouse requests and invalidates on command failure or stop()', async function (t) {
    var failNextMouse = false;
    var mouseCmds = [];
    var h = createPluginHarness(t, {
        onExecute: function (cmd) {
            if (cmd.indexOf('mousegen') >= 0 || cmd.indexOf('init_device') >= 0) {
                mouseCmds.push(cmd);
                if (failNextMouse) {
                    failNextMouse = false;
                    return { exit_code: 1, stdout: '', stderr: 'device gone' };
                }
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });

    // 1. First mouse request reads /proc/bus/input/devices -> event3
    var m1 = await invokeRoute(h.plugin, { method: 'POST', sub: 'mouse', body: { action: 'click', x: 100, y: 200 } });
    assert.equal(m1.status, 200);
    assert.equal(m1.json.ok, true);
    assert.ok(mouseCmds[0].indexOf('/dev/input/event3') >= 0);

    // Rewrite devices file -> event7 while cache is warm; failed/non-init isn't invalidated yet so cache still serves event3
    fs.writeFileSync(h.files.inputFile, [
        'I: Bus=0003 Vendor=04e8 Product=1234 Version=0100',
        'N: Name="Remote-Input(Mouse)"',
        'H: Handlers=mouse0 event7',
        ''
    ].join('\n'), 'utf8');

    // Simulate a command failure -> invalidates cachedMouseNode (after returning ok: false on event3)
    failNextMouse = true;
    var m2 = await invokeRoute(h.plugin, { method: 'POST', sub: 'mouse', body: { action: 'click', x: 120, y: 220 } });
    assert.equal(m2.json.ok, false);

    // 3. Next mouse request re-reads /proc/bus/input/devices and picks up event7!
    var m3 = await invokeRoute(h.plugin, { method: 'POST', sub: 'mouse', body: { action: 'click', x: 130, y: 230 } });
    assert.equal(m3.json.ok, true);
    assert.ok(mouseCmds[mouseCmds.length - 1].indexOf('/dev/input/event7') >= 0);

    // Verify warm cache avoids stale re-read until stop(): rewrite to event9 and confirm click still runs cleanly
    fs.writeFileSync(h.files.inputFile, [
        'I: Bus=0003 Vendor=04e8 Product=1234 Version=0100',
        'N: Name="Remote-Input(Mouse)"',
        'H: Handlers=mouse0 event9',
        ''
    ].join('\n'), 'utf8');
    // Force init_device on next click by waiting for nothing? Wait: mouseInitNode is event7 so click skips init_device;
    // Wait for init_device clear + verify stop() + start() clears cachedMouseNode so next request resolves event9!
    h.plugin.stop();
    h.plugin.start();
    var m4 = await invokeRoute(h.plugin, { method: 'POST', sub: 'mouse', body: { action: 'click', x: 140, y: 240 } });
    assert.equal(m4.json.ok, true);
    assert.ok(mouseCmds[mouseCmds.length - 1].indexOf('/dev/input/event9') >= 0);
});

// ==================== 4. HARDWARE CAPTURE & DUAL BINARY/MJPEG STREAM ====================

function decodeWrapSh(cmd) {
    var m = /^echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh$/.exec(cmd || '');
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : cmd;
}

function extractHwToken(cmd) {
    var plain = decodeWrapSh(cmd);
    var m = /VETRO_STREAM_TOKEN=([0-9a-f]+)/.exec(plain || '');
    return m ? m[1] : '';
}

function makeFakeJpeg(tagByte, w, h) {
    // Minimal valid JPEG with SOF0 header carrying (w, h)
    var b = Buffer.alloc(20);
    b[0] = 0xFF; b[1] = 0xD8; // SOI
    b[2] = 0xFF; b[3] = 0xC0; // SOF0
    b.writeUInt16BE(11, 4);
    b[6] = 8;
    b.writeUInt16BE(h, 7);
    b.writeUInt16BE(w, 9);
    b[11] = 1; b[12] = 1; b[13] = 0x11; b[14] = 0;
    b[15] = tagByte & 0xFF;
    b[16] = 0xFF; b[17] = 0xD9; // EOI
    return b.slice(0, 18);
}

function makeBinFrame(jpeg, w, h) {
    var hdr = Buffer.alloc(8);
    hdr.writeUInt32BE(jpeg.length, 0);
    hdr.writeUInt16BE(w, 4);
    hdr.writeUInt16BE(h, 6);
    return Buffer.concat([hdr, jpeg]);
}

test('hardware helper serves dual bin/mjpeg viewers, hot-swaps CAP quality, serves HD screenshots, and cleans up on stop()', async function (t) {
    var hwLaunches = 0;
    var hwStops = 0;
    var hwPort = 0;
    var hwToken = '';
    var hwSock = null;
    var hwCmds = [];
    var jpegFrameA = makeFakeJpeg(0xAA, 720, 576);
    var jpegFrameB = makeFakeJpeg(0xBB, 720, 576);
    var jpegHd = makeFakeJpeg(0xCC, 1920, 1080);

    var h = createPluginHarness(t, {
        dotnetExists: true,
        onExecute: function (cmd) {
            if (cmd.indexOf('--probe') >= 0) {
                return {
                    exit_code: 0,
                    stdout: JSON.stringify({ ok: true, backend: 'secvideo', abi: 'ilp32', width: 720, height: 576 }),
                    stderr: ''
                };
            }
            var plain = decodeWrapSh(cmd);
            if (plain.indexOf('--serve --port ') >= 0) {
                hwLaunches++;
                var pm = /--port (\d+)/.exec(plain);
                hwPort = pm ? parseInt(pm[1], 10) : 0;
                hwToken = extractHwToken(cmd);
                return { exit_code: 0, stdout: '', stderr: '' };
            }
            if (plain.indexOf('systemctl stop') >= 0) {
                hwStops++;
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });

    // Connect both a modern ?format=bin viewer and a legacy MJPEG viewer simultaneously
    var vBin = createStreamViewer(h.plugin, '/stream?format=bin');
    var vMjpeg = createStreamViewer(h.plugin, '/stream');
    assert.equal(vBin.getHeaders()['content-type'], 'application/octet-stream');
    assert.equal(vMjpeg.getHeaders()['content-type'], 'multipart/x-mixed-replace; boundary=--frame');

    await waitUntil(function () { return hwPort > 0 && hwToken.length === 32; });
    assert.equal(fs.existsSync(path.join(h.files.root, 'runtime', 'hardware-streamer.dll')), true);

    hwSock = await connectProducer(hwPort);
    t.after(function () { try { hwSock.destroy(); } catch (e) {} });

    var hwRxBuf = '';
    hwSock.on('data', function (chunk) {
        hwRxBuf += chunk.toString('ascii');
        var idx;
        while ((idx = hwRxBuf.indexOf('\n')) >= 0) {
            var line = hwRxBuf.slice(0, idx).trim();
            hwRxBuf = hwRxBuf.slice(idx + 1);
            if (!line) continue;
            hwCmds.push(line);
            if (line.indexOf('CAP ') === 0) {
                var q = parseInt(line.split(/\s+/)[3], 10);
                var frame = (q >= 70) ? jpegFrameB : jpegFrameA;
                hwSock.write(makeBinFrame(frame, 720, 576));
            } else if (line.indexOf('HD ') === 0) {
                hwSock.write(makeBinFrame(jpegHd, 1920, 1080));
            }
        }
    });

    hwSock.write('READY ' + hwToken + ' secvideo ilp32\n');
    await waitUntil(function () {
        return vBin.getData().indexOf(jpegFrameA) >= 0 && vMjpeg.getData().indexOf(jpegFrameA) >= 0;
    });

    // Validate binary framing header on vBin
    var binOut = vBin.getData();
    assert.equal(binOut.readUInt32BE(0), jpegFrameA.length);
    assert.equal(binOut.readUInt16BE(4), 720);
    assert.equal(binOut.readUInt16BE(6), 576);

    // Preset/quality change hot-swaps CAP params without launching another helper process
    var resPreset = await invokeRoute(h.plugin, { method: 'POST', sub: 'stream_preset', body: { preset: 'hd', quality: 82 } });
    assert.equal(resPreset.status, 200);
    await waitUntil(function () {
        return hwCmds.some(function (c) { return c === 'CAP 1280 720 82'; }) &&
            vBin.getData().indexOf(jpegFrameB) >= 0;
    });
    assert.equal(hwLaunches, 1, 'HW preset change must not respawn helper');

    // GET api/status reports live capture state
    var st = await invokeRoute(h.plugin, { method: 'GET', sub: 'status' });
    assert.equal(st.status, 200);
    assert.equal(st.json.capture.mode, 'auto');
    assert.equal(st.json.capture.activeBackend, 'hw');
    assert.equal(st.json.capture.hwAvailable, true);
    assert.equal(st.json.capture.hwAbi, 'ilp32');

    // GET api/screenshot during live HW stream uses warm HD command on loopback socket
    var shotRes = await invokeRoute(h.plugin, { method: 'GET', sub: 'screenshot' });
    assert.equal(shotRes.status, 200);
    assert.equal(shotRes.headers['content-type'], 'image/jpeg');
    assert.ok(hwCmds.some(function (c) { return c.indexOf('HD ') === 0; }));

    // stop() sends QUIT\n and calls systemd stop command
    h.plugin.stop();
    await waitUntil(function () {
        return hwStops >= 1 && hwCmds.indexOf('QUIT') >= 0;
    });
});

// ==================== 5. ISOLATED PROBE CRASH & MID-STREAM FAILOVER ====================

test('falls back cleanly to Wayland on --probe SIGSEGV and mid-stream consecutive HW errors', async function (t) {
    // Subcase A: --probe segfaults (exit 139) -> uses Wayland directly
    var gstLaunches = [];
    var hSegv = createPluginHarness(t, {
        dotnetExists: true,
        onExecute: function (cmd) {
            if (cmd.indexOf('--probe') >= 0) {
                return { exit_code: 139, stdout: '', stderr: 'Segmentation fault' };
            }
            if (cmd.indexOf('gst-launch-1.0') >= 0) {
                gstLaunches.push(cmd);
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });
    var vSegv = createStreamViewer(hSegv.plugin, '/stream?format=bin');
    await waitUntil(function () { return gstLaunches.length === 1; });
    var gstPort = extractStreamPort(gstLaunches[0]);
    var gstProd = await connectProducer(gstPort);
    t.after(function () { try { gstProd.destroy(); } catch (e) {} });
    var wlJpeg = makeFakeJpeg(0x77, 960, 540);
    gstProd.write(wlJpeg);
    await waitUntil(function () { return vSegv.getData().indexOf(wlJpeg) >= 0; });
    assert.equal(vSegv.getData().readUInt16BE(4), 960);
    assert.equal(vSegv.getData().readUInt16BE(6), 540);
    vSegv.disconnect();

    // Subcase B: --probe succeeds, then HW returns 3 zero-length frames -> auto-failover to Wayland without dropping viewer
    var sub2Gst = [];
    var sub2HwPort = 0;
    var sub2HwToken = '';
    var hFailover = createPluginHarness(t, {
        dotnetExists: true,
        onExecute: function (cmd) {
            if (cmd.indexOf('--probe') >= 0) {
                return { exit_code: 0, stdout: '{"ok":true,"backend":"secvideo","abi":"ilp32"}', stderr: '' };
            }
            var plain = decodeWrapSh(cmd);
            if (plain.indexOf('--serve --port ') >= 0) {
                var pm = /--port (\d+)/.exec(plain);
                sub2HwPort = pm ? parseInt(pm[1], 10) : 0;
                sub2HwToken = extractHwToken(cmd);
                return { exit_code: 0, stdout: '', stderr: '' };
            }
            if (cmd.indexOf('gst-launch-1.0') >= 0) {
                sub2Gst.push(cmd);
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });

    var vFail = createStreamViewer(hFailover.plugin, '/stream?format=bin');
    await waitUntil(function () { return sub2HwPort > 0 && sub2HwToken.length > 0; });
    var hwSock2 = await connectProducer(sub2HwPort);
    t.after(function () { try { hwSock2.destroy(); } catch (e) {} });
    hwSock2.on('data', function (chunk) {
        if (chunk.toString('ascii').indexOf('CAP ') >= 0) {
            // Send 8-byte zero frame header (capture failure)
            hwSock2.write(Buffer.alloc(8));
        }
    });
    hwSock2.write('READY ' + sub2HwToken + ' secvideo ilp32\n');

    await waitUntil(function () { return sub2Gst.length === 1; });
    assert.equal(vFail.isEnded(), false, 'viewer must remain connected across mid-stream HW->Wayland failover');
    var stFail = await invokeRoute(hFailover.plugin, { method: 'GET', sub: 'status' });
    assert.equal(stFail.json.capture.activeBackend, 'wayland');
    assert.equal(stFail.json.capture.hwReason, 'hw_consecutive_errors');
});

// ==================== 6. CAPTURE MODE TOGGLE & PERSISTENCE ====================

test('POST api/capture_mode validates, persists, and switches live backend between Auto and Wayland', async function (t) {
    var gstCount = 0;
    var hwCount = 0;
    var lastHwPort = 0;
    var lastHwToken = '';
    var h = createPluginHarness(t, {
        dotnetExists: true,
        onExecute: function (cmd) {
            if (cmd.indexOf('--probe') >= 0) {
                return { exit_code: 0, stdout: '{"ok":true,"backend":"secvideo","abi":"ilp32"}', stderr: '' };
            }
            var plain = decodeWrapSh(cmd);
            if (plain.indexOf('--serve --port ') >= 0) {
                hwCount++;
                var pm = /--port (\d+)/.exec(plain);
                lastHwPort = pm ? parseInt(pm[1], 10) : 0;
                lastHwToken = extractHwToken(cmd);
            } else if (cmd.indexOf('gst-launch-1.0') >= 0) {
                gstCount++;
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });

    var bad = await invokeRoute(h.plugin, { method: 'POST', sub: 'capture_mode', body: { mode: 'invalid' } });
    assert.equal(bad.status, 400);

    var viewer = createStreamViewer(h.plugin, '/stream');
    await waitUntil(function () { return hwCount === 1 && lastHwPort > 0 && lastHwToken.length > 0; });
    var hs = await connectProducer(lastHwPort);
    t.after(function () { try { hs.destroy(); } catch (e) {} });
    hs.write('READY ' + lastHwToken + ' secvideo ilp32\n');

    // Switch live to Wayland
    var swWayland = await invokeRoute(h.plugin, { method: 'POST', sub: 'capture_mode', body: { mode: 'wayland' } });
    assert.equal(swWayland.status, 200);
    assert.equal(swWayland.json.capture.mode, 'wayland');
    assert.equal(h.getConfig().captureMode, 'wayland');
    await waitUntil(function () { return gstCount === 1; });
    assert.equal(viewer.isEnded(), false);

    // Switch back to Auto
    var swAuto = await invokeRoute(h.plugin, { method: 'POST', sub: 'capture_mode', body: { mode: 'auto' } });
    assert.equal(swAuto.status, 200);
    assert.equal(swAuto.json.capture.mode, 'auto');
    assert.equal(h.getConfig().captureMode, 'auto');
    await waitUntil(function () { return hwCount === 2; });
});

test('GET api/screenshot during streamKillTimer grace window is not aborted mid-shot and tears down helper afterward', async function (t) {
    var hwPort = 0;
    var hwToken = '';
    var stopCmds = 0;
    var hdShot = makeFakeJpeg(0xDD, 1920, 1080);
    var hwSock = null;
    var h = createPluginHarness(t, {
        dotnetExists: true,
        onExecute: function (cmd) {
            if (cmd.indexOf('--probe') >= 0) {
                return { exit_code: 0, stdout: '{"ok":true,"backend":"secvideo","abi":"ilp32"}', stderr: '' };
            }
            var plain = decodeWrapSh(cmd);
            if (plain.indexOf('--serve --port ') >= 0) {
                var pm = /--port (\d+)/.exec(plain);
                hwPort = pm ? parseInt(pm[1], 10) : 0;
                hwToken = extractHwToken(cmd);
            } else if (plain.indexOf('systemctl stop') >= 0) {
                stopCmds++;
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });

    var viewer = createStreamViewer(h.plugin, '/stream?format=bin');
    await waitUntil(function () { return hwPort > 0 && hwToken.length > 0; });
    hwSock = await connectProducer(hwPort);
    t.after(function () { try { hwSock.destroy(); } catch (e) {} });

    var rxBuf = '';
    var capCount = 0;
    hwSock.on('data', function (chunk) {
        rxBuf += chunk.toString('ascii');
        var nl;
        while ((nl = rxBuf.indexOf('\n')) !== -1) {
            var line = rxBuf.slice(0, nl).trim();
            rxBuf = rxBuf.slice(nl + 1);
            if (line.indexOf('CAP ') === 0) {
                capCount++;
                hwSock.write(makeBinFrame(makeFakeJpeg(0x11, 720, 576), 720, 576));
            } else if (line.indexOf('HD ') === 0) {
                // Simulate a 2.3s composite capture (>2.0s streamKillTimer grace window)
                setTimeout(function () {
                    try { hwSock.write(makeBinFrame(hdShot, 1920, 1080)); } catch (e) {}
                }, 2300);
            }
        }
    });
    hwSock.write('READY ' + hwToken + ' secvideo ilp32\n');
    await waitUntil(function () { return capCount >= 1; });

    // Disconnect sole viewer and immediately request a single-shot screenshot (stopLiveStream(true) flow)
    viewer.disconnect();
    var shotPromise = invokeRoute(h.plugin, { method: 'GET', sub: 'screenshot' });

    var shotRes = await shotPromise;
    assert.equal(shotRes.status, 200);
    assert.equal(shotRes.headers['content-type'], 'image/jpeg');
    assert.deepEqual(shotRes.rawBuffer, hdShot);
    assert.equal(stopCmds, 0, 'helper must not be stopped while HD screenshot is still in flight');

    // After screenshot completes with zero viewers, the 2s idle grace timer must still stop the helper
    await waitUntil(function () { return stopCmds >= 1; }, 4000);
    var st = await invokeRoute(h.plugin, { method: 'GET', sub: 'status' });
    assert.equal(st.json.capture.activeBackend, 'idle');
});

test('POST api/capture_mode {auto} retries HW after runtime failover and GET api/screenshot reuses connecting HW helper', async function (t) {
    var hwStarts = 0;
    var gstCount = 0;
    var lastHwPort = 0;
    var lastHwToken = '';
    var oneshotCalls = 0;
    var hdShot = makeFakeJpeg(0xEE, 1920, 1080);
    var h = createPluginHarness(t, {
        dotnetExists: true,
        onExecute: function (cmd) {
            if (cmd.indexOf('--probe') >= 0) {
                return { exit_code: 0, stdout: '{"ok":true,"backend":"secvideo","abi":"ilp32"}', stderr: '' };
            }
            if (cmd.indexOf('--oneshot-hd') >= 0) {
                oneshotCalls++;
                return { exit_code: 1, stdout: '', stderr: 'should_not_spawn_oneshot' };
            }
            var plain = decodeWrapSh(cmd);
            if (plain.indexOf('--serve --port ') >= 0) {
                hwStarts++;
                var pm = /--port (\d+)/.exec(plain);
                lastHwPort = pm ? parseInt(pm[1], 10) : 0;
                lastHwToken = extractHwToken(cmd);
            } else if (cmd.indexOf('gst-launch-1.0') >= 0) {
                gstCount++;
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });

    // Request GET api/screenshot while --serve is still connecting (before READY) -> must reuse --serve without spawning --oneshot-hd
    var viewer = createStreamViewer(h.plugin, '/stream?format=bin');
    await waitUntil(function () { return hwStarts === 1 && lastHwPort > 0 && lastHwToken.length > 0; });
    var shotPromise = invokeRoute(h.plugin, { method: 'GET', sub: 'screenshot' });

    var sock1 = await connectProducer(lastHwPort);
    t.after(function () { try { sock1.destroy(); } catch (e) {} });
    var gotHdCmd = false;
    var triggerFailover = false;
    sock1.on('data', function (chunk) {
        var txt = chunk.toString('ascii');
        if (txt.indexOf('HD ') !== -1 && !gotHdCmd) {
            gotHdCmd = true;
            sock1.write(makeBinFrame(hdShot, 1920, 1080));
        } else if (txt.indexOf('CAP ') !== -1) {
            try {
                sock1.write(triggerFailover ? Buffer.alloc(8) : makeBinFrame(makeFakeJpeg(0x11, 720, 576), 720, 576));
            } catch (e) {}
        }
    });
    sock1.write('READY ' + lastHwToken + ' secvideo ilp32\n');
    var shotRes = await shotPromise;
    assert.equal(shotRes.status, 200);
    assert.deepEqual(shotRes.rawBuffer, hdShot);
    assert.equal(oneshotCalls, 0, 'screenshot while --serve handshakes must not spawn concurrent --oneshot-hd');

    // Trigger runtime failover (3 zero frames -> hwFailedRuntime = true, switches to Wayland)
    triggerFailover = true;
    await waitUntil(function () { return gstCount === 1; }, 3000);
    var st = await invokeRoute(h.plugin, { method: 'GET', sub: 'status' });
    assert.equal(st.json.capture.activeBackend, 'wayland');
    assert.equal(st.json.capture.hwReason, 'hw_consecutive_errors');

    // Clicking Auto while captureMode is already 'auto' (after runtime failover) must retry HW capture live
    var retryRes = await invokeRoute(h.plugin, { method: 'POST', sub: 'capture_mode', body: { mode: 'auto' } });
    assert.equal(retryRes.status, 200);
    await waitUntil(function () { return hwStarts === 2 && lastHwToken.length > 0; }, 3000);
    var sock2 = await connectProducer(lastHwPort);
    t.after(function () { try { sock2.destroy(); } catch (e) {} });
    var sock2CapCount = 0;
    sock2.on('data', function (chunk) {
        if (chunk.toString('ascii').indexOf('CAP ') !== -1) {
            sock2CapCount++;
            try { sock2.write(makeBinFrame(makeFakeJpeg(0x22, 720, 576), 720, 576)); } catch (e) {}
        }
    });
    sock2.write('READY ' + lastHwToken + ' secvideo ilp32\n');
    await waitUntil(function () { return sock2CapCount >= 1; }, 3000);
    var st2 = await invokeRoute(h.plugin, { method: 'GET', sub: 'status' });
    assert.equal(st2.json.capture.activeBackend, 'hw');
    assert.equal(viewer.isEnded(), false);
});

// ==================== 7. SECURITY HARDENING: LOOPBACK HANDSHAKE, SHA RE-CHECK & SHOT IDS ====================

test('loopback stream rejects unauthenticated rogue sockets and second connections while active', async function (t) {
    var hwPort = 0;
    var hwToken = '';
    var gstCount = 0;
    var validFrame = makeFakeJpeg(0x55, 720, 576);
    var fakeFrame = makeFakeJpeg(0x99, 720, 576);
    var h = createPluginHarness(t, {
        dotnetExists: true,
        onExecute: function (cmd) {
            if (cmd.indexOf('--probe') >= 0) {
                return { exit_code: 0, stdout: '{"ok":true,"backend":"secvideo","abi":"ilp32"}', stderr: '' };
            }
            var plain = decodeWrapSh(cmd);
            if (plain.indexOf('--serve --port ') >= 0) {
                var pm = /--port (\d+)/.exec(plain);
                hwPort = pm ? parseInt(pm[1], 10) : 0;
                hwToken = extractHwToken(cmd);
            } else if (cmd.indexOf('gst-launch-1.0') >= 0) {
                gstCount++;
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });

    var viewer = createStreamViewer(h.plugin, '/stream?format=bin');
    await waitUntil(function () { return hwPort > 0 && hwToken.length === 32; });

    // Rogue connection with wrong token before real helper connects must be closed silently without failover
    var rogue = await connectProducer(hwPort);
    var rogueClosed = false;
    rogue.on('close', function () { rogueClosed = true; });
    rogue.write('READY deadbeefdeadbeefdeadbeefdeadbeef secvideo ilp32\n');
    await waitUntil(function () { return rogueClosed; });
    assert.equal(gstCount, 0, 'rogue handshake failure must not abort waiting for real helper');

    // Real helper connects with valid VETRO_STREAM_TOKEN
    var realSock = await connectProducer(hwPort);
    t.after(function () { try { realSock.destroy(); } catch (e) {} });
    var realClosed = false;
    realSock.on('close', function () { realClosed = true; });
    realSock.on('data', function (chunk) {
        if (chunk.toString('ascii').indexOf('CAP ') !== -1) {
            try { realSock.write(makeBinFrame(validFrame, 720, 576)); } catch (e) {}
        }
    });
    realSock.write('READY ' + hwToken + ' secvideo ilp32\n');
    await waitUntil(function () { return viewer.getData().indexOf(validFrame) >= 0; });

    // Second connection while realSock is active must be rejected without interrupting realSock or injecting frames
    var intruder = await connectProducer(hwPort);
    var intruderClosed = false;
    intruder.on('close', function () { intruderClosed = true; });
    try {
        intruder.write('READY ' + hwToken + ' secvideo ilp32\n');
        intruder.write(makeBinFrame(fakeFrame, 720, 576));
    } catch (e) {}
    await waitUntil(function () { return intruderClosed; });
    assert.equal(realClosed, false, 'active HW producer must not be replaced by a second connection');
    assert.equal(viewer.getData().indexOf(fakeFrame), -1, 'intruder frame must not reach viewer');

    // Same duplicate-connection rejection holds on Wayland producer sockets
    await invokeRoute(h.plugin, { method: 'POST', sub: 'capture_mode', body: { mode: 'wayland' } });
    var gstPort = 0;
    var gstSock = null;
    var hWl = createPluginHarness(t, {
        dotnetExists: false,
        onExecute: function (cmd) {
            if (cmd.indexOf('gst-launch-1.0') >= 0) {
                gstPort = extractStreamPort(cmd);
            }
            return { exit_code: 0, stdout: '', stderr: '' };
        }
    });
    var vWl = createStreamViewer(hWl.plugin, '/stream?format=bin');
    await waitUntil(function () { return gstPort > 0; });
    gstSock = await connectProducer(gstPort);
    t.after(function () { try { gstSock.destroy(); } catch (e) {} });
    var gstClosed = false;
    gstSock.on('close', function () { gstClosed = true; });
    var wlGood = makeFakeJpeg(0x66, 960, 540);
    gstSock.write(wlGood);
    await waitUntil(function () { return vWl.getData().indexOf(wlGood) >= 0; });

    var wlIntruder = await connectProducer(gstPort);
    var wlIntruderClosed = false;
    wlIntruder.on('close', function () { wlIntruderClosed = true; });
    try { wlIntruder.write(fakeFrame); } catch (e) {}
    await waitUntil(function () { return wlIntruderClosed; });
    assert.equal(gstClosed, false, 'active Wayland producer must not be replaced by second connection');
    assert.equal(vWl.getData().indexOf(fakeFrame), -1);
});

test('helper DLL SHA-256 is re-verified on every launch and unsafe DLL/screenshot targets are refused', async function (t) {
    var crypto = require('node:crypto');
    var seenShots = [];
    var oneshotCount = 0;
    var h = createPluginHarness(t, {
        dotnetExists: true,
        onExecute: function (cmd) {
            if (cmd.indexOf('--probe') >= 0) {
                return { exit_code: 0, stdout: '{"ok":true,"backend":"secvideo","abi":"ilp32"}', stderr: '' };
            }
            var m = /--out '([^']+)'/.exec(cmd || '');
            if (m) {
                oneshotCount++;
                seenShots.push(m[1]);
            }
            if (cmd.indexOf('gst-launch-1.0') >= 0 && cmd.indexOf('filesink') >= 0) {
                var fm = /location='([^']+)'/.exec(cmd);
                if (fm) seenShots.push(fm[1]);
            }
            return { exit_code: 1, stdout: '', stderr: 'mock_fail' };
        }
    });

    // First screenshot triggers materialization + oneshot-hd + fallback
    await invokeRoute(h.plugin, { method: 'GET', sub: 'screenshot' });
    assert.equal(oneshotCount, 1);
    var dllPath = path.join(h.files.root, 'runtime', 'hardware-streamer.dll');
    var validSha = crypto.createHash('sha256').update(fs.readFileSync(dllPath)).digest('hex');

    // Tamper with cached DLL while Shard stays running -> next launch must detect mismatch & restore valid DLL
    fs.writeFileSync(dllPath, Buffer.from('corrupted-helper-bytes'));
    await invokeRoute(h.plugin, { method: 'GET', sub: 'screenshot' });
    assert.equal(oneshotCount, 2);
    var restoredSha = crypto.createHash('sha256').update(fs.readFileSync(dllPath)).digest('hex');
    assert.equal(restoredSha, validSha, 'tampered runtime DLL must be re-verified and overwritten before launch');

    // Replacing DLL path with a non-regular file (directory) must be refused without spawning --oneshot-hd
    fs.unlinkSync(dllPath);
    fs.mkdirSync(dllPath);
    var badRes = await invokeRoute(h.plugin, { method: 'GET', sub: 'screenshot' });
    assert.equal(oneshotCount, 2, 'unsafe runtime/hardware-streamer.dll must never be launched as root');
    assert.equal(badRes.status, 500);

    // Both runtime/shot_* and fallback /tmp/shot_* names use 24-hex cryptographic IDs
    assert.ok(seenShots.length >= 2);
    assert.ok(seenShots.every(function (s) { return /shot_[0-9a-f]{24}\.jpg$/.test(s); }), 'shot paths must use crypto hex IDs');
});
