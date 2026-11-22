'use strict';
// Sources (profiles, keys, rate limit), quiet hours, grouping of repeats and webhooks: the rules on their own and through the Shard's routes.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const {EventEmitter} = require('events');

const folder = path.join(__dirname, '../plugins/notification-center');
const rules = require(path.join(folder, 'rules.js'));
const create = require(path.join(folder, 'index.js'));

const at = (h, m) => new Date(2026, 0, 15, h, m);
const noIcon = v => String(v || '');

test('quiet hours cross midnight and let the allowed level through', () => {
    const s = rules.sanitizeSettings({quiet: {enabled: true, from: '22:00', to: '07:00', allow: 'alert'}}, {});
    assert.equal(rules.isQuiet(s, 'info', at(23, 0)), true);
    assert.equal(rules.isQuiet(s, 'info', at(3, 30)), true);
    assert.equal(rules.isQuiet(s, 'info', at(7, 0)), false, 'the end is exclusive');
    assert.equal(rules.isQuiet(s, 'info', at(12, 0)), false);
    assert.equal(rules.isQuiet(s, 'alert', at(23, 0)), false, 'alerts still get through');
    assert.equal(rules.isQuiet(s, 'warn', at(23, 0)), true);
    const w = rules.sanitizeSettings({quiet: {allow: 'warn'}}, s);
    assert.equal(rules.isQuiet(w, 'warn', at(23, 0)), false);
    const none = rules.sanitizeSettings({quiet: {allow: 'none'}}, s);
    assert.equal(rules.isQuiet(none, 'alert', at(23, 0)), true);
    assert.equal(rules.isQuiet(rules.defaultSettings(), 'info', at(23, 0)), false, 'off by default');
});

test('quiet hours inside one day, and bad times are ignored', () => {
    const s = rules.sanitizeSettings({quiet: {enabled: true, from: '13:00', to: '14:30'}}, {});
    assert.equal(rules.isQuiet(s, 'info', at(14, 0)), true);
    assert.equal(rules.isQuiet(s, 'info', at(14, 30)), false);
    const bad = rules.sanitizeSettings({quiet: {enabled: true, from: '25:99', to: 'x'}}, {});
    assert.equal(bad.quiet.from, '22:00');
    assert.equal(bad.quiet.to, '07:00');
});

test('templates fill {{paths}} from the posted JSON and never evaluate anything', () => {
    const data = {repository: {name: 'tv'}, commits: [{message: 'Fix banner'}], n: 3, nested: {a: 1}};
    assert.equal(rules.render('{{repository.name}}: {{commits.0.message}} ({{n}})', data), 'tv: Fix banner (3)');
    assert.equal(rules.render('{{missing.path}}|{{ repository.name }}', data), '|tv');
    assert.equal(rules.render('{{nested}}', data), '{"a":1}');
    assert.equal(rules.render('{{__proto__.x}}{{constructor.name}}', data), '');
    assert.equal(rules.render('${1+1} {{ 1+1 }}', data), '${1+1} {{ 1+1 }}');
});

test('profile defaults fill in what the sender left out; the sender wins', () => {
    const p = rules.sanitizeProfile({icon: '\u{1F3E0}', level: 'warn', mode: 'full', duration: 20}, noIcon, {});
    const filled = rules.applyProfile({message: 'x'}, p);
    assert.deepEqual([filled.icon, filled.level, filled.mode, filled.duration], ['\u{1F3E0}', 'warn', 'full', 20]);
    const own = rules.applyProfile({message: 'x', level: 'ok', duration: 3}, p);
    assert.deepEqual([own.level, own.duration], ['ok', 3]);
});

test('keys are compared fully, validated, and never exposed', () => {
    assert.ok(rules.sameKey('abcdefgh12', 'abcdefgh12'));
    assert.ok(!rules.sameKey('abcdefgh12', 'abcdefgh13'));
    assert.ok(!rules.sameKey('abcdefgh12', 'abcdefgh1'));
    assert.ok(!rules.sameKey(undefined, 'abcdefgh12'));
    assert.ok(rules.sanitizeProfile({key: 'short'}, noIcon, {}).error);
    const p = rules.sanitizeProfile({key: 'a-good-key-123'}, noIcon, {});
    assert.equal(rules.publicProfile(p).hasKey, true);
    assert.ok(!('key' in rules.publicProfile(p)));
});

