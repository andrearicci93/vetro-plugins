'use strict';
// Home Assistant: a Vetro Shard that adds one card to the launcher's Control center (Down on the apps row) and a page in the dashboard
// to set it up. The card lists up to 7 entities you chose (lights, switches, scenes, scripts, buttons) with their state; OK on a row
// switches it. It talks only to the Home Assistant address you set, through HA's REST API with a long-lived access token.
// Plain ES5 (var, function): older TVs run Node 4.4. The launcher never runs this code: Vetro asks card() and cardSelect() for it.
//
// Rows are never ticked. The Control center ignores OK on a ticked row, and a light you can only turn on is no use: the state is
// written in the row's value ("Living room · on") and OK sends turn_on or turn_off for the opposite of what the row shows.

var fs = require('fs');
var path = require('path');
var ha = require('./ha.js');

module.exports = function (ctx) {
    var READ_MS = 2500;            // card(): the host gives up after 3 s
    var ACTION_MS = 8500;          // cardSelect(): the host gives up after 10 s, in all (one read at most, then the service call)
    var MAX_BODY = 16 * 1024;

    var cfg = null;                // {url, token, entities: [{id, name}]}, read from ctx.config
    var shown = null;              // what the card last showed: {rows: [...], states: {id: 'on'|'off'|...}}
    var lastError = null;
    var client = new ha.Client(function () { return conf(); });

    function cleanEntities(list) {
        var out = [], seen = {};
        if (!Array.isArray(list)) return out;
        for (var i = 0; i < list.length && out.length < ha.MAX_ENTITIES; i++) {
            var e = list[i];
            if (!e || typeof e !== 'object' || !ha.entityDomain(e.id) || seen[e.id]) continue;
            seen[e.id] = true;
            out.push({ id: e.id, name: ha.plain(e.name, ha.NAME_MAX) });
        }
        return out;
    }

    function readConfig() {
        var raw = null;
        try { raw = ctx.config.get(); } catch (e) { raw = null; }
        if (!raw || typeof raw !== 'object') raw = {};
        return { url: typeof raw.url === 'string' ? raw.url : '', token: typeof raw.token === 'string' ? raw.token : '', entities: cleanEntities(raw.entities) };
    }
    function conf() { return cfg || (cfg = readConfig()); }
    function configured() { var c = conf(); return !!ha.parseAddress(c.url) && ha.validToken(c.token); }
    function find(id) { var l = conf().entities; for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }

    function json(res, body, code) {
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }
    function html() {
        var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
        for (var i = 0; i < places.length; i++) { try { return fs.readFileSync(places[i], 'utf8'); } catch (e) { /* next */ } }
        return '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><body style="font:16px system-ui;margin:24px">ui.html is missing from this Shard.</body>';
    }
    function readBody(req, cb) {
        var chunks = [], size = 0, done = false;
        req.on('data', function (c) { size += c.length; if (size > MAX_BODY) { if (!done) { done = true; cb(new Error('Request too large')); } return; } chunks.push(c); });
        req.on('end', function () {
            if (done) return;
            done = true;
            var p;
            try { p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return cb(new Error('Invalid JSON')); }
            if (!p || typeof p !== 'object' || Array.isArray(p)) return cb(new Error('Invalid JSON'));
            cb(null, p);
        });
        req.on('error', function (e) { if (!done) { done = true; cb(e); } });
    }

    // ---- the card --------------------------------------------------------------------------------------------------------------------

    function rowsOf(c, results) {
        var rows = [], states = {}, switches = 0, on = 0;
        for (var i = 0; i < c.entities.length; i++) {
            var e = c.entities[i], def = ha.DOMAINS[ha.entityDomain(e.id)], r = results[i];
            if (def.kind === 'run') { rows.push({ id: e.id, label: e.name || e.id, value: def.value, ticked: false }); continue; }
            switches++;
            var label = e.name || (r.state && r.state.attributes && ha.plain(r.state.attributes.friendly_name, ha.NAME_MAX)) || e.id, value;
            if (r.state && typeof r.state.state === 'string') {
                value = ha.plain(r.state.state, 24);
                states[e.id] = value;
                if (value === 'on') on++;
            } else value = r.err && r.err.status === 404 ? 'missing' : 'n/a';
            rows.push({ id: e.id, label: label, value: value, ticked: false });
        }
        return { rows: rows, states: states, note: switches ? on + ' of ' + switches + ' on' : '' };
    }

    // One GET per chosen entity that has a state, all at once (never /api/states: on a real HA that is thousands of entities).
    function card() {
        var c = conf();
        if (!configured()) return { rows: [], note: 'Set the Home Assistant address in the Shard page', choosable: false };
        if (!c.entities.length) return { rows: [], note: 'Choose entities in the Shard page', choosable: false };
        var reads = c.entities.map(function (e) {
            if (ha.DOMAINS[ha.entityDomain(e.id)].kind === 'run') return Promise.resolve({});
            return client.request('GET', '/api/states/' + e.id, null, READ_MS, 64 * 1024).then(
                function (r) { return { state: r.json }; },
                function (err) { return { err: err }; });
        });
        return Promise.all(reads).then(function (results) {
            var asked = 0, failed = [], i;
            for (i = 0; i < results.length; i++) {
                if (ha.DOMAINS[ha.entityDomain(c.entities[i].id)].kind === 'run') continue;
                asked++;
                if (results[i].err && results[i].err.status !== 404) failed.push(results[i].err);
            }
            if (asked && failed.length === asked) {
                var worst = failed[0];
                for (i = 0; i < failed.length; i++) if (failed[i].status === 401 || failed[i].status === 403) worst = failed[i];
                lastError = ha.reasonOf(worst);
                throw new Error(lastError);
            }
            lastError = null;
            var built = rowsOf(c, results);
            shown = { rows: built.rows, states: built.states };
            return { rows: built.rows, note: built.note, choosable: true };
        });
    }

    function shownRows() { return shown ? { rows: shown.rows.map(function (r) { return { id: r.id, label: r.label, value: r.value, ticked: false }; }) } : {}; }

    // A press that did not work: the card stays as it was, with a note. The rows go back too, so the host does not read the card again
    // (with Home Assistant down that read would add 2.5 s to an action that already took 8.5, past the launcher's 12 s).
    function refused(note) { var out = shownRows(); out.ok = false; out.note = note; return out; }
    function noteFor(err) { lastError = ha.reasonOf(err); return refused(lastError); }

    // OK on a row. Never throws and never rejects: a failure is {ok: false, note}, so the card stays and says why.
    function cardSelect(rowId) {
        try {
            var ent = find(rowId);
            if (!ent || !configured()) return refused(ent ? 'Set the Home Assistant address in the Shard page' : 'Not one of the chosen entities');
            var domain = ha.entityDomain(ent.id), def = ha.DOMAINS[domain], started = Date.now();
            var call = function (service, budget) {
                return client.request('POST', '/api/services/' + domain + '/' + service, { entity_id: ent.id }, Math.max(1500, budget), 256 * 1024);
            };
            if (def.kind === 'run') {
                return call(def.service, ACTION_MS).then(function () { lastError = null; var s = shownRows(); s.ok = true; return s; }, noteFor);
            }
            // The state the row showed decides what OK means: the user pressed "turn this off" because the row said "on". A fresh read
            // is only for a row nobody has shown yet.
            var known = shown && shown.states[ent.id];
            var state = known ? Promise.resolve(known) : client.request('GET', '/api/states/' + ent.id, null, READ_MS, 64 * 1024).then(function (r) {
                return r.json && typeof r.json.state === 'string' ? r.json.state : 'unknown';
            });
            return state.then(function (now) {
                if (now === 'unavailable') return refused((ent.name || ent.id) + ' is unavailable');
                var want = now === 'on' ? 'off' : 'on';
                return call('turn_' + want, ACTION_MS - (Date.now() - started)).then(function (r) {
                    // HA answers with the states that changed during the call; if the entity is not among them (a slow device), expect the new one.
                    var after = want, list = r.json;
                    if (Array.isArray(list)) {
                        for (var i = 0; i < list.length; i++) {
                            if (list[i] && list[i].entity_id === ent.id && typeof list[i].state === 'string') { after = ha.plain(list[i].state, 24); break; }
                        }
                    }
                    lastError = null;
                    if (!shown) return { ok: true };
                    shown.states[ent.id] = after;
                    for (var j = 0; j < shown.rows.length; j++) if (shown.rows[j].id === ent.id) shown.rows[j].value = after;
                    var out = shownRows();
                    out.ok = true;
                    return out;
                }, noteFor);
            }, noteFor);
        } catch (e) { return refused(ha.reasonOf(e)); }
    }

    // ---- the page --------------------------------------------------------------------------------------------------------------------

    function publicConfig() {
        var c = conf();
        return { url: c.url, hasToken: !!c.token, entities: c.entities, max: ha.MAX_ENTITIES };
    }

    // Applies what the page sent. Only the keys that are there change. The token is never sent back to the page, and it does not follow
    // the address: a new address without a new token forgets the old one.
    function applyConfig(p) {
        var cur = conf(), next = { url: cur.url, token: cur.token, entities: cur.entities }, i;
        var typed = typeof p.token === 'string' ? p.token.replace(/^\s+|\s+$/g, '') : '';
        if (p.url !== undefined) {
            if (typeof p.url !== 'string') return { error: 'The address must be text' };
            var text = p.url.replace(/^\s+|\s+$/g, '');
            if (!text) { next.url = ''; next.token = ''; }
            else {
                var addr = ha.parseAddress(text), old = ha.parseAddress(cur.url);
                if (!addr) return { error: 'Not an address: use http://192.168.1.20:8123 (no user name or password in it)' };
                if (!old || old.text !== addr.text) next.token = '';
                next.url = addr.text;
            }
        }
        if (p.clearToken === true) next.token = '';
        if (typed) {
            if (!ha.validToken(typed)) return { error: 'That is not an access token (letters and digits, no spaces)' };
            next.token = typed;
        }
        if (p.entities !== undefined) {
            if (!Array.isArray(p.entities) || p.entities.length > ha.MAX_ENTITIES) return { error: 'The card holds at most ' + ha.MAX_ENTITIES + ' entities' };
            var seen = {}, list = [];
            for (i = 0; i < p.entities.length; i++) {
                var e = p.entities[i];
                if (!e || typeof e !== 'object' || !ha.entityDomain(e.id)) return { error: String(e && e.id).slice(0, 60) + ' cannot be on the card (not a light, switch, fan, scene, script or button, or longer than ' + ha.ID_MAX + ' characters)' };
                if (seen[e.id]) return { error: e.id + ' is listed twice' };
                seen[e.id] = true;
                list.push({ id: e.id, name: ha.plain(e.name, ha.NAME_MAX) });
            }
            next.entities = list;
        }
        try { ctx.config.set(next); } catch (err) { return { error: 'Could not save: ' + ha.plain(err && err.message, 80) }; }
        var forgot = !!cur.token && !next.token;
        cfg = next;
        shown = null;
        return { ok: true, tokenForgotten: forgot };
    }

    // What the picker offers: every entity of a supported type, from one /api/states call (the only place that reads them all).
    function listEntities(res) {
        if (!configured()) return json(res, { error: 'Save the address and the access token first' }, 400);
        client.request('GET', '/api/states', null, 9000, 12 * 1024 * 1024).then(function (r) {
            var out = [], list = Array.isArray(r.json) ? r.json : [];
            for (var i = 0; i < list.length && out.length < 800; i++) {
                var s = list[i], id = s && s.entity_id;
                if (typeof id !== 'string') continue;
                var m = /^([a-z_]+)\./.exec(id), def = m && Object.prototype.hasOwnProperty.call(ha.DOMAINS, m[1]) ? ha.DOMAINS[m[1]] : null;
                if (!def) continue;
                var name = ha.plain(s.attributes && s.attributes.friendly_name, ha.NAME_MAX) || id.slice(0, ha.NAME_MAX);
                out.push({ id: id.slice(0, 80), name: name, state: ha.plain(s.state, 24), kind: def.kind, usable: !!ha.entityDomain(id) });
            }
            out.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0; });
            lastError = null;
            json(res, { entities: out });
        }).then(null, function (err) {
            lastError = ha.reasonOf(err);
            if (!res.headersSent) json(res, { error: lastError }, 502);
        });
    }

    return {
        start: function () { cfg = readConfig(); shown = null; lastError = null; },
        stop: function () { client.abortAll(); shown = null; },

        // Nothing secret: the dashboard shows this. Not the token, not the full address.
        status: function () {
            var a = ha.parseAddress(conf().url);
            return { configured: configured(), host: a ? a.hostname + ':' + a.port : null, entities: conf().entities.length, error: lastError };
        },

        card: card,
        cardSelect: cardSelect,

        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(html());
                return true;
            }
            if (sub === 'config' && req.method === 'GET') { json(res, publicConfig()); return true; }
            if (sub === 'config' && req.method === 'POST') {
                readBody(req, function (err, p) {
                    if (err) return json(res, { error: err.message }, 400);
                    var r = applyConfig(p);
                    if (r.error) return json(res, { error: r.error }, 400);
                    var out = publicConfig();
                    out.tokenForgotten = r.tokenForgotten;
                    json(res, out);
                });
                return true;
            }
            if (sub === 'entities' && req.method === 'GET') { listEntities(res); return true; }
            return false;
        }
    };
};
