'use strict';
// Notices, without a root command, when Samsung's YouTube may have been started without our flags. Plain ES5.
//
// Vetro's process can list /proc but, on Tizen, usually cannot read the files of another app's processes (no Smack rule from one
// app to another). So the gate watches for new processes: one it can read is looked at directly (the Cobalt app's command line
// says whether it carries our flags); one it cannot read is "something that is not ours started", and only if it is still there
// at the next scan (so the root agent's own short-lived commands never count) it asks for one root check. Each process is tried
// once in its life, which keeps the TV's Smack log to one line per such process. The once-a-minute check in index.js covers
// anything this misses.

var fs = require('fs');

var COBALT_BIN = '/usr/apps/com.samsung.tv.cobalt/bin/cobalt_launcher';

function fromBase64(text) { return Buffer.from && Buffer.from !== Uint8Array.from ? Buffer.from(text, 'base64') : new Buffer(text, 'base64'); }

function decodeAul(b64) {
    if (!b64) return '';
    try { return fromBase64(b64).toString('binary').replace(/[^\x20-\x7e]/g, ' '); } catch (e) { return ''; }
}

// The same decision as setup.checkScript(), from one process's /proc/<pid>/cmdline: 'ok' (YouTube with our flags), 'relaunch'
// (YouTube without them), or null (not Samsung's YouTube). Scans all NUL-separated AUL tokens for USERDATA (falling back to
// args[3] on older Tizen) and __AUL_APPID__ (for bare launches without USERDATA).
function classify(cmdline) {
    var args = String(cmdline || '').split('\0');
    if (args[0].indexOf(COBALT_BIN) !== 0) return null;
    var ud = null, appId = null;
    for (var i = 1; i < args.length - 1; i++) {
        if (args[i] === 'USERDATA' && ud === null) ud = args[i + 1];
        else if (args[i] === '__AUL_APPID__' && appId === null) appId = args[i + 1];
    }
    var text = decodeAul(ud || args[3]);
    var isYt = (' ' + text + ' ').indexOf('dial_name=YouTube ') >= 0;
    if (!isYt && appId) {
        var idText = decodeAul(appId);
        if (/(?:^| )com\.samsung\.tv\.cobalt-yt(?: |$)/.test(idText)) isYt = true;
    }
    if (!isYt) return null;
    return text.indexOf('share/vyt') >= 0 ? 'ok' : 'relaunch';
}

// opts: { proc: '/proc', fs: (for tests) }
function Gate(opts) {
    opts = opts || {};
    this.proc = opts.proc || '/proc';
    this.fs = opts.fs || fs;
    this.seen = null;            // pid -> 'base' (there before, never tried) | 'read' | 'new' (unreadable, seen once) | 'done'
}

// Forget what was seen: the next scan only takes note of what is running.
Gate.prototype.reset = function () { this.seen = null; };

// quiet: true while the patched app is running (the proxy has connections): new processes are noted, not tried.
// Returns { blind: true } when /proc cannot be listed, else { verdict: 'relaunch' | 'ok' | null, check: boolean }.
Gate.prototype.scan = function (quiet) {
    var names;
    try { names = this.fs.readdirSync(this.proc); } catch (e) { return { blind: true, error: e.message }; }
    var first = !this.seen, old = this.seen || {}, now = {}, verdict = null, check = false;
    for (var i = 0; i < names.length; i++) {
        var pid = names[i];
        if (!/^\d+$/.test(pid)) continue;
        var was = old[pid];
        if (was === 'new') { now[pid] = 'done'; check = true; continue; }
        if (was) { now[pid] = was; continue; }
        if (first || quiet) { now[pid] = 'base'; continue; }
        var cmdline;
        try { cmdline = this.fs.readFileSync(this.proc + '/' + pid + '/cmdline', 'binary'); }
        catch (e) {
            if (e.code === 'ENOENT' || e.code === 'ESRCH') continue;          // already gone
            now[pid] = 'new';                                                  // EACCES / EPERM: not ours to read
            continue;
        }
        now[pid] = 'read';
        var v = classify(cmdline);
        if (v === 'relaunch' || (v === 'ok' && !verdict)) verdict = v;
    }
    this.seen = now;
    return { verdict: verdict, check: check };
};

// When to look, without the side effects: index.js calls step() every SCAN_MS and runs what it answers.
// A root check is asked for at most every CHECK_MS when something new started (or a check failed, or the patched app just
// closed), and every BACKSTOP_MS anyway, except while the patched app is open. Blind (no /proc): every CHECK_MS, as before.
var SCAN_MS = 3000, CHECK_MS = 6000, BACKSTOP_MS = 60 * 1000;

function Watcher(opts) {
    this.gate = new Gate(opts);
    this.blind = false;
    this.want = true;            // the first step after a start checks as root: an app already running is in the first scan
    this.last = -Infinity;
    this.wasQuiet = false;
}
// The watch cannot act (the proxy or the certificate is not ready): start over, and check as soon as it can.
Watcher.prototype.blocked = function () { this.gate.reset(); this.want = true; };
// A root check failed (no root agent yet, the TV busy): try again after CHECK_MS, not a minute later.
Watcher.prototype.failed = function () { this.want = true; };
// now: ms; quiet: the proxy has connections (the patched app is open); canAct: false while relaunches are rate-limited.
// Returns { blind: <error, once>, relaunch: true } or { check: 'check' | 'backstop' } (or neither).
Watcher.prototype.step = function (now, quiet, canAct) {
    var out = {}, r = this.blind ? null : this.gate.scan(quiet);
    if (r && r.blind) { this.blind = true; out.blind = r.error; r = null; }
    if (r && r.check) this.want = true;
    if (this.wasQuiet && !quiet) this.want = true;      // it just closed: what started meanwhile was only noted
    this.wasQuiet = quiet;
    if (!canAct) return out;
    if (r && r.verdict === 'relaunch') { out.relaunch = true; return out; }
    var kind = null;
    if (this.blind || this.want) { if (now - this.last >= CHECK_MS) kind = 'check'; }
    else if (!quiet && now - this.last >= BACKSTOP_MS) kind = 'backstop';
    if (kind) { this.want = false; this.last = now; out.check = kind; }
    return out;
};

module.exports = { Gate: Gate, Watcher: Watcher, classify: classify, COBALT_BIN: COBALT_BIN, SCAN_MS: SCAN_MS, CHECK_MS: CHECK_MS, BACKSTOP_MS: BACKSTOP_MS };
