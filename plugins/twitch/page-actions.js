'use strict';
// Player navigation and channel point bonuses run in the Twitch page. The enabled features
// share one document script, which is replaced when either option changes. Bonus checks run
// only while the protected session is ready and Twitch is in the foreground.

var crypto = require('crypto');
var inspector = require('./inspector-client.js');
var twitchPage = require('./twitch-page.js');
var POINTS_TOAST = 'points';

function installPlayerControls() {
    if (window.top !== window || !/(^|\.)tv\.twitch\.tv$/.test(location.hostname) || window.__vetroTwitchControls) return;
    var captured = {}, manuallyHidden = new WeakSet();

    function playerControls() {
        var focus = document.activeElement;
        if (document.visibilityState !== 'visible' || !focus || document.getElementById('vetro-twitch-accounts') ||
            focus.closest('input, textarea, [contenteditable="true"], [role="dialog"], [role="menu"], [aria-modal="true"]')) return null;
        var key = Object.keys(focus).find(function (name) { return /^__reactFiber\$/.test(name); });
        var inControls = false, layout = null;
        for (var fiber = focus[key]; fiber; fiber = fiber.return) {
            var name = fiber.type && fiber.type.displayName;
            if (name === 'DialogLayer' || name === 'StarshotModalContainer' || fiber.tag === 4) return null;
            if (name === 'PlayingUILayout.Controls' || name === 'PlayingUILayout.BackButton') inControls = true;
            if (name === 'PlayingUILayout' && inControls) layout = fiber;
            if (name === 'ChannelPlayerLayout') break;
        }
        if (!fiber || !layout || !layout.memoizedProps || layout.memoizedProps.hidePlayUi !== false) return null;

        // PlayingUILayout subscribes its single boolean state to RecentUserIntentRoot.
        // Use that setter so the native back button, shade and bottom controls transition together.
        var queue = null, recentIntent = null;
        for (var hook = layout.memoizedState; hook; hook = hook.next) {
            var candidate = hook.queue;
            if (!candidate || typeof candidate.lastRenderedState !== 'boolean' || typeof candidate.dispatch !== 'function') continue;
            if (queue) return null;
            queue = candidate;
        }
        for (fiber = layout.return; fiber; fiber = fiber.return) {
            var value = fiber.memoizedProps && fiber.memoizedProps.value;
            if (value && typeof value.simulateUserIntent === 'function' && typeof value.subscribeToRecentIntentChange === 'function') {
                recentIntent = value;
                break;
            }
        }
        return queue && recentIntent ? { queue: queue, recentIntent: recentIntent } : null;
    }

    function remoteKey(event) {
        if (event.key === 'Enter' || event.keyCode === 13) return 'ok';
        if (event.key === 'Escape' || event.keyCode === 27 || event.keyCode === 10009) return 'back';
        return null;
    }
    function consume(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
    function keydown(event) {
        var key = remoteKey(event);
        if (key && captured[key]) return consume(event);
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
        var direction = (event.keyCode >= 37 && event.keyCode <= 40) || /^Arrow(Up|Down|Left|Right)$/.test(event.key);
        if (!key && !direction) return;
        var controls = playerControls();
        if (!controls) return;
        var queue = controls.queue, visible = queue.lastRenderedState;
        if (direction && manuallyHidden.has(queue)) {
            // Until Twitch's inactivity timer expires, a new intent alone does not announce a visibility change.
            manuallyHidden.delete(queue);
            if (!visible) queue.dispatch(true);
        }
        if ((key === 'back' && visible) || (key === 'ok' && !visible)) {
            consume(event);
            captured[key] = true;
            if (key === 'back') manuallyHidden.add(queue);
            else {
                manuallyHidden.delete(queue);
                controls.recentIntent.simulateUserIntent();
            }
            queue.dispatch(key === 'ok');
        }
    }
    function keyup(event) {
        var key = remoteKey(event);
        if (!key || !captured[key]) return;
        delete captured[key];
        consume(event);
    }
    function clearKeys() { captured = {}; }
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('blur', clearKeys);
    window.__vetroTwitchControls = {
        stop: function () {
            window.removeEventListener('keydown', keydown, true);
            window.removeEventListener('keyup', keyup, true);
            window.removeEventListener('blur', clearKeys);
            clearKeys();
            delete window.__vetroTwitchControls;
        }
    };
}

function installPointsPage(readNativeSession) {
    if (window.top !== window || !/(^|\.)tv\.twitch\.tv$/.test(location.hostname) || window.__vetroTwitchPoints) return;
    var instance = String(Date.now()) + ':' + Math.random().toString(36).slice(2);
    var candidate = null, pending = null, cancelRequest = null, stopped = false;
    var reserved = /^(?:app-shell|search|following|browse|directory|settings|videos|collections|home|login|activate|broadcast|not-found)$/i;
    // Identifiers for Twitch's persisted bonus lookup and claim operations.
    var contextHash = '374314de591e69925fce3ddc2bcf085796f56ebb8cad67a0daa3165c03adc345';
    var claimHash = '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0';

    function stream() {
        if (stopped || document.visibilityState !== 'visible' || document.getElementById('vetro-twitch-accounts')) return null;
        var path = location.pathname.split('/').filter(Boolean), channel = path[0] || '';
        if (path.length !== 1 || !/^[A-Za-z0-9_]{1,25}$/.test(channel) || reserved.test(channel)) return null;
        var playing = Array.prototype.some.call(document.querySelectorAll('video'), function (video) {
            return !video.paused && !video.ended && video.readyState >= 2;
        });
        if (!playing) return null;
        var cookies = document.cookie, token = /(?:^|;\s*)auth-token=([^;]+)/.exec(cookies);
        var user = /(?:^|;\s*)tachyon-user=([^;]+)/.exec(cookies);
        if (!token || !user) return null;
        var id;
        try { id = JSON.parse(decodeURIComponent(user[1])).id; } catch (error) { return null; }
        if (!/^\d{1,32}$/.test(id)) return null;
        return { channel: channel.toLowerCase(), token: token[1], account: String(id) };
    }
    function matches(snapshot) {
        var now = stream();
        return now && now.channel === snapshot.channel && now.account === snapshot.account && now.token === snapshot.token;
    }
    function keyFor(snapshot) { return instance + ':' + snapshot.account + ':' + snapshot.channel; }
    function nativeClient() {
        var session = readNativeSession(true);
        return session.signedIn === true ? session.clientId : null;
    }
    function request(snapshot, name, hash, variables) {
        return new Promise(function (resolve, reject) {
            var controller = typeof AbortController === 'function' ? new AbortController() : null;
            var finished = false, timeout;
            function finish(error, result) {
                if (finished) return;
                finished = true;
                window.clearTimeout(timeout);
                if (cancelRequest === cancel) cancelRequest = null;
                if (error) reject(error); else resolve(result);
            }
            function cancel() {
                if (controller) controller.abort();
                finish(new Error('Twitch points request cancelled'));
            }
            cancelRequest = cancel;
            timeout = window.setTimeout(cancel, 3500);
            var options = {
                method: 'POST', credentials: 'omit', redirect: 'error',
                headers: { 'Client-ID': snapshot.client, 'Content-Type': 'application/json', Authorization: 'OAuth ' + snapshot.token },
                body: JSON.stringify({ operationName: name, variables: variables, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } })
            };
            if (controller) options.signal = controller.signal;
            Promise.resolve().then(function () {
                if (finished || !matches(snapshot)) throw new Error('Twitch session changed');
                return fetch('https://gql.twitch.tv/gql', options);
            }).then(function (response) {
                if (!response.ok) throw new Error('Twitch points request rejected');
                return response.json();
            }).then(function (result) {
                if (!result || (result.errors && result.errors.length) || !result.data) throw new Error('Twitch points request rejected');
                finish(null, result.data);
            }).catch(function (error) { finish(error); });
        });
    }
    function read(snapshot) {
        return request(snapshot, 'ChannelPointsContext', contextHash, { channelLogin: snapshot.channel }).then(function (data) {
            var community = data.community || {}, channel = community.channel || {};
            var points = (community.self || {}).communityPoints || (channel.self || {}).communityPoints;
            if (!points || typeof points.balance !== 'number' || !isFinite(points.balance)) return null;
            var bonus = points.availableClaim, claimId = bonus && (bonus.id || bonus.claimID), channelId = channel.id || community.id;
            var earning = (channel.communityPointsSettings || {}).earning || {};
            return { balance: points.balance, bonus: !!bonus, claimId: claimId, channelId: channelId,
                amount: earnedPoints(bonus), baseAmount: earning.claimPoints };
        });
    }
    function earnedPoints(claim) {
        if (!claim) return null;
        var amount = typeof claim.pointsEarnedTotal === 'number' ? claim.pointsEarnedTotal : claim.pointGain;
        return typeof amount === 'number' && isFinite(amount) && amount > 0 ? amount : null;
    }
    function pause() {
        if (cancelRequest) cancelRequest();
        candidate = pending = null;
    }
    window.__vetroTwitchPoints = {
        snapshot: function () {
            var now = stream();
            return now ? { key: keyFor(now) } : null;
        },
        lookup: function () {
            candidate = pending = null;
            var snapshot = stream();
            if (!snapshot) return null;
            snapshot.client = nativeClient();
            if (!snapshot.client) return { phase: 'waiting-for-native-session' };
            return read(snapshot).then(function (points) {
                if (!matches(snapshot)) return null;
                if (!points) return { phase: 'points-unavailable' };
                if (!points.bonus) return { phase: 'waiting-for-bonus' };
                if (typeof points.claimId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(points.claimId) ||
                    typeof points.channelId !== 'string' || !/^\d{1,32}$/.test(points.channelId)) {
                    throw new Error('Twitch returned an invalid bonus');
                }
                var key = snapshot.account + ':' + points.channelId + ':' + points.claimId;
                candidate = { key: key, stream: snapshot, points: points };
                return { key: key };
            });
        },
        claim: function (key) {
            var claim = candidate;
            candidate = null;
            if (!claim || claim.key !== key || !matches(claim.stream) || nativeClient() !== claim.stream.client) return false;
            return request(claim.stream, 'ClaimCommunityPoints', claimHash, { input: { claimID: claim.points.claimId, channelID: claim.points.channelId } })
                .then(function (data) {
                    var response = data.claimCommunityPoints;
                    if (!response || response.error || (!response.claim && typeof response.currentPoints !== 'number')) {
                        throw new Error('Twitch did not accept the bonus');
                    }
                    if (matches(claim.stream)) {
                        claim.points.amount = earnedPoints(response.claim) || claim.points.amount;
                        pending = claim;
                    }
                    return true;
                });
        },
        confirm: function () {
            var claim = pending;
            if (!claim || !matches(claim.stream)) return null;
            return read(claim.stream).then(function (after) {
                if (!matches(claim.stream) || !after) return null;
                var gain = after.balance - claim.points.balance, amount = claim.points.amount;
                var minimum = amount || claim.points.baseAmount;
                if ((after.bonus && (!after.claimId || after.claimId === claim.points.claimId)) || gain <= 0 ||
                    (typeof minimum === 'number' && minimum > gain)) return false;
                pending = null;
                return { key: keyFor(claim.stream), channel: claim.stream.channel, points: amount || gain };
            });
        },
        pause: pause,
        stop: function () { stopped = true; pause(); delete window.__vetroTwitchPoints; }
    };
}

