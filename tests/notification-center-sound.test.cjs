'use strict';
// Sounds: a notification can ask for one of the TV's system sounds. The Shard has `exec` for exactly one command shape; a fake ctx.execute records
// every command, so these tests also prove that nothing from a request can reach it.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const {EventEmitter} = require('events');

const folder = path.join(__dirname, '../plugins/notification-center');
const create = require(path.join(folder, 'index.js'));
const rules = require(path.join(folder, 'rules.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SHAPE = /^paplay --volume=\d{1,6} \/usr\/share\/feedback\/sound\/operation\/[a-z_]+\.wav$/;
const DIR = '/usr/share/feedback/sound/operation/';

function start(options = {}) {
    let config = options.seed || {};
    const commands = [];
    const ctx = {
        id: 'notification-center', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sound-')),
        config: {get: () => JSON.parse(JSON.stringify(config)), set: v => { config = JSON.parse(JSON.stringify(v)); }},
        queueFile: path.join(os.tmpdir(), 'nc-q-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json'),
        sound: {gapMs: options.gapMs === undefined ? 0 : options.gapMs, waitMs: options.waitMs === undefined ? 0 : options.waitMs, seenFile: options.seenFile, songScale: options.songScale === undefined ? 0.01 : options.songScale}
    };
    if (options.execute !== null) {
        ctx.execute = cmd => {
            commands.push(cmd);
            if (options.execute) return options.execute(cmd);
            return Promise.resolve({exit_code: 0, stdout: '', stderr: ''});
        };
    }
    const shard = create(ctx);
    if (shard.start) shard.start();
    return {shard, commands};
}
function call(shard, method, sub, body, headers) {
    return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = method; req.url = '/' + sub; req.headers = headers || {}; req.destroy = () => {};
        const res = {writeHead(code) { this.code = code; }, end(text) { let j = null; try { j = JSON.parse(text); } catch (e) { /* not JSON */ } resolve({code: this.code, json: j, text}); }};
        if (!shard.route(req, res, sub)) return reject(new Error('route not handled: ' + method + ' ' + sub));
        setImmediate(() => { if (body != null) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); req.emit('end'); });
    });
}
async function withShard(fn, options) {
    const s = start(options);
    try { await fn(s.shard, s.commands); } finally { if (s.shard.stop) s.shard.stop(); }
}
// paplay volume = the request volume x the sound volume setting x 3 (the system sounds are quiet), of 65536
const vol = (percent, master = 100) => Math.round(65536 * percent / 100 * master / 100 * 3);

test('the manifest asks for exec, and only the sound command uses it', () => {
    assert.deepEqual(manifest.permissions, ['exec']);
});

test('a notification with a sound runs the one fixed command, with the volume and the boost', () => withShard(async (s, commands) => {
    const r = await call(s, 'POST', 'notify', {title: 'Goal', message: 'Sporting 1-0', sound: 'reward', volume: 80});
    assert.equal(r.code, 200);
    assert.equal(r.json.sound, 'requested');
    await wait(50);
    assert.deepEqual(commands, ['paplay --volume=' + vol(80) + ' ' + DIR + 'vi_reward.wav']);
}));

test('without a sound nothing is run (the default is silence)', () => withShard(async (s, commands) => {
    const r = await call(s, 'POST', 'notify', {message: 'quiet one'});
    assert.equal(r.json.sound, 'none');
    await wait(50);
    assert.deepEqual(commands, []);
}));

test('only names from the closed list are accepted; anything else is ignored and never reaches the command', () => withShard(async (s, commands) => {
    for (const bad of ['../../etc/passwd', 'Chime', '__proto__', 'constructor', 'chime; reboot', 'chime $(id)', {toString: 1}, ['chime'], 5, '', null]) {
        const r = await call(s, 'POST', 'notify', {message: 'x' + Math.random(), sound: bad});
        assert.equal(r.code, 200);
        assert.equal(r.json.sound, 'none', JSON.stringify(bad));
        assert.equal((await call(s, 'POST', 'play', {sound: bad})).code, 400, 'play ' + JSON.stringify(bad));
    }
    await wait(50);
    assert.deepEqual(commands, []);
}));

