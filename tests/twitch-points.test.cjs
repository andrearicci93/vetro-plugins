'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function setup(options = {}) {
    const dom = new JSDOM('<html lang="fr"><div id="__next"></div><video></video></html>', {
        url: 'https://pewter-example.tv.twitch.tv/smallant', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const w = dom.window;
    const player = w.document.querySelector('video');
    const playerState = { paused: false, ended: false, readyState: 3 };
    Object.keys(playerState).forEach(key => Object.defineProperty(player, key, { get: () => playerState[key] }));
    const root = w.document.getElementById('__next');
    const auth = { authCookieName: 'auth-token', loggedIn: true, logout() {} };
    root.__reactContainer$test = {
        memoizedProps: { value: { clientId: 'nativeclientid123456789' } },
        child: { memoizedProps: { value: auth } }
    };
    function signIn(id) {
        auth.loggedIn = id !== null;
        w.document.cookie = id === null ? 'auth-token=; Max-Age=0; Secure' : 'auth-token=fixture-token-' + id + '; Secure';
        w.document.cookie = id === null ? 'tachyon-user=; Max-Age=0; Secure'
            : 'tachyon-user=' + encodeURIComponent(JSON.stringify({ id })) + '; Secure';
    }
    signIn('7');

    const calls = [], requests = [], timers = new Set();
    let now = 100000, config = {}, connected = false;
    let bonus = { id: 'bonus-1', pointGain: 50 }, balance = 8552, release;
    w.fetch = async (url, request) => {
        const { operationName, variables } = JSON.parse(request.body);
        assert.equal(url, 'https://gql.twitch.tv/gql');
        assert.equal(request.headers['Client-ID'], 'nativeclientid123456789');
        assert.equal(request.credentials, 'omit');
        assert.match(request.headers.Authorization, /^OAuth fixture-token-/);
        calls.push({ operationName, variables: JSON.parse(JSON.stringify(variables)) });
        if (operationName === 'ChannelPointsContext' && options.holdLookup && !release) await new Promise(resolve => { release = resolve; });
        if (operationName === 'ChannelPointsContext') return {
            ok: true,
            json: async () => ({ data: { community: { id: '12', self: { communityPoints: { balance, availableClaim: bonus } } } } })
        };
        assert.equal(operationName, 'ClaimCommunityPoints');
        if (options.refuse) return { ok: true, json: async () => ({ errors: [{ message: 'Refused' }] }) };
        const pointGain = bonus.pointGain;
        if (!options.unconfirmed) { balance += pointGain + (options.passiveGain || 0); bonus = null; }
        return { ok: true, json: async () => ({ data: { claimCommunityPoints: { claim: { pointGain } } } }) };
    };
    const client = {
        isOpen: () => connected,
        close: () => { connected = false; },
        call: async (method, args = {}) => {
            requests.push({ method, args });
            if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'points-script' };
            if (method !== 'Runtime.evaluate') return {};
            const value = w.eval(args.expression);
            return { result: { value: args.awaitPromise ? await value : value } };
        }
    };
    const inspector = {
        listTargets: async () => [{ webSocketDebuggerUrl: 'ws://local' }],
        isTwitchPage: () => true,
        connect: async () => { connected = true; return client; }
    };
    const sandbox = {
        module: { exports: {} },
        require: id => id === './inspector-client.js' ? inspector : id==='./accounts/page.js'?require('../plugins/twitch/accounts/page.js'):require(id),
        Date: { now: () => now }, Promise,
        Math: Object.assign(Object.create(Math), { random: () => options.random || 0 }),
        setInterval(fn) { timers.add(fn); return fn; },
        clearInterval(fn) { timers.delete(fn); },
        setTimeout(fn) { setImmediate(fn); }
    };
    vm.runInNewContext(fs.readFileSync('plugins/twitch/page-actions.js', 'utf8'), sandbox);
    const points = sandbox.module.exports.createPageActions({
        config: { get: () => JSON.parse(JSON.stringify(config)), set: value => { config = JSON.parse(JSON.stringify(value)); } }
    });
    points.setDocumentFeatures(true, true);
    return {
        w, points, calls, requests, playerState, signIn, config: () => config, release: () => release(),
        setBonus: value => { bonus = value; },
        async flush() { for (let i = 0; i < 12; i++) await new Promise(setImmediate); },
        async tick(elapsed = 2000) { now += elapsed; for (const fn of timers) fn(); await this.flush(); },
        async close() { await points.stop(); assert.equal(timers.size, 0); dom.window.close(); },
        toast: () => w.document.querySelector('[data-vetro-points-indicator]')
    };
}

