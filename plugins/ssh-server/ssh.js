'use strict';
// A small SSH-2 server in pure JavaScript, leaning on Node's crypto for the maths. No native code and no npm
// dependencies, so it runs as unsigned JS inside Vetro's already-signed Node process (the only way to run code on a
// signature-enforced Tizen TV). It needs Node 10+ (Ed25519, createECDH) — the TV this targets runs Node 12.
//
// Algorithms (one of each, all supported by a stock OpenSSH client and available on Node 12):
//   kex      ecdh-sha2-nistp256        (crypto.createECDH('prime256v1'))
//   hostkey  ssh-ed25519               (crypto.sign(null, H, key))
//   cipher   aes256-ctr                (both directions)
//   mac      hmac-sha2-256             (encrypt-and-mac, mac over seq||plaintext)
//   userauth publickey, ssh-ed25519 keys only
//
// Written in ES5 syntax (var/function) so it still packs through the catalog's ES5 check, even though it only RUNS on
// a modern-Node TV. Security-sensitive: read it before trusting it with a root login. RFCs 4251-4254, 5656.

var crypto = require('crypto');
var net = require('net');
var EventEmitter = require('events').EventEmitter;

// ---- message numbers ----
var MSG = {
    DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7,
    KEXINIT: 20, NEWKEYS: 21, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31,
    USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53, USERAUTH_PK_OK: 60,
    GLOBAL_REQUEST: 80, REQUEST_SUCCESS: 81, REQUEST_FAILURE: 82,
    CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93,
    CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95, CHANNEL_EOF: 96, CHANNEL_CLOSE: 97,
    CHANNEL_REQUEST: 98, CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100
};
var SERVER_ID = 'SSH-2.0-VetroSSH_0.1';

// ---- buffer writer / reader (SSH wire types) ----
function Writer() { this.parts = []; }
Writer.prototype.byte = function (n) { var b = Buffer.alloc(1); b[0] = n & 0xff; this.parts.push(b); return this; };
Writer.prototype.bool = function (v) { return this.byte(v ? 1 : 0); };
Writer.prototype.u32 = function (n) { var b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); this.parts.push(b); return this; };
Writer.prototype.raw = function (buf) { this.parts.push(buf); return this; };
Writer.prototype.string = function (buf) { if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8'); var l = Buffer.alloc(4); l.writeUInt32BE(buf.length, 0); this.parts.push(l, buf); return this; };
Writer.prototype.mpint = function (buf) {
    // positive multi-precision integer: drop leading zero bytes, prepend 0x00 if the high bit is set.
    var i = 0; while (i < buf.length - 1 && buf[i] === 0) i++;
    buf = buf.slice(i);
    if (buf.length && (buf[0] & 0x80)) buf = Buffer.concat([Buffer.from([0]), buf]);
    return this.string(buf);
};
Writer.prototype.nameList = function (arr) { return this.string(arr.join(',')); };
Writer.prototype.done = function () { return Buffer.concat(this.parts); };

function Reader(buf) { this.buf = buf; this.pos = 0; }
Reader.prototype.byte = function () { return this.buf[this.pos++]; };
Reader.prototype.bool = function () { return this.buf[this.pos++] !== 0; };
Reader.prototype.u32 = function () { var n = this.buf.readUInt32BE(this.pos); this.pos += 4; return n; };
Reader.prototype.string = function () { var l = this.u32(); var s = this.buf.slice(this.pos, this.pos + l); this.pos += l; return s; };
Reader.prototype.rest = function () { return this.buf.slice(this.pos); };

function sshString(buf) { return new Writer().string(buf).done(); }

// ---- ed25519 host key: raw <-> KeyObject ----
var ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // DER prefix for a 32-byte Ed25519 public key
function ed25519RawFromPublic(keyObject) { return keyObject.export({ type: 'spki', format: 'der' }).slice(-32); }
function ed25519PublicFromRaw(raw) { return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' }); }
function hostKeyBlob(pubRaw) { return new Writer().string('ssh-ed25519').string(pubRaw).done(); }

// Create (or load) a persistent Ed25519 host key. store = { get:fn, set:fn } of a PEM string; returns {priv, pubRaw, blob}.
function loadHostKey(pem) {
    var priv;
    if (pem) { try { priv = crypto.createPrivateKey(pem); } catch (e) { priv = null; } }
    var pubPem = null;
    if (!priv) { var kp = crypto.generateKeyPairSync('ed25519'); priv = kp.privateKey; pubPem = kp.publicKey; }
    var pub = pubPem || crypto.createPublicKey(priv);
    var raw = ed25519RawFromPublic(pub);
    return { priv: priv, pubRaw: raw, blob: hostKeyBlob(raw), pem: priv.export({ type: 'pkcs8', format: 'pem' }) };
}

// ---- authorized_keys: parse ssh-ed25519 entries into raw 32-byte keys ----
function parseAuthorizedKeys(text) {
    var out = [];
    String(text || '').split('\n').forEach(function (line) {
        line = line.trim();
        if (!line || line.charAt(0) === '#') return;
        var parts = line.split(/\s+/);
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] === 'ssh-ed25519' && parts[i + 1]) {
                try {
                    var blob = Buffer.from(parts[i + 1], 'base64');
                    var r = new Reader(blob);
                    if (r.string().toString() === 'ssh-ed25519') { var raw = r.string(); if (raw.length === 32) out.push(raw); }
                } catch (e) { /* skip bad line */ }
                break;
            }
        }
    });
    return out;
}

