'use strict';
// A minimal MQTT 3.1.1 server that only receives. Vetro's MQTT bridge connects to it as if it were a
// broker; every PUBLISH it sends is handed to onMessage. Nothing is stored or forwarded: retained
// messages are not kept, subscriptions are acknowledged but never receive anything.
//
// Written against Vetro's own client (app/service/mqtt.js), which is strict about a few things:
//   - CONNACK must be exactly 2 bytes with flags 0, or Vetro drops the connection;
//   - SUBACK must be 3 bytes: Vetro sends one topic per SUBSCRIBE, and we answer one code per topic;
//   - PINGREQ must be answered before the next keepalive tick, or Vetro reconnects.
// Its CONNECT always carries a retained will (the availability topic): it is read and ignored.
//
// It listens on 127.0.0.1 only by default, so only programs on the TV itself can reach it.
// Plain ES5: the TV may run Node 4.4.

var net = require('net');
var compat = require('./compat.js');

var MAX_PACKET = 262144;          // Vetro's discovery records are the largest messages it sends (< 1 KB)
var MAX_CLIENTS = 4;
var CONNECT_TIMEOUT_MS = 10000;   // time allowed between opening the socket and sending CONNECT
var RETRY_MS = 30000;             // when the port could not be bound

function noop() {}

function encodeLength(n) {
    var out = [];
    do {
        var digit = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) digit |= 0x80;
        out.push(digit);
    } while (n > 0);
    return out;
}

function packet(firstByte, body) {
    var bytes = [firstByte].concat(encodeLength(body.length)).concat(body);
    return compat.fromBytes(bytes);
}

// Reads an MQTT length-prefixed field at `at`; throws if it runs past the end of the packet.
function readField(body, at) {
    if (at + 2 > body.length) throw new Error('Malformed MQTT packet');
    var len = body.readUInt16BE(at);
    if (at + 2 + len > body.length) throw new Error('Malformed MQTT packet');
    return { value: body.slice(at + 2, at + 2 + len), next: at + 2 + len };
}

