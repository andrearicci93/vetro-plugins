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
function openTwitchPage(port, requireCurrent) {
    return inspector.listTargets(port).then(function (list) {
        // Discovery is asynchronous. A stopped feature should never open a socket after it finishes.
        requireCurrent();
        var targets = Array.isArray(list) ? list.filter(isTwitchPage) : [];
        if (targets.length !== 1) throw new Error('Expected one hosted Twitch TV page');

        var target = targets[0];
        return inspector.connect(target.webSocketDebuggerUrl, port).then(function (client) {
            return { client: client, url: target.url };
        });
    });
}

function evaluate(client, expression, awaitPromise) {
    var parameters = { expression: expression, returnByValue: true };
    if (awaitPromise === true) parameters.awaitPromise = true;
    return client.call('Runtime.evaluate', parameters).then(function (result) {
        if (result.exceptionDetails) throw new Error('Twitch page script failed');
        return result.result && result.result.value;
    });
}

// One registration per feature connection. The ID is kept even if the feature was stopped
// while Chromium was registering it, so the caller can still remove that late registration.
function createDocumentScript(client) {
    var identifier = null;
    return {
        install: function (source, requireCurrent) {
            return client.call('Page.enable').then(function () {
                requireCurrent();
                return client.call('Page.addScriptToEvaluateOnNewDocument', { source: source });
            }).then(function (result) {
                identifier = result.identifier;
                requireCurrent();
                if (!identifier) throw new Error('Twitch page registration unavailable');
                return evaluate(client, source);
            });
        },
        remove: function () {
            if (!identifier) return Promise.resolve();
            return client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: identifier });
        }
    };
}

function localWebSocketPath(address, port) {
    var u = legacyUrl.parse(address || '');
    if (u.protocol !== 'ws:' || ['127.0.0.1', '127.0.0.2', 'localhost'].indexOf(u.hostname) < 0 || Number(u.port) !== port || u.auth ||
        !/^\/(?:devtools|inspector)\/page\/[A-Za-z0-9_.-]+$/.test(u.pathname || '') || u.search) throw new Error('Inspector must be local and target a page');
    return u.pathname;
}
function maskedClientFrame(data, opcode) {
    var payload = Buffer.isBuffer(data) ? data : new Buffer(data, 'utf8');
    var length = payload.length;
    var header = zeroedBuffer(length < 126 ? 2 : length < 65536 ? 4 : 10);
    var mask = crypto.randomBytes(4);
    var masked = zeroedBuffer(length);
    header[0] = 128 | (opcode || 1);
    header[1] = 128 | (length < 126 ? length : length < 65536 ? 126 : 127);
    if (length >= 126 && length < 65536) header.writeUInt16BE(length, 2);
    if (length >= 65536) header.writeUInt32BE(length, 6);
    for (var i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, masked]);
}

