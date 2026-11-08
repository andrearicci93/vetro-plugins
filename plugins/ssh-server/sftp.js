'use strict';
// SFTP version 3 server over one SSH channel, backed by Node's fs. This is what makes `scp` (modern OpenSSH uses
// SFTP under the hood) and `sftp` work against this server — no sftp-server binary needed on the TV. ES5 syntax,
// async fs so a big transfer does not block Vetro's single process. draft-ietf-secsh-filexfer-02.

var fs = require('fs');
var path = require('path');

var T = { INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8, SETSTAT: 9, FSETSTAT: 10,
    OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18, READLINK: 19, SYMLINK: 20,
    STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105 };
var FX = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, OP_UNSUPPORTED: 8 };
var F = { READ: 0x01, WRITE: 0x02, APPEND: 0x04, CREAT: 0x08, TRUNC: 0x10, EXCL: 0x20 };
var A = { SIZE: 0x01, UIDGID: 0x02, PERMISSIONS: 0x04, ACMODTIME: 0x08 };

function errStatus(e) {
    if (!e) return FX.FAILURE;
    if (e.code === 'ENOENT') return FX.NO_SUCH_FILE;
    if (e.code === 'EACCES' || e.code === 'EPERM') return FX.PERMISSION_DENIED;
    return FX.FAILURE;
}

// ---- tiny writer (length-prefixed SFTP packet) ----
function Pkt(type) { this.parts = []; this.type = type; }
Pkt.prototype.u32 = function (n) { var b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); this.parts.push(b); return this; };
Pkt.prototype.u64 = function (n) { var b = Buffer.alloc(8); var hi = Math.floor(n / 4294967296); b.writeUInt32BE(hi >>> 0, 0); b.writeUInt32BE((n >>> 0), 4); this.parts.push(b); return this; };
Pkt.prototype.byte = function (n) { this.parts.push(Buffer.from([n & 0xff])); return this; };
Pkt.prototype.str = function (s) { if (typeof s === 'string') s = Buffer.from(s, 'utf8'); var l = Buffer.alloc(4); l.writeUInt32BE(s.length, 0); this.parts.push(l, s); return this; };
Pkt.prototype.raw = function (b) { this.parts.push(b); return this; };
Pkt.prototype.done = function () {
    var body = Buffer.concat(this.parts), head = Buffer.alloc(5);
    head.writeUInt32BE(body.length + 1, 0); head[4] = this.type;
    return Buffer.concat([head, body]);
};

function Reader(buf) { this.b = buf; this.p = 0; }
Reader.prototype.u32 = function () { var n = this.b.readUInt32BE(this.p); this.p += 4; return n; };
Reader.prototype.u64 = function () { var hi = this.b.readUInt32BE(this.p), lo = this.b.readUInt32BE(this.p + 4); this.p += 8; return hi * 4294967296 + lo; };
Reader.prototype.byte = function () { return this.b[this.p++]; };
Reader.prototype.str = function () { var l = this.u32(); var s = this.b.slice(this.p, this.p + l); this.p += l; return s; };

function attrsBuf(st) {
    var p = new Pkt(0); // reuse as plain writer; type unused here
    var flags = A.SIZE | A.UIDGID | A.PERMISSIONS | A.ACMODTIME;
    var w = [];
    var b = Buffer.alloc(4); b.writeUInt32BE(flags, 0); w.push(b);
    var sz = Buffer.alloc(8); var hi = Math.floor(st.size / 4294967296); sz.writeUInt32BE(hi >>> 0, 0); sz.writeUInt32BE((st.size >>> 0), 4); w.push(sz);
    var ug = Buffer.alloc(8); ug.writeUInt32BE(st.uid >>> 0, 0); ug.writeUInt32BE(st.gid >>> 0, 4); w.push(ug);
    var pm = Buffer.alloc(4); pm.writeUInt32BE(st.mode >>> 0, 0); w.push(pm);
    var tm = Buffer.alloc(8); tm.writeUInt32BE(Math.floor(st.atimeMs / 1000) >>> 0, 0); tm.writeUInt32BE(Math.floor(st.mtimeMs / 1000) >>> 0, 4); w.push(tm);
    return Buffer.concat(w);
}
function skipAttrs(r) {
    var flags = r.u32(), out = {};
    if (flags & A.SIZE) out.size = r.u64();
    if (flags & A.UIDGID) { out.uid = r.u32(); out.gid = r.u32(); }
    if (flags & A.PERMISSIONS) out.mode = r.u32();
    if (flags & A.ACMODTIME) { out.atime = r.u32(); out.mtime = r.u32(); }
    return out;
}

