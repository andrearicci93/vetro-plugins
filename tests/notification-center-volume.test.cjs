'use strict';
// Review follow-ups for the sound: a volume below 10 must never become the maximum, one rule for every entry point, and a cap on pending sounds.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const {EventEmitter} = require('events');

const folder = path.join(__dirname, '../plugins/notification-center');
const create = require(path.join(folder, 'index.js'));
const rules = require(path.join(folder, 'rules.js'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// paplay volume = the request volume x the sound volume setting x 3 (the system sounds are quiet), of 65536
const vol = (percent, master = 100) => Math.round(65536 * percent / 100 * master / 100 * 3);

function start(options = {}) {
    let config = options.seed || {};
    const commands = [];
    const ctx = {
        id: 'notification-center', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vol-')),
        config: {get: () => JSON.parse(JSON.stringify(config)), set: v => { config = JSON.parse(JSON.stringify(v)); }},
        queueFile: path.join(os.tmpdir(), 'nc-q-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json'),
        sound: {gapMs: 0, waitMs: options.waitMs === undefined ? 0 : options.waitMs, songScale: 0.01},
        execute: cmd => { commands.push(cmd); return Promise.resolve({exit_code: 0, stdout: '', stderr: ''}); }
    };
    const shard = create(ctx);
    if (shard.start) shard.start();
    return {shard, commands};
}
function call(shard, method, sub, body) {
    return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = method; req.url = '/' + sub; req.headers = {}; req.destroy = () => {};
        const res = {writeHead(code) { this.code = code; }, end(text) { let j = null; try { j = JSON.parse(text); } catch (e) { /* not JSON */ } resolve({code: this.code, json: j, text}); }};
        if (!shard.route(req, res, sub)) return reject(new Error('route not handled: ' + method + ' ' + sub));
        setImmediate(() => { if (body != null) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); req.emit('end'); });
    });
}
async function withShard(fn, options) {
    const s = start(options);
    try { await fn(s.shard, s.commands); } finally { if (s.shard.stop) s.shard.stop(); }
}
const volumeOf = cmd => Number(/--volume=(\d+)/.exec(cmd)[1]);

test('a volume below 10 is the quietest, never the loudest (notify)', () => withShard(async (s, commands) => {
    const cases = [[0, 10], [5, 10], [-3, 10], ['1', 10], [9, 10], [10, 10], [50, 50], [100, 100], [500, 100], [{toString: 1}, 100], ['abc', 100], [undefined, 100]];
    let i = 0;
    for (const [given, shown] of cases) {
        const body = {message: 'volume case ' + (i++), sound: 'chime', group: false};
        if (given !== undefined) body.volume = given;
        const r = await call(s, 'POST', 'notify', body);
        assert.equal(r.json.sound, 'requested', JSON.stringify(given));
        await wait(5);
        assert.equal(volumeOf(commands[commands.length - 1]), vol(shown), 'volume ' + JSON.stringify(given) + ' should play at ' + shown);
    }
}));

test('POST play uses the same rule', () => withShard(async (s, commands) => {
    await call(s, 'POST', 'play', {sound: 'chime', volume: 0});
    await wait(5);
    assert.equal(volumeOf(commands[0]), vol(10));
}));

test('a source and a webhook store a clamped default volume; 0 or empty clears it', () => withShard(async s => {
    await call(s, 'POST', 'profiles', {source: 'quiet', volume: 5});
    assert.equal((await call(s, 'GET', 'profiles')).json.profiles.quiet.volume, 10);
    await call(s, 'POST', 'profiles', {source: 'quiet', volume: 250});
    assert.equal((await call(s, 'GET', 'profiles')).json.profiles.quiet.volume, 100);
    await call(s, 'POST', 'profiles', {source: 'quiet', volume: 0});
    assert.equal((await call(s, 'GET', 'profiles')).json.profiles.quiet.volume, 0);
    await call(s, 'POST', 'profiles', {source: 'quiet', volume: 30});
    await call(s, 'POST', 'profiles', {source: 'quiet', volume: ''});
    assert.equal((await call(s, 'GET', 'profiles')).json.profiles.quiet.volume, 0);
    await call(s, 'POST', 'hooks', {name: 'quiethook', message: 'x', volume: 5});
    assert.equal((await call(s, 'GET', 'hooks')).json.hooks.quiethook.volume, 10);
    assert.equal(rules.storedVolume(-3), 10);
    assert.equal(rules.storedVolume(null), 0);
}));

test('the sound volume setting is clamped too, also from text; junk keeps the old value', () => withShard(async s => {
    assert.equal((await call(s, 'POST', 'settings', {soundVolume: '5'})).json.settings.soundVolume, 10);
    assert.equal((await call(s, 'POST', 'settings', {soundVolume: 70})).json.settings.soundVolume, 70);
    assert.equal((await call(s, 'POST', 'settings', {soundVolume: 'abc'})).json.settings.soundVolume, 70);
    assert.equal((await call(s, 'POST', 'settings', {soundVolume: 1000})).json.settings.soundVolume, 100);
}));

test('at most 8 sounds wait for their banner at once; the rest are skipped, and stop() cancels the timers', async () => {
    const s = start({waitMs: 5000});
    try {
        const states = [];
        for (let i = 0; i < 12; i++) {
            const r = await call(s.shard, 'POST', 'notify', {message: 'pending sound ' + i, sound: 'chime', group: false});
            states.push(r.json.sound);
        }
        assert.deepEqual(states, ['requested', 'requested', 'requested', 'requested', 'requested', 'requested', 'requested', 'requested', 'skipped', 'skipped', 'skipped', 'skipped']);
    } finally { s.shard.stop(); }
});