// ================= per-connection state machine =================
function Connection(socket, server) {
    EventEmitter.call(this);
    var self = this;
    this.socket = socket;
    this.server = server;
    this.log = server.opts.log || function () {};
    this.inbuf = Buffer.alloc(0);
    this.gotId = false;
    this.clientId = null;
    this.seqIn = 0; this.seqOut = 0;
    this.decipher = null; this.cipher = null; this.macInKey = null; this.macOutKey = null;
    this.blockIn = 8; this.blockOut = 8; this.macInLen = 0; this.macOutLen = 0;
    this.firstBlock = null;           // decrypted first block of the packet being read
    this.sessionId = null;
    this.authed = false; this.authUser = null;
    this.channels = {};
    this.nextChannelId = 0;
    this.authTries = 0;
    this.counted = true;                             // contributes to the server's half-open cap until authed or closed
    server.pending = (server.pending || 0) + 1;

    // Login grace timer: drop a connection that hasn't authenticated in time, so a peer can't sit half-open holding a
    // packet buffer inside Vetro's process. Cleared on auth success and on cleanup.
    var graceMs = (server.opts.loginGraceMs != null) ? server.opts.loginGraceMs : 30000;
    if (graceMs > 0) this.graceTimer = setTimeout(function () {
        if (self.authed || self._gone) return;
        self.log('login grace time expired');
        try { self.disconnect(2, 'login grace time expired'); } catch (e) {}
        try { self.socket.destroy(); } catch (e) {}
        self.cleanup();
    }, graceMs);

    socket.on('data', function (d) { try { self.onData(d); } catch (e) { self.fail(e); } });
    socket.on('error', function (e) { self.log('socket error: ' + e.message); self.cleanup(); });
    socket.on('close', function () { self.cleanup(); });

    socket.write(SERVER_ID + '\r\n');
}
Connection.prototype = Object.create(EventEmitter.prototype);

Connection.prototype.fail = function (e) { this.log('connection error: ' + (e && e.message || e)); try { this.socket.destroy(); } catch (x) {} this.cleanup(); };
Connection.prototype.cleanup = function () {
    if (this._gone) return; this._gone = true;
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    this._uncount();
    for (var id in this.channels) if (this.channels[id]) this.channels[id]._shutdown();
    this.emit('end');
};
// Release this connection's half-open slot exactly once (on auth success, or on close if never authed).
Connection.prototype._uncount = function () { if (this.counted) { this.counted = false; if (this.server.pending > 0) this.server.pending--; } };