test('the Twitch TV remote toggles the native stream controls before acting on their focus', async () => {
    const x = setup();
    x.points.setDocumentFeatures(true, false);
    const w = x.w, d = w.document;
    const button = d.createElement('button');
    d.body.appendChild(button);
    button.focus();

    function fiber(displayName, parent, extra) {
        return Object.assign({ type: { displayName }, return: parent }, extra);
    }
    let recentIntents = 0, nativeBack = 0, clicks = 0, releases = 0;
    const recent = fiber('RecentUserIntentRoot', null, {
        memoizedProps: { value: {
            simulateUserIntent() { recentIntents++; },
            subscribeToRecentIntentChange() {}
        } }
    });
    const player = fiber('ChannelPlayerLayout', recent);
    const queue = { lastRenderedState: true, dispatch(visible) { this.lastRenderedState = visible; } };
    const layout = fiber('PlayingUILayout', player, {
        memoizedProps: { hidePlayUi: false },
        memoizedState: { next: { queue } }
    });
    const controls = fiber('PlayingUILayout.Controls', layout);
    button.__reactFiber$test = fiber('Button', controls);

    button.addEventListener('click', () => { clicks++; });
    d.addEventListener('keydown', event => {
        if (event.keyCode === 10009) nativeBack++;
        if (event.key === 'Enter') button.click();
    });
    d.addEventListener('keyup', () => { releases++; });
    function key(type, name, code, repeat = false) {
        const event = new w.KeyboardEvent(type, { key: name, keyCode: code, repeat, bubbles: true, cancelable: true });
        button.dispatchEvent(event);
        return event.defaultPrevented;
    }
    function press(name, code) {
        const prevented = key('keydown', name, code);
        assert.equal(key('keyup', name, code), prevented);
        return prevented;
    }

    try {
        x.points.start();
        await x.points.attach(8123);
        assert.equal(x.calls.length, 0, 'remote controls work with channel points disabled');
        assert.equal(w.__vetroTwitchPoints, undefined);
        assert.equal(key('keydown', 'GoBack', 10009), true);
        assert.equal(queue.lastRenderedState, false);
        assert.equal(key('keydown', 'GoBack', 10009, true), true);
        assert.equal(key('keyup', 'GoBack', 10009), true);
        assert.equal(nativeBack, 0);
        assert.equal(releases, 0);
        assert.equal(press('GoBack', 10009), false, 'back exits normally when the controls are already hidden');
        assert.equal(nativeBack, 1);

        assert.equal(key('keydown', 'Enter', 13), true);
        assert.equal(queue.lastRenderedState, true);
        assert.equal(recentIntents, 1);
        assert.equal(key('keydown', 'Enter', 13, true), true);
        assert.equal(key('keyup', 'Enter', 13), true);
        assert.equal(clicks, 0);
        assert.equal(press('Enter', 13), false, 'a second OK activates the focused button');
        assert.equal(clicks, 1);

        assert.equal(press('GoBack', 10009), true);
        assert.equal(press('ArrowRight', 39), false, 'navigation keeps its native handling');
        assert.equal(queue.lastRenderedState, true);

        button.__reactFiber$test = fiber('MenuOption', fiber('DialogLayer', controls));
        assert.equal(press('GoBack', 10009), false);
        button.__reactFiber$test = fiber('ChatButton', player);
        assert.equal(press('GoBack', 10009), false);
        button.__reactFiber$test = fiber('Button', controls);
        layout.memoizedProps.hidePlayUi = true;
        assert.equal(press('GoBack', 10009), false);
        layout.memoizedProps.hidePlayUi = false;
        const accounts = d.createElement('div');
        accounts.id = 'vetro-twitch-accounts';
        d.body.appendChild(accounts);
        assert.equal(press('GoBack', 10009), false);
        accounts.remove();
        await x.points.detach();
        assert.equal(press('GoBack', 10009), false, 'detaching restores the native handler');
        x.points.setDocumentFeatures(false, true);
        await x.points.attach(8123);
        assert.equal(x.points.connected(), true);
        assert.equal(press('GoBack', 10009), false, 'a disabled preference keeps native Back');
        assert.equal(w.__vetroTwitchControls, undefined);
        assert.ok(w.__vetroTwitchPoints);
        const documentScript = x.requests.filter(request => request.method === 'Page.addScriptToEvaluateOnNewDocument').at(-1);
        assert.doesNotMatch(documentScript.args.source, /__vetroTwitchControls/);
    } finally {
        await x.close();
    }
});

