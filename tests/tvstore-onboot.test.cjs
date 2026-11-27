'use strict';
// The tvstore-onboot Shard: its real index.js and tv.sh, run with sh against a stand-in for the TV's sqlite3 (a script that keeps
// the flag of each "database" in a file; TVSTORE_ONBOOT_DBS points tv.sh at them) and for ctx.execute. None of this was tried on a TV.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const cp = require('child_process');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'tvstore-onboot');
const shard = require(path.join(PLUGIN, 'index.js'));
Object.assign(shard.TIMES, { first: 20, retry: 20, again: 150, command: 5000 });

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tvstore-onboot-')));
const bin = path.join(dir, 'bin'), WRITES = path.join(dir, 'writes'), WRONG = path.join(dir, 'wrong');
fs.mkdirSync(bin);
// sqlite3 <options> <db> <sql>: the flag is the text of the file; an empty file lists no TV-Store. Anything about another app is refused.
fs.writeFileSync(path.join(bin, 'sqlite3'), `#!/bin/sh
for a in "$@"; do db="$sql"; sql="$a"; done
case "$sql" in
  *"app_id='A2STVStore.sdbservice'"*) ;;
  *) echo "another app: $sql" >> "${WRONG}"; exit 1 ;;
esac
case "$sql" in
  SELECT\\ app_onboot\\ FROM*) cat "$db" ;;
  *"UPDATE package_app_info SET app_onboot='true' WHERE"*) echo "$db" >> "${WRITES}"; [ -f "$db.stuck" ] && exit 1; printf true > "$db" ;;
  *) echo "unknown: $sql" >> "${WRONG}"; exit 1 ;;
esac
`);
fs.chmodSync(path.join(bin, 'sqlite3'), 0o755);

let n = 0;
const db = text => { const f = path.join(dir, 'db' + (++n)); fs.writeFileSync(f, text); return f; };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
const writes = () => read(WRITES).split('\n').filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what) { const t0 = Date.now(); while (!check()) { if (Date.now() - t0 > 15000) assert.fail(what); await sleep(10); } }

// One Shard on these databases. down: how many times the TV agent is not connected yet.
function run(dbs, down) {
  const calls = [], modes = [];
  const ctx = { id: 'tvstore-onboot', dir: PLUGIN, config: { get: () => ({}), set() {} }, execute(cmd, ms) {
    calls.push(cmd); modes.push(/ tvstore-onboot (set|check)$/.exec(cmd)[1]);
    assert.ok(ms > 0, 'every command has a timeout');
    if (down && down-- > 0) return Promise.reject(new Error('The TV agent is not connected'));
    return new Promise((resolve, reject) => cp.execFile('sh', ['-c', cmd], { env: { PATH: bin + ':' + process.env.PATH, TVSTORE_ONBOOT_DBS: dbs.join(' ') } },
      (err, stdout) => err ? reject(err) : resolve({ stdout, exit_code: 0 })));
  } };
  const s = shard(ctx);
  s.start();
  return { shard: s, calls, modes };
}

test('a flag that is off is turned on once, in the list that has TV-Store, and left alone at the next look', async () => {
  const global = db(''), user = db('false'), r = run([path.join(dir, 'none'), global, user]);
  assert.equal(r.shard.status().result, 'starting');
  await until(() => r.shard.status().result === 'set', 'the flag is set');
  assert.equal(read(user), 'true');
  assert.equal(read(global), '');
  const st = r.shard.status();
  assert.ok(st.setAt && !st.error && /next start of the TV/.test(st.text), JSON.stringify(st));
  await until(() => r.shard.status().result === 'kept', 'the next look');
  assert.deepEqual(writes(), [user]);
  assert.equal(r.shard.status().setAt, st.setAt);
  r.shard.stop();
  const c = r.calls.length;
  await sleep(400);
  assert.equal(r.calls.length, c, 'nothing after stop()');
});

test('a flag that is on is not written', async () => {
  const before = writes().length, r = run([db('true')]);
  await until(() => r.shard.status().result === 'kept', 'kept');
  r.shard.stop();
  assert.equal(writes().length, before);
});

test('TV-Store is not on the TV', async () => {
  const before = writes().length, r = run([db(''), path.join(dir, 'none')]);
  await until(() => r.shard.status().result === 'absent', 'absent');
  r.shard.stop();
  assert.equal(writes().length, before);
});

test('a flag that will not turn on: three tries, then it only reads', async () => {
  const f = db('false'), before = writes().length;
  fs.writeFileSync(f + '.stuck', '');
  const r = run([f]);
  await until(() => r.shard.status().result === 'off' && r.modes.length >= 5, 'it only reads');
  r.shard.stop();
  assert.equal(writes().length - before, 3);
  assert.equal(r.modes.slice(0, 5).join(' '), 'set set set check check');
  assert.equal(read(f), 'false');
});

test('the TV agent is not connected yet: waited for', async () => {
  const f = db('false'), r = run([f], 2);
  await until(() => !!r.shard.status().error, 'an error is kept meanwhile');
  await until(() => r.shard.status().result === 'set', 'set once the agent is there');
  r.shard.stop();
  assert.equal(r.calls.length, 3);
  assert.equal(r.shard.status().error, null);
});

test('no command was about anything but the flag of TV-Store’s service', () => {
  assert.equal(read(WRONG), '');
});