Connection.prototype.onData = function (chunk) {
    this.inbuf = Buffer.concat([this.inbuf, chunk]);
    if (!this.gotId) {
        var s = this.inbuf.indexOf('\n');
        if (s < 0) { if (this.inbuf.length > 4096) throw new Error('no ident'); return; }
        var line = this.inbuf.slice(0, s).toString('binary').replace(/\r$/, '');
        if (line.slice(0, 4) !== 'SSH-') throw new Error('bad ident: ' + line);
        this.clientId = line;
        this.gotId = true;
        this.inbuf = this.inbuf.slice(s + 1);
    }
    this.drain();
};

// Pull complete packets out of inbuf. aes-ctr is a byte-stream cipher in Node, so we decrypt the first block to learn
// the length, then the remainder; the MAC follows in cleartext.
Connection.prototype.drain = function () {
    while (true) {
        if (this.firstBlock === null) {
            if (this.inbuf.length < this.blockIn) return;
            var fb = this.inbuf.slice(0, this.blockIn);
            this.firstBlock = this.decipher ? this.decipher.update(fb) : fb;
            this._consumed = this.blockIn;
        }
        var pktLen = this.firstBlock.readUInt32BE(0);
        if (pktLen < 1 || pktLen > 0x80000) throw new Error('bad packet length ' + pktLen);
        var total = 4 + pktLen;
        if (this.inbuf.length < total + this.macInLen) return;
        var rest = this.inbuf.slice(this.blockIn, total);
        rest = this.decipher ? this.decipher.update(rest) : rest;
        var plain = Buffer.concat([this.firstBlock, rest]);
        if (this.macInLen) {
            var mac = this.inbuf.slice(total, total + this.macInLen);
            var h = crypto.createHmac('sha256', this.macInKey);
            var sb = Buffer.alloc(4); sb.writeUInt32BE(this.seqIn >>> 0, 0);
            h.update(sb); h.update(plain);
            var want = h.digest();
            if (!timingEqual(want, mac)) throw new Error('bad MAC');
        }
        this.inbuf = this.inbuf.slice(total + this.macInLen);
        this.firstBlock = null;
        this.seqIn = (this.seqIn + 1) >>> 0;
        var padLen = plain[4];
        var payload = plain.slice(5, 4 + pktLen - padLen);
        this.handlePacket(payload);
        if (this._gone) return;
    }
};

Connection.prototype.send = function (payload) {
    try { this._send(payload); } catch (e) { this.fail(e); }
};
Connection.prototype._send = function (payload) {
    var block = this.blockOut;
    // padding: at least 4, to make (4 + 1 + payload + pad) a multiple of block
    var min = 4, lenNoPad = 1 + payload.length, pad = block - ((4 + lenNoPad) % block); if (pad < min) pad += block;
    var padding = crypto.randomBytes(pad);
    var pktLen = 1 + payload.length + pad;
    var head = Buffer.alloc(5); head.writeUInt32BE(pktLen, 0); head[4] = pad;
    var packet = Buffer.concat([head, payload, padding]);
    var out;
    if (this.cipher) {
        var h = crypto.createHmac('sha256', this.macOutKey);
        var sb = Buffer.alloc(4); sb.writeUInt32BE(this.seqOut >>> 0, 0);
        h.update(sb); h.update(packet);
        var mac = h.digest();
        out = Buffer.concat([this.cipher.update(packet), mac]);
    } else {
        out = packet;
    }
    this.seqOut = (this.seqOut + 1) >>> 0;
    try { this.socket.write(out); } catch (e) { this.fail(e); }
};

Connection.prototype.disconnect = function (reason, msg) {
    try { this.send(new Writer().byte(MSG.DISCONNECT).u32(reason || 11).string(msg || '').string('').done()); } catch (e) {}
    try { this.socket.end(); } catch (e) {}
};