test('rate limiter allows N per minute per source', () => {
    const allow = rules.makeLimiter();
    assert.ok(allow('a', 2, 1000) && allow('a', 2, 1001));
    assert.ok(!allow('a', 2, 1002));
    assert.ok(allow('b', 2, 1002), 'another source is separate');
    assert.ok(allow('a', 2, 62000), 'the window slides');
    assert.ok(allow('a', 0, 1003), '0 = no limit');
});

function start(seed) {
    let config = seed || {};
    const shard = create({
        id: 'notification-center', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rules-')),
        config: {get: () => JSON.parse(JSON.stringify(config)), set: v => { config = JSON.parse(JSON.stringify(v)); }},
        execute: () => Promise.reject(new Error('no exec'))
    });
    if (shard.start) shard.start();
    return shard;
}
function call(shard, method, sub, body, headers) {
    return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = method; req.url = '/' + sub; req.headers = headers || {}; req.destroy = () => {};
        const res = {writeHead(code) { this.code = code; }, end(text) { let j = null; try { j = JSON.parse(text); } catch (e) { /* not JSON */ } resolve({code: this.code, json: j, text}); }};
        if (!shard.route(req, res, sub)) return reject(new Error('route not handled: ' + method + ' ' + sub));
        setImmediate(() => { if (body != null) req.emit('data', typeof body === 'string' ? body : JSON.stringify(body)); req.emit('end'); });
    });
}
const queued = async s => (await call(s, 'GET', 'notifications')).json.notifications;

test('a source profile fills defaults, and its key is required', async () => {
    const s = start();
    try {
        const made = await call(s, 'POST', 'profiles', {source: 'doorbell', icon: '\u{1F6AA}', level: 'warn', genKey: true});
        assert.equal(made.code, 200);
        assert.match(made.json.key, /^[a-f0-9]{32}$/);
        const listed = await call(s, 'GET', 'profiles');
        assert.equal(listed.json.profiles.doorbell.hasKey, true);
        assert.doesNotMatch(listed.text, new RegExp(made.json.key), 'the key is never returned again');

        assert.equal((await call(s, 'POST', 'notify', {message: 'Ring', source: 'doorbell'})).code, 403, 'no key');
        assert.equal((await call(s, 'POST', 'notify', {message: 'Ring', source: 'doorbell'}, {'x-nc-key': 'wrong-key-123'})).code, 403, 'wrong key');
        const ok = await call(s, 'POST', 'notify', {message: 'Ring', source: 'doorbell'}, {'x-nc-key': made.json.key});
        assert.equal(ok.code, 200);
        const n = (await queued(s))[0];
        assert.equal(n.level, 'warn');
        assert.equal(n.icon, '\u{1F6AA}');
    } finally { if (s.stop) s.stop(); }
});

test('a disabled source and an unknown source in strict mode are refused', async () => {
    const s = start();
    try {
        await call(s, 'POST', 'profiles', {source: 'old', enabled: false});
        assert.equal((await call(s, 'POST', 'notify', {message: 'x', source: 'old'})).code, 403);
        assert.equal((await call(s, 'POST', 'notify', {message: 'x', source: 'new-thing'})).code, 200, 'unknown sources are allowed by default');
        await call(s, 'POST', 'settings', {strict: true});
        assert.equal((await call(s, 'POST', 'notify', {message: 'y', source: 'new-thing'})).code, 403);
        assert.equal((await call(s, 'POST', 'notify', {message: 'y'})).code, 403, 'a source is required in strict mode');
    } finally { if (s.stop) s.stop(); }
});

test('the rate limit of a source answers 429', async () => {
    const s = start();
    try {
        await call(s, 'POST', 'profiles', {source: 'noisy', rate: 2});
        const codes = [];
        for (let i = 0; i < 3; i++) codes.push((await call(s, 'POST', 'notify', {message: 'm' + i, source: 'noisy'})).code);
        assert.deepEqual(codes, [200, 200, 429]);
    } finally { if (s.stop) s.stop(); }
});

test('profile and settings routes validate their input', async () => {
    const s = start();
    try {
        assert.equal((await call(s, 'POST', 'profiles', {source: 'Bad Name!'})).code, 400);
        assert.equal((await call(s, 'POST', 'profiles', {source: 'ok-one', key: 'short'})).code, 400);
        assert.equal((await call(s, 'POST', 'profiles', {source: 'ok-one'})).code, 200);
        assert.equal((await call(s, 'POST', 'profiles', {source: 'ok-one', delete: true})).json.deleted, 'ok-one');
        const st = await call(s, 'POST', 'settings', {quiet: {enabled: true, from: '23:00', to: '06:00', allow: 'warn'}, groupSeconds: 120});
        assert.deepEqual(st.json.settings.quiet, {enabled: true, from: '23:00', to: '06:00', allow: 'warn'});
        assert.equal(st.json.settings.groupSeconds, 120);
        assert.equal((await call(s, 'GET', 'settings')).json.settings.groupSeconds, 120);
    } finally { if (s.stop) s.stop(); }
});

