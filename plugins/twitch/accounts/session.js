'use strict';
// Works with the account page on the exact Twitch TV origin selected at attachment. The account
// manager decides when to change sessions. This module reads, replaces and verifies the cookies.

var https = require('https');
var url = require('url');
var inspector = require('../inspector-client.js');
var page = require('./page.js');
var storage = require('./store.js');

function validation(cookies) {
    var token = cookies.filter(function (c) { return c.name === 'auth-token'; })[0];
    if (!token) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
        var finished = false, timer, request;
        function finish(error, result) { if (finished) return; finished = true; clearTimeout(timer); if (error) reject(new Error('Twitch account validation is unavailable')); else resolve(result); }
        request = https.get({ hostname: 'id.twitch.tv', path: '/oauth2/validate', headers: { Authorization: 'OAuth ' + token.value } }, function (response) {
            var text = '';
            response.on('data', function (chunk) { if (text.length + chunk.length > 16384) { response.destroy(); finish(true); } else text += chunk; });
            response.on('error', function () { finish(true); });
            response.on('end', function () {
                if (response.statusCode === 401) return finish(false, null);
                if (response.statusCode !== 200) return finish(true);
                try {
                    var value = JSON.parse(text);
                    if (!/^\d{1,32}$/.test(value.user_id) || !/^[a-zA-Z0-9_]{1,32}$/.test(value.login)) return finish(true);
                    finish(false, { id: String(value.user_id), login: value.login });
                } catch (e) { finish(true); }
            });
        });
        request.on('error', function () { finish(true); });
        timer = setTimeout(function () { request.destroy(); finish(true); }, 4000);
    });
}
function sameCookieValues(actual, expected) {
    return actual.length === expected.length && actual.every(function (cookie) {
        return expected.some(function (other) {
            return cookie.name === other.name && cookie.value === other.value && cookie.domain === other.domain && cookie.path === other.path;
        });
    });
}
function open(port, requireCurrent) {
    var client = null, documentScript = null, origin = null;
    function callPage(expression) {
        return inspector.evaluate(client, 'location.origin === ' + JSON.stringify(origin) + ' && window.__vetroTwitchAccounts ? ' +
            'window.__vetroTwitchAccounts.' + expression + ' : null')
            .catch(function () { throw new Error('Twitch account page is unavailable'); });
    }
    function navigate(route) {
        return client.call('Page.navigate', { url: origin + route }).then(function (result) {
            if (result.errorText) throw new Error('Twitch could not reload');
        }).catch(function () { throw new Error('Twitch could not reload'); });
    }
    function readCookies() {
        return client.call('Network.getCookies', { urls: [origin + '/'] }).then(function (result) {
            var accountCookies = (result.cookies || []).filter(function (cookie) {
                return storage.names.indexOf(cookie.name) >= 0 && /^\.?twitch\.tv$/.test(cookie.domain) && cookie.path === '/';
            });
            return storage.cookies(accountCookies);
        }).catch(function () { throw new Error('Twitch authentication cookies are unavailable'); });
    }

    // Replace only the account cookies. The caller owns recovery if a delete, write or readback fails.
    function replaceCookies(cookies) {
        var next = storage.cookies(cookies);
        return readCookies().then(function (current) {
            return current.reduce(function (task, cookie) {
                return task.then(function () {
                    return client.call('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path });
                });
            }, Promise.resolve());
        }).then(function () {
            if (!next.length) return;
            var browserCookies = next.map(function (cookie) {
                var parameters = {};
                Object.keys(cookie).forEach(function (key) {
                    if (key !== 'session') parameters[key] = cookie[key];
                });
                return parameters;
            });
            return client.call('Network.setCookies', { cookies: browserCookies });
        }).then(readCookies).then(function (actual) {
            if (!sameCookieValues(actual, next)) throw new Error('Twitch did not accept the account cookies');
        }).catch(function () {
            throw new Error('Twitch could not update the account session');
        });
    }

    function close() {
        if (!client) return Promise.resolve();
        var old = client;
        var cleanup = Promise.resolve();
        if (old.isOpen()) {
            if (documentScript) cleanup = documentScript.remove();
            // Try to clean the current page even if removing the script for future documents fails.
            cleanup = cleanup.catch(function () {}).then(function () { return callPage('stop()'); }).catch(function () {});
        }
        return cleanup.then(function () {
            old.close();
            client = null;
        });
    }
    return inspector.openTwitchPage(port, requireCurrent).then(function (opened) {
        client = opened.client;
        requireCurrent();
        var target = url.parse(opened.url);
        origin = 'https://' + target.hostname + (target.port && target.port !== '443' ? ':' + target.port : '');
        documentScript = inspector.createDocumentScript(client);
        return documentScript.install(page.source(origin), requireCurrent);
    })
        .then(function () {
            requireCurrent(); return {
                connected: function () { return !!client && client.isOpen(); },
                read: function (deep) { return callPage('read(' + (deep ? 'true' : 'false') + ')'); },
                publish: function (value) { return callPage('set(' + JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ')'); },
                cookies: readCookies,
                replace: replaceCookies,
                reload: function () { return navigate('/'); },
                signIn: function () { return navigate('/login'); },
                validate: validation,
                close: close
            };
        }).catch(function () { return close().then(function () { throw new Error('Could not attach the Twitch account manager'); }); });
}
module.exports = { open: open, validate: validation };