// ---- dispatch ----
Connection.prototype.handlePacket = function (payload) {
    if (!payload.length) return;
    var type = payload[0], r = new Reader(payload); r.byte();
    switch (type) {
        case MSG.KEXINIT: return this.onKexInit(payload, r);
        case MSG.KEX_ECDH_INIT: return this.onKexEcdhInit(r);
        case MSG.NEWKEYS: return this.onNewKeys();
        case MSG.SERVICE_REQUEST: return this.onServiceRequest(r);
        case MSG.USERAUTH_REQUEST: return this.onUserauthRequest(payload, r);
        case MSG.CHANNEL_OPEN: return this.onChannelOpen(r);
        case MSG.CHANNEL_REQUEST: return this.onChannelRequest(r);
        case MSG.CHANNEL_DATA: return this.onChannelData(r);
        case MSG.CHANNEL_WINDOW_ADJUST: return this.onWindowAdjust(r);
        case MSG.CHANNEL_EOF: return this.onChannelEof(r);
        case MSG.CHANNEL_CLOSE: return this.onChannelClose(r);
        case MSG.GLOBAL_REQUEST: return this.onGlobalRequest(r);
        case MSG.DISCONNECT: this.log('client disconnect'); try { this.socket.end(); } catch (e) {} return this.cleanup();
        case MSG.IGNORE: case MSG.DEBUG: case MSG.UNIMPLEMENTED: return;
        default:
            this.send(new Writer().byte(MSG.UNIMPLEMENTED).u32((this.seqIn - 1) >>> 0).done());
    }
};

// ---- key exchange ----
Connection.prototype.buildKexInit = function () {
    var w = new Writer();
    w.byte(MSG.KEXINIT);
    w.raw(crypto.randomBytes(16));
    w.nameList(['ecdh-sha2-nistp256']);
    w.nameList(['ssh-ed25519']);
    w.nameList(['aes256-ctr']);          // c2s
    w.nameList(['aes256-ctr']);          // s2c
    w.nameList(['hmac-sha2-256']);       // c2s
    w.nameList(['hmac-sha2-256']);       // s2c
    w.nameList(['none']);                // compression c2s
    w.nameList(['none']);                // compression s2c
    w.nameList([]); w.nameList([]);      // languages
    w.bool(false);                        // first_kex_packet_follows
    w.u32(0);
    return w.done();
};
Connection.prototype.startKex = function () { this.myKexInit = this.buildKexInit(); this.send(this.myKexInit); this.kexSent = true; };
Connection.prototype.onKexInit = function (payload, r) {
    // A KEXINIT after the first exchange has completed is a re-key request. We do a single initial exchange only;
    // rather than leave the client hanging (we would never answer), disconnect cleanly so it reports a clear error.
    // Stock OpenSSH only re-keys after ~1 GiB / 1 hour, so this is rare; `RekeyLimit default none` avoids it entirely.
    if (this.kexDone) { this.log('re-key requested (unsupported); disconnecting'); return this.disconnect(2, 'key re-exchange not supported'); }
    this.peerKexInit = payload;
    if (!this.kexSent) this.startKex();
    // We negotiate nothing fancy: we only offer one of each, and a stock client includes all of them.
};
Connection.prototype.onKexEcdhInit = function (r) {
    var Qc = r.string();                                  // client ephemeral public point (uncompressed, 65 bytes)
    var ecdh = crypto.createECDH('prime256v1');
    var Qs = ecdh.generateKeys();                         // server ephemeral public point
    var K = ecdh.computeSecret(Qc);                       // shared secret (raw X), to be mpint-encoded
    var hostKey = this.server.hostKey;

    // Exchange hash H = sha256(V_C || V_S || I_C || I_S || K_S || Q_C || Q_S || K)
    var h = crypto.createHash('sha256');
    h.update(sshString(this.clientId));
    h.update(sshString(SERVER_ID));
    h.update(sshString(this.peerKexInit));
    h.update(sshString(this.myKexInit));
    h.update(sshString(hostKey.blob));
    h.update(sshString(Qc));
    h.update(sshString(Qs));
    h.update(new Writer().mpint(K).done());
    var H = h.digest();

    var sig = crypto.sign(null, H, hostKey.priv);         // Ed25519 signature over H
    var sigBlob = new Writer().string('ssh-ed25519').string(sig).done();

    if (!this.sessionId) this.sessionId = H;              // the first H is the session id, forever

    this.send(new Writer().byte(MSG.KEX_ECDH_REPLY).string(hostKey.blob).string(Qs).string(sigBlob).done());
    this.send(new Writer().byte(MSG.NEWKEYS).done());
    this.pending = this.deriveKeys(K, H);                 // apply to the send side now, receive side on client NEWKEYS
    this.applyOut();
};
Connection.prototype.deriveKeys = function (K, H) {
    var Kmp = new Writer().mpint(K).done(), sid = this.sessionId;
    function derive(letter, need) {
        var out = crypto.createHash('sha256').update(Kmp).update(H).update(Buffer.from(letter)).update(sid).digest();
        while (out.length < need) out = Buffer.concat([out, crypto.createHash('sha256').update(Kmp).update(H).update(out).digest()]);
        return out.slice(0, need);
    }
    return {
        ivC2S: derive('A', 16), ivS2C: derive('B', 16),
        keyC2S: derive('C', 32), keyS2C: derive('D', 32),
        macC2S: derive('E', 32), macS2C: derive('F', 32)
    };
};
Connection.prototype.applyOut = function () {
    var k = this.pending;
    this.cipher = crypto.createCipheriv('aes-256-ctr', k.keyS2C, k.ivS2C);
    this.macOutKey = k.macS2C; this.macOutLen = 32; this.blockOut = 16;
};
Connection.prototype.onNewKeys = function () {
    var k = this.pending;
    this.decipher = crypto.createDecipheriv('aes-256-ctr', k.keyC2S, k.ivC2S);
    this.macInKey = k.macC2S; this.macInLen = 32; this.blockIn = 16;
    this.pending = null;
    this.kexDone = true;             // first key exchange finished; a later client KEXINIT is a re-key request
};

