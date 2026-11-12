'use strict';
// Adds features to Samsung's own Twitch app. Vetro can start the app through its Twitch tile, or
// session-manager.js can pick it up when it comes to the foreground after a launch from Samsung Home.
// When session preparation fails, Twitch can still open in its normal mode.
//
// The features share one protected Web Inspector. Each feature opens and closes its own connection.
// The last feature to switch off is cleaned up before the Inspector is taken down.

var fs = require('fs');
var path = require('path');
var createSessionManager = require('./session-manager.js');
var createAdFilter = require('./filter/index.js');
var createChatEmotes = require('./emotes/index.js');
var createAccounts = require('./accounts/index.js');
var createPageActions = require('./page-actions.js').createPageActions;
var TWITCH_APP_ID = 'Jz7aUrV2Q4.Twitch';
var ATTACHMENT_CHECK_MS = 1000;
var ATTACHMENT_RETRY_MS = 30000;
var ACCOUNT_ACTIONS = ['capture', 'add', 'switch', 'cancel', 'manage', 'choose', 'dismiss', 'forget', 'forget-all'];
var DEFAULT_SETTINGS = {
    adFiltering: true,
    adFallback: false,
    emotes7tv: true,
    adSkipIndicator: false,
    accountManager: false,
    accountChooserOnLaunch: true,
    channelPoints: false,
    channelPointsIndicator: false,
    playerControls: true
};

