'use strict';
// The Home Assistant Shard against a fake Home Assistant: the card contract of Vetro 0.7.0 (limits, timeouts, no ticks), the safety of what
// OK may do, the errors, and the setup routes. It does not need the Vetro repository: the limits below are the host's, written out.
const { test } = require('node:test'), assert = require('node:assert/strict'), http = require('http'), { EventEmitter } = require('events');
const build = require('../scripts/build.cjs'), ha = require('../plugins/home-assistant/ha.js');
const create = require('../plugins/home-assistant/index.js');
const fs = require('fs'), path = require('path');

// Whatever a test opens is closed when it ends, also when an assertion throws: a fake server left open would keep `npm test` alive for ever.
const open = [];
const T = (name, fn) => test(name, async () => { try { await fn(); } finally { while (open.length) { try { open.pop()(); } catch (e) { /* already closed */ } } } });

const ROWS_MAX = 7, ID_RE = /^[A-Za-z0-9_.-]{1,40}$/, LABEL_MAX = 40, VALUE_MAX = 24, NOTE_MAX = 80;
const ent = (id, name) => ({ id, name: name || '' });

// A fake Home Assistant. `states` is what it knows; `mode` bends its answers; `seen` records what reached it.
function fakeHa() {
    const state = { states: {}, mode: {}, seen: [] };
    state.server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            state.seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
            const go = () => {
                const m = state.mode, send = (code, text) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(text); };
                if (m.status) return send(m.status, m.body || '{}');
                if (m.raw != null) return send(200, m.raw);
                let r;
                if (req.method === 'GET' && (r = /^\/api\/states\/(.+)$/.exec(req.url))) return state.states[r[1]] ? send(200, JSON.stringify(state.states[r[1]])) : send(404, '{"message":"Entity not found."}');
                if (req.method === 'GET' && req.url === '/api/states') return send(200, JSON.stringify(Object.keys(state.states).map(k => state.states[k])));
                if (req.method === 'POST' && (r = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(req.url))) {
                    const s = state.states[JSON.parse(body).entity_id];
                    if (s && r[2] === 'turn_on') s.state = 'on';
                    if (s && r[2] === 'turn_off') s.state = 'off';
                    return send(200, JSON.stringify(s ? [s] : []));
                }
                send(404, '{}');
            };
            state.mode.delayMs ? setTimeout(go, state.mode.delayMs) : go();
        });
    });
    state.add = (id, value, name) => { state.states[id] = { entity_id: id, state: value, attributes: { friendly_name: name || id } }; };
    state.listen = () => new Promise(resolve => state.server.listen(0, '127.0.0.1', () => resolve(state.server.address().port)));
    state.close = () => { state.server.close(); if (state.server.closeAllConnections) state.server.closeAllConnections(); };
    open.push(state.close);
    return state;
}

// The Shard with an in-memory config, the way Vetro's ctx gives it one.
function shard(initial) {
    let stored = JSON.parse(JSON.stringify(initial || {}));
    const ctx = { id: 'home-assistant', dir: '/nonexistent', config: { get: () => JSON.parse(JSON.stringify(stored)), set: v => { stored = JSON.parse(JSON.stringify(v)); } } };
    const inst = create(ctx);
    inst.start();
    open.push(() => inst.stop());
    inst.stored = () => stored;
    return inst;
}

// Calls a route the way the host does and returns {code, body, text}.
function call(inst, method, sub, payload) {
    return new Promise((resolve, reject) => {
        const req = new EventEmitter(); req.method = method;
        const out = { code: 0, headers: {}, text: '' };
        const res = { headersSent: false, writeHead(code, headers) { out.code = code; out.headers = headers || {}; this.headersSent = true; }, end(t) { out.text = String(t || ''); try { out.body = JSON.parse(out.text); } catch (e) { out.body = null; } resolve(out); } };
        let handled;
        try { handled = inst.route(req, res, sub); } catch (e) { return reject(e); }
        if (handled === false) return resolve({ handled: false });
        process.nextTick(() => { if (payload !== undefined) req.emit('data', Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))); req.emit('end'); });
    });
}