test('every command ever run has exactly the fixed shape, whatever the request sends', () => withShard(async (s, commands) => {
    const hostile = [500, 3, -1, 1e15, 'abc', '80; reboot', '$(id)', {toString: 1}, [1], null, true, NaN, '  60  ', 12.7];
    for (const sound of Object.keys(rules.SOUNDS)) for (const volume of hostile) await call(s, 'POST', 'notify', {message: sound + String(Math.random()), sound, volume});
    for (const volume of hostile) await call(s, 'POST', 'play', {sound: 'chime', volume});
    await call(s, 'POST', 'settings', {soundVolume: '300; reboot', soundDelayMs: {toString: 1}});
    await call(s, 'POST', 'settings', {soundVolume: {toString: 1}});
    await wait(100);
    assert.ok(commands.length > 100, 'many sounds were played: ' + commands.length);
    for (const c of commands) assert.match(c, SHAPE);
}));

test('the volume is clamped to 10-100 (below 10 is the quietest) and defaults to 100 only when missing or not a number', () => withShard(async (s, commands) => {
    for (const volume of [500, 3, {toString: 1}, 50]) await call(s, 'POST', 'notify', {message: 'v' + String(Math.random()), sound: 'chime', volume});
    await wait(80);
    assert.deepEqual(commands.map(c => Number(/--volume=(\d+)/.exec(c)[1])), [vol(100), vol(10), vol(100), vol(50)]);
}));

test('the sound volume is a setting, 10-100 %, default 100, and scales every sound', () => withShard(async (s, commands) => {
    assert.equal((await call(s, 'GET', 'settings')).json.settings.soundVolume, 100);
    assert.equal((await call(s, 'POST', 'settings', {soundVolume: 40})).json.settings.soundVolume, 40);
    assert.equal((await call(s, 'POST', 'settings', {soundVolume: 1000})).json.settings.soundVolume, 100);
    assert.equal((await call(s, 'POST', 'settings', {soundVolume: 3})).json.settings.soundVolume, 10, 'below 10 is raised to 10, never to the maximum');
    await call(s, 'POST', 'settings', {soundVolume: 50});
    assert.equal((await call(s, 'POST', 'settings', {soundVolume: 'x'})).json.settings.soundVolume, 50, 'an invalid value keeps the current one');
    assert.equal((await call(s, 'POST', 'settings', {strict: false})).json.settings.soundVolume, 50, 'other settings keep it');
    await call(s, 'POST', 'notify', {message: 'half', sound: 'alert'});
    await wait(50);
    assert.deepEqual(commands, ['paplay --volume=' + vol(100, 50) + ' ' + DIR + 'vi_fail.wav']);
}));

test('a source can have a default sound and volume, and the request can still choose another', () => withShard(async (s, commands) => {
    await call(s, 'POST', 'profiles', {source: 'match-alerts', sound: 'success', volume: 60});
    assert.equal((await call(s, 'GET', 'profiles')).json.profiles['match-alerts'].sound, 'success');
    await call(s, 'POST', 'notify', {message: 'goal', source: 'match-alerts'});
    await call(s, 'POST', 'notify', {message: 'red card', source: 'match-alerts', sound: 'alert', volume: 90});
    await wait(80);
    assert.deepEqual(commands, ['paplay --volume=' + vol(60) + ' ' + DIR + 'vi_success.wav', 'paplay --volume=' + vol(90) + ' ' + DIR + 'vi_fail.wav']);
    assert.equal((await call(s, 'POST', 'profiles', {source: 'match-alerts', sound: 'nope'})).json.profile.sound, '', 'an unknown sound clears it');
}));

test('webhooks and ntfy can choose a sound too', () => withShard(async (s, commands) => {
    await call(s, 'POST', 'hooks', {name: 'door', message: '{{who}} is at the door', sound: 'open'});
    await call(s, 'POST', 'hook/door', {who: 'Ana'});
    await call(s, 'POST', 'ntfy', 'Backup finished', {sound: 'soft', 'content-type': 'text/plain'});
    await call(s, 'POST', 'ntfy', JSON.stringify({message: 'Disk almost full', sound: 'alert', volume: 70}), {'content-type': 'application/json'});
    await wait(100);
    assert.deepEqual(commands.map(c => /operation\/(.+)\.wav/.exec(c)[1]), ['home_open', 'select', 'vi_fail']);
    assert.equal(Number(/--volume=(\d+)/.exec(commands[2])[1]), vol(70));
}));

