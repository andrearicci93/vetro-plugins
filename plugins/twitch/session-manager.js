'use strict';
var sessionShell = require('./session-shell.js');
var SESSION_POLL_MS = 2000;
var SCRIPT_TIMEOUT_MS = 10000;
var PREPARATION_TIMEOUT_MS = 20000;
var PREPARATION_RETRY_STEP_MS = 5000;
var MAX_PREPARATION_BACKOFF_MS = 30000;
var TILE_FALLBACK_MS = 8000;
var CLEANUP_RETRY_MS = 250;
var MAX_CLEANUP_ATTEMPTS = 3;

module.exports = function (context, onChange) {
    var running = false, pollTimer = null, sessionTask = null, tileLaunchTask = null;
    var lifecycleGeneration = 0, preparationFailures = 0, nextPreparationAttemptAt = 0;
    var suppressedProcessIdentity = null, tileFallbackUntil = 0;
    var sessionState = { phase: 'stopped', port: null, error: null, takeovers: 0, key: null, foreground: false };

    function runSessionScript(script, timeout) {
        return context.execute(sessionShell.encodeShellCommand(script), timeout || SCRIPT_TIMEOUT_MS).then(function (result) {
            if (!result || result.exit_code !== 0 || result.timed_out) throw new Error('TV session command failed');
            return String(result.stdout || '');
        });
    }
    function clearReadySession(phase) {
        sessionState.phase = phase;
        sessionState.port = null;
        sessionState.key = null; sessionState.foreground = false;
    }
    function adoptOwnedSession(snapshot) {
        var owned = snapshot.ownedSession;
        sessionState.phase = 'ready';
        sessionState.port = owned.port;
        sessionState.key = owned.pid + ':' + owned.start + ':' + owned.port;
        sessionState.foreground = snapshot.foreground;
        sessionState.error = null;
        preparationFailures = 0;
    }
    function checkSession(fromTile) {
        if (!running || sessionTask || (!fromTile && Date.now() < nextPreparationAttemptAt)) return;
        var checkGeneration = lifecycleGeneration;
        var previousPhase = sessionState.phase, previousKey = sessionState.key, previousForeground = sessionState.foreground;

        function prepare(snapshot) {
            if (!snapshot.ownedSession) sessionState.phase = 'preparing';
            return runSessionScript(sessionShell.prepareSessionScript(snapshot.pid, snapshot.start, fromTile), PREPARATION_TIMEOUT_MS).then(function (prepareOutput) {
                if (!running || checkGeneration !== lifecycleGeneration) return;
                var started = /^ready=1$/m.test(prepareOutput);
                var reused = fromTile && /^reused=1$/m.test(prepareOutput);
                if (!started && !reused) {
                    if (/^raced=1$|^busy$/m.test(prepareOutput)) {
                        if (!snapshot.ownedSession) sessionState.phase = 'waiting-for-twitch';
                        return false;
                    }
                    throw new Error('Protected Twitch session was not confirmed');
                }
                if (started) {
                    sessionState.takeovers++;
                    clearReadySession('connecting');
                }
                sessionState.error = null;
                preparationFailures = 0;
                nextPreparationAttemptAt = 0;
                return runSessionScript(sessionShell.inspectSessionScript()).then(function (output) {
                    if (!running || checkGeneration !== lifecycleGeneration) return false;
                    var prepared = sessionShell.parseSessionSnapshot(output);
                    if (prepared.ownedSession && !prepared.staleSession && !prepared.isolationMissing) adoptOwnedSession(prepared);
                    return true;
                }, function () {
                    // The launch succeeded; the regular inspection will retry confirmation.
                    return running && checkGeneration === lifecycleGeneration;
                });
            });
        }

        sessionTask = runSessionScript(sessionShell.inspectSessionScript()).then(function (output) {
            if (!running || checkGeneration !== lifecycleGeneration) return;
            var snapshot = sessionShell.parseSessionSnapshot(output);
            sessionState.foreground = snapshot.foreground;
            sessionState.error = null;
            if (fromTile) return prepare(snapshot);
            if (snapshot.staleSession || snapshot.isolationMissing) {
                return runSessionScript(sessionShell.cleanupSessionScript({restoreNormalApp: snapshot.isolationMissing})).then(function (cleanupOutput) {
                    clearReadySession(/cleanup_pending=1/.test(cleanupOutput) ? 'waiting-for-inspector-close' : 'waiting-for-twitch');
                });
            }
            if (snapshot.ownedSession) {
                adoptOwnedSession(snapshot);
                return;
            }
            clearReadySession('waiting-for-twitch'); sessionState.foreground = snapshot.foreground;
            if (!snapshot.pid || !snapshot.foreground) {
                suppressedProcessIdentity = null;
                return;
            }
            var processIdentity = snapshot.pid + ':' + snapshot.start;
            if (Date.now() < tileFallbackUntil) suppressedProcessIdentity = processIdentity;
            tileFallbackUntil = 0;
            if (processIdentity === suppressedProcessIdentity) {
                sessionState.phase = 'normal-fallback';
                return;
            }
            return prepare(snapshot);
        }).catch(function (error) {
            sessionState.error = error.message;
            if (fromTile) {
                clearReadySession('waiting-for-twitch');
                return false;
            }
            clearReadySession('retrying');
            preparationFailures++;
            nextPreparationAttemptAt = Date.now() + Math.min(MAX_PREPARATION_BACKOFF_MS, preparationFailures * PREPARATION_RETRY_STEP_MS);
            // A normal fallback remains usable until an explicit retry or app exit/reopen.
            return runSessionScript(sessionShell.inspectSessionScript()).then(function (output) {
                var snapshot = sessionShell.parseSessionSnapshot(output);
                sessionState.foreground = snapshot.foreground;
                if (snapshot.pid && !snapshot.ownedSession) suppressedProcessIdentity = snapshot.pid + ':' + snapshot.start;
            }).catch(function () {});
        }).then(function (handled) {
            sessionTask = null;
            if (running && checkGeneration === lifecycleGeneration) {
                if (fromTile) tileFallbackUntil = handled ? 0 : Date.now() + TILE_FALLBACK_MS;
                if (onChange && (previousPhase !== sessionState.phase || previousKey !== sessionState.key ||
                    previousForeground !== sessionState.foreground)) onChange();
            }
            return handled;
        });
        return sessionTask;
    }
    function cleanupWithRetry(attempt) {
        return runSessionScript(sessionShell.cleanupSessionScript({restoreNormalApp: true})).then(function (output) {
            if (!/^busy$/m.test(output)) return output;
            if (attempt >= MAX_CLEANUP_ATTEMPTS) throw new Error('Session cleanup is busy');
            return new Promise(function (resolve) { setTimeout(resolve, CLEANUP_RETRY_MS); })
                .then(function () { return cleanupWithRetry(attempt + 1); });
        });
    }
    return {
        start: function () {
            running = true;
            lifecycleGeneration++;
            sessionState.phase = 'starting';
            pollTimer = setInterval(checkSession, SESSION_POLL_MS);
            if (pollTimer.unref) pollTimer.unref();
            checkSession();
        },
        launch: function () {
            if (tileLaunchTask) return tileLaunchTask;
            var generation = lifecycleGeneration;
            tileLaunchTask = Promise.resolve(sessionTask).then(function () {
                if (!running || generation !== lifecycleGeneration) return false;
                return checkSession(true);
            }).then(function (handled) { tileLaunchTask = null; return handled === true; }, function (error) {
                tileLaunchTask = null;
                throw error;
            });
            return tileLaunchTask;
        },
        stop: function () {
            running = false;
            lifecycleGeneration++;
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
            return (sessionTask || Promise.resolve()).then(function () { return cleanupWithRetry(1); }).then(function (output) {
                clearReadySession(/cleanup_pending=1/.test(output) ? 'cleanup-pending' : 'stopped');
            }, function () {
                clearReadySession('cleanup-failed');
                sessionState.error = 'Close Twitch to end the inspector; its network guard remains until then';
            });
        },
        status: function () {
            return { phase: sessionState.phase, port: sessionState.port, error: sessionState.error,
                takeovers: sessionState.takeovers, key: sessionState.key, foreground: sessionState.foreground };
        },
        retry: function () {
            suppressedProcessIdentity = null;
            tileFallbackUntil = 0;
            nextPreparationAttemptAt = 0;
            preparationFailures = 0;
            checkSession();
        }
    };
};