// What the host lets through, applied to what the card returned: if this holds, the host drops or cuts nothing.
function fitsTheHost(card) {
    assert.ok(card && Array.isArray(card.rows));
    assert.ok(card.rows.length <= ROWS_MAX, 'at most ' + ROWS_MAX + ' rows');
    const seen = {};
    card.rows.forEach(r => {
        assert.match(r.id, ID_RE); assert.ok(!seen[r.id], 'ids differ'); seen[r.id] = true;
        assert.ok(r.label && r.label.length <= LABEL_MAX, 'label ' + r.label); assert.ok(String(r.value).length <= VALUE_MAX, 'value');
        assert.ok(!/[\u0000-\u001f]/.test(r.label + r.value), 'no control characters');
        assert.equal(r.ticked, false, 'OK is ignored on a ticked row, so no row is ticked');
    });
    if (card.note) assert.ok(card.note.length <= NOTE_MAX);
}

T('manifest and files pass the catalog checks, and the card methods are there', () => {
    const dir = path.join(__dirname, '..', 'plugins', 'home-assistant');
    const r = build.pack(dir, 'home-assistant');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.manifest.controlCenter, { label: 'Home Assistant' });
    assert.deepEqual(r.manifest.permissions, [], 'no exec: it runs no command on the TV');
    const inst = shard();
    assert.equal(typeof inst.card, 'function'); assert.equal(typeof inst.cardSelect, 'function');
    assert.ok(!/ctx\.execute|child_process|\beval\b/.test(fs.readFileSync(path.join(dir, 'index.js'), 'utf8') + fs.readFileSync(path.join(dir, 'ha.js'), 'utf8')));
});

T('address parsing: IPs, names, https, a sub-path; no credentials, no other scheme', () => {
    assert.equal(ha.parseAddress('192.168.1.20:8123').text, 'http://192.168.1.20:8123');
    assert.equal(ha.parseAddress(' http://homeassistant:8123/ ').text, 'http://homeassistant:8123');
    assert.equal(ha.parseAddress('https://ha.example.org').text, 'https://ha.example.org:443');
    assert.equal(ha.parseAddress('https://ha.example.org/sub/').base, '/sub');
    for (const bad of ['', '   ', 'ftp://x', 'http://user:pw@host', 'http://host?x=1', 'http://host#a', 'http://ho st', 'http://', 'http://host:99999', 'javascript:alert(1)', null, 5, 'http://host/a b'])
        assert.equal(ha.parseAddress(bad), null, String(bad));
});

T('which entities can be on the card', () => {
    for (const id of ['light.living_room', 'switch.tv', 'fan.x', 'input_boolean.night', 'scene.evening', 'script.bedtime', 'button.doorbell', 'input_button.go'])
        assert.ok(ha.entityDomain(id), id);
    for (const id of ['lock.front_door', 'cover.garage', 'alarm_control_panel.home', 'climate.x', 'light.' + 'x'.repeat(40), 'Light.x', 'light.a b', 'light.', 'light', '__proto__.x', 'constructor.x', "light.x'", '', null, 7])
        assert.equal(ha.entityDomain(id), null, String(id));
});

T('card: one read per entity with a state, scenes without a call, never the whole list, never ticked', async () => {
    const f = fakeHa(), port = await f.listen();
    f.add('light.living', 'on', 'Living room'); f.add('light.kitchen', 'off', 'Kitchen'); f.add('scene.evening', 'scening', 'Evening');
    const s = shard({ url: '127.0.0.1:' + port, token: 'T0KEN', entities: [ent('light.living'), ent('light.kitchen', 'Cucina'), ent('scene.evening', 'Evening')] });
    const card = await s.card();
    fitsTheHost(card);
    assert.deepEqual(card.rows.map(r => [r.label, r.value]), [['Living room', 'on'], ['Cucina', 'off'], ['Evening', 'Scene']]);
    assert.equal(card.note, '1 of 2 on'); assert.equal(card.choosable, true);
    assert.equal(f.seen.length, 2); assert.ok(f.seen.every(q => q.method === 'GET' && /^\/api\/states\/light\./.test(q.url) && q.auth === 'Bearer T0KEN'));
    s.stop(); f.close();
});

