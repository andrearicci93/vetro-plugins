'use strict';
var fs = require('fs'), path = require('path');
var createSessionManager = require('./session-manager.js');
var createAdFilter = require('./filter/index.js');
var createChatEmotes = require('./emotes/index.js');
var createAccounts = require('./accounts/index.js');
var createPageActions = require('./page-actions.js').createPageActions;
var TWITCH_APP_ID = 'Jz7aUrV2Q4.Twitch';
var ATTACHMENT_CHECK_MS = 1000;
var ATTACHMENT_RETRY_MS = 30000;
var DEFAULT_SETTINGS = { adFiltering: true, emotes7tv: true, adSkipIndicator: false, accountManager: false,
    accountChooserOnLaunch: true, channelPoints: false, channelPointsIndicator: false, playerControls: true };
module.exports = function (context) {
    var sessionManager = createSessionManager(context, onSessionChange), adFilter = createAdFilter(), chatEmotes = createChatEmotes(), accounts = createAccounts(context);
    var pageActions = createPageActions(context);
    var stored = context.config.get() || {};
    var settings = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
        settings[key] = typeof stored[key] === 'boolean' ? stored[key] : DEFAULT_SETTINGS[key];
    });
    applySettings();
    var features = [{ key: 'adFiltering', module: adFilter }, { key: 'emotes7tv', module: chatEmotes },
        { key: 'accountManager', module: accounts }, { module: pageActions, enabled: pageActionsEnabled }];
    var running = false, sessionStarted = false, reconcileTimer = null, reconciliationTask = null, shutdownTask = null;
    var attachedSessionId = null, attachmentError = null, nextAttachmentRetryAt = 0, settingsRevision = 0, sessionRevision = 0, lifecycleGeneration = 0;
    function applySettings() {
        adFilter.setSkipIndicator(settings.adSkipIndicator);
        accounts.setChooser(settings.accountChooserOnLaunch);
        pageActions.setIndicator(settings.channelPointsIndicator);
        pageActions.setDocumentFeatures(settings.playerControls, settings.channelPoints);
        if (!settings.channelPoints) pageActions.setPointsActive(false);
    }
    function settingsCopy() { return Object.assign({}, settings); }
    function pageActionsEnabled() { return settings.playerControls || settings.channelPoints; }
    function featureEnabled(feature) { return feature.enabled ? feature.enabled() : settings[feature.key]; }
    function anyEnabled() { return features.some(featureEnabled); }
    function stopFeatures(force) {
        features.forEach(function (feature) {
            if (feature.started && (force || !featureEnabled(feature))) {
                feature.started = false;
                // Invalidate pending attachments immediately; a later enable waits for this cleanup.
                feature.stopTask = feature.module.stop();
            }
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
    function sessionStillMatches(expectedSession, generation) {
        var latestSession = sessionManager.status();
        return running && lifecycleGeneration === generation && anyEnabled() && latestSession.phase === 'ready' && latestSession.key === expectedSession.key;
    }
    function onSessionChange() {
        sessionRevision++;
        reconcile();
    }
    function reconcile() {
        if (!running || reconciliationTask || shutdownTask) return;
        var revision = settingsRevision, observedSessionRevision = sessionRevision, generation = lifecycleGeneration;
        reconciliationTask = stopFeatures(false).then(function () {
            if (!running || generation !== lifecycleGeneration) return;
            if (!anyEnabled()) return stopSession();
            if (!sessionStarted) { sessionStarted = true; sessionManager.start(); }
            features.forEach(function (feature) {
                if (featureEnabled(feature) && !feature.started) { feature.module.start(); feature.started = true; }
            });
            var sessionState = sessionManager.status();
            accounts.setForeground(sessionState.foreground === true);
            pageActions.setPointsActive(settings.channelPoints && sessionState.phase === 'ready' && sessionState.foreground === true);
            if (sessionState.phase !== 'ready' || !sessionState.key || !sessionState.port) {
                if (attachedSessionId) return detachFeatures();
                return;
            }
            var allConnected = features.every(function (feature) { return !featureEnabled(feature) || feature.module.connected(); });
            if (attachedSessionId === sessionState.key && (allConnected || Date.now() < nextAttachmentRetryAt)) return;
            return (attachedSessionId === sessionState.key ? Promise.resolve() : detachFeatures()).then(function () {
                if (!sessionStillMatches(sessionState, generation)) return;
                attachedSessionId = sessionState.key;
                var attachmentFailures = [];
                return Promise.all(features.map(function (feature) {
                    if (!featureEnabled(feature) || !feature.started || feature.module.connected()) return;
                    return feature.module.detach().then(function () {
                        if (sessionStillMatches(sessionState, generation) && featureEnabled(feature) && feature.started) return feature.module.attach(sessionState.port);
                    }).catch(function (e) {
                        if (featureEnabled(feature) && feature.started) attachmentFailures.push(e.message);
                    }).then(function () {
                        if (!running || generation !== lifecycleGeneration || !featureEnabled(feature) || !feature.started) return feature.module.detach();
                    });
                })).then(function () {
                    if (!sessionStillMatches(sessionState, generation)) return detachFeatures();
                    attachmentError = attachmentFailures.length ? attachmentFailures.join('; ') : null;
                    nextAttachmentRetryAt = attachmentFailures.length ? Date.now() + ATTACHMENT_RETRY_MS : 0;
                });
            });
        }).catch(function (e) {
            attachmentError = e.message; nextAttachmentRetryAt = Date.now() + ATTACHMENT_RETRY_MS;
            return detachFeatures();
        }).then(function () {
            reconciliationTask = null;
            if (running && (revision !== settingsRevision || observedSessionRevision !== sessionRevision || generation !== lifecycleGeneration)) reconcile();
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
        settings = next; applySettings(); settingsRevision++; attachmentError = null; nextAttachmentRetryAt = 0;
        stopFeatures(false); reconcile();
        return true;
    }
    function summary() {
        return { settings: settingsCopy(), session: sessionManager.status(),
            connected: running && anyEnabled() && !!attachedSessionId && features.every(function (feature) { return !featureEnabled(feature) || feature.module.connected(); }),
            filter: adFilter.status(), emotes: chatEmotes.status(), accounts: accounts.status(), points: pageActions.status(), error: attachmentError };
    }
    function json(res, value, code) { res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
    function readSettings(req, res) {
        var body = '', bytes = 0, finished = false;
        function fail(code, message) { if (!finished) { finished = true; json(res, { error: message }, code); } }
        req.on('data', function (chunk) {
            if (finished) return;
            bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
            if (bytes > 512) { fail(413, 'Settings payload too large'); return; }
            body += chunk;
        });
        req.on('error', function () { fail(400, 'Could not read settings'); });
        req.on('aborted', function () { finished = true; });
        req.on('end', function () {
            if (finished) return;
            var patch;
            try { patch = JSON.parse(body); } catch (e) { fail(400, 'Expected a JSON settings object'); return; }
            try {
                if (!saveSettings(patch)) { fail(400, 'Expected one or more known boolean settings'); return; }
            } catch (e) { fail(500, 'Could not save settings'); return; }
            finished = true; json(res, settingsCopy());
        });
    }
    function readAccountAction(req, res) {
        var body = '', bytes = 0, finished = false;
        function answer(value, code) { if (!finished) { finished = true; json(res, value, code); } }
        req.on('data', function (chunk) {
            if (finished) return;
            bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
            if (bytes > 256) return answer({ error: 'Account request too large' }, 413);
            body += chunk;
        });
        req.on('error', function () { answer({ error: 'Account request could not be read' }, 400); });
        req.on('aborted', function () { finished = true; });
        req.on('end', function () {
            if (finished) return;
            var value;
            try { value = JSON.parse(body); } catch (e) { answer({ error: 'Expected an account action' }, 400); return; }
            if (!value || Array.isArray(value) || Object.keys(value).some(function (key) { return key !== 'action' && key !== 'id'; }) ||
                ['capture', 'add', 'switch', 'cancel', 'manage', 'choose', 'dismiss', 'forget', 'forget-all'].indexOf(value.action) < 0 ||
                (value.id !== undefined && (typeof value.id !== 'string' || !/^\d{1,32}$/.test(value.id))) ||
                (['switch', 'forget'].indexOf(value.action) >= 0 && !value.id)) { answer({ error: 'Invalid account action' }, 400); return; }
            if (!settings.accountManager) { answer({ error: 'Enable account management first' }, 409); return; }
            accounts.action(value.action, value.id).then(function (state) { answer(state); }, function (error) { answer({ error: error.message }, 409); });
        });
    }
    return {
        launch: function (appId) {
            if (appId !== TWITCH_APP_ID || !running || shutdownTask || !anyEnabled()) return Promise.resolve(false);
            if (!sessionStarted) { sessionStarted = true; sessionManager.start(); }
            return sessionManager.launch();
        },
        start: function () {
            if (running) return;
            running = true;
            reconcileTimer = setInterval(reconcile, ATTACHMENT_CHECK_MS); if (reconcileTimer.unref) reconcileTimer.unref(); reconcile();
        },
        stop: function () {
            running = false; lifecycleGeneration++; if (reconcileTimer) clearInterval(reconcileTimer); reconcileTimer = null;
            if (shutdownTask) return shutdownTask;
            // Stop features first, including pending attachments, then restore normal app launching.
            shutdownTask = stopFeatures(true).then(function () { return reconciliationTask; })
                .then(stopSession).then(function () { shutdownTask = null; if (running) reconcile(); });
            return shutdownTask;
        },
        status: summary,
        route: function (req, res, sub) {
            sub = String(sub || '');
            if (sub === 'ui' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8')); return true;
            }
            if (sub === 'accounts' && req.method === 'GET') { json(res, accounts.status()); return true; }
            if (sub === 'accounts' && req.method === 'POST') {
                readAccountAction(req, res); return true;
            }
            if (sub === 'status' && req.method === 'GET') { json(res, summary()); return true; }
            if (sub === 'settings' && req.method === 'GET') { json(res, settingsCopy()); return true; }
            if (sub === 'settings' && req.method === 'POST') { readSettings(req, res); return true; }
            if (sub === 'retry' && req.method === 'POST') {
                nextAttachmentRetryAt = 0; if (anyEnabled()) sessionManager.retry(); reconcile(); json(res, { ok: true }); return true;
            }
            if (sub === 'filter/status' && req.method === 'GET') { json(res, adFilter.details()); return true; }
            if (sub === 'emotes/status' && req.method === 'GET') {
                chatEmotes.details().then(function (value) { json(res, value); }); return true;
            }
            return false;
        }
    };
};
