'use strict';
// By hand, not in CI (CI has no Vetro repository): runs the packed Home Assistant Shard inside Vetro's real plugin-host.js
// (0.7.0 or later) against a fake Home Assistant, to see the host's own limits, timeouts and cleaning applied to it.
//   node scripts/build.cjs && node tests/manual/home-assistant-in-vetro-host.cjs /path/to/vetro
// Takes about 25 seconds (it waits out the two timeouts).
const assert = require('assert').strict, fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const vetro = process.argv[2];
if (!vetro) { console.error('usage: node tests/manual/home-assistant-in-vetro-host.cjs <path to the Vetro repository>'); process.exit(2); }
const { PluginHost, CARD_ROWS_MAX } = require(path.resolve(vetro, 'app/service/plugin-host.js'));
const BUNDLE = path.join(__dirname, '../../dist/home-assistant-0.1.0.vplugin');
const raw = fs.readFileSync(BUNDLE, 'utf8');
const sha = require('crypto').createHash('sha256').update(raw, 'utf8').digest('hex');

// ---- a fake Home Assistant -----------------------------------------------------------------------------------------------------------
let mode = {};        // per test: delayMs, status, body, and the table of states
const seen = [];
const states = {};
function reset() { mode = {}; seen.length = 0; for (const k of Object.keys(states)) delete states[k]; }
const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        const go = () => {
            if (mode.status) { res.writeHead(mode.status); return res.end(mode.body || ''); }
            if (mode.raw != null) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(mode.raw); }
            let m;
            if (req.method === 'GET' && (m = /^\/api\/states\/(.+)$/.exec(req.url))) {
                const s = states[m[1]];
                if (!s) { res.writeHead(404); return res.end('{"message":"Entity not found."}'); }
                res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(s));
            }
            if (req.method === 'GET' && req.url === '/api/states') { res.writeHead(200); return res.end(JSON.stringify(Object.keys(states).map(k => states[k]))); }
            if (req.method === 'POST' && (m = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(req.url))) {
                const id = JSON.parse(body).entity_id, s = states[id];
                if (s && mode.applies !== false) { if (m[2] === 'turn_on') s.state = 'on'; if (m[2] === 'turn_off') s.state = 'off'; }
                res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(s && mode.applies !== false ? [s] : []));
            }
            res.writeHead(404); res.end('{}');
        };
        mode.delayMs ? setTimeout(go, mode.delayMs) : go();
    });
});

