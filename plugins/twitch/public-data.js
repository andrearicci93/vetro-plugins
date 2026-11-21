'use strict';
var https = require('https');

function createJsonClient(maxBytes) {
    var cancellations = [], alive = true;
    function request(host, path, body) {
        return new Promise(function (resolve, reject) {
            if (!alive) return reject(new Error('Stopped'));
            var done = false, bytes = 0, chunks = [], timer, req;
            function finish(error, value) {
                if (done) return; done = true; clearTimeout(timer);
                var index = cancellations.indexOf(cancel); if (index >= 0) cancellations.splice(index, 1);
                if (error) { req.destroy(); reject(error); } else resolve(value);
            }
            function cancel() { finish(new Error('Stopped')); }
            req = https.request({ hostname: host, port: 443, path: path, method: body ? 'POST' : 'GET', headers: body ? {
                'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json'
            } : {} }, function (res) {
                res.on('data', function (chunk) { bytes += chunk.length; if (bytes > maxBytes) finish(new Error('Public API response too large')); else chunks.push(chunk); });
                res.on('error', function (e) { finish(e); });
                res.on('end', function () {
                    if (res.statusCode === 404) return finish(null, {});
                    if (res.statusCode !== 200) return finish(new Error('Public API unavailable (' + res.statusCode + ')'));
                    try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { finish(new Error('Invalid public API response')); }
                });
            });
            req.on('error', function (e) { finish(e); });
            cancellations.push(cancel); timer = setTimeout(function () { finish(new Error('Public API timeout')); }, 6000);
            if (body) req.write(JSON.stringify(body)); req.end();
        });
    }
    return {
        request: request,
        stop: function () { alive = false; cancellations.slice().forEach(function (cancel) { cancel(); }); }
    };
}

function normalizeEmotes(data) {
    var entries = data && (data.emote_set || data).emotes || [];
    if (!Array.isArray(entries)) entries = [];
    var result = [], seen = Object.create(null);
    entries.slice(0, 2500).forEach(function (emote) {
        if (!emote || typeof emote !== 'object') return;
        var host = emote.data && emote.data.host, base = host && host.url;
        if (typeof emote.name !== 'string' || !/^\S{1,64}$/.test(emote.name) || !/^\/\/cdn\.7tv\.app\/emote\/[A-Za-z0-9]+$/.test(base || '') || seen[emote.name]) return;
        var files = Array.isArray(host.files) ? host.files : [], chosen = null;
        ['2x.webp', '1x.webp', '2x.gif', '1x.gif', '2x.png', '1x.png'].some(function (name) {
            chosen = files.filter(function (f) { return f && f.name === name; })[0]; return !!chosen;
        });
        if (!chosen) return;
        seen[emote.name] = true;
        result.push({ name: emote.name, url: 'https:' + base + '/' + chosen.name, zeroWidth: !!(emote.flags & 1) });
    });
    return result;
}
function createEmoteCatalogue(transport) {
    var cache = {}, alive = true, lastLookup = 'idle';
    var client = createJsonClient(3 * 1024 * 1024), request = transport || client.request;
    function cached(key, load) {
        if (!alive) return Promise.reject(new Error('Stopped'));
        if (cache[key] && Date.now() - cache[key].at < 15 * 60 * 1000) return Promise.resolve(cache[key].value);
        return load().then(function (value) {
            if (!alive) throw new Error('Stopped');
            if (Object.keys(cache).length >= 8) cache = {};
            cache[key] = { at: Date.now(), value: value }; return value;
        });
    }
    return {
        global: function () { return cached('global', function () { return request('api.7tv.app', '/v3/emote-sets/global').then(normalizeEmotes); }); },
        channel: function (login) {
            if (!/^[a-z0-9_]{1,25}$/.test(login || '')) return Promise.reject(new Error('Invalid channel'));
            return cached('channel:' + login, function () {
                return request('gql.twitch.tv', '/gql', { query: 'query($login:String!){user(login:$login){id}}', variables: { login: login } }).then(function (d) {
                    var id = d.data && d.data.user && d.data.user.id;
                    if (d.errors && d.errors.length) { lastLookup = 'query-rejected'; throw new Error('Anonymous channel lookup rejected'); }
                    if (typeof id !== 'string' || !/^\d{1,24}$/.test(id)) { lastLookup = 'user-not-found'; return []; }
                    return request('api.7tv.app', '/v3/users/twitch/' + id).then(function (data) { var entries = normalizeEmotes(data); lastLookup = entries.length ? 'ready' : 'no-channel-emotes'; return entries; });
                });
            });
        },
        status: function () { return lastLookup; },
        stop: function () { alive = false; client.stop(); cache = {}; }
    };
}

var AVATAR_RETRY_MS = 60000, AVATAR_CACHE_MS = 3600000;
var TWITCH_AVATAR = /^https:\/\/static-cdn\.jtvnw\.net\/jtv_user_pictures\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif)$/i;

function createAvatarCatalogue(client) {
    client = client || createJsonClient(64 * 1024);
    var cache = Object.create(null), pending = false;

    function refresh(ids, retainedIds) {
        if (pending) return;
        Object.keys(cache).forEach(function (id) { if (retainedIds.indexOf(id) < 0) delete cache[id]; });
        var now = Date.now();
        var missing = ids.filter(function (id) { return !cache[id] || cache[id].nextCheckAt <= now; });
        if (!missing.length) return;

        missing.forEach(function (id) { cache[id] = { url: cache[id] && cache[id].url, nextCheckAt: now + AVATAR_RETRY_MS }; });
        pending = true;
        client.request('gql.twitch.tv', '/gql', {
            query: 'query($ids:[ID!]!){users(ids:$ids){id profileImageURL(width:300)}}',
            variables: { ids: missing }
        }).then(function (response) {
            var users = response && response.data && response.data.users;
            if (!Array.isArray(users)) return;
            users.forEach(function (user) {
                if (!user || missing.indexOf(user.id) < 0 || typeof user.profileImageURL !== 'string' ||
                    user.profileImageURL.length > 512 || !TWITCH_AVATAR.test(user.profileImageURL)) return;
                cache[user.id] = { url: user.profileImageURL, nextCheckAt: Date.now() + AVATAR_CACHE_MS };
            });
        }).then(function () { pending = false; }, function () { pending = false; });
    }

    return {
        refresh: refresh,
        get: function (id) { return cache[id] && cache[id].url; },
        stop: function () { client.stop(); cache = Object.create(null); }
    };
}

module.exports = { createEmoteCatalogue: createEmoteCatalogue, normalizeEmotes: normalizeEmotes, createAvatarCatalogue: createAvatarCatalogue };