T('card without a setup says so, and calls nothing', async () => {
    const empty = shard();
    const a = await empty.card();
    assert.deepEqual(a.rows, []); assert.match(a.note, /address/); assert.equal(a.choosable, false);
    const noEntities = shard({ url: 'http://127.0.0.1:9', token: 'x', entities: [] });
    const b = await noEntities.card();
    assert.deepEqual(b.rows, []); assert.match(b.note, /Choose entities/);
    assert.equal(empty.status().configured, false);
});

T('more than seven, odd ids and long names fit the host', async () => {
    const f = fakeHa(), port = await f.listen(), list = [];
    for (let i = 0; i < 12; i++) { f.add('light.l' + i, 'on', 'Lamp ' + i + ' ' + 'y'.repeat(60)); list.push(ent('light.l' + i)); }
    f.add('light.strange', 'x'.repeat(100), 'Line\nbreak\tname');
    const s = shard({ url: '127.0.0.1:' + port, token: 'T', entities: [ent('lock.door'), ent('light.' + 'z'.repeat(40)), ent('Light.Bad'), ent('light.strange')].concat(list, [ent('light.l1')]) });
    const card = await s.card();
    fitsTheHost(card);
    assert.equal(card.rows.length, 7); assert.equal(card.rows[0].id, 'light.strange', 'bad ids are dropped, order kept');
    assert.equal(card.rows[0].label, 'Line break name');
    s.stop(); f.close();
});

T('OK turns a light off when the row says on, on otherwise; HA\'s toggle is never used', async () => {
    const f = fakeHa(), port = await f.listen();
    f.add('light.living', 'on', 'Living room'); f.add('light.kitchen', 'off', 'Kitchen');
    const s = shard({ url: '127.0.0.1:' + port, token: 'T', entities: [ent('light.living'), ent('light.kitchen')] });
    await s.card(); f.seen.length = 0;
    let r = await s.cardSelect('light.living');
    assert.equal(r.ok, true); assert.equal(f.seen.length, 1, 'one call, no read');
    assert.equal(f.seen[0].url, '/api/services/light/turn_off'); assert.deepEqual(JSON.parse(f.seen[0].body), { entity_id: 'light.living' });
    fitsTheHost(r); assert.equal(r.rows.find(x => x.id === 'light.living').value, 'off');
    // HA changed the light meanwhile (someone pressed the wall switch): the press still means what the row showed
    f.states['light.kitchen'].state = 'on'; f.seen.length = 0;
    r = await s.cardSelect('light.kitchen');
    assert.equal(f.seen[0].url, '/api/services/light/turn_on', 'the row said off, so it is turn_on');
    // a slow device whose state HA has not changed yet: the new state the press asked for is shown
    f.mode.status = 0; f.states['light.living'].state = 'off'; f.seen.length = 0;
    r = await s.cardSelect('light.living');
    assert.equal(f.seen[0].url, '/api/services/light/turn_on');
    assert.ok(f.seen.every(q => !/toggle/.test(q.url)));
    s.stop(); f.close();
});

T('OK on a scene, script or button fires it; an unavailable light is refused; first press without a read asks HA', async () => {
    const f = fakeHa(), port = await f.listen();
    f.add('scene.evening', 'x'); f.add('button.bell', 'x'); f.add('light.gone', 'unavailable', 'Lamp'); f.add('light.fresh', 'on', 'Fresh');
    const s = shard({ url: '127.0.0.1:' + port, token: 'T', entities: [ent('scene.evening'), ent('button.bell'), ent('light.gone', 'Lamp'), ent('light.fresh')] });
    await s.card(); f.seen.length = 0;
    await s.cardSelect('scene.evening'); assert.equal(f.seen[0].url, '/api/services/scene/turn_on');
    await s.cardSelect('button.bell'); assert.equal(f.seen[1].url, '/api/services/button/press');
    const r = await s.cardSelect('light.gone');
    assert.equal(r.ok, false); assert.match(r.note, /unavailable/); assert.equal(f.seen.length, 2, 'nothing sent for it');
    // a Shard that never showed the card yet (the first press after a restart): it reads the one entity, then acts
    const cold = shard({ url: '127.0.0.1:' + port, token: 'T', entities: [ent('light.fresh')] });
    f.seen.length = 0;
    const c = await cold.cardSelect('light.fresh');
    assert.equal(c.ok, true); assert.deepEqual(f.seen.map(q => q.method + ' ' + q.url), ['GET /api/states/light.fresh', 'POST /api/services/light/turn_off']);
    s.stop(); cold.stop(); f.close();
});

