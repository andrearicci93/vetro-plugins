'use strict';
var https = require('https'), url = require('url'), inspector = require('../inspector-client.js'), page = require('./page.js'), storage = require('./store.js');
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
function sameValues(a, b) {
    return a.length === b.length && a.every(function (x) { return b.some(function (y) { return x.name === y.name && x.value === y.value && x.domain === y.domain && x.path === y.path; }); });
}
function open(port, requireCurrent) {
    var client = null, scriptId = null, origin = null;
    function evaluate(expression) {
        return client.call('Runtime.evaluate', { expression: expression, returnByValue: true }).then(function (result) {
            if (result.exceptionDetails) throw new Error('Twitch account page is unavailable');
            return result.result && result.result.value;
        }).catch(function () { throw new Error('Twitch account page is unavailable'); });
    }
    function callPage(expression) {
        return evaluate('location.origin === ' + JSON.stringify(origin) + ' && window.__vetroTwitchAccounts ? ' +
            'window.__vetroTwitchAccounts.' + expression + ' : null');
    }
    function navigate(route) {
        return client.call('Page.navigate', { url: origin + route }).then(function (result) {
            if (result.errorText) throw new Error('Twitch could not reload');
        }).catch(function () { throw new Error('Twitch could not reload'); });
    }
    function readCookies() {
        return client.call('Network.getCookies', { urls: [origin + '/'] }).then(function (result) {
            return storage.cookies((result.cookies || []).filter(function (c) { return storage.names.indexOf(c.name) >= 0 && /^\.?twitch\.tv$/.test(c.domain) && c.path === '/'; }));
        }).catch(function () { throw new Error('Twitch authentication cookies are unavailable'); });
    }
    function close() {
        if (!client) return Promise.resolve();
        var old = client;
        return (old.isOpen() ? (scriptId ? old.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }) : Promise.resolve())
            .catch(function () {}).then(function () { return callPage('stop()'); }).catch(function () {}) : Promise.resolve()).then(function () { old.close(); client = null; });
    }
    return inspector.listTargets(port).then(function (targets) {
        requireCurrent(); var pages = targets.filter(inspector.isTwitchPage);
        if (pages.length !== 1) throw new Error('Expected one Twitch account page');
        var target = url.parse(pages[0].url);
        origin = 'https://' + target.hostname + (target.port && target.port !== '443' ? ':' + target.port : '');
        return inspector.connect(pages[0].webSocketDebuggerUrl, port);
    }).then(function (connection) {
        client = connection; requireCurrent(); return client.call('Page.enable');
    }).then(function () { requireCurrent(); return client.call('Page.addScriptToEvaluateOnNewDocument', { source: page.source(origin) }); })
        .then(function (result) { scriptId = result.identifier; requireCurrent(); if (!scriptId) throw new Error('Account page injection is unavailable'); return evaluate(page.source(origin)); })
        .then(function () {
            requireCurrent(); return {
                connected: function () { return !!client && client.isOpen(); },
                read: function (deep) { return callPage('read(' + (deep ? 'true' : 'false') + ')'); },
                publish: function (value) { return callPage('set(' + JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ')'); },
                cookies: readCookies,
                replace: function (cookies) {
                    var next = storage.cookies(cookies);
                    return readCookies().then(function (current) {
                        return current.reduce(function (task, c) { return task.then(function () { return client.call('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }); }); }, Promise.resolve());
                    }).then(function () {
                        if (!next.length) return;
                        return client.call('Network.setCookies', { cookies: next.map(function (c) { var p = {}; Object.keys(c).forEach(function (key) { if (key !== 'session') p[key] = c[key]; }); return p; }) });
                    }).then(readCookies).then(function (actual) { if (!sameValues(actual, next)) throw new Error('Twitch did not accept the account cookies'); }).catch(function () { throw new Error('Twitch could not update the account session'); });
                },
                reload: function () { return navigate('/'); },
                signIn: function () { return navigate('/login'); },
                validate: validation,
                close: close
            };
        }).catch(function () { return close().then(function () { throw new Error('Could not attach the Twitch account manager'); }); });
}
module.exports = { open: open, validate: validation };