function modeString(st) {
    var m = st.mode, t = '-';
    if (st.isDirectory()) t = 'd'; else if (st.isSymbolicLink()) t = 'l'; else if (st.isCharacterDevice()) t = 'c'; else if (st.isBlockDevice()) t = 'b'; else if (st.isFIFO()) t = 'p'; else if (st.isSocket()) t = 's';
    var rwx = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
    return t + rwx[(m >> 6) & 7] + rwx[(m >> 3) & 7] + rwx[m & 7];
}
function longname(name, st) {
    var d = new Date(st.mtimeMs), mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    var day = ('  ' + d.getDate()).slice(-2), hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var size = ('           ' + st.size).slice(-11);
    return modeString(st) + ' 1 ' + ('     ' + (st.uid >>> 0)).slice(-5) + ' ' + ('     ' + (st.gid >>> 0)).slice(-5) + ' ' + size + ' ' + mon + ' ' + day + ' ' + hm + ' ' + name;
}

// Attach an SFTP server to a channel. opts: { log }
function serve(channel, opts) {
    opts = opts || {}; var log = opts.log || function () {};
    var inbuf = Buffer.alloc(0);
    var handles = {}, nextH = 0;

    function reply(buf) { channel.write(buf); }
    function status(id, code, msg) { reply(new Pkt(T.STATUS).u32(id).u32(code).str(msg || '').str('').done()); }
    function newHandle(obj) { var h = 'h' + (nextH++); handles[h] = obj; return h; }

    channel.on('data', function (d) { inbuf = Buffer.concat([inbuf, d]); process(); });
    // The sftp client signals it is done by sending CHANNEL_EOF and then waits for the server to close the channel.
    // Release handles and finish the channel (exit-status + eof + close) so the client can disconnect.
    channel.on('eof', function () { closeAll(); if (channel.exit) channel.exit(0); });
    channel.on('close', function () { closeAll(); });

    function closeAll() {
        for (var h in handles) { if (handles[h] && handles[h].fd != null) { try { fs.close(handles[h].fd, function () {}); } catch (e) {} } }
        handles = {};
    }

    function process() {
        while (inbuf.length >= 4) {
            var len = inbuf.readUInt32BE(0);
            if (len > 256 * 1024 + 64) { channel.close(); return; }      // oversized frame: bail
            if (inbuf.length < 4 + len) return;
            var frame = inbuf.slice(4, 4 + len); inbuf = inbuf.slice(4 + len);
            handle(frame[0], new Reader(frame.slice(1)));
        }
    }

    function handle(type, r) {
        if (type === T.INIT) { r.u32(); return reply(new Pkt(T.VERSION).u32(3).done()); }
        var id = r.u32();
        switch (type) {
            case T.REALPATH: {
                var p = r.str().toString('utf8') || '.';
                var abs = path.resolve(p);
                return reply(new Pkt(T.NAME).u32(id).u32(1).str(abs).str(abs).raw(Buffer.alloc(4)).done()); // one name, empty attrs
            }
            case T.STAT: case T.LSTAT: {
                var sp = r.str().toString('utf8'); var fn = type === T.STAT ? fs.stat : fs.lstat;
                return fn(sp, function (e, st) { if (e) return status(id, errStatus(e), e.message); reply(new Pkt(T.ATTRS).u32(id).raw(attrsBuf(st)).done()); });
            }
            case T.FSTAT: {
                var hd = handles[r.str().toString()]; if (!hd || hd.fd == null) return status(id, FX.FAILURE, 'bad handle');
                return fs.fstat(hd.fd, function (e, st) { if (e) return status(id, errStatus(e), e.message); reply(new Pkt(T.ATTRS).u32(id).raw(attrsBuf(st)).done()); });
            }
            case T.OPEN: {
                var fp = r.str().toString('utf8'); var pf = r.u32(); skipAttrs(r);
                var flags = (pf & F.WRITE) ? ((pf & F.READ) ? 'r+' : 'w') : 'r';
                if (pf & F.APPEND) flags = 'a';
                if ((pf & F.CREAT) && (pf & F.EXCL)) flags = 'wx';
                else if ((pf & F.CREAT) && (pf & F.TRUNC)) flags = 'w';
                else if ((pf & F.CREAT) && (pf & F.WRITE)) flags = (pf & F.READ) ? 'a+' : 'a';
                if ((pf & F.WRITE) && (pf & F.TRUNC)) flags = (pf & F.READ) ? 'w+' : 'w';
                return fs.open(fp, flags, function (e, fd) {
                    if (e) return status(id, errStatus(e), e.message);
                    reply(new Pkt(T.HANDLE).u32(id).str(newHandle({ fd: fd, path: fp })).done());
                });
            }
            case T.READ: {
                var rh = handles[r.str().toString()]; var off = r.u64(), rl = r.u32();
                if (!rh || rh.fd == null) return status(id, FX.FAILURE, 'bad handle');
                var buf = Buffer.alloc(Math.min(rl, 256 * 1024));
                return fs.read(rh.fd, buf, 0, buf.length, off, function (e, n) {
                    if (e) return status(id, errStatus(e), e.message);
                    if (n === 0) return status(id, FX.EOF);
                    reply(new Pkt(T.DATA).u32(id).str(buf.slice(0, n)).done());
                });
            }
            case T.WRITE: {
                var wh = handles[r.str().toString()]; var woff = r.u64(), wdata = r.str();
                if (!wh || wh.fd == null) return status(id, FX.FAILURE, 'bad handle');
                return fs.write(wh.fd, wdata, 0, wdata.length, woff, function (e) { status(id, e ? errStatus(e) : FX.OK, e ? e.message : ''); });
            }
            case T.CLOSE: {
                var hk = r.str().toString(), ch = handles[hk]; delete handles[hk];
                if (ch && ch.fd != null) return fs.close(ch.fd, function (e) { status(id, e ? errStatus(e) : FX.OK, e ? e.message : ''); });
                return status(id, FX.OK);
            }
            case T.OPENDIR: {
                var dp = r.str().toString('utf8');
                return fs.readdir(dp, function (e, names) { if (e) return status(id, errStatus(e), e.message); reply(new Pkt(T.HANDLE).u32(id).str(newHandle({ dir: dp, names: names, i: 0 })).done()); });
            }
            case T.READDIR: {
                var dh = handles[r.str().toString()]; if (!dh || !dh.names) return status(id, FX.FAILURE, 'bad handle');
                if (dh.i >= dh.names.length) return status(id, FX.EOF);
                var batch = dh.names.slice(dh.i, dh.i + 64); dh.i += batch.length;
                var entries = [], pending = batch.length;
                if (!pending) return status(id, FX.EOF);
                batch.forEach(function (nm) {
                    fs.lstat(path.join(dh.dir, nm), function (e, st) {
                        entries.push({ name: nm, st: e ? null : st });
                        if (--pending === 0) {
                            var pkt = new Pkt(T.NAME).u32(id).u32(entries.length);
                            entries.forEach(function (en) {
                                var st2 = en.st || { size: 0, uid: 0, gid: 0, mode: 0, atimeMs: 0, mtimeMs: 0, isDirectory: function () { return false; }, isSymbolicLink: function () { return false; }, isCharacterDevice: function () { return false; }, isBlockDevice: function () { return false; }, isFIFO: function () { return false; }, isSocket: function () { return false; } };
                                pkt.str(en.name).str(longname(en.name, st2)).raw(attrsBuf(st2));
                            });
                            reply(pkt.done());
                        }
                    });
                });
                return;
            }
            case T.REMOVE: { var rp = r.str().toString('utf8'); return fs.unlink(rp, function (e) { status(id, e ? errStatus(e) : FX.OK, e ? e.message : ''); }); }
            case T.MKDIR: { var mp = r.str().toString('utf8'); skipAttrs(r); return fs.mkdir(mp, function (e) { status(id, e ? errStatus(e) : FX.OK, e ? e.message : ''); }); }
            case T.RMDIR: { var rmp = r.str().toString('utf8'); return fs.rmdir(rmp, function (e) { status(id, e ? errStatus(e) : FX.OK, e ? e.message : ''); }); }
            case T.RENAME: { var op = r.str().toString('utf8'), np = r.str().toString('utf8'); return fs.rename(op, np, function (e) { status(id, e ? errStatus(e) : FX.OK, e ? e.message : ''); }); }
            case T.SETSTAT: case T.FSETSTAT: {
                var target, isH = type === T.FSETSTAT;
                if (isH) { var sh = handles[r.str().toString()]; target = sh && sh.path; } else target = r.str().toString('utf8');
                var at = skipAttrs(r);
                if (!target) return status(id, FX.OK);
                var steps = [];
                if (at.mode != null) steps.push(function (cb) { fs.chmod(target, at.mode & 0xfff, cb); });
                if (at.size != null) steps.push(function (cb) { fs.truncate(target, at.size, cb); });
                if (at.atime != null && at.mtime != null) steps.push(function (cb) { fs.utimes(target, at.atime, at.mtime, cb); });
                (function run(i) { if (i >= steps.length) return status(id, FX.OK); steps[i](function (e) { if (e) return status(id, errStatus(e), e.message); run(i + 1); }); })(0);
                return;
            }
            case T.READLINK: { var lp = r.str().toString('utf8'); return fs.readlink(lp, function (e, t) { if (e) return status(id, errStatus(e), e.message); reply(new Pkt(T.NAME).u32(id).u32(1).str(t).str(t).raw(Buffer.alloc(4)).done()); }); }
            default: return status(id, FX.OP_UNSUPPORTED, 'unsupported');
        }
    }
}

module.exports = { serve: serve };