test('quiet hours record a notification without queuing it', async () => {
    const s = start();
    try {
        await call(s, 'POST', 'settings', {quiet: {enabled: true, from: '00:00', to: '23:59', allow: 'alert'}});
        const r = await call(s, 'POST', 'notify', {message: 'shh', level: 'info'});
        if (new Date().getHours() === 23 && new Date().getMinutes() === 59) return;   // the one minute outside the window
        assert.equal(r.json.suppressed, 'quiet hours');
        assert.equal((await queued(s)).length, 0);
        const rec = (await call(s, 'GET', 'recent')).json.recent[0];
        assert.equal(rec.suppressed, true);
        const loud = await call(s, 'POST', 'notify', {message: 'fire', level: 'alert'});
        assert.equal(loud.json.suppressed, undefined, 'an alert still gets through');
        assert.equal((await queued(s)).length, 1);
    } finally { if (s.stop) s.stop(); }
});

test('repeats inside the grouping window are counted, not shown again', async () => {
    const s = start();
    try {
        const a = await call(s, 'POST', 'notify', {title: 'Goal', message: 'Sporting 1-0'});
        const b = await call(s, 'POST', 'notify', {title: 'Goal', message: 'Sporting 1-0'});
        const c = await call(s, 'POST', 'notify', {title: 'Goal', message: 'Sporting 2-0'});
        assert.equal(b.json.merged, true);
        assert.equal(b.json.count, 2);
        assert.equal(b.json.id, a.json.id);
        assert.equal(c.json.merged, undefined, 'a different message is a new notification');
        assert.equal((await queued(s)).length, 2);
        assert.equal((await call(s, 'GET', 'recent')).json.recent.filter(r => r.id === a.json.id)[0].count, 2);
        await call(s, 'POST', 'settings', {groupSeconds: 0});
        const d = await call(s, 'POST', 'notify', {title: 'Goal', message: 'Sporting 2-0'});
        assert.equal(d.json.merged, undefined, 'grouping can be turned off');
    } finally { if (s.stop) s.stop(); }
});

test('a webhook turns any JSON into a notification through its templates', async () => {
    const s = start();
    try {
        assert.equal((await call(s, 'POST', 'hook/github', {a: 1})).code, 404, 'unknown hook');
        const made = await call(s, 'POST', 'hooks', {name: 'github', title: '{{repository.name}}', message: '{{pusher.name}} pushed {{commits.0.message}}', level: 'ok', icon: '\u{1F4E6}'});
        assert.equal(made.code, 200);
        assert.equal(made.json.url, 'hook/github');
        const r = await call(s, 'POST', 'hook/github', {repository: {name: 'tv-notification-center'}, pusher: {name: 'ana'}, commits: [{message: 'Fix banner'}]});
        assert.equal(r.code, 200);
        const n = (await queued(s))[0];
        assert.equal(n.title, 'tv-notification-center');
        assert.equal(n.message, 'ana pushed Fix banner');
        assert.equal(n.level, 'ok');
        assert.equal(n.icon, '\u{1F4E6}');
        assert.equal((await call(s, 'POST', 'hooks', {name: 'bad name', message: 'x'})).code, 400);
        assert.equal((await call(s, 'POST', 'hooks', {name: 'nomsg'})).code, 400);
        assert.equal((await call(s, 'POST', 'hooks', {name: 'github', delete: true})).json.deleted, 'github');
    } finally { if (s.stop) s.stop(); }
});

test('a webhook uses its name as the source, so that source\'s key protects it', async () => {
    const s = start();
    try {
        await call(s, 'POST', 'hooks', {name: 'ha', message: '{{text}}'});
        await call(s, 'POST', 'profiles', {source: 'ha', key: 'ha-secret-key-1'});
        assert.equal((await call(s, 'POST', 'hook/ha', 'plain text body')).code, 403);
        const r = await call(s, 'POST', 'hook/ha', 'plain text body', {'x-nc-key': 'ha-secret-key-1'});
        assert.equal(r.code, 200);
        assert.equal((await queued(s))[0].message, 'plain text body');
    } finally { if (s.stop) s.stop(); }
});