// ---- auth ----
Connection.prototype.onServiceRequest = function (r) {
    var name = r.string().toString();
    if (name === 'ssh-userauth') this.send(new Writer().byte(MSG.SERVICE_ACCEPT).string(name).done());
    else this.disconnect(7, 'service not available');
};
// Send USERAUTH_FAILURE. `attempt` marks a genuine authentication try (not the cheap publickey probe); after a few of
// those we disconnect, so a peer can't brute-force signatures. The probe phase never counts, so a client offering
// several agent keys isn't locked out.
Connection.prototype.authReject = function (attempt) {
    if (attempt) {
        this.authTries++;
        var max = (this.server.opts.maxAuthAttempts != null) ? this.server.opts.maxAuthAttempts : 6;
        if (this.authTries >= max) {
            this.log('too many authentication failures');
            try { this.disconnect(2, 'too many authentication failures'); } catch (e) {}
            try { this.socket.destroy(); } catch (e) {}
            return this.cleanup();
        }
    }
    this.send(new Writer().byte(MSG.USERAUTH_FAILURE).nameList(['publickey']).bool(false).done());
};
Connection.prototype.onUserauthRequest = function (payload, r) {
    if (this.authed) return;
    var user = r.string().toString('utf8');
    var service = r.string().toString();
    var method = r.string().toString();
    if (method !== 'publickey' || service !== 'ssh-connection') return this.authReject(true);
    var signed = r.bool();
    var alg = r.string().toString();
    var keyBlob = r.string();
    if (alg !== 'ssh-ed25519') return this.authReject(false);

    // the key must be in authorized_keys
    var kr = new Reader(keyBlob); kr.string(); var rawKey = kr.string();
    if (!this.server.keyAllowed(rawKey)) return this.authReject(signed);   // count only a real (signed) attempt

    if (!signed) {
        // query phase: tell the client this key would be acceptable
        return this.send(new Writer().byte(MSG.USERAUTH_PK_OK).string(alg).string(keyBlob).done());
    }
    var sigBlob = r.string();
    var sr = new Reader(sigBlob); sr.string(); var sig = sr.string();

    // signed data = string(session_id) || the userauth request up to and including the public key blob
    var data = Buffer.concat([
        sshString(this.sessionId),
        new Writer().byte(MSG.USERAUTH_REQUEST).string(user).string(service).string(method).bool(true).string(alg).string(keyBlob).done()
    ]);
    var ok = false;
    try { ok = crypto.verify(null, data, ed25519PublicFromRaw(rawKey), sig); } catch (e) { ok = false; }
    if (!ok) return this.authReject(true);

    this.authed = true; this.authUser = user;
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    this._uncount();
    this.send(new Writer().byte(MSG.USERAUTH_SUCCESS).done());
    this.log('auth ok: ' + user);
};