test('a credited bonus is claimed once, reported, and shown only when its notification is enabled', async () => {
    const x = setup({ passiveGain: 10 });
    try {
        x.points.start();
        x.points.setPointsActive(true);
        await x.points.attach(8123);
        await x.flush();
        assert.deepEqual(x.calls.map(call => call.operationName), ['ChannelPointsContext']);
        await x.tick(4000);
        assert.deepEqual(x.calls.map(call => call.operationName), ['ChannelPointsContext', 'ChannelPointsContext', 'ClaimCommunityPoints', 'ChannelPointsContext']);
        assert.deepEqual(x.calls[2].variables, { input: { claimID: 'bonus-1', channelID: '12' } });
        assert.equal(x.points.status().confirmed, 1);
        assert.equal(x.points.status().lastClaim.points, 50);
        assert.equal(x.toast(), null);
        assert.match(x.config().pointsAttempted[0], /^[a-f0-9]{64}$/);
        assert.ok(!JSON.stringify(x.config()).includes('bonus-1'));
        assert.ok(!JSON.stringify(x.points.status()).includes('fixture-token'));

        await x.tick();
        assert.equal(x.calls.length, 4, 'no new lookup before the one-minute interval');
        x.setBonus({ id: 'bonus-2', pointGain: 50 });
        x.points.setIndicator(true);
        await x.tick(60000);
        await x.tick(4000);
        assert.equal(x.points.status().confirmed, 2);
        assert.equal(x.toast().textContent, '+50 points de chaîne');
        assert.equal(x.toast().style.pointerEvents, 'none');
        x.points.setIndicator(false);
        await x.flush();
        assert.equal(x.toast(), null);
    } finally {
        await x.close();
    }
});

test('each bonus waits for the randomized delay and is rechecked before claiming', async () => {
    for (const [random, delay] of [[0, 3000], [0.5, 7500], [0.9999, 11999]]) {
        const x = setup({ random });
        try {
            x.points.start();
            x.points.setPointsActive(true);
            await x.points.attach(8123);
            await x.flush();
            await x.tick(delay - 1);
            assert.equal(x.calls.length, 1, 'only the initial lookup runs before the deadline');
            assert.deepEqual(x.config(), {}, 'waiting does not record an attempted claim');
            await x.tick(1);
            assert.deepEqual(x.calls.map(call => call.operationName),
                ['ChannelPointsContext', 'ChannelPointsContext', 'ClaimCommunityPoints', 'ChannelPointsContext']);
            assert.equal(x.points.status().confirmed, 1);
        } finally {
            await x.close();
        }
    }
});

