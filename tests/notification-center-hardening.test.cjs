'use strict';
// Regression tests for the catalog review: nothing a request can send may throw inside the Shard, hang Vetro or open more downloads than allowed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const {EventEmitter} = require('events');

const folder = path.join(__dirname, '../plugins/notification-center');
const create = require(path.join(folder, 'index.js'));
const rules = require(path.join(folder, 'rules.js'));

function start() {
    let config = {};
    const shard = create({
        id: 'notification-center', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hard-')),
        config: {get: () => JSON.parse(JSON.stringify(config)), set: v => { config = JSON.parse(JSON.stringify(v)); }},
        execute: () => Promise.reject(new Error('no exec')), queueFile: path.join(os.tmpdir(), 'nc-q-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json')
    });
    if (shard.start) shard.start();
    return shard;
}
// `chunks` are emitted one by one as Buffers (like a real request); strings are sent as one chunk.
function call(shard, method, sub, chunks, headers) {
    return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = method; req.url = '/' + sub; req.headers = headers || {}; req.destroy = () => {};
        const res = {writeHead(code) { this.code = code; }, end(text) { let j = null; try { j = JSON.parse(text); } catch (e) { /* not JSON */ } resolve({code: this.code, json: j, text}); }};
        let handled;
        try { handled = shard.route(req, res, sub); } catch (e) { return reject(new Error('route threw: ' + e.message)); }
        if (!handled) return reject(new Error('route not handled: ' + method + ' ' + sub));
        setImmediate(() => {
            try {
                if (chunks != null) for (const c of [].concat(chunks)) req.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(typeof c === 'string' ? c : JSON.stringify(c)));
                req.emit('end');
            } catch (e) { reject(new Error('handler threw: ' + e.message)); }
        });
    });
}
const queued = async s => (await call(s, 'GET', 'notifications')).json.notifications;
const HOSTILE = [{toString: 1}, {valueOf: 1, toString: 1}, [], [{toString: 1}], {length: 1e15}, null, true, 12345678901234567890, {a: {b: {c: 1}}}, '\u0000\u001f', 'x'.repeat(5000)];

test('hostile values in every notify field never throw and never turn the Shard off', async () => {
    const s = start();
    try {
        for (const field of ['message', 'title', 'seconds', 'duration', 'level', 'mode', 'icon', 'image', 'wallpaper', 'source', 'open', 'key']) {
            for (const bad of HOSTILE) {
                const body = {message: 'ok', [field]: bad};
                if (field === 'message') body.title = 'T';
                const r = await call(s, 'POST', 'notify', JSON.stringify(body));
                assert.ok(r.code === 200 || r.code === 400 || r.code === 403, field + ' => ' + r.code + ' ' + r.text);
            }
        }
        assert.equal((await call(s, 'POST', 'notify', {message: 'still alive'})).code, 200);
    } finally { if (s.stop) s.stop(); }
});

test('the exact request from the review does not throw', async () => {
    const s = start();
    try {
        const r = await call(s, 'POST', 'notify', '{"message":{"toString":1}}');
        assert.equal(r.code, 400);
        assert.match(r.json.error, /message/);
    } finally { if (s.stop) s.stop(); }
});

test('hostile values in the other routes (ntfy, profiles, settings, hooks, hook) answer, never throw', async () => {
    const s = start();
    try {
        for (const bad of HOSTILE) {
            for (const [method, sub, body] of [
                ['POST', 'ntfy', {message: 'x', title: bad, priority: bad, tags: bad}],
                ['POST', 'profiles', {source: bad, icon: bad, level: bad, mode: bad, duration: bad, rate: bad, key: bad, enabled: bad}],
                ['POST', 'profiles', {source: 'ok', icon: bad, level: bad, mode: bad, duration: bad, rate: bad, key: bad}],
                ['POST', 'settings', {quiet: bad, groupSeconds: bad, strict: bad}],
                ['POST', 'settings', bad],
                ['POST', 'hooks', {name: 'h', message: bad, title: bad, level: bad, icon: bad, mode: bad, duration: bad, source: bad}],
                ['POST', 'hook/h', bad],
                ['POST', 'lang', {lang: bad}]
            ]) {
                const r = await call(s, method, sub, JSON.stringify(body), sub === 'ntfy' ? {'content-type': 'application/json'} : {});
                assert.ok(r.code >= 200 && r.code < 500, sub + ' => ' + r.code + ' ' + r.text);
            }
        }
        assert.equal((await call(s, 'POST', 'notify', {message: 'still alive'})).code, 200);
    } finally { if (s.stop) s.stop(); }
});

test('ntfy tags with a huge length return at once instead of looping', async () => {
    const s = start();
    try {
        const r = await Promise.race([
            call(s, 'POST', 'ntfy', '{"message":"x","tags":{"length":1e15}}', {'content-type': 'application/json'}),
            new Promise(resolve => setTimeout(() => resolve('HUNG'), 3000))
        ]);
        assert.notEqual(r, 'HUNG', 'the ntfy route must not loop over sender-controlled length');
        assert.equal(r.code, 200);
        const long = await call(s, 'POST', 'ntfy', JSON.stringify({message: 'y', tags: Array.from({length: 600}, (_, i) => 'x' + i).concat('tada')}), {'content-type': 'application/json'});
        assert.equal(long.code, 200);
        assert.equal((await queued(s)).filter(n => n.message === 'y')[0].icon, '', 'tags past the 10th are ignored');
        await call(s, 'POST', 'ntfy', JSON.stringify({message: 'z', tags: ['tada']}), {'content-type': 'application/json'});
        assert.equal((await queued(s)).filter(n => n.message === 'z')[0].icon, '🎉');
    } finally { if (s.stop) s.stop(); }
});