// ---- channels ----
Connection.prototype.onGlobalRequest = function (r) {
    r.string(); var wantReply = r.bool();
    if (wantReply) this.send(new Writer().byte(MSG.REQUEST_FAILURE).done());
};
Connection.prototype.onChannelOpen = function (r) {
    var type = r.string().toString();
    var peerId = r.u32(), peerWin = r.u32(), peerMax = r.u32();
    if (!this.authed || type !== 'session' || this.server.stopped) {
        return this.send(new Writer().byte(MSG.CHANNEL_OPEN_FAILURE).u32(peerId).u32(3).string('only session channels').string('').done());
    }
    var id = this.nextChannelId++;
    var ch = new Channel(this, id, peerId, peerWin, peerMax);
    this.channels[id] = ch;
    var myMax = 32 * 1024;
    this.send(new Writer().byte(MSG.CHANNEL_OPEN_CONFIRMATION).u32(peerId).u32(id).u32(ch.localWinInit).u32(myMax).done());
};
Connection.prototype.chan = function (r) { var id = r.u32(); return { id: id, ch: this.channels[id] }; };
Connection.prototype.onChannelData = function (r) { var c = this.chan(r); var data = r.string(); if (c.ch) c.ch._incoming(data); };
Connection.prototype.onWindowAdjust = function (r) { var c = this.chan(r); var n = r.u32(); if (c.ch) c.ch._addWindow(n); };
Connection.prototype.onChannelEof = function (r) { var c = this.chan(r); if (c.ch) c.ch.emit('eof'); };
Connection.prototype.onChannelClose = function (r) { var c = this.chan(r); if (c.ch) c.ch._peerClosed(); };
Connection.prototype.onChannelRequest = function (r) {
    var id = r.u32(), type = r.string().toString(), wantReply = r.bool(), ch = this.channels[id];
    if (!ch) return;
    var ok = ch._request(type, r);
    if (wantReply) this.send(new Writer().byte(ok ? MSG.CHANNEL_SUCCESS : MSG.CHANNEL_FAILURE).u32(ch.peerId).done());
};

