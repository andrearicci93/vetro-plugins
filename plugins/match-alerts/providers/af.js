'use strict';
// Optional API-Football provider (football only). No key is shipped: the Shard injects getKey()
// so the secret stays in ctx.config and never appears in a route response or in this file.
module.exports = function (env) {
    var getJson = env.getJson, clean = env.clean, byId = env.byId;
    var COMPS = env.COMPS, getKey = env.getKey;
    var af = { live: false, nextKick: {} };

    function afGet(p, cb) {
        var key = getKey();
        if (!key) { return cb('no API-Football key set'); }
        getJson('v3.football.api-sports.io', p, { 'x-apisports-key': key }, function (err, d) {
            if (err) { return cb(err); }
            var e = d && d.errors;
            if (e && ((Array.isArray(e) && e.length) || (!Array.isArray(e) && Object.keys(e).length))) {
                return cb('API-Football: ' + clean(JSON.stringify(e), 120));
            }
            cb(null, d && d.response);
        });
    }
    function afEvents(items) {
        var out = [], i, d, kind = '', extra = '';
        for (i = 0; i < (items || []).length; i++) {
            d = items[i]; kind = String(d.type || ''); extra = String(d.detail || '');
            if (/missed/i.test(extra)) { continue; }
            if (/card/i.test(kind) || /card/i.test(extra)) {
                kind = /red/i.test(extra) ? 'cardR' : 'cardY';
            } else if (/goal/i.test(kind) || /penalty/i.test(extra)) { kind = 'goal'; }
            else if (/subst/i.test(kind)) { kind = 'sub'; }
            else { continue; }
            out.push({
                kind: kind, teamId: String((d.team && d.team.id) || ''),
                minute: (d.time && d.time.elapsed) ? String(d.time.elapsed) + "'" : '',
                player: String((d.player && d.player.name) || ''),
                detail: String((d.assist && d.assist.name) || extra),
                text: extra || kind
            });
        }
        return out;
    }
    function afNorm(f) {
        var s = f.fixture && f.fixture.status && f.fixture.status.short || 'NS';
        var st = (s === 'NS' || s === 'TBD' || s === 'PST') ? 'pre' :
            (/^(FT|AET|PEN|CANC|ABD|AWD|WO)$/.test(s) ? 'post' : 'in');
        return {
            id: 'af-' + f.fixture.id, state: st,
            desc: s === 'HT' ? 'Halftime' : String((f.fixture.status && f.fixture.status.long) || s),
            clock: f.fixture.status && f.fixture.status.elapsed ? f.fixture.status.elapsed + "'" : '',
            date: f.fixture.date,
            home: { id: String(f.teams.home.id), name: f.teams.home.name, short: f.teams.home.name, score: f.goals && f.goals.home || 0 },
            away: { id: String(f.teams.away.id), name: f.teams.away.name, short: f.teams.away.name, score: f.goals && f.goals.away || 0 },
            events: afEvents(f.events)
        };
    }
    function afTeams(league, cb) {
        var d = new Date(), season = d.getMonth() < 6 ? d.getFullYear() - 1 : d.getFullYear();
        var lg = byId(COMPS, league);
        afGet('/teams?league=' + ((lg && lg.af) || 94) + '&season=' + season, function (err, list) {
            if (err) { return cb(err); }
            cb(null, (list || []).map(function (t) { return { id: String(t.team.id), name: t.team.name }; }));
        });
    }

    return {
        afGet: afGet, afEvents: afEvents, afNorm: afNorm, afTeams: afTeams,
        state: function () { return af; },
        reset: function () { af = { live: false, nextKick: {} }; }
    };
};