test('__proto__ and constructor are not levels, modes or sources', async () => {
    const s = start();
    try {
        await call(s, 'POST', 'notify', {message: 'a', level: '__proto__', mode: 'constructor'});
        await call(s, 'POST', 'notify', {message: 'b', level: 'toString', mode: 'hasOwnProperty'});
        const [a, b] = await queued(s);
        assert.deepEqual([a.level, a.mode, b.level, b.mode], ['info', 'banner', 'info', 'banner']);
        assert.equal(rules.sanitizeProfile({level: '__proto__', mode: 'constructor'}, String, {}).level, '');
        assert.equal(rules.sanitizeProfile({level: '__proto__', mode: 'constructor'}, String, {}).mode, '');
        assert.equal(rules.sanitizeSettings({quiet: {allow: '__proto__'}}, {}).quiet.allow, 'alert');
        assert.equal((await call(s, 'POST', 'profiles', {source: 'constructor', icon: 'x'})).code, 200, 'a source may be called constructor');
        assert.equal((await call(s, 'POST', 'notify', {message: 'c', source: 'constructor'})).code, 200);
        assert.equal((await call(s, 'POST', 'notify', {message: 'd', source: '__proto__'})).code, 200, 'an invalid source name is ignored');
        assert.equal(rules.applyProfile(JSON.parse('{"__proto__":{"level":"alert"},"message":"m"}'), null).level, undefined);
    } finally { if (s.stop) s.stop(); }
});

test('a multi-byte character split across two chunks stays intact', async () => {
    const s = start();
    try {
        const bytes = Buffer.from('{"message":"ação \u{1F514}"}');
        const cut = bytes.indexOf(0xC3) + 1;   // between the two bytes of the first ç
        await call(s, 'POST', 'notify', [bytes.slice(0, cut), bytes.slice(cut, cut + 7), bytes.slice(cut + 7)]);
        assert.equal((await queued(s))[0].message, 'ação \u{1F514}');
    } finally { if (s.stop) s.stop(); }
});

test('Resend keeps the wallpaper (and image) in the recent list', async () => {
    const s = start();
    try {
        await call(s, 'POST', 'notify', {message: 'pic', image: 'http://example.test/i.png', wallpaper: 'http://example.test/w.png', open: false});
        const rec = (await call(s, 'GET', 'recent')).json.recent[0];
        assert.equal(rec.wallpaper, 'http://example.test/w.png');
        assert.equal(rec.image, 'http://example.test/i.png');
    } finally { if (s.stop) s.stop(); }
});

test('there is no route that fetches an arbitrary URL', async () => {
    const s = start();
    try {
        let hits = 0;
        const probe = http.createServer((q, r) => { hits += 1; r.writeHead(200, {'Content-Type': 'image/png'}); r.end('x'); });
        await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
        const url = 'http://127.0.0.1:' + probe.address().port + '/p.png';
        const r = await call(s, 'GET', 'img?url=' + encodeURIComponent(url) + '&info=1');
        assert.equal(r.code, 404);
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(hits, 0, 'the URL was never fetched');
        assert.equal((await call(s, 'GET', 'img?id=%E0%A4%A')).code, 404, 'a malformed id does not throw');
        probe.close();
    } finally { if (s.stop) s.stop(); }
});

test('at most 2 picture downloads run at once, the rest wait, and stop() aborts them all', async () => {
    const s = start();
    let active = 0, peak = 0, started = 0;
    const slow = http.createServer((q, r) => {
        active += 1; started += 1; peak = Math.max(peak, active);
        r.writeHead(200, {'Content-Type': 'image/png'});
        const t = setInterval(() => r.write('x'), 40);   // drips bytes: an idle timeout would never fire
        r.on('close', () => { clearInterval(t); active -= 1; });
    });
    await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve));
    try {
        const base = 'http://127.0.0.1:' + slow.address().port;
        const ids = [];
        for (let i = 0; i < 5; i++) ids.push((await call(s, 'POST', 'notify', {message: 'p' + i, image: base + '/' + i + '.png', open: false, seconds: 60})).json.id);
        const answers = ids.map(id => call(s, 'GET', 'img?id=' + id));
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.ok(peak <= 2, 'peak simultaneous downloads was ' + peak);
        assert.equal(started, 2, 'the other three are waiting, not started');
        s.stop();
        const done = await Promise.all(answers);
        assert.ok(done.every(r => r.code === 502 && /stopped/.test(r.text)), done.map(r => r.code + r.text).join(' | '));
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(active, 0, 'every connection was closed by stop()');
        assert.equal(started, 2, 'waiting downloads never started after stop()');
    } finally { slow.close(); }
});

test('the queue file is written under a temporary name and renamed, leaving no temp files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-qf-'));
    const target = path.join(dir, 'queue.json');
    let config = {};
    const s = create({id: 'notification-center', dir, config: {get: () => config, set: v => { config = v; }}, execute: () => Promise.reject(new Error('no exec')), queueFile: target});
    if (s.start) s.start();
    try {
        await call(s, 'POST', 'notify', {message: 'file', open: false});
        assert.ok(fs.existsSync(target));
        assert.match(JSON.parse(fs.readFileSync(target, 'utf8')).notifications[0].message, /file/);
        assert.deepEqual(fs.readdirSync(dir).filter(f => /\.tmp$/.test(f)), [], 'no temp file is left behind');
        if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o022, 0, 'not writable by group or others');
    } finally { if (s.stop) s.stop(); }
});