test('the claimed points notification uses the current locale and the singular form for one point', async () => {
    const x = setup();
    try {
        x.setBonus({id: 'one-point', pointGain: 1});
        x.points.start();
        x.points.setPointsActive(true);
        x.points.setIndicator(true);
        await x.points.attach(8123);
        await x.flush();
        x.w.document.documentElement.lang = 'de-DE';
        await x.tick(4000);
        assert.equal(x.points.status().lastClaim.points, 1);
        assert.equal(x.toast().textContent, '+1 Kanalpunkt');
    } finally {
        await x.close();
    }
});

test('leaving the stream, disabling points or detaching cancels a delayed claim', async () => {
    for (const leave of [
        x => x.signIn(null), x => x.signIn('8'), x => x.w.history.pushState(null, '', '/another_channel'),
        x => { x.playerState.paused = true; }, x => x.points.setPointsActive(false), x => x.points.detach()
    ]) {
        const x = setup();
        try {
            x.points.start();
            x.points.setPointsActive(true);
            await x.points.attach(8123);
            await x.flush();
            await leave(x);
            await x.tick(4000);
            assert.equal(x.calls.filter(call => call.operationName === 'ClaimCommunityPoints').length, 0);
            assert.deepEqual(x.config(), {});
        } finally {
            await x.close();
        }
    }
});

test('an offer that disappears or changes during the delay is not claimed', async () => {
    for (const bonus of [null, { id: 'new-offer', pointGain: 50 }]) {
        const x = setup();
        try {
            x.points.start();
            x.points.setPointsActive(true);
            await x.points.attach(8123);
            await x.flush();
            x.setBonus(bonus);
            await x.tick(4000);
            assert.equal(x.calls.filter(call => call.operationName === 'ClaimCommunityPoints').length, 0);
            assert.deepEqual(x.config(), {});
        } finally {
            await x.close();
        }
    }
});

test('a refused claim is remembered across reattachment and an unconfirmed credit stays silent', async () => {
    const x = setup({ refuse: true });
    try {
        x.points.start();
        x.points.setPointsActive(true);
        x.points.setIndicator(true);
        await x.points.attach(8123);
        await x.flush();
        await x.tick(4000);
        assert.equal(x.points.status().confirmed, 0);
        assert.match(x.points.status().error, /could not be completed/);
        assert.equal(x.toast(), null);
        await x.points.detach();
        await x.points.attach(8123);
        await x.flush();
        await x.tick(4000);
        assert.equal(x.calls.filter(call => call.operationName === 'ClaimCommunityPoints').length, 1);
    } finally {
        await x.close();
    }

    const y = setup({ unconfirmed: true });
    try {
        y.points.start();
        y.points.setPointsActive(true);
        y.points.setIndicator(true);
        await y.points.attach(8123);
        await y.flush();
        await y.tick(4000);
        assert.equal(y.calls.filter(call => call.operationName === 'ClaimCommunityPoints').length, 1);
        assert.equal(y.points.status().confirmed, 0);
        assert.match(y.points.status().error, /not confirmed/);
        assert.equal(y.toast(), null);
    } finally {
        await y.close();
    }
});

test('guest mode, paused playback and a changed account, channel or foreground cancel the claim', async () => {
    for (const leave of [
        x => x.signIn(null), x => x.signIn('8'), x => x.w.history.pushState(null, '', '/another_channel'),
        x => { x.playerState.paused = true; }, x => x.points.setPointsActive(false)
    ]) {
        const x = setup({ holdLookup: true });
        try {
            x.points.start();
            x.points.setPointsActive(true);
            await x.points.attach(8123);
            await x.flush();
            assert.equal(x.calls.length, 1);
            leave(x);
            x.release();
            await x.flush();
            assert.equal(x.calls.length, 1);
            assert.equal(x.toast(), null);
            assert.deepEqual(x.config(), {});
        } finally {
            await x.close();
        }
    }

    const y = setup();
    try {
        y.signIn(null);
        y.points.start();
        y.points.setPointsActive(true);
        await y.points.attach(8123);
        await y.tick(60000);
        assert.equal(y.calls.length, 0);
        assert.equal(y.points.status().phase, 'waiting-for-signed-in-live');
    } finally {
        await y.close();
    }
});
