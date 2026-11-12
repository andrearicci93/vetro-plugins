'use strict';
// Intercept complete HLS responses before Chromium hands them to the Twitch player.
var https = require('https'), url = require('url');
var playlistFilter = require('./playlist-filter.js');
var MAX_RESPONSE_BYTES = 524288;
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
            !/^(?:content-length|content-encoding|transfer-encoding|etag|content-md5|content-range|content-type)$/i.test(h.name);
    }).map(function (h) { return h.name + ': ' + h.value; });
    headers.push('Content-Type: application/vnd.apple.mpegurl', 'Content-Length: ' + body.length);
    return Buffer.concat([new Buffer('HTTP/1.1 200 OK\r\n' + headers.join('\r\n') + '\r\n\r\n', 'utf8'), body]).toString('base64');
}
function create(client, transport, onReplacement) {
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
            if (args.rawResponse && interceptionEnabled && onReplacement) {
                try { onReplacement(); } catch (e) { /* An optional notification must not affect playback. */ }
            }
        }, function () {
            stats.bodyFailures++;
            if (args.rawResponse) return client.call('Network.continueInterceptedRequest', { interceptionId: id });
            throw new Error('Could not resume Twitch playlist');
        }).catch(function () {
            // Closing the CDP session releases requests that Chromium still holds.
            client.close();
        }).then(function () {
            delete pausedRequests[id];
            stats.inFlight--;
        });
        return paused.continuation;
    }
    function handleInterceptedPlaylistResponse(event) {
        var id = event.interceptionId;
        if (!id || pausedRequests[id]) return;
        pausedRequests[id] = {}; stats.inFlight++; stats.intercepted++;
        var address = event.request && event.request.url;
        if (!interceptionEnabled || event.responseStatusCode !== 200 || !playlistFilter.isMediaPlaylist(allowedRequestUrl(address)) || stats.inFlight > 8) {
            continueRequest(id); return;
        }
        client.call('Network.getResponseBodyForInterception', { interceptionId: id }).then(function (r) {
            if (!interceptionEnabled || !pausedRequests[id] || pausedRequests[id].continuation) return null;
            var text = r.base64Encoded ? new Buffer(r.body, 'base64').toString('utf8') : r.body;
            if (typeof text !== 'string' || text.length > MAX_RESPONSE_BYTES) return null;
            return playlistProcessor.replacementFor(address, text);
        }).then(function (replacement) { return continueRequest(id, replacement, event.responseHeaders); }, function () { stats.bodyFailures++; return continueRequest(id); });
    }
    return {
        start: function () {
            playlistProcessor = playlistFilter.create(requestText); interceptionEnabled = true;
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
module.exports = { create: create };
