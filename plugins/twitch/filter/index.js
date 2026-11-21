'use strict';
var createSkipIndicator = require('../page-actions.js').createAdSkipIndicator;
var inspectorApi = require('../inspector-client.js'), networkInterceptor = require('./network-interceptor.js');
module.exports = function () {
    var running = false, inspectorConnection = null, interceptor = null, indicator = null, indicatorEnabled = false, attachmentGeneration = 0, error = null, attachmentTask = null;
    function closeConnection() {
        var old = inspectorConnection, filtering = interceptor, oldIndicator = indicator; inspectorConnection = null; interceptor = null; indicator = null;
        if (!old) return Promise.resolve();
        return Promise.all([filtering ? filtering.stop() : null, oldIndicator ? oldIndicator.stop() : null])
            .then(function () { old.close(); }, function (errorCause) { old.close(); throw errorCause; });
    }

    function detach() {
        attachmentGeneration++;
        return (attachmentTask ? attachmentTask.catch(function () {}) : Promise.resolve()).then(closeConnection);
    }
    function attach(port) {
        if (attachmentTask || inspectorConnection) return Promise.reject(new Error('Detach before attaching again'));
        error = null;
        var startedGeneration = ++attachmentGeneration, openedConnection = null;
        function requireCurrentAttachment() { if (!running || startedGeneration !== attachmentGeneration) throw new Error('Attachment cancelled'); }
        var attachResult = inspectorApi.listTargets(port).then(function (list) {
            requireCurrentAttachment(); var targets = Array.isArray(list) ? list.filter(inspectorApi.isTwitchPage) : [];
            if (targets.length !== 1) throw new Error('Expected exactly one Twitch TV page in this local inspector');
            return inspectorApi.connect(targets[0].webSocketDebuggerUrl, port);
        }).then(function (connection) {
            openedConnection = connection; requireCurrentAttachment(); inspectorConnection = connection;
            var sessionIndicator = createSkipIndicator(inspectorConnection); indicator = sessionIndicator;
            sessionIndicator.setEnabled(indicatorEnabled);
            interceptor = networkInterceptor.create(inspectorConnection, null, function () {
                if (running && startedGeneration === attachmentGeneration) sessionIndicator.notify();
            });
            return interceptor.start();
        }).then(function () { requireCurrentAttachment(); })
            .catch(function (errorCause) {
                error = errorCause.message;
                if (inspectorConnection === openedConnection && inspectorConnection) return closeConnection().catch(function () {}).then(function () { throw errorCause; });
                if (openedConnection) openedConnection.close(); throw errorCause;
            });
        attachmentTask = attachResult.then(function (value) { attachmentTask = null; return value; }, function (errorCause) { attachmentTask = null; throw errorCause; });
        return attachmentTask;
    }
    return {
        attach: attach, detach: detach,
        setSkipIndicator: function (enabled) {
            indicatorEnabled = enabled === true;
            return indicator ? indicator.setEnabled(indicatorEnabled) : Promise.resolve();
        },
        connected: function () { return !!inspectorConnection && inspectorConnection.isOpen(); },
        start: function () { running = true; },
        stop: function () { running = false; return detach().catch(function () { error = 'Detach could not be confirmed. Close and reopen Twitch to complete cleanup.'; }); },
        status: function () { return { running: running, attached: !!inspectorConnection, busy: !!attachmentTask, error: error }; },
        details: function () { return { attached: !!inspectorConnection, error: error, network: interceptor ? interceptor.status() : null, indicator: indicator ? indicator.status() : null }; }
    };
};
