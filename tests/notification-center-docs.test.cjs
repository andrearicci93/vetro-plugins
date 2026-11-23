'use strict';
// Keeps the documentation in step with the code: GET api (built from the validating code), API.md, CHANGELOG.md and manifest.json.
// A new field, route or version that is not documented in all of them fails here.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const {EventEmitter} = require('events');

const folder = path.join(__dirname, '../plugins/notification-center');
const read = f => fs.readFileSync(path.join(folder, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const apiMd = read('API.md');
const changelog = read('CHANGELOG.md');
const readme = read('README.md');

function describeApi() {
    let config = {};
    const shard = require(path.join(folder, 'index.js'))({
        id: 'notification-center', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nc-docs-')),
        config: {get: () => config, set: v => { config = v; }}, execute: () => Promise.reject(new Error('no exec')), queueFile: path.join(os.tmpdir(), 'nc-q-docs-' + process.pid + '.json')
    });
    let out;
    const req = new EventEmitter(); req.method = 'GET'; req.url = '/api'; req.headers = {};
    shard.route(req, {writeHead() {}, end(text) { out = JSON.parse(text); }}, 'api');
    if (shard.stop) shard.stop();
    return out;
}
const api = describeApi();

test('GET api reports the manifest version, and the CHANGELOG has an entry for it', () => {
    assert.equal(api.version, manifest.version);
    assert.match(changelog, new RegExp('^## ' + manifest.version.replace(/\./g, '\\.') + '\\b', 'm'), 'CHANGELOG.md needs a "## ' + manifest.version + '" section');
});

test('every field GET api lists is documented in API.md', () => {
    for (const name of Object.keys(api.fields)) assert.ok(apiMd.includes('`' + name + '`'), 'API.md does not mention field `' + name + '`');
});

test('every route GET api lists is documented in API.md', () => {
    for (const e of api.endpoints) assert.ok(apiMd.includes('`' + e.method + ' ' + e.path), 'API.md does not document ' + e.method + ' ' + e.path);
});

test('every enum value GET api lists is documented in API.md', () => {
    for (const [name, values] of Object.entries(api.enums || {})) for (const v of values) assert.ok(apiMd.includes(String(v)), 'API.md does not mention ' + name + ' value ' + v);
});

test('the README points at API.md and the CHANGELOG', () => {
    assert.match(readme, /\(API\.md\)/);
    assert.match(readme, /\(CHANGELOG\.md\)/);
});