function light(id, state, name) { states[id] = { entity_id: id, state, attributes: { friendly_name: name || id } }; }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-host-'));
function configure(port, entities, extra) {
    fs.mkdirSync(path.join(dir, 'home-assistant'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'home-assistant', 'config.json'), JSON.stringify(Object.assign({ url: 'http://127.0.0.1:' + port, token: 'TOKEN123', entities }, extra || {})));
}
const ent = (id, name) => ({ id, name: name || '' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const host = new PluginHost({ dir, external: true });
    let ok = 0;
    const t = (name) => { ok++; console.log('ok', ok, name); };
    try {
        host.start();
        const st = host._readState(); st.developer = true; host._writeState(st);     // Developer mode, as for any unsigned Shard
        const r = host.install(raw, sha, null);
        assert.ok(r && r.ok !== false, 'install: ' + JSON.stringify(r));
        t('bundle installs through the real host with its SHA-256 (' + JSON.stringify(r).slice(0, 80) + ')');
        host.setEnabled('home-assistant', true);
        assert.equal(host.status('home-assistant').state, 'running', JSON.stringify(host.status('home-assistant')));
        assert.deepEqual(host.cards(), [{ plugin: 'home-assistant', label: 'Home Assistant' }]);
        t('Shard runs; cards() lists it');

        // not configured: no network, a note, no rows
        let c = await host.cardOf('home-assistant');
        assert.equal(c.ok, true); assert.deepEqual(c.rows, []); assert.match(c.note, /address/); assert.equal(c.choosable, false);
        t('empty config: note "' + c.note + '", no rows, not choosable');

        // good read; scene needs no call; names; no ticks; counts
        reset(); light('light.living', 'on', 'Living room'); light('light.kitchen', 'off', 'Kitchen'); light('scene.evening', 'scening', 'Evening');
        configure(port, [ent('light.living'), ent('light.kitchen', 'Cucina'), ent('scene.evening', 'Evening')]);
        host.setEnabled('home-assistant', false); host.setEnabled('home-assistant', true);     // restart: start() re-reads config
        c = await host.cardOf('home-assistant');
        assert.deepEqual(c.rows, [
            { id: 'light.living', label: 'Living room', value: 'on', ticked: false },
            { id: 'light.kitchen', label: 'Cucina', value: 'off', ticked: false },
            { id: 'scene.evening', label: 'Evening', value: 'Scene', ticked: false }]);
        assert.equal(c.note, '1 of 2 on');
        assert.ok(seen.every(s => s.auth === 'Bearer TOKEN123') && seen.length === 2 && seen.every(s => /^\/api\/states\/light\./.test(s.url)), JSON.stringify(seen));
        t('good read: 3 rows, 2 GETs of single entities, scene without a call, bearer token sent, no row ticked, note "' + c.note + '"');

        // OK on a light: uses the state shown (on -> turn_off), HA's toggle is never called, new rows come back at once
        seen.length = 0;
        let s = await host.selectCard('home-assistant', 'light.living');
        assert.equal(s.ok, true); assert.equal(seen.length, 1, 'only the service call, no extra read');
        assert.equal(seen[0].url, '/api/services/light/turn_off'); assert.deepEqual(JSON.parse(seen[0].body), { entity_id: 'light.living' });
        assert.equal(s.card.rows[0].value, 'off'); assert.equal(s.card.rows[1].value, 'off');
        t('OK on "on" light: POST light/turn_off once, rows returned with it off, no re-read');
        // press again (card shows off): turn_on. Then HA does not report the change in its answer: the expected state is used
        seen.length = 0; mode.applies = false;
        s = await host.selectCard('home-assistant', 'light.living');
        assert.equal(seen[0].url, '/api/services/light/turn_on'); assert.equal(s.card.rows[0].value, 'on');
        t('second press: turn_on; a service answer without the entity falls back to the expected state');
        mode = {};
        // scene runs
        seen.length = 0; s = await host.selectCard('home-assistant', 'scene.evening');
        assert.equal(seen[0].url, '/api/services/scene/turn_on'); assert.equal(s.ok, true);
        t('scene: POST scene/turn_on');

        // unknown / invalid rows
        seen.length = 0;
        for (const id of ['light.not_chosen', 'lock.front', '__proto__', 'light.living;x']) {
            s = await host.selectCard('home-assistant', id);
            assert.equal(s.ok === false || s.unavailable === true, true, id);
        }
        assert.ok(seen.every(q => q.method === 'GET' || false) && seen.length === 0, 'nothing reached HA: ' + JSON.stringify(seen));
        t('unknown, unsafe and non-chosen row ids are refused without touching HA');

        // service error: the card stays, with a note
        mode = { status: 500, delayMs: 0 };
        s = await host.selectCard('home-assistant', 'light.kitchen');
        assert.equal(s.ok, false); assert.match(s.note, /HA answered 500/);
        assert.equal(host.status('home-assistant').state, 'running');
        t('HA 500 on a press: {ok:false, note:"' + s.note + '"}, Shard still running');
        mode = { status: 401 };
        s = await host.selectCard('home-assistant', 'light.kitchen'); assert.equal(s.note, 'Token refused');
        t('401 on a press: "Token refused"');

        // reads: 401, broken JSON, HA down, slow HA, 404 entity
        reset(); light('light.living', 'on', 'Living room'); light('light.kitchen', 'off', 'Kitchen');
        mode = { status: 401 }; c = await host.cardOf('home-assistant');
        assert.equal(c.ok, false); assert.equal(c.reason, 'Token refused'); t('read 401 -> Not available: "Token refused"');
        mode = { raw: '{not json' }; c = await host.cardOf('home-assistant');
        assert.equal(c.ok, false); assert.equal(c.reason, 'HA sent something unreadable'); t('broken JSON -> "' + c.reason + '"');
        mode = { delayMs: 5000 }; const t0 = Date.now(); c = await host.cardOf('home-assistant'); const took = Date.now() - t0;
        assert.equal(c.ok, false); assert.equal(c.reason, 'HA did not answer'); assert.ok(took < 3000, 'took ' + took);
        t('slow HA (5 s): own timeout "' + c.reason + '" after ' + took + ' ms, before the host\'s 3 s');
        mode = {}; delete states['light.kitchen'];
        c = await host.cardOf('home-assistant');
        assert.equal(c.ok, true); assert.equal(c.rows[1].value, 'missing');
        t('one entity gone from HA: its row says "missing", the others still show');
        configure(port + 1, [ent('light.living'), ent('light.kitchen')]);
        host.setEnabled('home-assistant', false); host.setEnabled('home-assistant', true);
        c = await host.cardOf('home-assistant'); assert.equal(c.reason, 'HA did not answer');
        assert.equal(host.status('home-assistant').controlCenter.error, 'HA did not answer'); assert.equal(host.status('home-assistant').state, 'running');
        for (let i = 0; i < 5; i++) await host.cardOf('home-assistant');
        assert.equal(host.status('home-assistant').state, 'running'); assert.equal(host.status('home-assistant').errors, 0);
        t('HA down: "HA did not answer", shown by the dashboard status, never counts toward the 3 failures');

        // more than 7 chosen in config: the Shard keeps 7; odd ids are dropped
        reset(); const ids = []; for (let i = 0; i < 12; i++) { ids.push('light.l' + i); light('light.l' + i, 'on', 'Lamp ' + i); }
        configure(port, ids.map(i => ent(i)).concat([ent('lock.door'), ent('light.' + 'x'.repeat(40)), ent('Light.Bad'), ent('light.a b')]));
        host.setEnabled('home-assistant', false); host.setEnabled('home-assistant', true);
        c = await host.cardOf('home-assistant');
        assert.equal(c.rows.length, CARD_ROWS_MAX); assert.equal(c.rows.length, 7);
        t('12 entities in config: the card shows ' + c.rows.length);

        // a press that HA never answers: the Shard gives up before the host's 10 s
        reset(); light('light.l0', 'on', 'Lamp 0'); configure(port, [ent('light.l0')]);
        host.setEnabled('home-assistant', false); host.setEnabled('home-assistant', true);
        await host.cardOf('home-assistant');
        mode = { delayMs: 12000 };
        const t1 = Date.now(); s = await host.selectCard('home-assistant', 'light.l0'); const took2 = Date.now() - t1;
        assert.equal(s.ok, false); assert.equal(s.note, 'HA did not answer'); assert.ok(took2 < 10000, 'took ' + took2);
        t('press that HA never answers: "' + s.note + '" after ' + took2 + ' ms (< 10 s)');

        // stop() aborts what is in flight; no handle is left
        mode = { delayMs: 12000 };
        const pending = host.cardOf('home-assistant'); await sleep(50);
        host.setEnabled('home-assistant', false);
        const stopped = await pending; assert.equal(stopped.ok, false);
        t('switched off while reading: the answer is dropped (' + stopped.reason + ')');
        console.log('\nALL ' + ok + ' CHECKS PASSED');
    } catch (e) { console.error('FAIL', e && e.stack || e); process.exitCode = 1; }
    host.stop(); server.close(); server.closeAllConnections && server.closeAllConnections();
    setTimeout(() => { const h = process._getActiveHandles().filter(x => x !== process.stdout && x !== process.stderr && x !== process.stdin); console.log('open handles at the end:', h.length); process.exit(process.exitCode || 0); }, 300).unref();
});