function sameSecret(a, b) {
    a = String(a == null ? '' : a);
    b = String(b == null ? '' : b);
    var diff = a.length ^ b.length;
    for (var i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
}

// opts: { port, host ('127.0.0.1'), username, password, onMessage(msg), onEvent(type, text), retryMs }
function Receiver(opts) {
    opts = opts || {};
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port;
    this.username = opts.username || null;
    this.password = opts.password || null;
    this.onMessage = opts.onMessage || noop;
    this.onEvent = opts.onEvent || noop;
    this.retryMs = opts.retryMs || RETRY_MS;
    this.server = null;
    this.clients = [];
    this.listening = false;
    this.error = null;
    this.retryTimer = null;
    this.stopped = true;
    this.received = 0;
}

Receiver.prototype.start = function () {
    if (!this.stopped) return;
    this.stopped = false;
    this._listen();
};

Receiver.prototype._listen = function () {
    var self = this;
    var server = net.createServer(function (socket) { self._accept(server, socket); });
    this.server = server;
    // A bind failure (port taken) arrives here, asynchronously: never let it escape as an exception.
    server.on('error', function (e) {
        if (self.server !== server) return;
        self.server = null;
        self.listening = false;
        self.error = 'Cannot listen on ' + self.host + ':' + self.port + ' (' + (e && (e.code || e.message)) + ')';
        self.onEvent('error', self.error);
        try { server.close(); } catch (x) { /* was not listening */ }
        self._scheduleRetry();
    });
    try {
        server.listen(this.port, this.host, function () {
            // Older Node (12 and before) resolves the host first and binds afterwards, even when close()
            // was called in between: a receiver stopped right after starting would stay bound. Close it here.
            if (self.server !== server) { try { server.close(); } catch (e) { /* closed */ } return; }
            self.listening = true;
            self.error = null;
            var address = server.address();
            if (address && address.port) self.port = address.port;
            self.onEvent('listening', 'Listening for Vetro on ' + self.host + ':' + self.port);
        });
    } catch (e) {
        // Synchronous throws (an invalid port) are reported like a bind failure.
        this.server = null;
        this.error = 'Cannot listen on ' + this.host + ':' + this.port + ' (' + (e && e.message) + ')';
        this.onEvent('error', this.error);
        this._scheduleRetry();
    }
};

Receiver.prototype._scheduleRetry = function () {
    var self = this;
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(function () {
        self.retryTimer = null;
        if (!self.stopped && !self.server) self._listen();
    }, this.retryMs);
};

Receiver.prototype.stop = function () {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    var clients = this.clients.slice();
    this.clients = [];
    clients.forEach(function (c) { c.close(); });
    var server = this.server;
    this.server = null;
    this.listening = false;
    if (server) { try { server.close(); } catch (e) { /* not listening */ } }
};

Receiver.prototype.status = function () {
    return {
        listening: this.listening,
        host: this.host,
        port: this.port,
        error: this.error,
        received: this.received,
        clients: this.clients.filter(function (c) { return c.connected; }).map(function (c) {
            return { clientId: c.clientId, since: c.connectedAt };
        })
    };
};

Receiver.prototype._accept = function (server, socket) {
    // Errors on a socket must always have a listener: an unhandled one would end Vetro's whole service.
    socket.on('error', noop);
    if (this.server !== server || this.stopped || this.clients.length >= MAX_CLIENTS) {
        socket.destroy();
        return;
    }
    var client = new Connection(this, socket);
    this.clients.push(client);
};

Receiver.prototype._remove = function (client) {
    var at = this.clients.indexOf(client);
    if (at >= 0) this.clients.splice(at, 1);
};

function Connection(receiver, socket) {
    var self = this;
    this.receiver = receiver;
    this.socket = socket;
    this.buffer = compat.alloc(0);
    this.connected = false;
    this.closed = false;
    this.clientId = null;
    this.connectedAt = null;
    socket.setNoDelay(true);
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on('timeout', function () { self.close(); });
    socket.on('close', function () {
        var wasConnected = self.connectedAt !== null;
        self.closed = true;
        self.connected = false;
        receiver._remove(self);
        if (wasConnected) receiver.onEvent('disconnected', 'Vetro disconnected (' + self.clientId + ')');
    });
    socket.on('data', function (chunk) {
        if (self.closed) return;
        if (self.buffer.length + chunk.length > MAX_PACKET + 8) { self.close(); return; }
        self.buffer = Buffer.concat([self.buffer, chunk]);
        try {
            self._drain();
        } catch (e) {
            receiver.onEvent('error', 'Dropped a client: ' + e.message);
            self.close();
        }
    });
}

Connection.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    try { this.socket.destroy(); } catch (e) { /* already gone */ }
};

Connection.prototype._send = function (buf) {
    if (!this.closed) { try { this.socket.write(buf); } catch (e) { this.close(); } }
};

Connection.prototype._drain = function () {
    while (this.buffer.length >= 2 && !this.closed) {
        var length = 0, multiplier = 1, i = 1, digit;
        do {
            if (i >= this.buffer.length) return;            // length bytes not all here yet
            if (i > 4) throw new Error('Malformed MQTT length');
            digit = this.buffer[i++];
            length += (digit & 127) * multiplier;
            multiplier *= 128;
        } while (digit & 128);
        if (length > MAX_PACKET) throw new Error('MQTT packet too large');
        if (this.buffer.length < i + length) return;       // rest of the packet in a later chunk
        var type = this.buffer[0] >> 4, flags = this.buffer[0] & 15;
        var body = this.buffer.slice(i, i + length);
        this.buffer = this.buffer.slice(i + length);
        this._packet(type, flags, body);
    }
};