// ================= channel =================
function Channel(conn, id, peerId, peerWin, peerMax) {
    EventEmitter.call(this);
    this.conn = conn; this.id = id; this.peerId = peerId;
    this.peerWin = peerWin; this.peerMax = peerMax;
    this.pty = null; this.closed = false; this.sentEof = false; this.sentClose = false;
    this.outQ = [];              // buffered bytes waiting for window room
    this.outPending = 0;         // total bytes queued, for backpressure
    this.wantEof = false;        // eof requested but held until the queue drains
    this.HIGH = 256 * 1024;      // backpressure threshold reported to producers
    this.localWinInit = 2 * 1024 * 1024;  // our receive window, advertised in CHANNEL_OPEN_CONFIRMATION
    this.localWin = this.localWinInit;    // bytes of that window the client may still send
}
Channel.prototype = Object.create(EventEmitter.prototype);
// Account for data the client sends us against our receive window, and top the window back up with a WINDOW_ADJUST
// before it runs out — without this an upload stalls once the client has sent one full window (~2 MB).
Channel.prototype._incoming = function (data) {
    this.localWin -= data.length;
    if (!this.sentClose && this.localWin < (this.localWinInit >> 1)) {
        var add = this.localWinInit - this.localWin;
        this.localWin += add;
        try { this.conn.send(new Writer().byte(MSG.CHANNEL_WINDOW_ADJUST).u32(this.peerId).u32(add).done()); } catch (e) {}
    }
    this.emit('data', data);
};
Channel.prototype._addWindow = function (n) { this.peerWin += n; this._flush(); };
Channel.prototype._peerClosed = function () { this.close(); };
Channel.prototype._request = function (type, r) {
    var conn = this.conn;
    if (type === 'pty-req') {
        var term = r.string().toString(); var cols = r.u32(), rows = r.u32(); r.u32(); r.u32(); r.string();
        if (!(conn.server.opts && conn.server.opts.allowPty)) return false;   // refuse: client falls back to line mode
        this.pty = { term: term, cols: cols, rows: rows };
        return true;
    }
    if (type === 'env') { r.string(); r.string(); return true; }
    if (conn.server.stopped && (type === 'shell' || type === 'exec' || type === 'subsystem')) return false;
    if (type === 'shell') { conn.server.emit('shell', this); return true; }
    if (type === 'exec') { var cmd = r.string().toString('utf8'); conn.server.emit('exec', this, cmd); return true; }
    if (type === 'subsystem') { var name = r.string().toString(); conn.server.emit('subsystem', this, name); return true; }
    if (type === 'window-change') { var c = r.u32(), ro = r.u32(); if (this.pty) { this.pty.cols = c; this.pty.rows = ro; } this.emit('resize', c, ro); return true; }
    return false;
};
// flow-controlled write to the client. Data is queued and sent as the client opens its window; returns false when the
// queue is above the high-water mark so producers can pause (see 'drain').
Channel.prototype.write = function (buf) {
    if (this.closed) return false;
    if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
    if (buf.length) { this.outQ.push(buf); this.outPending += buf.length; this._flush(); }
    return this.outPending < this.HIGH;
};
Channel.prototype._flush = function () {
    while (this.outQ.length && this.peerWin > 0 && !this.sentClose) {
        var head = this.outQ[0];
        var room = Math.min(this.peerWin, this.peerMax, head.length);
        var slice = head.length === room ? this.outQ.shift() : (this.outQ[0] = head.slice(room), head.slice(0, room));
        this.conn.send(new Writer().byte(MSG.CHANNEL_DATA).u32(this.peerId).string(slice).done());
        this.peerWin -= slice.length; this.outPending -= slice.length;
    }
    if (!this.outQ.length) {
        if (this.outPending < this.HIGH) this.emit('drain');
        if (this.wantEof) this._sendEof();
    }
};
Channel.prototype.writeStderr = function (buf) {
    if (this.closed) return; if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
    // stderr is small (shell diagnostics); send directly but still respect the window counter.
    this.conn.send(new Writer().byte(MSG.CHANNEL_EXTENDED_DATA).u32(this.peerId).u32(1).string(buf).done());
    this.peerWin -= buf.length;
};
Channel.prototype.exit = function (code) {
    if (this.sentClose || this._exitSent) return; this._exitSent = true;
    this.conn.send(new Writer().byte(MSG.CHANNEL_REQUEST).u32(this.peerId).string('exit-status').bool(false).u32(code >>> 0).done());
    this.eof();
    // close once everything queued has been written
    var self = this;
    if (!this.outQ.length) this.close(); else this.once('drain', function () { self.close(); });
};
Channel.prototype.eof = function () { if (this.sentEof || this.closed) return; this.wantEof = true; if (!this.outQ.length) this._sendEof(); };
Channel.prototype._sendEof = function () { if (this.sentEof || this.closed) return; this.sentEof = true; this.wantEof = false; this.conn.send(new Writer().byte(MSG.CHANNEL_EOF).u32(this.peerId).done()); };
Channel.prototype.close = function () {
    if (this.sentClose) return; this.sentClose = true; this.closed = true;
    try { this.conn.send(new Writer().byte(MSG.CHANNEL_CLOSE).u32(this.peerId).done()); } catch (e) {}
    this._shutdown();
};
Channel.prototype._shutdown = function () { if (this._down) return; this._down = true; this.closed = true; delete this.conn.channels[this.id]; this.emit('close'); };