var POINTS_KEY = 'window.__vetroTwitchPoints';
var CONTROLS_KEY = 'window.__vetroTwitchControls';
var CONTROLS_SOURCE = '(' + installPlayerControls.toString() + ')();';
var POINTS_SOURCE = '(' + installPointsPage.toString() + ')(' + twitchPage.readNativeSession.toString() + ');';
var POINTS_POLL_MS = 2000, POINTS_CHECK_MS = 60000, POINTS_RETRY_MS = 120000, POINTS_SESSION_RETRY_MS = 10000;
var POINTS_DELAY_MIN_MS = 3000, POINTS_DELAY_RANGE_MS = 9000;
var MAX_ACCEPTED = 128;
function createPageActions(context) {
    var running = false, pointsActive = false, indicator = false, connection = null, documentScript = null;
    var documentSource = CONTROLS_SOURCE, installedSource = null;
    var timer = null, attachment = null, polling = false, generation = 0, visit = 0, streamKey = null, nextCheckAt = 0;
    var delayedClaim = null;
    var phase = 'waiting-for-twitch', error = null, lastClaim = null, confirmed = 0;

    function call(client, expression, wait) { return inspector.evaluate(client, POINTS_KEY + ' && ' + POINTS_KEY + '.' + expression, wait); }
    function cleanPage(client, script) {
        return (script ? script.remove().catch(function () {}) : Promise.resolve())
            .then(function () {
                return inspector.evaluate(client, CONTROLS_KEY + ' && ' + CONTROLS_KEY + '.stop();' +
                    POINTS_KEY + ' && ' + POINTS_KEY + '.stop();' + twitchPage.hideIndicatorScript(POINTS_TOAST));
            }).catch(function () {})
            .then(function () { client.close(); });
    }
    function acceptedHashes(config) {
        return Array.isArray(config.pointsAccepted) ? config.pointsAccepted.filter(function (hash) {
            return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
        }) : [];
    }
    function rememberAccepted(hash) {
        var config = context.config.get() || {}, hashes = acceptedHashes(config);
        if (hashes.indexOf(hash) >= 0) return;
        config.pointsAccepted = hashes.slice(1 - MAX_ACCEPTED).concat(hash);
        // Older builds recorded failed requests too. A fresh offer can be checked with Twitch again.
        delete config.pointsAttempted;
        context.config.set(config);
    }
    function poll() {
        if (!running || !pointsActive || !connection || polling) return;
        var client = connection, expectedVisit = visit;
        function current() { return running && pointsActive && connection === client && visit === expectedVisit; }
        function checkBonus() {
            phase = 'checking';
            return call(client, 'lookup()', true).then(function (offer) {
                if (!current()) return null;
                if (offer && typeof offer.key === 'string' && /^\d{1,32}:\d{1,32}:[A-Za-z0-9_-]{1,160}$/.test(offer.key)) return offer.key;
                phase = offer && offer.phase || 'waiting-for-signed-in-live';
                if (phase === 'waiting-for-native-session') nextCheckAt = Date.now() + POINTS_SESSION_RETRY_MS;
                return null;
            });
        }
        function confirm(remaining) {
            if (!current()) return;
            phase = 'confirming';
            return call(client, 'confirm()', true).then(function (result) {
                if (!current()) return;
                if (result === false && remaining > 1) {
                    return new Promise(function (resolve) { setTimeout(resolve, 1200); }).then(function () { return confirm(remaining - 1); });
                }
                if (!result) {
                    if (result === false) error = 'Twitch has not confirmed the credited points';
                    return call(client, 'pause()').catch(function () {});
                }
                if (result.key !== streamKey || !/^[a-z0-9_]{1,25}$/.test(result.channel) ||
                    typeof result.points !== 'number' || !isFinite(result.points) || result.points <= 0) return;
                lastClaim = { channel: result.channel, points: result.points, at: Date.now() };
                confirmed++;
                phase = 'waiting-for-bonus';
                if (indicator) {
                    var sameStream = '(function(){var snapshot=' + POINTS_KEY + ' && ' + POINTS_KEY + '.snapshot();' +
                        'if (snapshot && snapshot.key===' + JSON.stringify(result.key) + ')';
                    return inspector.evaluate(client, sameStream + twitchPage.showIndicatorScript(POINTS_TOAST, result.points) + '})();').catch(function () {});
                }
            });
        }
        polling = true;
        call(client, 'snapshot()').then(function (snapshot) {
            if (!current()) return;
            var key = snapshot && snapshot.key;
            if (key !== streamKey) { streamKey = key; delayedClaim = null; nextCheckAt = 0; error = null; }
            if (!key) { phase = 'waiting-for-signed-in-live'; return; }
            if (delayedClaim) {
                if (Date.now() < delayedClaim.at) return;
                var due = delayedClaim;
                delayedClaim = null;
                // Re-read the offer after the delay; the bonus or signed-in stream may have changed.
                return checkBonus().then(function (claimKey) {
                    if (!current() || !claimKey) return;
                    if (claimKey !== due.key) { phase = 'waiting-for-bonus'; return; }
                    phase = 'claiming';
                    return call(client, 'claim(' + JSON.stringify(claimKey) + ')', true).then(function (accepted) {
                        if (accepted === true) {
                            rememberAccepted(due.hash);
                            return confirm(3);
                        }
                        if (current()) phase = 'waiting-for-signed-in-live';
                    });
                });
            }
            if (Date.now() < nextCheckAt) return;
            nextCheckAt = Date.now() + POINTS_CHECK_MS;
            error = null;
            return checkBonus().then(function (claimKey) {
                if (!current() || !claimKey) return;
                var hash = crypto.createHash('sha256').update(claimKey).digest('hex');
                if (acceptedHashes(context.config.get() || {}).indexOf(hash) >= 0) { phase = 'waiting-for-bonus'; return; }
                phase = 'scheduled';
                delayedClaim = { key: claimKey, hash: hash, at: Date.now() + POINTS_DELAY_MIN_MS + Math.floor(Math.random() * POINTS_DELAY_RANGE_MS) };
            });
        }).catch(function () {
            if (current()) {
                delayedClaim = null;
                error = phase === 'claiming' ? 'Twitch bonus claim could not be completed' :
                    phase === 'confirming' ? 'Twitch bonus confirmation could not be completed' : 'Twitch bonus check could not be completed';
                nextCheckAt = Date.now() + POINTS_RETRY_MS;
            }
        }).then(function () { polling = false; });
    }
    function startPolling() {
        if (!running || !pointsActive || !connection || installedSource !== documentSource || timer) return;
        timer = setInterval(poll, POINTS_POLL_MS);
        if (timer.unref) timer.unref();
        poll();
    }
    function stopPolling() {
        if (timer) clearInterval(timer);
        timer = null;
    }
    function attach(port) {
        if (attachment || connection) return Promise.reject(new Error('Detach first'));
        var expected = ++generation, opened = null, script = null;
        var source = documentSource;
        function requireCurrent() { if (!running || expected !== generation) throw new Error('Twitch page attachment cancelled'); }
        attachment = inspector.openTwitchPage(port, requireCurrent).then(function (pageTarget) {
            opened = pageTarget.client;
            requireCurrent();
            script = inspector.createDocumentScript(opened);
            return script.install(source, requireCurrent);
        }).then(function () {
            requireCurrent();
            connection = opened;
            documentScript = script;
            installedSource = source;
            startPolling();
        }).then(function () { attachment = null; }, function (cause) {
            return (opened ? cleanPage(opened, script) : Promise.resolve()).then(function () { attachment = null; throw cause; });
        });
        return attachment;
    }
    function detach() {
        generation++;
        visit++;
        stopPolling();
        var client = connection, script = documentScript;
        connection = documentScript = installedSource = streamKey = null;
        delayedClaim = null;
        nextCheckAt = 0;
        phase = 'waiting-for-twitch';
        return (attachment ? attachment.catch(function () {}) : Promise.resolve()).then(function () {
            if (client) return cleanPage(client, script);
        });
    }
    return {
        start: function () { running = true; error = null; },
        stop: function () { running = false; return detach(); },
        attach: attach, detach: detach,
        // Reattach when the registered script differs so new documents use the same options.
        connected: function () { return !!connection && connection.isOpen() && installedSource === documentSource; },
        setDocumentFeatures: function (controlsEnabled, pointsEnabled) {
            documentSource = (controlsEnabled ? CONTROLS_SOURCE : '') + (pointsEnabled ? POINTS_SOURCE : '');
        },
        setPointsActive: function (value) {
            value = value === true;
            if (value === pointsActive) return;
            pointsActive = value;
            visit++;
            streamKey = null;
            delayedClaim = null;
            if (pointsActive) startPolling();
            else {
                stopPolling();
                phase = 'waiting-for-twitch';
                if (connection) inspector.evaluate(connection, POINTS_KEY + ' && ' + POINTS_KEY + '.pause();' + twitchPage.hideIndicatorScript(POINTS_TOAST)).catch(function () {});
            }
        },
        setIndicator: function (value) {
            value = value === true;
            if (value === indicator) return;
            indicator = value;
            if (!indicator && connection) inspector.evaluate(connection, twitchPage.hideIndicatorScript(POINTS_TOAST)).catch(function () {});
        },
        status: function () { return { phase: phase, confirmed: confirmed, lastClaim: lastClaim, error: error }; }
    };
}
module.exports = { createPageActions: createPageActions };