Connection.prototype._packet = function (type, flags, body) {
    if (!this.connected && type !== 1) throw new Error('Expected CONNECT');
    switch (type) {
        case 1: return this._connect(body);
        case 3: return this._publish(flags, body);
        case 6: // PUBREL (QoS 2, second half) -> PUBCOMP
            if (body.length < 2) throw new Error('Malformed PUBREL');
            return this._send(packet(0x70, [body[0], body[1]]));
        case 4: case 5: case 7: return undefined;          // acks for messages we never send
        case 8: return this._subscribe(flags, body);
        case 10: // UNSUBSCRIBE -> UNSUBACK
            if (body.length < 2) throw new Error('Malformed UNSUBSCRIBE');
            return this._send(packet(0xb0, [body[0], body[1]]));
        case 12: return this._send(packet(0xd0, []));      // PINGREQ -> PINGRESP
        case 14: return this.close();                       // DISCONNECT
        default: throw new Error('Unsupported MQTT packet type ' + type);
    }
};

Connection.prototype._connect = function (body) {
    if (this.connected) throw new Error('Second CONNECT');
    var f = readField(body, 0), protocol = f.value.toString('utf8'), at = f.next;
    if (at + 4 > body.length) throw new Error('Malformed CONNECT');
    var level = body[at], flags = body[at + 1], keepalive = body.readUInt16BE(at + 2);
    at += 4;
    if (!((protocol === 'MQTT' && level === 4) || (protocol === 'MQIsdp' && level === 3))) {
        this._send(packet(0x20, [0, 1]));                   // unacceptable protocol version
        this.close();
        return;
    }
    f = readField(body, at); this.clientId = f.value.toString('utf8') || 'anonymous'; at = f.next;
    if (flags & 0x04) {                                     // will topic and will message: read past them
        f = readField(body, at); at = f.next;
        f = readField(body, at); at = f.next;
    }
    var username = null, password = null;
    if (flags & 0x80) { f = readField(body, at); username = f.value.toString('utf8'); at = f.next; }
    if (flags & 0x40) { f = readField(body, at); password = f.value.toString('utf8'); at = f.next; }
    var r = this.receiver;
    if (r.username && (!sameSecret(username, r.username) || !sameSecret(password, r.password))) {
        this._send(packet(0x20, [0, 4]));                   // bad user name or password
        r.onEvent('error', 'Refused a client with the wrong user name or password');
        this.close();
        return;
    }
    this.connected = true;
    this.connectedAt = Date.now();
    // Any packet resets the socket timer, which is MQTT's keepalive rule (1.5 x the client's interval).
    this.socket.setTimeout(keepalive ? Math.ceil(keepalive * 1500) : 0);
    this._send(packet(0x20, [0, 0]));
    r.onEvent('connected', 'Vetro connected (' + this.clientId + ')');
};

Connection.prototype._publish = function (flags, body) {
    var qos = (flags >> 1) & 3;
    if (qos === 3) throw new Error('Invalid QoS');
    var f = readField(body, 0), topic = f.value.toString('utf8'), at = f.next, id = null;
    if (qos > 0) {
        if (at + 2 > body.length) throw new Error('Missing packet id');
        id = [body[at], body[at + 1]];
        at += 2;
    }
    if (qos === 1) this._send(packet(0x40, id));            // PUBACK
    if (qos === 2) this._send(packet(0x50, id));            // PUBREC
    var r = this.receiver;
    r.received++;
    try {
        r.onMessage({ topic: topic, payload: body.slice(at), retained: !!(flags & 1), qos: qos, clientId: this.clientId });
    } catch (e) {
        r.onEvent('error', 'Message handler failed: ' + e.message);
    }
};

Connection.prototype._subscribe = function (flags, body) {
    if (body.length < 2) throw new Error('Malformed SUBSCRIBE');
    var codes = [], at = 2;
    while (at < body.length) {
        var f = readField(body, at);
        if (f.next >= body.length) throw new Error('Malformed SUBSCRIBE');
        at = f.next + 1;                                    // the requested QoS byte
        codes.push(0);                                      // granted QoS 0 (nothing is ever delivered)
    }
    if (!codes.length) throw new Error('SUBSCRIBE without topics');
    this._send(packet(0x90, [body[0], body[1]].concat(codes)));
};

module.exports = { Receiver: Receiver };