T('OK refuses what is not on the card, and nothing reaches HA', async () => {
    const f = fakeHa(), port = await f.listen();
    f.add('light.a', 'on');
    const s = shard({ url: '127.0.0.1:' + port, token: 'T', entities: [ent('light.a')] });
    await s.card(); f.seen.length = 0;
    for (const id of ['light.other', 'lock.front_door', 'cover.garage', '__proto__', 'constructor', 'light.a/../x', '', null, undefined, 5, {}]) {
        const r = await s.cardSelect(id);
        assert.equal(r.ok, false, String(id)); assert.match(r.note, /chosen/);
    }
    assert.equal(f.seen.length, 0);
    s.stop(); f.close();
});

T('errors say why, short and without the address or the token', async () => {
    const f = fakeHa(), port = await f.listen();
    f.add('light.a', 'on', 'A'); f.add('light.b', 'off', 'B');
    const s = shard({ url: '127.0.0.1:' + port, token: 'SECRET-TOKEN', entities: [ent('light.a'), ent('light.b')] });
    const reason = p => p.then(() => 'no error', e => e.message);
    f.mode = { status: 401 }; assert.equal(await reason(s.card()), 'Token refused');
    f.mode = { status: 500 }; assert.equal(await reason(s.card()), 'HA answered 500');
    f.mode = { raw: '{broken' }; assert.equal(await reason(s.card()), 'HA sent something unreadable');
    f.mode = { raw: 'x'.repeat(200 * 1024) }; assert.equal(await reason(s.card()), 'HA answer is too large');
    f.mode = {}; delete f.states['light.b']; const part = await s.card();
    assert.deepEqual(part.rows.map(r => r.value), ['on', 'missing'], 'one entity gone: its row says so, the card still works');
    assert.equal(s.status().error, null);
    f.close();
    assert.equal(await reason(s.card()), 'HA did not answer', 'connection refused');
    assert.equal(s.status().error, 'HA did not answer');
    const press = await s.cardSelect('light.a');
    assert.equal(press.ok, false); assert.equal(press.note, 'HA did not answer'); assert.ok(press.rows && press.rows.length, 'rows go back so the host does not read again');
    assert.ok(!/SECRET-TOKEN/.test(JSON.stringify([s.status(), press])), 'the token is in no status and no note');
    assert.ok(!/127\.0\.0\.1|http/.test(JSON.stringify(press)) && !/127\.0\.0\.1|http/.test(String(s.status().error)), 'a note and an error carry no address');
    s.stop();
});

T('a slow Home Assistant is given up on before the host\'s 3 s, and stop() ends what is open', async () => {
    const f = fakeHa(), port = await f.listen();
    f.add('light.a', 'on', 'A'); f.mode = { delayMs: 4000 };
    const s = shard({ url: '127.0.0.1:' + port, token: 'T', entities: [ent('light.a')] });
    const t0 = Date.now(), reason = await s.card().then(() => 'no error', e => e.message), took = Date.now() - t0;
    assert.equal(reason, 'HA did not answer'); assert.ok(took >= 2000 && took < 3000, 'took ' + took);
    const open = s.card().then(() => 'ok', e => e.message);
    await new Promise(r => setTimeout(r, 30)); s.stop();
    assert.equal(await open, 'HA did not answer'); f.close();
});