test('no sound for a notification that is not shown: quiet hours, a repeat, a wrong key, a rate limit', () => withShard(async (s, commands) => {
    await call(s, 'POST', 'profiles', {source: 'locked', key: 'secret-key-123'});
    assert.equal((await call(s, 'POST', 'notify', {message: 'no key', source: 'locked', sound: 'chime'})).code, 403);
    await call(s, 'POST', 'profiles', {source: 'slow', rate: 1});
    await call(s, 'POST', 'notify', {message: 'first', source: 'slow'});
    assert.equal((await call(s, 'POST', 'notify', {message: 'second', source: 'slow', sound: 'chime'})).code, 429);
    await call(s, 'POST', 'notify', {message: 'same', sound: 'chime'});
    const again = await call(s, 'POST', 'notify', {message: 'same', sound: 'chime'});
    assert.equal(again.json.merged, true);
    assert.equal(again.json.sound, undefined);
    await wait(50);
    assert.equal(commands.length, 1, 'only the first "same" played');

    await call(s, 'POST', 'settings', {quiet: {enabled: true, from: '00:00', to: '23:59', allow: 'alert'}});
    if (new Date().getHours() === 23 && new Date().getMinutes() === 59) return;   // the one minute outside the window
    const quiet = await call(s, 'POST', 'notify', {message: 'shh', sound: 'chime', level: 'info'});
    assert.equal(quiet.json.suppressed, 'quiet hours');
    const loud = await call(s, 'POST', 'notify', {message: 'fire', sound: 'alert', level: 'alert'});
    assert.equal(loud.json.sound, 'requested');
    await wait(50);
    assert.equal(commands.length, 2);
    assert.match(commands[1], /vi_fail\.wav$/);
}));

test('Resend keeps the sound: it is stored with the recent notification', () => withShard(async (s) => {
    await call(s, 'POST', 'notify', {message: 'again', sound: 'chime', volume: 50, open: false});
    const rec = (await call(s, 'GET', 'recent')).json.recent[0];
    assert.equal(rec.sound, 'chime');
    assert.equal(rec.volume, 50);
}));

test('the notification still works when the command fails, exits with an error or throws', async () => {
    for (const execute of [
        () => Promise.reject(new Error('paplay: not found')),
        () => Promise.resolve({exit_code: 1, stderr: 'no audio'}),
        () => { throw new Error('exec denied'); },
        () => 'not a promise'
    ]) {
        await withShard(async (s) => {
            const r = await call(s, 'POST', 'notify', {message: 'still shown', sound: 'chime'});
            assert.equal(r.code, 200);
            assert.equal(r.json.sound, 'requested');
            await wait(50);
            assert.equal((await call(s, 'GET', 'sounds')).json.last.ok, false, 'the failure is visible in GET sounds');
            assert.equal((await call(s, 'GET', 'notifications')).json.notifications.length, 1);
        }, {execute});
    }
});

test('one sound every 0.8 s: faster requests are skipped, not queued', () => withShard(async (s, commands) => {
    const a = await call(s, 'POST', 'notify', {message: 'a', sound: 'chime'});
    const b = await call(s, 'POST', 'notify', {message: 'b', sound: 'chime'});
    assert.equal(a.json.sound, 'requested');
    assert.equal(b.json.sound, 'skipped');
    assert.equal((await call(s, 'POST', 'play', {sound: 'chime'})).code, 429);
    await wait(50);
    assert.equal(commands.length, 1);
}, {gapMs: 800}));

test('GET sounds lists the closed list and the volume settings; status says sounds are available; without exec they are not', async () => {
    await withShard(async (s) => {
        const r = await call(s, 'GET', 'sounds');
        assert.deepEqual(r.json.sounds, ['chime', 'soft', 'reward', 'success', 'alert', 'rotation', 'open', 'poweron']);
        assert.equal(r.json.available, true);
        assert.equal(r.json.volume, 100);
        assert.equal(r.json.delayMs, 3000);
        assert.equal((await call(s, 'GET', 'status')).json.sound, true);
    });
    await withShard(async (s) => {
        assert.equal((await call(s, 'GET', 'sounds')).json.available, false);
        const r = await call(s, 'POST', 'notify', {message: 'no exec', sound: 'chime'});
        assert.equal(r.code, 200);
    }, {execute: null});
});