function timingEqual(a, b) { if (a.length !== b.length) return false; try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; } }

// ================= public API =================
// opts: { hostKeyPem, authorizedKeys: [rawEd25519...] | text, log }
// events: 'shell'(channel), 'exec'(channel, cmd), 'subsystem'(channel, name), 'connection'(conn)
function Server(opts) {
    EventEmitter.call(this);
    this.opts = opts || {};
    this.hostKey = loadHostKey(this.opts.hostKeyPem);
    this.authorizedKeys = Array.isArray(this.opts.authorizedKeys) ? this.opts.authorizedKeys : parseAuthorizedKeys(this.opts.authorizedKeys);
    this.connections = [];   // live accepted connections, so stop()/close() can tear them down
    this.pending = 0;        // connections accepted but not yet authenticated (bounds buffered memory)
    this.stopped = false;
    this.listening = false;  // true only while the listener is actually bound
    this.lastError = null;   // last listener error (e.g. EADDRINUSE), surfaced to the UI
    var self = this;
    this.net = net.createServer(function (socket) {
        // Guard everything: this runs inside Vetro's own process, so an uncaught throw here would crash the service.
        try {
            if (self.stopped) { try { socket.destroy(); } catch (x) {} return; }
            var maxPending = (self.opts.maxPending != null) ? self.opts.maxPending : 8;
            if (self.pending >= maxPending) {                       // too many half-open sessions: shed load
                try { socket.destroy(); } catch (x) {}
                if (self.opts.log) self.opts.log('refused connection: too many unauthenticated sessions');
                return;
            }
            socket.setNoDelay(true);
            var conn = new Connection(socket, self);
            self.connections.push(conn);
            conn.on('end', function () { var i = self.connections.indexOf(conn); if (i >= 0) self.connections.splice(i, 1); });
            conn.startKex();
            self.emit('connection', conn);
        } catch (e) { try { socket.destroy(); } catch (x) {} if (self.opts.log) self.opts.log('accept error: ' + (e && e.message || e)); }
    });
    this.net.on('error', function (e) {
        self.listening = false;
        self.lastError = (e && e.message) || String(e);
        if (self.opts.log) self.opts.log('listener error: ' + self.lastError);
    });
}
Server.prototype = Object.create(EventEmitter.prototype);
Server.prototype.keyAllowed = function (rawKey) {
    for (var i = 0; i < this.authorizedKeys.length; i++) if (timingEqual(this.authorizedKeys[i], rawKey)) return true;
    return false;
};
Server.prototype.setAuthorizedKeys = function (keysOrText) { this.authorizedKeys = Array.isArray(keysOrText) ? keysOrText : parseAuthorizedKeys(keysOrText); };
Server.prototype.hostKeyPem = function () { return this.hostKey.pem; };
Server.prototype.listen = function (port, host, cb) {
    var self = this; this.stopped = false; this.lastError = null;
    return this.net.listen(port, host, function () { self.listening = true; if (cb) cb(); });
};
// Stop the listener AND tear down every connection already open. Without destroying live sockets, an interactive
// session keeps running commands and an open SFTP session keeps its uid-5001 fs access after the Shard is switched off.
Server.prototype.close = function (cb) {
    this.stopped = true; this.listening = false;
    var conns = this.connections.slice();
    this.connections = [];
    for (var i = 0; i < conns.length; i++) {
        try { conns[i].disconnect(11, 'server stopping'); } catch (e) {}   // best-effort polite DISCONNECT
        try { conns[i].socket.destroy(); } catch (e) {}                    // force the socket shut
        try { conns[i].cleanup(); } catch (e) {}                           // shut down channels now (fires 'close' -> sftp closes fds)
    }
    return this.net.close(cb);
};
Server.prototype.address = function () { return this.net.address(); };

module.exports = {
    createServer: function (opts) { return new Server(opts); },
    parseAuthorizedKeys: parseAuthorizedKeys,
    loadHostKey: loadHostKey,
    Writer: Writer, Reader: Reader
};
