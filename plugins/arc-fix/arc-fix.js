'use strict';
// Opt-in HDMI ARC receiver reset for legacy AV receivers (such as the Yamaha RX-V375) that get
// stuck in "Decoder Off" when the TV switches the ARC S/PDIF stream from PCM to Dolby Digital / DD+.
//
// Sending CEC <Routing Change> (0.0.0.0 -> <port>.0.0.0) via org.tizen.tv.HdmiCec.SendRoutingChange
// without starting Tizen's One-Touch-Play timer switches only the AV receiver's internal input away
// from ARC (e.g. AV1 -> HDMI 1) while leaving the TV's active app (Stremio, Netflix, etc.) untouched.
// Waiting a few seconds (4 by default) and calling org.tizen.tv.HdmiCec.SetActiveSource returns the receiver to ARC,
// forcing its S/PDIF DSP to re-lock onto the AC3/EAC3 bitstream.
//
// This is the logic of the "arc-fix" Vetro plugin (API 1). The plugin being switched on is what turns the watcher on:
// nothing runs in the background unless the user switches the plugin on. Plain ES5, like every module the TV loads.

var UNIT = 'vetro-arc-fix';
var RETRY_FIRST_MS = 15000;
var RETRY_MAX_MS = 180000;

var DEC_CODECS = {
    0: 'LPCM', 1: 'AC3', 2: 'MPEG', 3: 'DTS', 4: 'WMA', 5: 'AAC', 6: 'ADPCM',
    7: 'MULAW', 8: 'ALAW', 9: 'EAC3', 13: 'VORBIS', 14: 'HE-AAC', 15: 'DTS LBR',
    16: 'AC4', 17: 'MPEG-H', 18: 'TrueHD', 19: 'MAT', 20: 'OPUS', 21: 'MCH PCM', 23: 'Idle'
};
var SPDIF_FORMATS = {
    0: 'NEO ES DTS', 1: 'ES DTS', 2: 'ES Dolby Digital', 3: 'PCM',
    4: 'ES AAC', 5: 'ES DD+', 6: 'MAT', 7: 'MCH PCM'
};

// Node 4 has Buffer.from, but it is the Uint8Array one and throws on a string; only Node 4.5+ has the real one.
function b64(s) { return (Buffer.from && Buffer.from !== Uint8Array.from ? Buffer.from(s, 'utf8') : new Buffer(s, 'utf8')).toString('base64'); }
// Shell functions every script uses to find the receiver, so the page, the watcher and the manual reset all agree.
// find_receiver prints the CEC index of the device that reports AUDIO_SYSTEM; when none does but the TV says a
// receiver is there, index 0. Prints nothing when there is no receiver; the resets still try index 0 then, as the
// TV may answer GetDevicePortNum even while IsReceiverAvailable says 0. port_of <index> prints that device's HDMI port.
var RECEIVER_SHELL_FUNCTIONS = [
    'find_receiver() {',
    '  for idx in 0 1 2 3 4; do',
    '    case "$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec GetDeviceType i $idx 2>/dev/null)" in *AUDIO_SYSTEM*) echo "$idx"; return ;; esac',
    '  done',
    '  a=$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec IsReceiverAvailable 2>/dev/null | awk \'{print $2}\')',
    '  if [ "$a" = "1" ]; then echo 0; fi',
    '}',
    'port_of() {',
    '  busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec GetDevicePortNum i "$1" 2>/dev/null | awk \'{print $3}\'',
    '}'
].join('\n');

function wrap(s) { return 'echo ' + b64(s) + ' | base64 -d | /bin/sh'; }
function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// promise.finally without relying on the runtime having it
function settle(promise, fn) {
    return promise.then(function (v) { fn(); return v; }, function (e) { fn(); throw e; });
}

function clampDelay(v) {
    var n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 4;
}

