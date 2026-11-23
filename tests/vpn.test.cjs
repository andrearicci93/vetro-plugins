'use strict';
// The vpn Shard's side of the review of nordtv 1.1.2 (vetro-plugins#13), against a fake root agent: the install runs
// one at a time and never next to another change, it is retried while the pinned binary is missing, a start without
// what the provider needs never takes a tunnel down, and an `up` still connecting is left alone. The shell scripts
// themselves ran on the TV (see the Shard README, "Tested").
const { test } = require('node:test'), assert = require('node:assert/strict');
const vpn = require('../plugins/vpn/index.js');

const SHA = vpn.BINARY.sha256;
const decode = cmd => { const m = /^echo (\S+) \| base64 -d \| sh$/.exec(cmd); assert.ok(m, 'commands are wrapped in base64'); return Buffer.from(m[1], 'base64').toString(); };
const state = o => JSON.stringify(Object.assign({ provider: 'nordvpn', profile: '', profiles: [], ready: true, running: false, connecting: false, country: 'IT', killswitch: true, enabled: true, autostart: true, hasToken: true }, o));

// A fake agent: `answer(script)` gives stdout for each decoded script; every script is recorded, with a way to hold
// one until the test lets it go.
function agent(answer) {
    const seen = [];
    const execute = cmd => { const script = decode(cmd); seen.push(script); return Promise.resolve(answer(script)).then(out => ({ exit_code: 0, stdout: out || '', stderr: '' })); };
    return { seen, execute };
}
const isInstall = s => s.includes('curl -fsSL');
const isState = s => / state$| status -json$/.test(s);

test('install: a download of its own (mktemp), checked and unpacked from that same file; no fixed .part', () => {
    const s = vpn.installScript(vpn.BINARY);
    assert.ok(!/\.part/.test(s));
    assert.match(s, /gz=\$\(mktemp \/opt\/nordtv\/nordtv\.gz\.XXXXXX\)/);
    assert.match(s, /curl -fsSL --max-time 90 -o "\$gz" /);
    assert.match(s, /sha256sum < "\$gz"/);
    assert.match(s, /gunzip -c < "\$gz" > "\$new" && chmod 700 "\$new" && mv -f "\$new" \/opt\/nordtv\/nordtv/);
    assert.match(s, /trap 'rm -f "\$gz" "\$new"' EXIT/);
});

test('staging: the binary is never made 0600, and the run folder must be root\'s own', () => {
    assert.match(vpn.STAGE, /case "\$f" in \/opt\/nordtv\/nordtv\|\/opt\/nordtv\/nordtv\.new\*\) ;;/);
    assert.match(vpn.STAGE, /\[ -L \/dev\/shm\/nordtv\.d \] \|\| \[ ! -d \/dev\/shm\/nordtv\.d \] \|\| \[ "\$\(stat -c %u \/dev\/shm\/nordtv\.d\)" != 0 \]; then rm -rf \/dev\/shm\/nordtv\.d; mkdir -m 700 /);
    assert.ok(!/\/dev\/shm\/nordtv\.new/.test(vpn.STAGE), 'no fixed file in /dev/shm itself');
    assert.equal(vpn.RUN, '/dev/shm/nordtv.d/nordtv');
});

test('install: a second call while one runs waits for it; other changes are refused meanwhile', async () => {
    let release;
    const hold = new Promise(r => { release = r; });
    const a = agent(s => isInstall(s) ? hold.then(() => '__INSTALLED__') : isState(s) ? '__SOURCE_' + SHA + '__\n' + state() : '');
    const v = new vpn.Vpn(a.execute);
    const first = v.install(), second = v.install();
    assert.equal(first, second);
    await assert.rejects(v.start({}), /already in progress/);
    await assert.rejects(v.reset(), /already in progress/);
    release();
    assert.equal((await first).result, 'installed');
    assert.equal(a.seen.filter(isInstall).length, 1);
    assert.equal(v.needInstall, false);
});

test('install retried from the timer while it fails, at most every 2 minutes; update pending is shown', async () => {
    let src = 'a7f033196957c03ae867ce5d4791b8590ac9cf024b15fcf4392abe9e30622af3'; // nordtv 1.0.0, from the nordvpn Shard
    const a = agent(s => isInstall(s) ? '__DOWNLOAD_FAILED__' : isState(s) ? '__SOURCE_' + src + '__\n' + state() : '');
    const v = new vpn.Vpn(a.execute);
    assert.equal((await v.maybeInstall()).result, 'download-failed');
    assert.equal(await v.maybeInstall(), null, 'not again within 2 minutes');
    const s = await v.read(false);
    assert.equal(s.updatePending, true);
    v.lastInstall.at -= 121000;
    assert.equal((await v.maybeInstall()).result, 'download-failed');
    assert.equal(a.seen.filter(isInstall).length, 2);
    src = SHA;
    assert.equal((await v.read(false)).updatePending, false);
    v.lastInstall.at -= 121000;
    assert.equal(await v.maybeInstall(), null, 'nothing to do once the pinned binary is there');
});

test('NordVPN without a token: refused before anything is stopped', async () => {
    const a = agent(s => isState(s) ? '__SOURCE_' + SHA + '__\n' + state({ running: true, provider: 'wireguard', profile: 'home', profiles: [{ name: 'home', allowedIps: ['0.0.0.0/0'], dns: [] }], hasToken: false }) : '');
    const v = new vpn.Vpn(a.execute);
    await assert.rejects(v.configure({ provider: 'nordvpn' }), /token/);
    await assert.rejects(v.start({ provider: 'nordvpn' }), /token/);
    assert.ok(!a.seen.some(s => / start\b| stop\b| down\b/.test(s)), 'no start, stop or down was sent');
});

test('supervise leaves an `up` that is still connecting alone', async () => {
    const a = agent(s => isState(s) ? '__SOURCE_' + SHA + '__\n' + state({ connecting: true, pid: 4242 }) : '');
    const v = new vpn.Vpn(a.execute);
    assert.deepEqual(await v.supervise(), { started: false });
    assert.ok(!a.seen.some(s => / start\b| down\b/.test(s) || s.includes('NORDTV_DNS')), 'no start and no leftover cleanup');
});

test('the leftover check recognises a starting `up` of this and of older versions', () => {
    assert.match(vpn.LEFTOVER, /grep -q -e "\^\/dev\/shm\/nordtv\.d\/nordtv up" -e "\^\/dev\/shm\/nordtv up"/);
});