function connect(address, port) {
    var route = localWebSocketPath(address, port);
    return new Promise(function (resolve, reject) {
        var socket = net.connect({ host: INSPECTOR_HOST, port: port });
        var key = crypto.randomBytes(16).toString('base64');
        var expectedAccept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        var input = zeroedBuffer(0), ready = false, closed = false;
        var nextCommandId = 0, pendingCommands = Object.create(null), eventHandlers = Object.create(null);
        var messageFragments = [], messageIsFragmented = false, messageBytes = 0;
        var connectionTimer = setTimeout(function () { close(new Error('Inspector connection timeout')); }, 4000);

        function close(error) {
            if (closed) return;
            closed = true;
            clearTimeout(connectionTimer);
            socket.destroy();
            Object.keys(pendingCommands).forEach(function (id) {
                var pending = pendingCommands[id];
                clearTimeout(pending.timer);
                pending.reject(error || new Error('Inspector closed'));
            });
            pendingCommands = Object.create(null);
            if (!ready) reject(error || new Error('Inspector closed'));
        }

        function handleProtocolMessage(payload) {
            var message;
            try { message = JSON.parse(payload.toString('utf8')); }
            catch (error) { return close(new Error('Invalid inspector response')); }
            if (!message || typeof message !== 'object' || Array.isArray(message)) {
                return close(new Error('Invalid inspector response'));
            }

            if (!message.id && typeof message.method === 'string') {
                (eventHandlers[message.method] || []).slice().forEach(function (handler) {
                    try { handler(message.params || {}); }
                    catch (error) { close(new Error('Inspector event handler failed')); }
                });
                return;
            }
            if (typeof message.id !== 'number' && typeof message.id !== 'string') return;
            var pending = pendingCommands[message.id];
            if (!pending) return;
            delete pendingCommands[message.id];
            clearTimeout(pending.timer);
            if (message.error) {
                var info = message.error.message || message.error.code;
                var detail = typeof info === 'string' || typeof info === 'number' ? String(info).slice(0, 100) : 'unknown error';
                pending.reject(new Error('Inspector command rejected: ' + detail));
            } else pending.resolve(message.result || {});
        }

        function readFrames() {
            while (!closed && input.length >= 2) {
                // Chromium sends unmasked frames. RSV bits would imply extensions we did not negotiate.
                if ((input[0] & 112) || (input[1] & 128)) return close(new Error('Unsupported inspector frame'));
                var fin = input[0] & 128, opcode = input[0] & 15;
                var length = input[1] & 127, offset = 2;
                if (length === 126) {
                    if (input.length < 4) return;
                    length = input.readUInt16BE(2);
                    offset = 4;
                } else if (length === 127) {
                    if (input.length < 10) return;
                    if (input.readUInt32BE(2)) return close(new Error('Frame too large'));
                    length = input.readUInt32BE(6);
                    offset = 10;
                }
                if (length > MAX_MESSAGE_BYTES || messageBytes + length > MAX_MESSAGE_BYTES) {
                    return close(new Error('Inspector message too large'));
                }
                if (input.length < offset + length) return;

                var body = input.slice(offset, offset + length);
                input = input.slice(offset + length);
                if (opcode === 8) return close();
                if (opcode === 9) {
                    socket.write(maskedClientFrame(body, 10));
                    continue;
                }
                if (opcode === 10) continue;

                if (opcode === 1 && !messageIsFragmented) {
                    messageFragments = [body];
                    messageBytes = length;
                } else if (opcode === 0 && messageIsFragmented) {
                    messageFragments.push(body);
                    messageBytes += length;
                } else return close(new Error('Invalid inspector fragmentation'));

                messageIsFragmented = !fin;
                if (fin) {
                    handleProtocolMessage(Buffer.concat(messageFragments));
                    messageFragments = [];
                    messageBytes = 0;
                }
            }
        }

        function onEvent(method, handler) {
            var handlers = eventHandlers[method] || (eventHandlers[method] = []);
            handlers.push(handler);
            return function () {
                var index = handlers.indexOf(handler);
                if (index >= 0) handlers.splice(index, 1);
            };
        }

        function sendCommand(method, params) {
            return new Promise(function (resolveCommand, rejectCommand) {
                if (closed) return rejectCommand(new Error('Inspector closed'));
                var id = ++nextCommandId;
                var timer = setTimeout(function () {
                    delete pendingCommands[id];
                    rejectCommand(new Error('Inspector command timeout'));
                }, 5000);
                pendingCommands[id] = { resolve: resolveCommand, reject: rejectCommand, timer: timer };
                socket.write(maskedClientFrame(JSON.stringify({ id: id, method: method, params: params || {} })));
            });
        }

        function acceptUpgrade() {
            var end = input.indexOf('\r\n\r\n');
            if (end < 0) {
                if (input.length > 16384) close(new Error('Inspector headers too large'));
                return false;
            }
            var header = input.slice(0, end).toString('ascii');
            var accept = /^sec-websocket-accept:\s*(\S+)\s*$/mi.exec(header);
            if (!/^HTTP\/1\.1 101\b/.test(header) || !accept || accept[1] !== expectedAccept) {
                close(new Error('Inspector handshake refused'));
                return false;
            }
            ready = true;
            clearTimeout(connectionTimer);
            input = input.slice(end + 4);
            resolve({ close: close, isOpen: function () { return !closed; }, on: onEvent, call: sendCommand });
            return true;
        }

        socket.on('error', close);
        socket.on('close', function () { close(); });
        socket.on('connect', function () {
            socket.write([
                'GET ' + route + ' HTTP/1.1',
                'Host: ' + INSPECTOR_HOST + ':' + port,
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Version: 13',
                'Sec-WebSocket-Key: ' + key,
                '',
                ''
            ].join('\r\n'));
        });
        socket.on('data', function (chunk) {
            input = Buffer.concat([input, chunk]);
            if (!ready && !acceptUpgrade()) return;
            readFrames();
        });
    });
}
var inspector = {
    openTwitchPage: openTwitchPage,
    evaluate: evaluate,
    createDocumentScript: createDocumentScript,
    listTargets: listTargets,
    isTwitchPage: isTwitchPage,
    localWebSocketPath: localWebSocketPath,
    connect: connect
};
module.exports = inspector;
