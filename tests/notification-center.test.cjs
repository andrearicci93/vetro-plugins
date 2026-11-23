'use strict';
// Behaviour tests for the notification-center Shard: request validation, icon cutting, queue, ntfy and the self-description.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const {EventEmitter} = require('events');

const folder = path.join(__dirname, '../plugins/notification-center');
const create = require(path.join(folder, 'index.js'));

function start() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-test-'));
    let config = {};
    const ctx = {
        id: 'notification-center', dir,
        config: {get: () => JSON.parse(JSON.stringify(config)), set: v => { config = JSON.parse(JSON.stringify(v)); }},
        execute: () => Promise.reject(new Error('exec was not declared')), queueFile: path.join(dir, 'queue.json')
    };
    const shard = create(ctx);
    if (shard.start) shard.start();
    return shard;
}

// Calls shard.route() like Vetro does and resolves with {code, headers, body}.
function call(shard, method, sub, body, headers) {
    return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = method; req.url = '/' + sub; req.headers = headers || {};
        req.destroy = () => {};
        const res = {
            writeHead(code, h) { this.code = code; this.headers = h || {}; },
            end(text) { resolve({code: this.code, headers: this.headers, body: text}); }
        };
        const handled = shard.route(req, res, sub);
        if (!handled) return reject(new Error('route not handled: ' + method + ' ' + sub));
        setImmediate(() => { if (body != null) req.emit('data', typeof body === 'string' ? body : JSON.stringify(body)); req.emit('end'); });
    });
}
const json = r => JSON.parse(r.body);

test('notify rejects invalid JSON and a missing message', async () => {
    const s = start();
    try {
        assert.equal((await call(s, 'POST', 'notify', '{nope')).code, 400);
        const r = await call(s, 'POST', 'notify', {title: 'only a title'});
        assert.equal(r.code, 400);
        assert.match(json(r).error, /message/);
    } finally { if (s.stop) s.stop(); }
});

test('notify queues a notification that GET notifications returns', async () => {
    const s = start();
    try {
        const r = await call(s, 'POST', 'notify', {title: 'Oven', message: 'Dinner is ready', level: 'ok'});
        assert.ok(r.code >= 200 && r.code < 300, 'status ' + r.code);
        const list = json(await call(s, 'GET', 'notifications'));
        assert.equal(list.notifications.length, 1);
        assert.equal(list.notifications[0].title, 'Oven');
        assert.equal(list.notifications[0].message, 'Dinner is ready');
        assert.equal(list.notifications[0].level, 'ok');
    } finally { if (s.stop) s.stop(); }
});

test('control characters never reach the stored text', async () => {
    const s = start();
    try {
        await call(s, 'POST', 'notify', {title: 'a\u0000b\u001fc', message: 'line1\nline2'});
        const n = json(await call(s, 'GET', 'notifications')).notifications[0];
        assert.doesNotMatch(n.title + n.message, /[\u0000-\u001f]/);
    } finally { if (s.stop) s.stop(); }
});

test('icons are cut between whole emoji, never inside one', async () => {
    const s = start();
    try {
        const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'; // one emoji made of 4 people joined
        await call(s, 'POST', 'notify', {message: 'x', icon: family + family + family});
        const icon = json(await call(s, 'GET', 'notifications')).notifications[0].icon;
        assert.ok(icon.length <= 16, 'icon is capped');
        assert.doesNotMatch(icon, /[\uD800-\uDBFF]$/, 'no lone high surrogate at the end');
        assert.doesNotMatch(icon, /[‍️]$/, 'no dangling joiner at the end');
    } finally { if (s.stop) s.stop(); }
});

test('ntfy route accepts plain text with a Title header', async () => {
    const s = start();
    try {
        const r = await call(s, 'POST', 'ntfy', 'Backup finished', {title: 'NAS', Title: 'NAS'});
        assert.ok(r.code >= 200 && r.code < 300, 'status ' + r.code);
        const n = json(await call(s, 'GET', 'notifications')).notifications[0];
        assert.equal(n.message, 'Backup finished');
    } finally { if (s.stop) s.stop(); }
});

test('GET api describes the API from the validating code', async () => {
    const s = start();
    try {
        const r = await call(s, 'GET', 'api');
        assert.equal(r.code, 200);
        const d = json(r);
        assert.ok(d && typeof d === 'object' && Object.keys(d).length > 0);
        assert.match(r.body, /notify/);
    } finally { if (s.stop) s.stop(); }
});

test('unknown routes are left to Vetro', () => {
    const s = start();
    try {
        const req = new EventEmitter(); req.method = 'GET'; req.url = '/nope'; req.headers = {};
        assert.ok(!s.route(req, {writeHead() {}, end() {}}, 'nope'));
    } finally { if (s.stop) s.stop(); }
});
