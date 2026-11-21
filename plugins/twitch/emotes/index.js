'use strict';
var inspectorApi = require('../inspector-client.js'), chatRenderer = require('./chat-renderer.js'), publicData = require('../public-data.js');
module.exports = function () {
    var running = false, inspectorConnection = null, catalogue = null, documentScriptId = null, pollTimer = null, pollInProgress = false, updateGeneration = 0, attachmentTask = null;
    var globalEmotes = [], channelEmotes = [], currentChannel = null, error = null, pageInstance = null, nextCatalogueRetryAt = 0;
    function evaluateInChatPage(expression) {
        if (!inspectorConnection) return Promise.reject(new Error('Not attached'));
        return inspectorConnection.call('Runtime.evaluate', { expression: expression, returnByValue: true }).then(function (result) {
            if (result.exceptionDetails) throw new Error('Twitch page script failed');
            return result.result && result.result.value;
        });
    }
    function applyCatalogue(entries, startedGeneration, expectedChannel) {
        if (!running || !inspectorConnection || startedGeneration !== updateGeneration) return Promise.resolve();
        // Channel aliases take priority over global aliases.
        return evaluateInChatPage('window.__vetro7TV && window.__vetro7TV.set(' + JSON.stringify(entries).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + (expectedChannel !== undefined ? ',' + JSON.stringify(expectedChannel) : '') + ')');
    }
    function pollChannel() {
        if (!running || !inspectorConnection || pollInProgress) return;
        pollInProgress = true; var connection = inspectorConnection;
        evaluateInChatPage(chatRenderer.state).then(function (pageState) {
            if (!pageState || inspectorConnection !== connection) return;
            if (pageState.instance !== pageInstance) { pageInstance = pageState.instance; currentChannel = undefined; }
            var login = pageState.channel;
            if (!running || !inspectorConnection || (login === currentChannel && (!error || Date.now() < nextCatalogueRetryAt))) return;
            var currentCatalogue = catalogue, startedGeneration = ++updateGeneration; currentChannel = login; channelEmotes = []; error = null;
            return applyCatalogue(globalEmotes, startedGeneration).then(function () {
                return login && running && startedGeneration === updateGeneration && currentCatalogue === catalogue ? currentCatalogue.channel(login) : [];
            }).then(function (entries) {
                if (startedGeneration !== updateGeneration || !running || !inspectorConnection) return;
                return applyCatalogue(globalEmotes.concat(entries), startedGeneration, login).then(function (applied) {
                    if (startedGeneration !== updateGeneration || inspectorConnection !== connection) return;
                    if (applied === false) { currentChannel = undefined; channelEmotes = []; } else channelEmotes = entries;
                });
            });
        }).catch(function (errorCause) { error = errorCause.message; nextCatalogueRetryAt = Date.now() + 30000; }).then(function () { pollInProgress = false; });
    }
    function closeConnection() {
        updateGeneration++; if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (catalogue) { catalogue.stop(); catalogue = null; }
        var connectionToClose = inspectorConnection, scriptToRemove = documentScriptId; inspectorConnection = null; documentScriptId = null; currentChannel = null;
        if (!connectionToClose) return Promise.resolve();
        var removalError = null;
        return (scriptToRemove ? connectionToClose.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptToRemove }).catch(function (errorCause) { removalError = errorCause; }) : Promise.resolve())
            .then(function () { return connectionToClose.call('Runtime.evaluate', { expression: chatRenderer.stop, returnByValue: true }); })
            .then(function () { connectionToClose.close(); if (removalError) throw removalError; }, function (errorCause) { connectionToClose.close(); throw errorCause; });
    }
    function detach() {
        updateGeneration++;
        return (attachmentTask ? attachmentTask.catch(function () {}) : Promise.resolve()).then(closeConnection);
    }
    function attach(port) {
        if (attachmentTask || inspectorConnection) return Promise.reject(new Error('Detach first'));
        var startedGeneration = ++updateGeneration; error = null; globalEmotes = []; channelEmotes = []; currentChannel = undefined;
        var openedConnection = null;
        function requireCurrentAttachment() { if (!running || startedGeneration !== updateGeneration) throw new Error('Attachment cancelled'); }
        var attachResult = inspectorApi.listTargets(port).then(function (list) {
            requireCurrentAttachment(); var targets = Array.isArray(list) ? list.filter(inspectorApi.isTwitchPage) : [];
            if (targets.length !== 1) throw new Error('Expected one hosted Twitch TV page');
            return inspectorApi.connect(targets[0].webSocketDebuggerUrl, port);
        }).then(function (connection) {
            openedConnection = connection; requireCurrentAttachment(); inspectorConnection = connection; catalogue = publicData.createEmoteCatalogue();
            return connection.call('Page.enable');
        }).then(function () { requireCurrentAttachment(); return inspectorConnection.call('Page.addScriptToEvaluateOnNewDocument', { source: chatRenderer.source }); })
            .then(function (result) { documentScriptId = result.identifier; requireCurrentAttachment(); if (!documentScriptId) throw new Error('Document injection unavailable'); return evaluateInChatPage(chatRenderer.source); })
            .then(function () { requireCurrentAttachment(); return catalogue.global(); })
            .then(function (entries) {
                requireCurrentAttachment(); globalEmotes = entries;
                return applyCatalogue(entries, startedGeneration);
            }).then(function () {
                requireCurrentAttachment(); pollChannel();
                pollTimer = setInterval(pollChannel, 2000); if (pollTimer.unref) pollTimer.unref();
                return { ok: true, globalEmotes: globalEmotes.length };
            }).catch(function (errorCause) {
                error = errorCause.message;
                if (inspectorConnection === openedConnection && inspectorConnection) return closeConnection().catch(function () {}).then(function () { throw errorCause; });
                if (openedConnection) openedConnection.close(); throw errorCause;
            });
        attachmentTask = attachResult.then(function (result) { attachmentTask = null; return result; }, function (errorCause) { attachmentTask = null; throw errorCause; });
        return attachmentTask;
    }
    return {
        attach: attach, detach: detach,
        connected: function () { return !!inspectorConnection && inspectorConnection.isOpen(); },
        start: function () { running = true; },
        stop: function () { running = false; return detach().catch(function () { error = 'Close and reopen Twitch to confirm emote removal'; }); },
        status: function () { return { attached: !!inspectorConnection, globalEmotes: globalEmotes.length, channelEmotes: channelEmotes.length, error: error }; },
        details: function () {
            if (!inspectorConnection) return Promise.resolve({ attached: false, error: error });
            return evaluateInChatPage(chatRenderer.status).then(function (page) {
                return { attached: true, globalEmotes: globalEmotes.length, channelEmotes: channelEmotes.length, page: page,
                    channelDetected: typeof currentChannel === 'string' && !!currentChannel, lookup: catalogue ? catalogue.status() : null, error: error };
            }, function () { return { attached: false, error: 'Inspector disconnected' }; });
        }
    };
};