function validPort(v) {
    if (v === null || v === undefined || v === '' || v === 'auto' || v === 0 || v === '0') return null;
    var n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

function check(r, what) {
    if (!r || r.exit_code || r.timed_out) throw new Error((r && (r.stderr || r.stdout)) || what + ' failed');
    return r.stdout || '';
}

// options.execute: ctx.execute. options.store: { get(): object, set(object) } (ctx.config). options.dir: ctx.dir.
// The PID and log files live in the plugin's own folder. Paths are shell-quoted once here.
function ArcFix(options) {
    var o = options || {};
    this.execute = o.execute;
    this.store = o.store || { get: function () { return {}; }, set: function () {} };
    this.pidFile = shellQuote(o.dir + '/vetro-arc-fix.pid');
    this.logFile = shellQuote(o.dir + '/vetro-arc-fix.log');
    this.now = o.now || function () { return Date.now(); };
    this.cancelWait = null;       // set while a manual reset waits between its two steps
    this.active = false;          // the plugin is switched on: the watcher should be running
    this.busy = false;
    this.lastError = null;
    this.failures = 0;
    this.nextTry = 0;
}

ArcFix.prototype.readState = function () {
    var d = null;
    try { d = this.store.get(); } catch (e) { d = null; }
    return {
        delaySeconds: clampDelay(d && d.delaySeconds),
        port: validPort(d && d.port),
        since: d && isFinite(d.since) && d.since !== null ? d.since : null
    };
};

ArcFix.prototype.writeState = function (state) {
    try { this.store.set(state); }
    catch (e) { throw new Error('The ARC fix setting could not be saved: ' + e.message); }
};

// Merges into what is stored, not into readState(): that one fills in defaults, and saving them would freeze today's
// default as if the user had chosen it.
ArcFix.prototype.patchState = function (patch) {
    var stored = null;
    try { stored = this.store.get(); } catch (e) { stored = null; }
    this.writeState(Object.assign({}, stored, patch));
};

// Prints "running=<pid>" when the watcher process is alive, "running=" otherwise.
ArcFix.prototype.runningCheckScript = function () {
    return [
        'p=$(cat ' + this.pidFile + ' 2>/dev/null)',
        'if [ -n "$p" ] && tr "\\0" " " < /proc/$p/cmdline 2>/dev/null | grep -q vetro-arc-fix; then echo "running=$p"; else echo "running="; fi'
    ].join('\n');
};

// Only the PID check, for the 10 s supervision: the full probe() reads CEC and amixer, which only the page needs.
ArcFix.prototype.isRunning = function () {
    return this.execute(wrap(this.runningCheckScript()), 5000).then(function (r) {
        return /^running=\d+$/m.test(check(r, 'ARC watcher check'));
    });
};

ArcFix.prototype.probeScript = function () {
    return [
        RECEIVER_SHELL_FUNCTIONS,
        this.runningCheckScript(),
        'avail=$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec IsReceiverAvailable 2>/dev/null | awk \'{print $2}\')',
        'echo "avail=${avail:-0}"',
        'rname=""; rport=""',
        'ridx=$(find_receiver)',
        'if [ -n "$ridx" ]; then',
        '  rname=$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec GetDeviceName i "$ridx" 2>/dev/null | sed -n \'s/^is [0-9-]* "\\(.*\\)"$/\\1/p\')',
        '  rport=$(port_of "$ridx")',
        'fi',
        'echo "rname=$rname"',
        'echo "rport=$rport"',
        'dec0=$(amixer cget numid=89 2>/dev/null | sed -n \'s/.*: values=\\([0-9]*\\).*/\\1/p\')',
        'spdif=$(amixer cget numid=20 2>/dev/null | sed -n \'s/.*: values=\\([0-9]*\\).*/\\1/p\')',
        'echo "dec0=$dec0"',
        'echo "spdif=$spdif"',
        'echo "log:"',
        'tail -n 8 ' + this.logFile + ' 2>/dev/null || true'
    ].join('\n');
};

ArcFix.prototype.probe = function () {
    return this.execute(wrap(this.probeScript()), 8000).then(function (r) {
        var out = check(r, 'ARC probe');
        var runM = /^running=(\d*)$/m.exec(out);
        var availM = /^avail=(\d+)$/m.exec(out);
        var nameM = /^rname=(.*)$/m.exec(out);
        var portM = /^rport=(\d*)$/m.exec(out);
        var decM = /^dec0=(\d*)$/m.exec(out);
        var spdifM = /^spdif=(\d*)$/m.exec(out);
        var pid = runM && runM[1] ? +runM[1] : null;
        var port = portM && portM[1] ? +portM[1] : null;
        var dec0 = decM && decM[1] !== '' ? +decM[1] : null;
        var spdif = spdifM && spdifM[1] !== '' ? +spdifM[1] : null;
        // The TV answers "[Invalid UTF-8]" for some receivers' CEC names; treat it as no name.
        var receiverName = nameM && nameM[1] && nameM[1] !== '[Invalid UTF-8]' ? nameM[1].trim() : null;
        return {
            running: !!pid,
            pid: pid,
            receiver: {
                available: availM ? availM[1] === '1' : false,
                name: receiverName || null,
                port: port && port >= 1 && port <= 4 ? port : null
            },
            stream: {
                codecId: dec0,
                codec: dec0 !== null ? (DEC_CODECS[dec0] || ('Codec ' + dec0)) : null,
                spdifId: spdif,
                spdif: spdif !== null ? (SPDIF_FORMATS[spdif] || ('Format ' + spdif)) : null
            },
            log: out.indexOf('log:\n') >= 0 ? out.split('log:\n')[1].trim() : ''
        };
    });
};

ArcFix.prototype.status = function () {
    var self = this, state = this.readState();
    var base = {
        enabled: this.active,
        delaySeconds: state.delaySeconds,
        port: state.port,
        since: state.since,
        busy: this.busy,
        error: this.lastError,
        failures: this.failures
    };
    return this.probe().then(function (p) {
        return Object.assign(base, p, {effectivePort: state.port || (p.receiver && p.receiver.port) || 3});
    }).catch(function (e) {
        return Object.assign(base, {
            running: null, pid: null,
            receiver: {available: false, name: null, port: null},
            stream: {codecId: null, codec: null, spdifId: null, spdif: null},
            effectivePort: state.port || 3,
            log: '',
            probeError: e.message
        });
    });
};

ArcFix.prototype.daemonFileContent = function (delaySeconds, configuredPort) {
    var delay = clampDelay(delaySeconds);
    var fixedPort = validPort(configuredPort);
    return [
        '#!/bin/sh',
        '# Vetro background watcher for HDMI ARC "Decoder Off" recovery.',
        'echo $$ > ' + this.pidFile,
        'DELAY=' + delay,
        'FIXED_PORT=' + (fixedPort || 0),
        'LAST_RUN=0',
        'RESET_TIMES=""',
        'log_msg() {',
        '  ts=$(date "+%H:%M:%S" 2>/dev/null || echo "--:--:--")',
        '  echo "[$ts] $1" >> ' + this.logFile,
        '  if [ "$(wc -l < ' + this.logFile + ' 2>/dev/null || echo 0)" -gt 60 ]; then',
        '    tail -n 40 ' + this.logFile + ' > ' + this.logFile + '.tmp && mv ' + this.logFile + '.tmp ' + this.logFile,
        '  fi',
        '}',
        RECEIVER_SHELL_FUNCTIONS,
        'resolve_port() {',
        '  if [ "$FIXED_PORT" -ge 1 ] && [ "$FIXED_PORT" -le 4 ]; then echo "$FIXED_PORT"; return; fi',
        '  p=$(port_of "$1")',
        '  case "$p" in 1|2|3|4) echo "$p" ;; *) echo 3 ;; esac',
        '}',
        'read_ctl() { amixer cget numid=$1 2>/dev/null | sed -n \'s/.*: values=\\([0-9]*\\).*/\\1/p\'; }',
        // The receiver loses the stream when the TV switches it from PCM to a bitstream. From one Dolby stream to the
        // same format (the next episode) it keeps up by itself, so the watcher remembers the last S/PDIF format and
        // skips the reset only when it has not changed. A different bitstream (DTS to Dolby) still gets a reset.
        'LAST_SPDIF=$(read_ctl 20)',
        'log_msg "Watcher started (delay=${DELAY}s, port=$([ "$FIXED_PORT" -ge 1 ] && echo "$FIXED_PORT" || echo auto), spdif=${LAST_SPDIF:-?})"',
        'busctl --system --augment-creds=no -j monitor 2>/dev/null | grep --line-buffered -E \'"member":"SetAudioInformation"|"member":"DigitalAudioFormatChanged"\' | while read -r line; do',
        '  now=$(date +%s 2>/dev/null || echo 0)',
        '  if [ $((now - LAST_RUN)) -lt 8 ]; then continue; fi',
        '  enc=$(echo "$line" | sed -n \'s/.*"data":\\[\\[[0-9-]*,[0-9-]*,\\([0-9-]*\\),.*/\\1/p\')',
        // The S/PDIF format can flip to a bitstream before the decoder reports its codec: wait up to 4 s for it.
        '  tries=0',
        '  while :; do',
        '    sleep 1',
        '    dec0=$(read_ctl 89)',
        '    spdif=$(read_ctl 20)',
        '    case "${spdif:-3}" in 3|7) break ;; esac',
        '    case "${dec0:-0}" in 1|3|9|15|16|18|19) break ;; esac',
        '    tries=$((tries + 1)); if [ "$tries" -ge 4 ]; then break; fi',
        '  done',
        '  prev=${LAST_SPDIF:-3}',
        '  case "${spdif:-3}" in 3|7)',
        '    LAST_SPDIF=${spdif:-3}',
        '    case "$prev" in 3|7) ;; *) log_msg "Back to PCM (spdif ${prev} -> ${spdif:-?})" ;; esac',
        '    continue ;;',
        '  esac',
        '  if [ "$prev" = "$spdif" ]; then log_msg "Same bitstream (spdif ${spdif}), receiver already locked: no reset"; continue; fi',
        '  case "${dec0:-0}" in',
        '    1|3|9|15|16|18|19)',
        '      idx=$(find_receiver)',
        '      if [ -z "$idx" ]; then log_msg "No CEC receiver found: no reset"; continue; fi',
        // A receiver that needs more than the 8 s debounce to re-lock would be reset again and again: at most 3 per 5 minutes.
        '      recent=""; n=0',
        '      for t in $RESET_TIMES; do if [ $((now - t)) -lt 300 ]; then recent="$recent $t"; n=$((n + 1)); fi; done',
        '      RESET_TIMES=$recent',
        '      if [ "$n" -ge 3 ]; then log_msg "3 resets in the last 5 minutes: pausing, no reset"; continue; fi',
        '      port=$(resolve_port "$idx")',
        '      LAST_SPDIF=$spdif',
        '      log_msg "Dolby/DTS bitstream start (enc=${enc:-?}, dec0=${dec0}, spdif=${spdif}) -> RoutingChange(0->${port}), wait ${DELAY}s, SetActiveSource"',
        '      dbus-send --system --print-reply --dest=org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec.SendRoutingChange int32:0 int32:"$port" >/dev/null 2>&1',
        '      sleep "$DELAY"',
        '      dbus-send --system --print-reply --dest=org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec.SetActiveSource >/dev/null 2>&1',
        '      LAST_RUN=$(date +%s 2>/dev/null || echo 0)',
        '      RESET_TIMES="$RESET_TIMES $LAST_RUN"',
        '      log_msg "ARC reset complete on HDMI ${port}"',
        '      ;;',
        // The format is only remembered once handled, so the next event tries again.
        '    *) log_msg "Bitstream (spdif ${spdif}) but decoder ${dec0:-?} is not Dolby/DTS: no reset" ;;',
        '  esac',
        'done'
    ].join('\n') + '\n';
};

ArcFix.prototype.stopLines = function () {
    return [
        'systemctl stop ' + UNIT + '.service >/dev/null 2>&1 || true',
        'p=$(cat ' + this.pidFile + ' 2>/dev/null)',
        'if [ -n "$p" ] && tr "\\0" " " < /proc/$p/cmdline 2>/dev/null | grep -q vetro-arc-fix; then',
        '  pkill -P "$p" >/dev/null 2>&1 || true',
        '  kill -9 "$p" >/dev/null 2>&1 || true',
        '  sleep 0.2',
        'fi',
        'rm -f ' + this.pidFile
    ].join('\n');
};

ArcFix.prototype.startScript = function (state) {
    // No script file: Tizen's UEP refuses to run unsigned script files ("the file is NOT signed"), so the watcher
    // reaches the shell on stdin, base64-encoded, like every command here (wrap()). "-s vetro-arc-fix" puts the
    // name in the process's cmdline, which the PID checks look for.
    var daemonB64 = b64(this.daemonFileContent(state.delaySeconds, state.port));
    var runner = '/bin/sh -c \'echo ' + daemonB64 + ' | base64 -d | /bin/sh -s vetro-arc-fix\'';
    return [
        this.stopLines(),
        'systemd-run --unit=' + UNIT + ' --collect -p KillSignal=SIGKILL -p StandardOutput=null -p StandardError=null ' + runner + ' >/dev/null 2>&1 || ' +
            'setsid nohup ' + runner + ' </dev/null >/dev/null 2>&1 &',
        'sleep 0.4',
        'echo started'
    ].join('\n');
};

ArcFix.prototype.launch = function () {
    var self = this, state = this.readState();
    return this.execute(wrap(this.startScript(state)), 10000).then(function (r) {
        check(r, 'ARC watcher start');
        // Switched off while the watcher was starting: end()'s stop may have run before the start finished.
        if (!self.active) return self.end();
        return self.isRunning().then(function (running) {
            if (!running) throw new Error('The ARC watcher process did not stay running');
        });
    });
};

// The plugin was switched on: start the background watcher.
ArcFix.prototype.begin = function () {
    var self = this;
    this.active = true;
    if (this.busy) return Promise.reject(new Error('Another ARC receiver action is in progress'));
    this.busy = true; this.lastError = null;
    return settle(this.launch().then(function () {
        try { self.patchState({ since: self.now() }); } catch (e) { /* the watcher runs; only the timestamp is lost */ }
        self.failures = 0; self.nextTry = 0;
    }).catch(function (e) {
        self.lastError = e.message;      // supervise() tries again with a growing delay
        throw e;
    }), function () { self.busy = false; });
};

// The plugin was switched off: stop the watcher.
ArcFix.prototype.end = function () {
    var self = this;
    this.active = false;
    // A manual reset is waiting between its two steps: end the wait now, so the receiver does not stay away from ARC.
    if (this.cancelWait) this.cancelWait();
    return this.execute(wrap(this.stopLines()), 8000).then(function (r) {
        check(r, 'ARC watcher stop');
    }).catch(function (e) { self.lastError = e.message; });
};

ArcFix.prototype.configure = function (options) {
    var self = this;
    if (this.busy) return Promise.reject(new Error('Another ARC receiver action is in progress'));
    var cur = this.readState();
    var delaySeconds = options && options.delaySeconds !== undefined ? clampDelay(options.delaySeconds) : cur.delaySeconds;
    var port = options && options.port !== undefined ? validPort(options.port) : cur.port;
    try { this.patchState({ delaySeconds: delaySeconds, port: port }); }
    catch (e) { return Promise.reject(e); }
    if (!this.active) return this.status();
    this.busy = true; this.lastError = null;
    return settle(this.launch().then(function () { return self.status(); }).catch(function (e) {
        self.lastError = e.message; throw e;
    }), function () { self.busy = false; });
};

ArcFix.prototype.trigger = function (options) {
    var self = this;
    if (this.busy) return Promise.reject(new Error('Another ARC receiver action is in progress'));
    this.busy = true; this.lastError = null;
    var state = this.readState();
    var delay = options && options.delaySeconds !== undefined ? clampDelay(options.delaySeconds) : state.delaySeconds;
    var reqPort = options && options.port !== undefined ? validPort(options.port) : state.port;
    // Two root commands with the wait in between done here, so the TV's root agent is not held during the wait and
    // each dbus-send reports its own failure.
    var run = this.sendRoutingChange(reqPort).then(function (usedPort) {
        return new Promise(function (resolve) {
            self.cancelWait = function () { clearTimeout(timer); self.cancelWait = null; resolve(); };
            var timer = setTimeout(self.cancelWait, delay * 1000);
        }).then(function () {
            return self.sendActiveSource(usedPort).catch(function (e) {
                throw new Error('The receiver was switched away from ARC but SetActiveSource failed: ' + e.message);
            });
        }).then(function () {
            return self.status();
        }).then(function (st) {
            return Object.assign(st, {triggered: true, usedPort: usedPort, usedDelaySeconds: delay});
        });
    }).catch(function (e) {
        self.lastError = e.message;
        throw e;
    });
    return settle(run, function () { self.busy = false; });
};

// First half of the manual reset: the receiver leaves ARC. Resolves with the HDMI port it was sent to.
ArcFix.prototype.sendRoutingChange = function (reqPort) {
    var script = [
        RECEIVER_SHELL_FUNCTIONS,
        'port=' + (reqPort || 0),
        'if [ "$port" -lt 1 ] || [ "$port" -gt 4 ]; then',
        '  idx=$(find_receiver); p=$(port_of "${idx:-0}")',
        '  case "$p" in 1|2|3|4) port=$p ;; *) port=3 ;; esac',
        'fi',
        'ts=$(date "+%H:%M:%S" 2>/dev/null || echo "--:--:--")',
        'echo "[$ts] Manual reset -> RoutingChange(0->${port})" >> ' + this.logFile,
        'dbus-send --system --print-reply --dest=org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec.SendRoutingChange int32:0 int32:"$port" >/dev/null || exit 1',
        'echo "reset_port=$port"'
    ].join('\n');
    return this.execute(wrap(script), 10000).then(function (r) {
        var m = /^reset_port=(\d+)$/m.exec(check(r, 'ARC RoutingChange'));
        return m ? +m[1] : (reqPort || 3);
    });
};

// Second half of the manual reset: the TV is the active source again and the receiver goes back to ARC.
ArcFix.prototype.sendActiveSource = function (port) {
    var script = [
        'dbus-send --system --print-reply --dest=org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec.SetActiveSource >/dev/null || exit 1',
        'ts=$(date "+%H:%M:%S" 2>/dev/null || echo "--:--:--")',
        'echo "[$ts] Manual ARC reset complete on HDMI ' + port + '" >> ' + this.logFile
    ].join('\n');
    return this.execute(wrap(script), 10000).then(function (r) { check(r, 'ARC SetActiveSource'); });
};

// Called on a timer while the plugin is on. If the root agent is not connected yet the commands fail and the retry
// delay grows (15 s, 30 s, ... 3 min), so a TV that is still booting is simply tried again.
ArcFix.prototype.supervise = function () {
    var self = this;
    if (!this.active || this.busy || this.now() < this.nextTry) return Promise.resolve(null);
    this.busy = true;
    return settle(this.isRunning().then(function (running) {
        if (running) { self.failures = 0; return 'running'; }
        return self.launch().then(function () { self.failures = 0; self.lastError = null; return 'started'; });
    }).catch(function (e) {
        self.failures++;
        self.nextTry = self.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * Math.pow(2, Math.min(self.failures, 6) - 1));
        self.lastError = e.message;
        return 'failed';
    }), function () { self.busy = false; });
};

module.exports = { ArcFix: ArcFix, clampDelay: clampDelay, validPort: validPort };
