'use strict';
// Tests for the companion app's background service (app/service.js) and the consistency of the app files.
// The service runs in the TV's web service runtime, so it is loaded here in a sandbox with fake `require`, `webapis` and `fetch`.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');

const appDir = path.join(__dirname, '../plugins/notification-center/app');
const source = fs.readFileSync(path.join(appDir, 'service.js'), 'utf8');

function sandbox(opts = {}) {
    const files = Object.assign({}, opts.files);
    const banners = [], fetched = [];
    const fsFake = {
        readFileSync(f) { if (!(f in files)) throw new Error('ENOENT ' + f); return files[f]; },
        writeFileSync(f, text) { files[f] = String(text); }
    };
    const osFake = {networkInterfaces: () => opts.interfaces || {eth0: [{family: 'IPv4', internal: false, address: '192.168.1.50'}, {family: 'IPv4', internal: true, address: '127.0.0.1'}]}};
    const context = {
        module: {exports: {}}, Date, JSON, Object, Array, parseInt, Promise, setTimeout,
        require: name => { if (name === 'fs') return fsFake; if (name === 'os') return osFake; throw new Error('unexpected require ' + name); },
        webapis: {postPlainNotification(title, message, seconds) { banners.push({title, message, seconds}); }},
        fetch: url => { fetched.push(url); return opts.fetch ? opts.fetch(url) : Promise.reject(new Error('offline')); }
    };
    context.exports = context.module.exports;
    vm.runInNewContext(source, context, {filename: 'service.js'});
    return {service: context.module.exports, banners, fetched, files};
}
const QUEUE = '/tmp/notification-center-queue.json', SEEN = '/tmp/notification-center-seen.json';
const queue = notes => JSON.stringify({notifications: notes});
const flush = () => new Promise(resolve => setImmediate(resolve));

test('service exports the three lifecycle hooks', () => {
    const {service} = sandbox();
    for (const k of ['onStart', 'onRequest', 'onStop']) assert.equal(typeof service[k], 'function', k);
});

test('a banner notification becomes a native banner with the level emoji and the duration', () => {
    const {service, banners} = sandbox({files: {[QUEUE]: queue([{id: '1', title: 'Oven', message: 'Dinner is ready', mode: 'banner', level: 'ok', duration: 12}])}});
    service.onStart();
    assert.deepEqual(banners, [{title: '✅ Oven', message: 'Dinner is ready', seconds: 12}]);
});

test('a custom icon replaces the level emoji, and a missing title gets a default', () => {
    const {service, banners} = sandbox({files: {[QUEUE]: queue([{id: '1', message: 'hi', mode: 'banner', level: 'info', icon: '\u{1F389}'}])}});
    service.onStart();
    assert.equal(banners[0].title, '\u{1F389} Notification');
    assert.equal(banners[0].seconds, 8, 'default duration');
});

test('the same id is never shown twice, even after a restart (ids are kept in a file)', () => {
    const first = sandbox({files: {[QUEUE]: queue([{id: 'a', message: 'one', mode: 'banner'}])}});
    first.service.onStart(); first.service.onRequest();
    assert.equal(first.banners.length, 1);
    assert.ok(JSON.parse(first.files[SEEN]).a, 'seen id saved');
    const second = sandbox({files: {[QUEUE]: first.files[QUEUE], [SEEN]: first.files[SEEN]}});
    second.service.onStart();
    assert.equal(second.banners.length, 0, 'restarted service shows nothing again');
});

test('full-screen notifications are marked seen but left to the app screen', () => {
    const {service, banners, files} = sandbox({files: {[QUEUE]: queue([{id: 'f', message: 'card', mode: 'full'}, {id: 'b', message: 'both', mode: 'both'}])}});
    service.onStart();
    assert.equal(banners.length, 0);
    assert.ok(JSON.parse(files[SEEN]).f);
});

test('expired notifications are not shown', () => {
    const {service, banners} = sandbox({files: {[QUEUE]: queue([{id: 'old', message: 'late', mode: 'banner', expires: Date.now() - 1000}, {id: 'new', message: 'fresh', mode: 'banner', expires: Date.now() + 60000}])}});
    service.onStart();
    assert.deepEqual(banners.map(b => b.message), ['fresh']);
});

test('the seen list is capped at 60 ids', () => {
    const notes = Array.from({length: 80}, (_, i) => ({id: 'n' + i, message: 'm', mode: 'full'}));
    const {service, files} = sandbox({files: {[QUEUE]: queue(notes)}});
    service.onStart();
    assert.equal(Object.keys(JSON.parse(files[SEEN])).length, 60);
});

test('without the queue file it asks the Shard on the loopback and then the LAN address', async () => {
    const {service, banners, fetched} = sandbox({fetch: url => url.startsWith('http://192.168.1.50') ? Promise.resolve({ok: true, json: () => Promise.resolve({notifications: [{id: 'net', message: 'over LAN', mode: 'banner'}]})}) : Promise.reject(new Error('EHOSTUNREACH'))});
    service.onStart();
    for (let i = 0; i < 6; i++) await flush();
    assert.match(fetched[0], /^http:\/\/127\.0\.0\.1:8099\/plugins\/notification-center\/api\/notifications/);
    assert.match(fetched[1], /^http:\/\/192\.168\.1\.50:8099\//);
    assert.deepEqual(banners.map(b => b.message), ['over LAN']);
});

test('a broken queue file or a missing webapis never throws', () => {
    const {service} = sandbox({files: {[QUEUE]: '{not json'}});
    assert.doesNotThrow(() => service.onStart());
    const ctx = sandbox({files: {[QUEUE]: queue([{id: 'x', message: 'm', mode: 'banner'}])}});
    assert.doesNotThrow(() => ctx.service.onRequest());
});

test('app files agree: ids, privileges, service entry and loader target', () => {
    const xml = fs.readFileSync(path.join(appDir, 'config.xml'), 'utf8');
    assert.match(xml, /<tizen:application id="NotifCtr01\.NotifCenter"/);
    assert.match(xml, /<tizen:service id="NotifCtr01\.Svc"/);
    assert.match(xml, /privilege\/notification"/);
    assert.match(xml, /privilege\/internet"/);
    assert.match(xml, /<tizen:content src="service\.js"\/>/);
    assert.ok(fs.existsSync(path.join(appDir, 'service.js')));
    const loader = fs.readFileSync(path.join(appDir, 'js/app.js'), 'utf8');
    assert.match(loader, /\/plugins\/notification-center\/api\/nt\.js/);
    const shard = fs.readFileSync(path.join(appDir, '../index.js'), 'utf8');
    assert.match(shard, /NotifCtr01\.NotifCenter/);
    assert.match(shard, /NotifCtr01\.Svc/);
});
