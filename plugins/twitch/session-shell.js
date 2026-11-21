'use strict';
// Assemble fixed shell sources for the owned Twitch session; execute them through stdin.
var fs = require('fs'), path = require('path');
function shellSource(name) {
    return fs.readFileSync(path.join(__dirname, 'session-shell', name + '.sh'), 'utf8');
}
var READ_HELPERS = shellSource('read-helpers');
var CLEANUP_HELPERS = shellSource('cleanup-helpers');
var PREPARE_BODY = shellSource('prepare');
var CLEANUP_GUARD = new Buffer([READ_HELPERS, CLEANUP_HELPERS,
    'if [ "${1:-}" = startup ]; then APP_USER_ID=$(id -u owner); guard_startup "$2" "$3"; else guard_session; fi'].join('\n'), 'utf8').toString('base64');

// Send the generated program as stdin so it needs no executable file on the TV.
function encodeShellCommand(script) {
    return 'echo ' + new Buffer(script, 'utf8').toString('base64') + ' | base64 -d | sh';
}
function inspectSessionScript() {
    return READ_HELPERS + '\ninspect_session';
}
function prepareSessionScript(observedPid, observedStart, fromTile) {
    if (!/^\d+$/.test(String(observedPid)) || !/^\d+$/.test(String(observedStart)) ||
        (Number(observedPid) === 0 && (!fromTile || String(observedStart) !== '0'))) {
        throw new Error('Invalid observed process');
    }
    return [READ_HELPERS, CLEANUP_HELPERS, 'APP_USER_ID=$(id -u owner)',
        'OBSERVED_PID=' + observedPid, 'OBSERVED_START=' + observedStart,
        'FROM_TILE=' + (fromTile ? '1' : '0'),
        'CLEANUP_GUARD_BASE64=' + CLEANUP_GUARD, PREPARE_BODY].join('\n');
}
function cleanupSessionScript(options) {
    var restoreNormalApp = !!(options && options.restoreNormalApp);
    return [READ_HELPERS, CLEANUP_HELPERS, 'APP_USER_ID=$(id -u owner)',
        'RESTORE_NORMAL_APP=' + (restoreNormalApp ? '1' : '0'), 'cleanup_session'].join('\n');
}
function parseSessionSnapshot(output) {
    var snapshot = { pid: 0, start: '0', foreground: false, ownedSession: null, staleSession: false, isolationMissing: false };
    String(output || '').split(/\r?\n/).forEach(function (line) {
        var pair = /^([a-z]+)=(.*)$/.exec(line); if (!pair) return;
        if (pair[1] === 'pid' && /^\d+$/.test(pair[2])) snapshot.pid = Number(pair[2]);
        if (pair[1] === 'start' && /^\d+$/.test(pair[2])) snapshot.start = pair[2];
        if (pair[1] === 'foreground') snapshot.foreground = pair[2] === '1';
        if (pair[1] === 'unsafe') snapshot.isolationMissing = pair[2] === '1';
        if (pair[1] === 'stale') snapshot.staleSession = pair[2] === '1';
        if (pair[1] === 'state') {
            var ownedSession;
            try { ownedSession = JSON.parse(pair[2]); } catch (error) { return; }
            if (!ownedSession || ownedSession.format !== 1 || ownedSession.ready !== true) return;
            var validPort = typeof ownedSession.port === 'number' && ownedSession.port % 1 === 0 &&
                ownedSession.port >= 1024 && ownedSession.port <= 65535;
            var validPid = typeof ownedSession.pid === 'number' && ownedSession.pid > 0 && ownedSession.pid % 1 === 0;
            var validStart = typeof ownedSession.start === 'string' && /^\d+$/.test(ownedSession.start);
            if (validPort && validPid && validStart) snapshot.ownedSession = ownedSession;
        }
    });
    if (snapshot.ownedSession && (snapshot.ownedSession.pid !== snapshot.pid || snapshot.ownedSession.start !== snapshot.start)) {
        snapshot.ownedSession = null;
        snapshot.staleSession = true;
    }
    return snapshot;
}
module.exports = {
    encodeShellCommand: encodeShellCommand,
    inspectSessionScript: inspectSessionScript,
    prepareSessionScript: prepareSessionScript,
    cleanupSessionScript: cleanupSessionScript,
    parseSessionSnapshot: parseSessionSnapshot
};
