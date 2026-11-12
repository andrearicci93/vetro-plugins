'use strict';
// Local Chromium DevTools Protocol client with bounded messages and command deadlines.
// Node 4 has no built-in WebSocket client, so this transport handles its frames directly.
var http = require('http'), net = require('net'), crypto = require('crypto'), legacyUrl = require('url');
var MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
var INSPECTOR_HOST = '127.0.0.2';
function zeroedBuffer(n) { var b = new Buffer(n); b.fill(0); return b; }
function listTargets(port) {
    return new Promise(function (resolve, reject) {
        var req = http.get({ hostname: INSPECTOR_HOST, port: port, path: '/json/list' }, function (res) {
            var text = '';
            res.on('data', function (c) { text += c; if (text.length > 262144) { req.destroy(); reject(new Error('Inspector list too large')); } });
            res.on('error', reject);
            res.on('end', function () {
                try { if (res.statusCode !== 200) throw new Error('Inspector unavailable'); resolve(JSON.parse(text)); } catch (e) { reject(e); }
            });
        });
        req.setTimeout(4000, function () { req.destroy(); reject(new Error('Inspector timeout')); }); req.on('error', reject);
    });
}
function isTwitchPage(t) {
    if (!t || t.type !== 'page' || typeof t.url !== 'string') return false;
    var u = legacyUrl.parse(t.url);
    return u.protocol === 'https:' && /(^|\.)tv\.twitch\.tv$/.test(u.hostname || '') && !u.auth;
}
function localWebSocketPath(address, port) {
    var u = legacyUrl.parse(address || '');
    if (u.protocol !== 'ws:' || ['127.0.0.1', '127.0.0.2', 'localhost'].indexOf(u.hostname) < 0 || Number(u.port) !== port || u.auth ||
        !/^\/(?:devtools|inspector)\/page\/[A-Za-z0-9_.-]+$/.test(u.pathname || '') || u.search) throw new Error('Inspector must be local and target a page');
    return u.pathname;
}
function maskedClientFrame(data, opcode) {
    data = Buffer.isBuffer(data) ? data : new Buffer(data, 'utf8');
    var n = data.length, h = zeroedBuffer(n < 126 ? 2 : n < 65536 ? 4 : 10), mask = crypto.randomBytes(4), body = zeroedBuffer(n);
    h[0] = 128 | (opcode || 1); h[1] = 128 | (n < 126 ? n : n < 65536 ? 126 : 127);
    if (n >= 126 && n < 65536) h.writeUInt16BE(n, 2);
    if (n >= 65536) h.writeUInt32BE(n, 6);
    for (var i = 0; i < n; i++) body[i] = data[i] ^ mask[i % 4];
    return Buffer.concat([h, mask, body]);
}
function connect(address, port) {
    var route = localWebSocketPath(address, port);
    return new Promise(function (resolve, reject) {
        var socket = net.connect({ host: INSPECTOR_HOST, port: port }), key = crypto.randomBytes(16).toString('base64');
        var expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        var input = zeroedBuffer(0), ready = false, closed = false, nextCommandId = 0, pendingCommands = {}, messageFragments = [], messageIsFragmented = false, messageBytes = 0, eventHandlers = {};
        var connectionTimer = setTimeout(function () { close(new Error('Inspector connection timeout')); }, 4000);
        function close(error) {
            if (closed) return; closed = true; clearTimeout(connectionTimer); socket.destroy();
            Object.keys(pendingCommands).forEach(function (k) { clearTimeout(pendingCommands[k].timer); pendingCommands[k].reject(error || new Error('Inspector closed')); }); pendingCommands = {};
            if (!ready) reject(error || new Error('Inspector closed'));
        }
        function handleProtocolMessage(payload) {
            var data; try { data = JSON.parse(payload.toString('utf8')); } catch (e) { close(new Error('Invalid inspector response')); return; }
            if (!data.id && data.method) {
                (eventHandlers[data.method] || []).slice().forEach(function (fn) { try { fn(data.params || {}); } catch (e) { close(new Error('Inspector event handler failed')); } });
                return;
            }
            var p = pendingCommands[data.id]; if (!p) return; delete pendingCommands[data.id]; clearTimeout(p.timer);
            if (data.error) p.reject(new Error('Inspector command rejected: ' + String(data.error.message || data.error.code).slice(0, 100))); else p.resolve(data.result || {});
        }
        function readFrames() {
            while (!closed && input.length >= 2) {
                var fin = input[0] & 128, op = input[0] & 15, size = input[1] & 127, offset = 2;
                if ((input[0] & 112) || (input[1] & 128)) return close(new Error('Unsupported inspector frame'));
                if (size === 126) { if (input.length < 4) return; size = input.readUInt16BE(2); offset = 4; }
                else if (size === 127) { if (input.length < 10) return; if (input.readUInt32BE(2)) return close(new Error('Frame too large')); size = input.readUInt32BE(6); offset = 10; }
                if (size > MAX_MESSAGE_BYTES || messageBytes + size > MAX_MESSAGE_BYTES) return close(new Error('Inspector message too large'));
                if (input.length < offset + size) return;
                var body = input.slice(offset, offset + size); input = input.slice(offset + size);
                if (op === 8) return close();
                if (op === 9) { socket.write(maskedClientFrame(body, 10)); continue; }
                if (op === 10) continue;
                if (op === 1 && !messageIsFragmented) { messageFragments = [body]; messageBytes = size; messageIsFragmented = !fin; }
                else if (op === 0 && messageIsFragmented) { messageFragments.push(body); messageBytes += size; messageIsFragmented = !fin; }
                else return close(new Error('Invalid inspector fragmentation'));
                if (fin) { handleProtocolMessage(Buffer.concat(messageFragments)); messageFragments = []; messageBytes = 0; }
            }
        }
        socket.on('error', close); socket.on('close', function () { close(); });
        socket.on('connect', function () {
            socket.write('GET ' + route + ' HTTP/1.1\r\nHost: ' + INSPECTOR_HOST + ':' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + '\r\n\r\n');
        });
        socket.on('data', function (chunk) {
            input = Buffer.concat([input, chunk]);
            if (!ready) {
                var end = input.indexOf('\r\n\r\n');
                if (end < 0) { if (input.length > 16384) close(new Error('Inspector headers too large')); return; }
                var header = input.slice(0, end).toString('ascii'), accept = /^sec-websocket-accept:\s*(\S+)\s*$/mi.exec(header);
                if (!/^HTTP\/1\.1 101\b/.test(header) || !accept || accept[1] !== expected) return close(new Error('Inspector handshake refused'));
                ready = true; clearTimeout(connectionTimer); input = input.slice(end + 4);
                resolve({ close: close, isOpen: function () { return !closed; }, on: function (method, fn) {
                    var list = eventHandlers[method] || (eventHandlers[method] = []); list.push(fn);
                    return function () { var i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
                }, call: function (method, params) {
                    return new Promise(function (yes, no) {
                        if (closed) return no(new Error('Inspector closed'));
                        var next = ++nextCommandId, timer = setTimeout(function () { delete pendingCommands[next]; no(new Error('Inspector command timeout')); }, 5000);
                        pendingCommands[next] = { resolve: yes, reject: no, timer: timer };
                        socket.write(maskedClientFrame(JSON.stringify({ id: next, method: method, params: params || {} })));
                    });
                } });
            }
            readFrames();
        });
    });
}
module.exports = { listTargets: listTargets, isTwitchPage: isTwitchPage, localWebSocketPath: localWebSocketPath, connect: connect };