test('POST play plays a sound without a notification, and refuses unknown names', () => withShard(async (s, commands) => {
    const ok = await call(s, 'POST', 'play', {sound: 'poweron', volume: 40});
    assert.equal(ok.code, 200);
    assert.equal(ok.json.sound, 'requested');
    for (const bad of [{sound: 'nope'}, {sound: '../x'}, {sound: {toString: 1}}, [], null]) {
        assert.equal((await call(s, 'POST', 'play', bad)).code, 400, JSON.stringify(bad));
    }
    assert.equal((await call(s, 'POST', 'play', '{not json')).code, 400);
    await wait(50);
    assert.deepEqual(commands, ['paplay --volume=' + vol(40) + ' ' + DIR + 'power_on.wav']);
    assert.deepEqual((await call(s, 'GET', 'notifications')).json.notifications, [], 'no notification was queued');
}));

test('the Shard has no other use of exec: the only command string in the source is the paplay one', () => {
    const source = fs.readFileSync(path.join(folder, 'index.js'), 'utf8');
    const calls = source.match(/ctx\.execute\(/g) || [];
    assert.equal(calls.length, 1);
    assert.match(source, /ctx\.execute\('paplay --volume=' \+ v \+ ' ' \+ SOUND_DIR \+ SOUND_FILES\[name\]/);
    assert.deepEqual(Object.keys(rules.SOUNDS), ['chime', 'soft', 'reward', 'success', 'alert', 'rotation', 'open', 'poweron']);
    assert.ok(!fs.readFileSync(path.join(folder, 'rules.js'), 'utf8').includes('execute'));
});

test('the sound waits for the banner: it plays when the banner service has recorded the id, not before', async () => {
    const seenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-seen-')), 'seen.json');
    await withShard(async (s, commands) => {
        const r = await call(s, 'POST', 'notify', {message: 'wait for me', sound: 'reward'});
        assert.equal(r.json.sound, 'requested');
        await wait(400);
        assert.deepEqual(commands, [], 'nothing yet: the banner is not on screen');
        fs.writeFileSync(seenFile, JSON.stringify({[r.json.id]: 1}));
        await wait(500);
        assert.equal(commands.length, 1);
        assert.match(commands[0], /vi_reward\.wav$/);
    }, {waitMs: 5000, seenFile});
});

test('if the banner is never recorded the sound still plays after the wait', () => withShard(async (s, commands) => {
    await call(s, 'POST', 'notify', {message: 'late banner', sound: 'chime'});
    await wait(200);
    assert.equal(commands.length, 0);
    await wait(600);
    assert.equal(commands.length, 1);
}, {waitMs: 500, seenFile: path.join(os.tmpdir(), 'nc-no-such-seen-file.json')}));

test('full-screen and both: the sound plays when the app screen asks for the queue', () => withShard(async (s, commands) => {
    await call(s, 'POST', 'notify', {message: 'card', sound: 'success', mode: 'full'});
    await wait(300);
    assert.equal(commands.length, 0);
    await call(s, 'GET', 'notifications?src=app');
    await wait(100);
    assert.equal(commands.length, 1);
    assert.match(commands[0], /vi_success\.wav$/);
    await call(s, 'GET', 'notifications?src=app');
    await wait(100);
    assert.equal(commands.length, 1, 'only once');
}, {waitMs: 5000}));

test('a notification that is only queued (open:false) plays its sound at once, and stop() cancels a pending sound', async () => {
    await withShard(async (s, commands) => {
        await call(s, 'POST', 'notify', {message: 'silent queue', sound: 'chime', open: false});
        await wait(80);
        assert.equal(commands.length, 1);
    }, {waitMs: 5000});
    const s = start({waitMs: 300, seenFile: path.join(os.tmpdir(), 'nc-no-such-seen-file.json')});
    await call(s.shard, 'POST', 'notify', {message: 'cancelled', sound: 'chime'});
    s.shard.stop();
    await wait(600);
    assert.equal(s.commands.length, 0, 'stop() cancelled the pending sound');
});

test('the sound starts soundDelayMs after the request (the Shard cannot see the banner), or as soon as the banner is seen', async () => {
    const seenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-delay-')), 'seen.json');
    await withShard(async (s, commands) => {
        await call(s, 'POST', 'settings', {soundDelayMs: 700});
        await call(s, 'POST', 'notify', {message: 'timed', sound: 'chime'});
        await wait(400);
        assert.equal(commands.length, 0, 'not yet');
        await wait(600);
        assert.equal(commands.length, 1, 'started after the delay');
        const trace = (await call(s, 'GET', 'sounds')).json.trace;
        assert.equal(trace.plannedMs, 700);
        assert.ok(trace.startedMs >= 650 && trace.startedMs < 1100, 'started at ' + trace.startedMs);
        assert.equal(trace.seenMs, null, 'the banner was never seen');
        // a banner that is seen before the delay starts its sound at once
        await call(s, 'POST', 'settings', {soundDelayMs: 3000});
        const b = await call(s, 'POST', 'notify', {message: 'seen early', sound: 'reward'});
        await wait(300);
        assert.equal(commands.length, 1);
        fs.writeFileSync(seenFile, JSON.stringify({[b.json.id]: 1}));
        await wait(300);
        assert.equal(commands.length, 2, 'played when the banner was seen');
        assert.ok((await call(s, 'GET', 'sounds')).json.trace.seenMs < 800);
    }, {waitMs: 10000, seenFile, gapMs: 0});
});

test('the delay (soundDelayMs) is a setting, 0-10000 ms, default 3000', () => withShard(async (s) => {
    assert.equal((await call(s, 'GET', 'settings')).json.settings.soundDelayMs, 3000);
    assert.equal((await call(s, 'GET', 'sounds')).json.delayMs, 3000);
    assert.equal((await call(s, 'POST', 'settings', {soundDelayMs: 1500})).json.settings.soundDelayMs, 1500);
    assert.equal((await call(s, 'POST', 'settings', {soundDelayMs: 99999})).json.settings.soundDelayMs, 10000);
    assert.equal((await call(s, 'POST', 'settings', {soundDelayMs: 'x'})).json.settings.soundDelayMs, 10000, 'an invalid value keeps the current one');
}));

test('goodie: a 10-second tune made only of the notification sounds', () => withShard(async (s, commands) => {
    const list = (await call(s, 'GET', 'sounds')).json.songs;
    assert.deepEqual(list.map(x => x.name), ['rock', 'fate']);
    const r = await call(s, 'POST', 'play', {song: 'rock'});
    assert.equal(r.code, 200);
    assert.equal(r.json.song, 'playing');
    await wait(300);   // the tune is played 100 times faster in the test (10 s -> 0.1 s)
    assert.equal(commands.length, 12, 'stomp, stomp, clap, four times');
    assert.deepEqual(commands.map(c => /operation\/(.+)\.wav/.exec(c)[1]), ['select', 'select', 'vi_success', 'select', 'select', 'vi_success', 'select', 'select', 'vi_success', 'select', 'select', 'vi_success']);
    for (const c of commands) assert.match(c, SHAPE);
    const fate = await call(s, 'POST', 'play', {song: 'fate'});
    assert.equal(fate.json.song, 'playing', 'the next one can start once the first has ended');
    await wait(300);
    assert.equal(commands.length, 24);
    for (const c of commands) assert.match(c, SHAPE);
}));

test('goodie: one song at a time, stop cancels it, and only the fixed names are accepted', () => withShard(async (s, commands) => {
    await call(s, 'POST', 'play', {song: 'rock'});
    assert.equal((await call(s, 'POST', 'play', {song: 'fate'})).code, 409, 'busy');
    await wait(20);
    assert.equal((await call(s, 'POST', 'play', {song: 'stop'})).json.song, 'stopped');
    const played = commands.length;
    await wait(250);
    assert.equal(commands.length, played, 'nothing is played after stop');
    assert.ok(played < 12);
    for (const bad of ['nope', '../x', '__proto__', 'constructor', {toString: 1}, ['rock'], 5, null]) {
        assert.equal((await call(s, 'POST', 'play', {song: bad})).code, 400, JSON.stringify(bad));
    }
    assert.equal((await call(s, 'POST', 'play', {song: 'rock'})).code, 200, 'stop freed the player');
    await wait(300);
    for (const c of commands) assert.match(c, SHAPE);
}));

test('goodie: stop() of the Shard cancels a song that is playing', async () => {
    const s = start({songScale: 0.1});
    await call(s.shard, 'POST', 'play', {song: 'rock'});
    await wait(200);
    const before = s.commands.length;
    s.shard.stop();
    await wait(1200);
    assert.equal(s.commands.length, before);
});
