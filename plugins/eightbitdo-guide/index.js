'use strict';

// The bundled .NET helper forwards a matching gamepad, withholding Guide.
// It releases its evdev grab and virtual gamepad when stopped. See README.md.
module.exports = function (ctx) {
    var fs = require('fs');
    var path = require('path');
    var timer = null;
    var active = false;
    var busy = false;
    var generation = 0;
    var detail = { running: false, connected: false, lastResult: 'stopped' };
    var unit = 'vetro-8bitdo-guide';

    function quote(value) {
        return "'" + value.replace(/'/g, "'\\''") + "'";
    }

    function shell(script) {
        var bytes = Buffer.from ? Buffer.from(script) : new Buffer(script);
        return 'echo ' + bytes.toString('base64') + ' | base64 -d | sh';
    }

    function stopCommand() {
        return 'systemctl stop ' + unit + '.service >/dev/null 2>&1 || true';
    }

    function startCommand() {
        var runtime = path.join(ctx.dir, 'runtime');
        // Create as Vetro's own UID so updates/removal can traverse the folder.
        if (!fs.existsSync(runtime)) fs.mkdirSync(runtime, 448);
        var info = fs.lstatSync(runtime);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe runtime directory');
        // Assets belong to the installed module; ctx.dir is its writable work area.
        var encoded = fs.readFileSync(path.join(__dirname, 'guide-bridge.dll.gz.b64'), 'utf8').trim();
        var binary = path.join(ctx.dir, 'guide-bridge.dll');
        var stateArgs = ' --state-dir ' + quote(runtime);
        return shell('set -e\n' +
            'if ! systemctl is-active --quiet ' + unit + '.service; then\n' +
            'echo ' + quote(encoded) + ' | base64 -d | gzip -d > ' + quote(binary + '.new') + '\n' +
            'chmod 600 ' + quote(binary + '.new') + '\n' +
            'mv ' + quote(binary + '.new') + ' ' + quote(binary) + '\n' +
            '/usr/bin/dotnet ' + quote(binary) + ' --self-test >/dev/null\n' +
            '/usr/bin/dotnet ' + quote(binary) + ' --check-platform\n' +
            'systemctl reset-failed ' + unit + '.service >/dev/null 2>&1 || true\n' +
            'systemd-run --unit=' + unit + ' --collect -p Restart=on-failure -p RestartSec=2 ' +
            '-p StandardOutput=null -p StandardError=null /usr/bin/dotnet ' + quote(binary) + stateArgs + ' >/dev/null 2>&1\n' +
            'fi\n/usr/bin/dotnet ' + quote(binary) + ' --status' + stateArgs);
    }

    function failure(error, mine) {
        if (active && mine === generation) {
            detail = { running: false, connected: false, lastResult: String(error.message || error) };
        }
    }

    function check() {
        if (!active || busy) return;
        busy = true;
        var mine = generation;
        var command;
        try {
            command = startCommand();
        } catch (error) {
            failure(error, mine);
            busy = false;
            return;
        }
        // A synchronous execute failure must also stay inside this callback.
        Promise.resolve().then(function () {
            return ctx.execute(command, 10000);
        }).then(function (result) {
            if (!active) return ctx.execute(stopCommand(), 10000);
            if (mine !== generation) return;
            if (result.exit_code || result.timed_out) {
                throw new Error(result.stderr || 'Could not start the Guide bridge');
            }
            try {
                detail = JSON.parse(result.stdout);
            } catch (error) {
                detail = { running: true, connected: false, lastResult: 'starting' };
            }
        }).catch(function (error) {
            failure(error, mine);
        }).then(function () {
            busy = false;
        });
    }

    return {
        start: function () {
            if (active) return;
            active = true;
            generation++;
            detail = { running: false, connected: false, lastResult: 'starting' };
            check();
            timer = setInterval(check, 5000);
        },
        stop: function () {
            active = false;
            generation++;
            if (timer) clearInterval(timer);
            timer = null;
            detail = { running: false, connected: false, lastResult: 'stopped' };
            return Promise.resolve().then(function () {
                return ctx.execute(stopCommand(), 10000);
            }).catch(function () {});
        },
        status: function () {
            return detail;
        }
    };
};