T('setup routes: the token never comes back, a new address forgets it, bad input is refused', async () => {
    const s = shard({ url: 'http://127.0.0.1:1', token: 'SECRET-TOKEN', entities: [ent('light.a', 'A')], other: 'kept?' });
    let r = await call(s, 'GET', 'config');
    assert.deepEqual(r.body, { url: 'http://127.0.0.1:1', hasToken: true, entities: [{ id: 'light.a', name: 'A' }], max: 7 });
    assert.ok(!/SECRET-TOKEN/.test(r.text) && !/SECRET-TOKEN/.test(JSON.stringify(s.status())));
    r = await call(s, 'POST', 'config', { entities: [{ id: 'light.a', name: 'Lamp' }, { id: 'scene.x', name: 'Evening' }] });
    assert.equal(r.code, 200); assert.equal(s.stored().token, 'SECRET-TOKEN', 'a change of entities keeps the token'); assert.equal(s.stored().entities.length, 2);
    r = await call(s, 'POST', 'config', { url: '10.0.0.5:8123' });
    assert.equal(r.body.tokenForgotten, true); assert.equal(r.body.hasToken, false); assert.equal(s.stored().url, 'http://10.0.0.5:8123'); assert.equal(s.stored().token, '');
    r = await call(s, 'POST', 'config', { token: ' NEW-TOKEN ' });
    assert.equal(s.stored().token, 'NEW-TOKEN'); assert.equal(r.body.hasToken, true);
    r = await call(s, 'POST', 'config', { url: '10.0.0.5:8123' });
    assert.equal(s.stored().token, 'NEW-TOKEN', 'the same address keeps the token');
    r = await call(s, 'POST', 'config', { url: 'http://10.0.0.6:8123', token: 'OTHER' });
    assert.equal(s.stored().token, 'OTHER');
    r = await call(s, 'POST', 'config', { clearToken: true }); assert.equal(s.stored().token, '');
    for (const bad of [{ url: 'ftp://x' }, { url: 'http://u:p@h' }, { url: 5 }, { token: 'has space' }, { token: 'new\nline' }, { entities: 'x' },
        { entities: [{ id: 'lock.door' }] }, { entities: [{ id: 'light.' + 'x'.repeat(40) }] }, { entities: [{ id: 'light.a' }, { id: 'light.a' }] },
        { entities: Array.from({ length: 8 }, (v, i) => ({ id: 'light.l' + i })) }, { entities: [null] }]) {
        const before = JSON.stringify(s.stored());
        r = await call(s, 'POST', 'config', bad);
        assert.equal(r.code, 400, JSON.stringify(bad)); assert.ok(r.body.error); assert.equal(JSON.stringify(s.stored()), before, 'nothing saved');
    }
    r = await call(s, 'POST', 'config', 'not json'); assert.equal(r.code, 400);
    r = await call(s, 'POST', 'config', '[]'); assert.equal(r.code, 400);
    r = await call(s, 'POST', 'config', 'x'.repeat(20000)); assert.equal(r.code, 400);
    assert.equal((await call(s, 'GET', 'nope')).handled, false);
    assert.equal((await call(s, 'PUT', 'config')).handled, false);
});

T('the picker lists the supported entities from HA, marks those the card cannot take, and says what went wrong', async () => {
    const f = fakeHa(), port = await f.listen();
    f.add('light.kitchen', 'on', 'Kitchen'); f.add('lock.door', 'locked', 'Door'); f.add('cover.garage', 'closed', 'Garage'); f.add('sensor.t', '20', 'Temp');
    f.add('scene.z', 'x', 'Zeta'); f.add('light.' + 'q'.repeat(50), 'off', 'Too long id');
    const s = shard({ url: '127.0.0.1:' + port, token: 'T' });
    let r = await call(s, 'GET', 'entities');
    assert.equal(r.code, 200);
    assert.deepEqual(r.body.entities.map(e => [e.name, e.kind, e.usable]), [['Kitchen', 'switch', true], ['Too long id', 'switch', false], ['Zeta', 'run', true]]);
    f.mode = { status: 401 }; r = await call(s, 'GET', 'entities'); assert.equal(r.code, 502); assert.equal(r.body.error, 'Token refused');
    assert.equal((await call(shard(), 'GET', 'entities')).code, 400);
    s.stop(); f.close();
});

T('the page is HTML and builds its rows with textContent, not innerHTML from Home Assistant names', async () => {
    const r = await call(shard(), 'GET', 'ui');
    assert.equal(r.code, 200); assert.match(r.headers['content-type'], /text\/html/); assert.match(r.text, /color-scheme/);
    assert.ok(!/fetch\(['"]\//.test(r.text), 'relative URLs only');
    const uses = r.text.match(/innerHTML[^;]*;/g) || [];
    assert.ok(uses.length > 0 && uses.every(u => /^innerHTML = '';$/.test(u)), 'innerHTML only clears a list: ' + uses.join(' | '));
});