module.exports = function (context) {
    var sessionManager = createSessionManager(context, requestReconcile);
    var adFilter = createAdFilter();
    var chatEmotes = createChatEmotes();
    var accounts = createAccounts(context);
    var pageActions = createPageActions(context);

    var stored = context.config.get() || {};
    var settings = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
        settings[key] = typeof stored[key] === 'boolean' ? stored[key] : DEFAULT_SETTINGS[key];
    });
    var features = [
        { options: ['adFiltering'], module: adFilter },
        { options: ['emotes7tv'], module: chatEmotes },
        { options: ['accountManager'], module: accounts },
        { options: ['playerControls', 'channelPoints'], module: pageActions }
    ];
    var running = false, lifecycleGeneration = 0, shutdownTask = null;
    var sessionStarted = false, reconcileTimer = null, reconciliationTask = null, reconcileRequested = false;
    var attachedSessionId = null, attachmentError = null, nextAttachmentRetryAt = 0;
    applySettings();

    function launch(appId) {
        if (appId !== TWITCH_APP_ID || !running || shutdownTask || !anyEnabled()) return Promise.resolve(false);
        startSession();
        return sessionManager.launch();
    }
    function start() {
        if (running) return;
        running = true;
        reconcileTimer = setInterval(reconcile, ATTACHMENT_CHECK_MS);
        if (reconcileTimer.unref) reconcileTimer.unref();
        reconcile();
    }
    function stop() {
        running = false;
        lifecycleGeneration++;
        if (reconcileTimer) clearInterval(reconcileTimer);
        reconcileTimer = null;
        if (shutdownTask) return shutdownTask;

        // Feature cleanup still needs the Inspector. A new start waits here until teardown is done.
        shutdownTask = stopFeatures(true).then(function () { return reconciliationTask; })
            .then(stopSession).then(function () {
                shutdownTask = null;
                if (running) reconcile();
            });
        return shutdownTask;
    }

    function applySettings() {
        adFilter.setFallback(settings.adFallback);
        adFilter.setSkipIndicator(settings.adSkipIndicator);
        accounts.setChooser(settings.accountChooserOnLaunch);
        pageActions.setIndicator(settings.channelPointsIndicator);
        pageActions.setDocumentFeatures(settings.playerControls, settings.channelPoints);
        if (!settings.channelPoints) pageActions.setPointsActive(false);
    }
    function settingsCopy() { return Object.assign({}, settings); }
    function featureEnabled(feature) {
        return feature.options.some(function (key) { return settings[key]; });
    }
    function anyEnabled() { return features.some(featureEnabled); }
    function enabledFeaturesConnected() {
        return features.every(function (feature) { return !featureEnabled(feature) || feature.module.connected(); });
    }

    function startSession() {
        if (sessionStarted) return;
        sessionStarted = true;
        sessionManager.start();
    }
    function startEnabledFeatures() {
        features.forEach(function (feature) {
            if (!featureEnabled(feature) || feature.started) return;
            feature.module.start();
            feature.started = true;
        });
    }
    function stopFeatures(force) {
        features.forEach(function (feature) {
            if (!feature.started || (!force && featureEnabled(feature))) return;
            feature.started = false;
            // Invalidate pending attachments immediately. A later enable waits for this cleanup.
            feature.stopTask = feature.module.stop();
        });
        return Promise.all(features.map(function (feature) { return feature.stopTask; }));
    }
    function stopSession() {
        attachedSessionId = null;
        if (!sessionStarted) return Promise.resolve();
        sessionStarted = false;
        return sessionManager.stop();
    }
    function detachFeatures() {
        attachedSessionId = null;
        return Promise.all(features.map(function (feature) { return feature.module.detach().catch(function () {}); }));
    }
    function isRunning(generation) {
        return running && lifecycleGeneration === generation;
    }
    function sessionStillMatches(expectedSession, generation) {
        var latestSession = sessionManager.status();
        return isRunning(generation) && anyEnabled() && latestSession.phase === 'ready' && latestSession.key === expectedSession.key;
    }
    function wantsConnection(feature) {
        return feature.started && featureEnabled(feature);
    }
    function attachFeature(feature, session, generation, failures) {
        if (!wantsConnection(feature) || feature.module.connected()) return;

        return feature.module.detach().then(function () {
            if (sessionStillMatches(session, generation) && wantsConnection(feature)) {
                return feature.module.attach(session.port);
            }
        }).catch(function (error) {
            if (wantsConnection(feature)) failures.push(error.message);
        }).then(function () {
            if (!isRunning(generation) || !wantsConnection(feature)) {
                return feature.module.detach();
            }
        });
    }
    function attachFeatures(session, generation) {
        var sameSession = attachedSessionId === session.key;
        if (sameSession && (enabledFeaturesConnected() || Date.now() < nextAttachmentRetryAt)) return;

        // Each feature owns its connection. A session change first detaches all features.
        return (sameSession ? Promise.resolve() : detachFeatures()).then(function () {
            if (!sessionStillMatches(session, generation)) return;
            attachedSessionId = session.key;
            var failures = [];
            var attachments = features.map(function (feature) {
                return attachFeature(feature, session, generation, failures);
            });
            return Promise.all(attachments).then(function () {
                if (!sessionStillMatches(session, generation)) return detachFeatures();
                attachmentError = failures.length ? failures.join('; ') : null;
                nextAttachmentRetryAt = failures.length ? Date.now() + ATTACHMENT_RETRY_MS : 0;
            });
        });
    }
    function requestReconcile() {
        reconcileRequested = true;
        reconcile();
    }

    // One pass at a time. A change during a pass asks for one more, using the latest settings and session.
    // The timer also checks for disconnected features, even when neither settings nor session has changed.
    function reconcile() {
        if (!running || reconciliationTask || shutdownTask) return;
        reconcileRequested = false;
        var generation = lifecycleGeneration;
        reconciliationTask = stopFeatures(false).then(function () {
            if (!isRunning(generation)) return;
            if (!anyEnabled()) return stopSession();
            startSession();
            startEnabledFeatures();

            var session = sessionManager.status();
            var foreground = session.foreground === true;
            accounts.setForeground(foreground);
            pageActions.setPointsActive(settings.channelPoints && session.phase === 'ready' && foreground);
            if (session.phase !== 'ready' || !session.key || !session.port) {
                if (attachedSessionId) return detachFeatures();
                return;
            }
            return attachFeatures(session, generation);
        }).catch(function (error) {
            attachmentError = error.message;
            nextAttachmentRetryAt = Date.now() + ATTACHMENT_RETRY_MS;
            return detachFeatures();
        }).then(function () {
            reconciliationTask = null;
            if (reconcileRequested) reconcile();
        });
    }
    function saveSettings(patch) {
        var keys = patch && typeof patch === 'object' && !Array.isArray(patch) ? Object.keys(patch) : [];
        if (!keys.length || keys.some(function (key) { return !Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) || typeof patch[key] !== 'boolean'; })) return false;
        var config = context.config.get();
        if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
        var next = settingsCopy();
        keys.forEach(function (key) { next[key] = patch[key]; });
        Object.keys(next).forEach(function (key) { config[key] = next[key]; });
        // Persist before changing runtime state, so a failed save leaves the current behavior intact.
        context.config.set(config);
        settings = next;
        applySettings();
        attachmentError = null;
        nextAttachmentRetryAt = 0;
        stopFeatures(false);
        requestReconcile();
        return true;
    }
    function summary() {
        return {
            settings: settingsCopy(),
            session: sessionManager.status(),
            connected: running && anyEnabled() && !!attachedSessionId && enabledFeaturesConnected(),
            filter: adFilter.status(),
            emotes: chatEmotes.status(),
            accounts: accounts.status(),
            points: pageActions.status(),
            error: attachmentError
        };
    }
    function json(res, value, code) {
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(value));
    }
    function readJson(req, res, maxBytes, messages, handle) {
        var body = '', bytes = 0, finished = false;
        function reply(value, code) {
            if (finished) return;
            finished = true;
            json(res, value, code);
        }
        req.on('data', function (chunk) {
            if (finished) return;
            bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
            if (bytes > maxBytes) return reply({ error: messages.tooLarge }, 413);
            body += chunk;
        });
        req.on('error', function () { reply({ error: messages.unreadable }, 400); });
        req.on('aborted', function () { finished = true; });
        req.on('end', function () {
            if (finished) return;
            var value;
            try { value = JSON.parse(body); }
            catch (error) { return reply({ error: messages.invalidJson }, 400); }
            handle(value, reply);
        });
    }
    function readSettings(req, res) {
        readJson(req, res, 512, {
            tooLarge: 'Settings payload too large',
            unreadable: 'Could not read settings',
            invalidJson: 'Expected a JSON settings object'
        }, function (patch, reply) {
            try {
                if (!saveSettings(patch)) return reply({ error: 'Expected one or more known boolean settings' }, 400);
            } catch (error) { return reply({ error: 'Could not save settings' }, 500); }
            reply(settingsCopy());
        });
    }
    function readAccountAction(req, res) {
        readJson(req, res, 256, {
            tooLarge: 'Account request too large',
            unreadable: 'Account request could not be read',
            invalidJson: 'Expected an account action'
        }, function (value, reply) {
            if (!value || typeof value !== 'object' || Array.isArray(value) ||
                Object.keys(value).some(function (key) { return key !== 'action' && key !== 'id'; })) {
                return reply({ error: 'Invalid account action' }, 400);
            }
            var action = value.action, id = value.id;
            if (ACCOUNT_ACTIONS.indexOf(action) < 0 ||
                (id !== undefined && (typeof id !== 'string' || !/^\d{1,32}$/.test(id))) ||
                ((action === 'switch' || action === 'forget') && !id)) {
                return reply({ error: 'Invalid account action' }, 400);
            }
            if (!settings.accountManager) return reply({ error: 'Enable account management first' }, 409);
            accounts.action(action, id).then(reply, function (error) { reply({ error: error.message }, 409); });
        });
    }
    return {
        launch: launch,
        start: start,
        stop: stop,
        status: summary,
        route: function (req, res, sub) {
            sub = String(sub || '');
            if (req.method === 'GET') {
                if (sub === 'ui') {
                    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8'));
                    return true;
                }
                if (sub === 'status') { json(res, summary()); return true; }
                if (sub === 'settings') { json(res, settingsCopy()); return true; }
                if (sub === 'accounts') { json(res, accounts.status()); return true; }
                if (sub === 'filter/status') { json(res, adFilter.details()); return true; }
                if (sub === 'emotes/status') {
                    chatEmotes.details().then(function (value) { json(res, value); });
                    return true;
                }
                return false;
            }
            if (req.method !== 'POST') return false;
            if (sub === 'settings') { readSettings(req, res); return true; }
            if (sub === 'accounts') { readAccountAction(req, res); return true; }
            if (sub === 'retry') {
                nextAttachmentRetryAt = 0;
                if (anyEnabled()) sessionManager.retry();
                reconcile();
                json(res, { ok: true });
                return true;
            }
            return false;
        }
    };
};
