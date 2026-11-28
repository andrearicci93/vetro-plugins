'use strict';
// Pauses the Twitch player's HLS responses, asks playlist-filter.js for a replacement, and
// resumes each request in Chromium. If a replacement fails, it tries the original response.
// Auxiliary HTTPS requests use their own connection and never inherit the app's credentials.

var https = require('https');
var url = require('url');
var createSkipIndicator = require('../twitch-page.js').createAdSkipIndicator;
var inspectorApi = require('../inspector-client.js');
var playlistFilter = require('./playlist-filter.js');

var MAX_RESPONSE_BYTES = 524288;
var MAX_PAUSED_PLAYLISTS = 8;
function allowedRequestUrl(address) {
    var parsed;
    try { parsed = url.parse(address); } catch (error) { return null; }
    if (parsed.protocol !== 'https:' || parsed.auth || (parsed.port && parsed.port !== '443')) return null;
    return parsed.hostname === 'gql.twitch.tv' || playlistFilter.isMediaPlaylist(parsed) ? parsed : null;
}
function fetchText(address, options, register) {
    return new Promise(function (resolve, reject) {
        var parsed = allowedRequestUrl(address);
        if (!parsed) return reject(new Error('Auxiliary host refused'));
        var done = false, request, deadline, unregister = null;
        function finish(error, result) {
            if (done) return; done = true; clearTimeout(deadline); if (unregister) unregister();
            if (error) { if (request) request.destroy(); reject(error); } else resolve(result);
        }
        var headers = options && options.headers || {};
        var opts = { hostname: parsed.hostname, port: 443, path: parsed.path, method: options && options.method || 'GET', headers: headers };
        // No redirects, cookies, Authorization, inherited app headers or account storage.
        request = https.request(opts, function (res) {
            var chunks = [], bytes = 0;
            res.on('data', function (chunk) { bytes += chunk.length; if (bytes > MAX_RESPONSE_BYTES) { res.destroy(); finish(new Error('Auxiliary response too large')); } else chunks.push(chunk); });
            res.on('error', function (e) { finish(e); });
            res.on('end', function () {
                if (res.statusCode < 200 || res.statusCode >= 300) finish(new Error('Twitch request failed'));
                else finish(null, Buffer.concat(chunks).toString('utf8'));
            });
        });
        request.on('error', function (e) { finish(e); });
        if (register) unregister = register(function () { finish(new Error('Filter stopped')); });
        deadline = setTimeout(function () { finish(new Error('Auxiliary deadline')); }, 1800);
        if (options && options.body) request.write(options.body);
        request.end();
    });
}
function rawResponse(text, originalHeaders) {
    var body = new Buffer(text, 'utf8');
    var source = Array.isArray(originalHeaders) ? originalHeaders : Object.keys(originalHeaders || {}).map(function (name) { return { name: name, value: String(originalHeaders[name]) }; });
    var headers = source.filter(function (h) {
        return /^[A-Za-z0-9-]+$/.test(h.name) && !/[\r\n]/.test(h.value) &&
            !/^(?:content-length|content-encoding|transfer-encoding|etag|last-modified|cache-control|expires|content-md5|content-range|content-type)$/i.test(h.name);
    }).map(function (h) { return h.name + ': ' + h.value; });
    headers.push('Content-Type: application/vnd.apple.mpegurl', 'Content-Length: ' + body.length, 'Cache-Control: no-store');
    return Buffer.concat([new Buffer('HTTP/1.1 200 OK\r\n' + headers.join('\r\n') + '\r\n\r\n', 'utf8'), body]).toString('base64');
}
function createNetworkInterceptor(client, transport, onReplacement, allowFallback) {
    var interceptionEnabled = false, removeEventListener = null, pausedRequests = Object.create(null), cancelRequests = [], playlistProcessor = null;
    var stats = { intercepted: 0, bodyFailures: 0, inFlight: 0 };
    function requestText(address, options) {
        if (transport) return transport(address, options);
        return fetchText(address, options, function (cancel) {
            cancelRequests.push(cancel);
            return function () {
                var index = cancelRequests.indexOf(cancel);
                if (index >= 0) cancelRequests.splice(index, 1);
            };
        });
    }
    function continueRequest(id, response, headers) {
        var paused = pausedRequests[id];
        if (!paused) return Promise.resolve();
        if (paused.continuation) return paused.continuation;
        var args = { interceptionId: id };
        if (response && interceptionEnabled) {
            try { args.rawResponse = rawResponse(response, headers); } catch (error) { stats.bodyFailures++; }
        }
        paused.continuation = client.call('Network.continueInterceptedRequest', args).then(function () {
            if (args.rawResponse && interceptionEnabled && onReplacement && paused.notifyReplacement) {
                try { onReplacement(); } catch (e) { /* An optional notification must not affect playback. */ }
            }
            return !!args.rawResponse;
        }, function () {
            stats.bodyFailures++;
            if (args.rawResponse) return client.call('Network.continueInterceptedRequest', { interceptionId: id })
                .then(function () { return false; });
            throw new Error('Could not resume Twitch playlist');
        }).catch(function () {
            // Closing the CDP session releases requests that Chromium still holds.
            client.close();
        }).then(function (replaced) {
            delete pausedRequests[id];
            stats.inFlight--;
            if (paused.acknowledgeDelivery) paused.acknowledgeDelivery(replaced === true);
        });
        return paused.continuation;
    }
    function handleInterceptedPlaylistResponse(event) {
        var id = event.interceptionId;
        if (!id || pausedRequests[id]) return;
        // A replaced master should also trigger the indicator. Media playlists set their own flag.
        pausedRequests[id] = { notifyReplacement: true };
        stats.inFlight++;
        stats.intercepted++;
        var address = event.request && event.request.url;
        if (!interceptionEnabled || event.responseStatusCode !== 200 ||
            !playlistFilter.isMediaPlaylist(allowedRequestUrl(address)) || stats.inFlight > MAX_PAUSED_PLAYLISTS) {
            continueRequest(id);
            return;
        }
        client.call('Network.getResponseBodyForInterception', { interceptionId: id }).then(function (r) {
            if (!interceptionEnabled || !pausedRequests[id] || pausedRequests[id].continuation) return null;
            var text = r.base64Encoded ? new Buffer(r.body, 'base64').toString('utf8') : r.body;
            if (typeof text !== 'string' || text.length > MAX_RESPONSE_BYTES) return null;
            return playlistProcessor.replacementFor(address, text, function (acknowledgeDelivery, notifyReplacement) {
                var paused = pausedRequests[id];
                if (!paused || paused.continuation) return false;
                paused.acknowledgeDelivery = acknowledgeDelivery;
                paused.notifyReplacement = notifyReplacement;
                return true;
            });
        }).then(function (replacement) {
            return continueRequest(id, replacement, event.responseHeaders);
        }, function () {
            stats.bodyFailures++;
            return continueRequest(id);
        });
    }
    return {
        start: function () {
            playlistProcessor = playlistFilter.create(requestText, allowFallback); interceptionEnabled = true;
            removeEventListener = client.on('Network.requestIntercepted', handleInterceptedPlaylistResponse);
            return client.call('Network.enable').then(function () {
                return client.call('Network.setRequestInterception', { patterns: [{ urlPattern: '*://*.ttvnw.net/*.m3u8*', interceptionStage: 'HeadersReceived' }] });
            });
        },
        status: function () {
            var result = { active: interceptionEnabled, intercepted: stats.intercepted, bodyFailures: stats.bodyFailures, inFlight: stats.inFlight };
            result.filter = playlistProcessor ? playlistProcessor.stats : null; return result;
        },
        stop: function () {
            interceptionEnabled = false;
            cancelRequests.slice().forEach(function (cancel) { cancel(); });
            if (removeEventListener) { removeEventListener(); removeEventListener = null; }
            if (playlistProcessor) playlistProcessor.stop();
            return client.call('Network.setRequestInterception', { patterns: [] }).catch(function () {})
                .then(function () { return Promise.all(Object.keys(pausedRequests).map(function (id) { return continueRequest(id); })); });
        }
    };
}

module.exports = function () {
    var running = false, inspectorConnection = null, interceptor = null, indicator = null, indicatorEnabled = false, fallbackEnabled = false;
    var attachmentGeneration = 0, error = null, attachmentTask = null;
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
        var attachResult = inspectorApi.openTwitchPage(port, requireCurrentAttachment).then(function (opened) {
            openedConnection = opened.client;
            requireCurrentAttachment();
            inspectorConnection = openedConnection;
            var sessionIndicator = createSkipIndicator(inspectorConnection); indicator = sessionIndicator;
            sessionIndicator.setEnabled(indicatorEnabled);
            interceptor = createNetworkInterceptor(inspectorConnection, null, function () {
                if (running && startedGeneration === attachmentGeneration) sessionIndicator.notify();
            }, function () { return fallbackEnabled; });
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
        setFallback: function (enabled) { fallbackEnabled = enabled === true; },
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
module.exports.createNetworkInterceptor = createNetworkInterceptor;
