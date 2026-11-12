'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../plugins/eightbitdo-guide/index.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const {verifyPayload} = require('../scripts/build-eightbitdo-guide-helper.cjs');
const zlib = require('zlib');

test('helper verification compares SHA-256 of the decoded DLL and rejects changed code', () => {
    const rebuilt = Buffer.from('managed helper fixture');
    for (const level of [1, 9]) {
        const hashes = verifyPayload(rebuilt, zlib.gzipSync(rebuilt, {level}).toString('base64'));
        assert.equal(hashes.rebuiltSha256, hashes.embeddedSha256);
        assert.match(hashes.rebuiltSha256, /^[a-f0-9]{64}$/);
    }
    assert.throws(() => verifyPayload(rebuilt, zlib.gzipSync(Buffer.from('different DLL')).toString('base64')), /SHA-256 mismatch/);
});

function fixture(options = {}) {
    const calls = [], intervals = new Map();
    let next = 0;
    const context = {
        module: {exports: {}}, Buffer, Promise,
        __dirname: '/installed-shard',
        require(name) {
            if (name === 'path') return path;
            if (name === 'fs') return {
                existsSync() {return !!options.stateLink;},
                mkdirSync(file, mode) {assert.equal(file, "/work dir/owner's shard/runtime"); assert.equal(mode, 448);},
                lstatSync() {return {isDirectory: () => true, isSymbolicLink: () => !!options.stateLink};},
                readFileSync(file) {
                assert.equal(file, '/installed-shard/guide-bridge.dll.gz.b64');
                if (options.assetError) throw Error('asset missing');
                return 'aGVscGVy';
            }};
            throw Error('Unexpected module ' + name);
        },
        setInterval(fn) {const id = ++next; intervals.set(id, fn); return id;},
        clearInterval(id) {intervals.delete(id);}
    };
    vm.runInNewContext(source, context);
    const plugin = context.module.exports({
        dir: "/work dir/owner's shard",
        execute(command, timeout) {
            calls.push({command, timeout});
            return options.execute ? options.execute(command, calls.length) : Promise.resolve({exit_code: 0, stdout: '{"running":true,"connected":true}', stderr: ''});
        }
    });
    return {plugin, calls, intervals, tick() {for (const fn of intervals.values()) fn();}};
}

test('Guide Shard starts only on enable, quotes its work path, and releases its timer', async () => {
    const f = fixture();
    assert.equal(f.calls.length, 0);
    f.plugin.start(); f.plugin.start();
    assert.equal(f.intervals.size, 1);
    await flush();
    assert.equal(f.calls.length, 1);
    const script = Buffer.from(f.calls[0].command.split(' ')[1], 'base64').toString();
    assert.match(script, /--self-test/);
    assert.match(script, /--check-platform/);
    assert.match(script, /--state-dir/);
    assert.match(script, /--status/);
    assert(!script.includes('/tmp/'), 'root commands do not use globally writable temporary paths');
    assert.match(script, /systemd-run --unit=vetro-8bitdo-guide/);
    assert(script.includes("'/work dir/owner'\\''s shard/guide-bridge.dll'"));
    assert.equal(f.calls[0].timeout, 10000);
    assert.equal(f.plugin.status().connected, true);
    await f.plugin.stop();
    assert.equal(f.intervals.size, 0);
    assert.match(f.calls.at(-1).command, /systemctl stop vetro-8bitdo-guide\.service/);
    assert.equal(f.plugin.status().running, false);
});

test('Guide Shard handles missing assets and root unavailability inside callbacks', async () => {
    const linked = fixture({stateLink: true});
    linked.plugin.start();
    assert.match(linked.plugin.status().lastResult, /Unsafe runtime directory/);
    assert.equal(linked.calls.length, 0);
    await linked.plugin.stop();
    const missing = fixture({assetError: true});
    assert.doesNotThrow(() => missing.plugin.start());
    assert.doesNotThrow(() => missing.tick());
    assert.match(missing.plugin.status().lastResult, /asset missing/);
    assert.equal(missing.calls.length, 0);
    await missing.plugin.stop();
    const unavailable = fixture({execute() {throw Error('no root agent');}});
    unavailable.plugin.start(); await flush();
    assert.match(unavailable.plugin.status().lastResult, /no root agent/);
    unavailable.tick(); await flush();
    assert.equal(unavailable.calls.length, 2, 'root can be retried after boot');
    await unavailable.plugin.stop();
    assert.equal(unavailable.intervals.size, 0);
});

test('Guide Shard does not overlap starts or publish stale status after stop', async () => {
    let resolveStart;
    const f = fixture({execute(command, count) {
        if (count === 1) return new Promise(resolve => {resolveStart = resolve;});
        return Promise.resolve({exit_code: 0, stdout: '{}'});
    }});
    f.plugin.start(); await flush();
    f.tick(); f.tick();
    assert.equal(f.calls.length, 1);
    await f.plugin.stop();
    resolveStart({exit_code: 0, stdout: '{"running":true,"connected":true}'});
    await flush();
    assert.equal(f.plugin.status().running, false);
    assert.equal(f.intervals.size, 0);
    assert(f.calls.slice(1).every(call => /systemctl stop/.test(call.command)), 'a late start is stopped');
    f.plugin.start(); await flush();
    assert.equal(f.intervals.size, 1);
    await f.plugin.stop();
});
