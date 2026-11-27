'use strict';
// Catalog-side contract checks for the NEWS Shard. The full 23 mocked tests live in the Shard's
// repository; these few run in the catalog CI so a bad update cannot be published unnoticed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const DIR = path.join(__dirname, '..', 'plugins', 'match-alerts');
const factory = require(path.join(DIR, 'index.js'));

function make() {
  const store = { modules: { sport: false, weather: false, news: false }, civ: { enabled: false } };
  return factory({ id: 'match-alerts', dir: DIR, config: { get: () => store, set: s => { store = s; } } });
}
function get(shard, sub) {
  return new Promise(resolve => {
    const res = { writeHead() {}, end(body) { resolve(JSON.parse(body)); } };
    shard.route({ method: 'GET', url: '/plugins/match-alerts/api/' + sub, on() {} }, res, sub);
  });
}

test('NEWS starts, reports status and stops cleanly', () => {
  const shard = make();
  assert.equal(typeof shard.start, 'function');
  assert.equal(typeof shard.stop, 'function');
  assert.equal(typeof shard.card, 'function');
  assert.equal(typeof shard.cardSelect, 'function');
  shard.start();
  assert.ok(shard.status());
  const card = shard.card();
  assert.ok(card.rows.length <= 7);
  shard.stop();
});

test('/api/last is public and never carries config or keys', async () => {
  const shard = make();
  shard.start();
  const last = await get(shard, 'last');
  assert.equal(last.version, require(path.join(DIR, 'manifest.json')).version);
  assert.ok(last.at > 0);
  assert.equal(last.config, undefined);
  assert.equal(last.keys, undefined);
  assert.equal(last.hasKey, undefined);
  shard.stop();
});
