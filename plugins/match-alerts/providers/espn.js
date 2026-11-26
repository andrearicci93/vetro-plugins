'use strict';
// ESPN public scoreboard: teams, matches, summaries, next-fixture scan and normalization.
// Plain ES5 (the TV runs Node 4.4). No network or notification code lives here: the Shard injects
// getJson/clean/addLog/fmtKick and owns the local HTTP client and the notify path.
module.exports = function (env) {
    var getJson = env.getJson, clean = env.clean, addLog = env.addLog;
    var fmtKick = env.fmtKick, OTHER = env.OTHER;
    var compCache = {};            // "soccer/por.1" -> { at, nextAt, events }
    var sumCache = {};             // event id -> { at, events } (summary: scorer, cards, subs)
    var sumPending = {}, sumWait = {}; // one in-flight summary per match, shared by all my clubs in it
    var dayCache = {};             // "soccer/<comp>|YYYYMMDD" -> { at, events }, shared by every club
    var seasonCache = {};          // "racing/f1|2026" -> { at, nextAt, events } for the season picker
    var nextHint = {};             // watch key -> { date: YYYYMMDD } of the last found fixture

    function espnSide(c) {
        var t = c.team || c.athlete || {};
        return {
            id: String(t.id || c.id || ''),
            name: String(t.displayName || t.fullName || t.name || ''),
            short: String(t.shortDisplayName || t.shortName || t.name || t.displayName || ''),
            score: parseInt(c.score, 10) || 0
        };
    }
    function espnEvent(d) {
        var typ = (d.type && d.type.text) || '', tl = typ.toLowerCase();
        var kind = '';
        if (d.scoringPlay || /goal|penalty - scored|own goal/.test(tl)) { kind = 'goal'; }
        // ESPN reports a saved/missed penalty as "Penalty - Saved" with scoringPlay=false, so it
        // used to be dropped entirely: no goal and no banner. Announce it as its own event.
        else if (/penalty/.test(tl)) { kind = /award/.test(tl) ? 'penalty' : 'penMiss'; }
        else if (/yellow card/.test(tl)) { kind = 'cardY'; }
        else if (/red card/.test(tl)) { kind = 'cardR'; }
        else if (/substitution/.test(tl)) { kind = 'sub'; }
        else { return null; }
        var parts = d.participants || [], i, p = null, q = null, role;
        // ESPN key events mark the scorer/assist explicitly in some feeds and only order them in
        // others. Prefer the explicit role, then the first athlete involved, then the first player.
        for (i = 0; i < parts.length; i++) {
            role = String(parts[i].type || '');
            if (!p && /scor|goal/i.test(role)) { p = parts[i].athlete || parts[i]; }
            else if (!q && /assist/i.test(role)) { q = parts[i].athlete || parts[i]; }
        }
        if (!p) { p = (d.athletesInvolved && d.athletesInvolved[0]) || (parts[0] && parts[0].athlete) || null; }
        if (!q) { q = (parts[1] && parts[1].athlete) || null; }
        p = p || {}; q = q || {};
        var player = String(p.displayName || p.fullName || p.shortName || '');
        if (!player && kind === 'goal') {
            // Last resort: the scorer is named in the event text but has no athlete object.
            var txt = String(d.text || typ);
            var g1 = /(?:scored\s+by|goal\s+by|golo\s+de)\s+([A-Za-z\u00C0-\u024F][^,.!?]+)/i.exec(txt);
            var g2 = /^([A-Za-z\u00C0-\u024F][^,.!?]+?)\s+(?:scores?|goals?|marca)/i.exec(txt);
            player = g1 ? clean(g1[1], 40) : (g2 ? clean(g2[1], 40) : '');
        }
        return {
            kind: kind, teamId: String((d.team && d.team.id) || ''),
            minute: (d.clock && d.clock.displayValue) || '',
            player: player,
            detail: String(q.displayName || q.fullName || q.shortName || ''),
            text: String(d.text || typ)
        };
    }
    function espnEvents(items) {
        var out = [], i, ev;
        for (i = 0; i < items.length; i++) { ev = espnEvent(items[i]); if (ev) { out.push(ev); } }
        return out;
    }
    function espnNorm(e) {
        var comp = (e.competitions && e.competitions[0]) || {}, cs = comp.competitors || [], i;
        var home = null, away = null, st = (e.status && e.status.type) || {};
        for (i = 0; i < cs.length; i++) {
            if (cs[i].homeAway === 'home') { home = espnSide(cs[i]); }
            else { away = espnSide(cs[i]); }
        }
        if (!home || !away) { return null; }
        return {
            id: 'espn-' + e.id, state: st.state || '', desc: st.description || '',
            clock: (e.status && e.status.displayClock) || '', date: e.date,
            home: home, away: away, events: espnEvents(comp.details || [])
        };
    }
    // Racing has no home/away: competitors are drivers with an `order` (the position). Only the
    // leader and the runner-up are kept, which is all a banner needs.
    function espnRaceNorm(e) {
        var comp = (e.competitions && e.competitions[0]) || {}, cs = comp.competitors || [], i, list = [];
        for (i = 0; i < cs.length; i++) {
            var t = cs[i].athlete || cs[i].team || {};
            var name = String(t.displayName || t.fullName || t.name || '');
            if (name) { list.push({ order: parseInt(cs[i].order, 10) || 99, id: String(t.id || ''), name: name }); }
        }
        if (!list.length) { return null; }
        list.sort(function (a, b) { return a.order - b.order; });
        var st = (e.status && e.status.type) || {};
        return {
            id: 'espn-' + e.id, state: st.state || '', desc: String(e.name || st.description || ''),
            clock: '', date: e.date, race: true,
            home: { id: list[0].id, name: list[0].name, short: list[0].name, score: 0 },
            away: { id: list[1] ? list[1].id : '', name: list[1] ? list[1].name : '', short: list[1] ? list[1].name : '', score: 0 },
            events: []
        };
    }
    function espnTeams(sport, league, cb) {
        var p = sport === 'soccer' ? 'soccer/' + league : ((OTHER[sport] || OTHER.basketball).espn);
        getJson('site.api.espn.com', '/apis/site/v2/sports/' + p + '/teams', {}, function (err, d) {
            if (err) { return cb(err); }
            var list = [];
            try {
                d.sports[0].leagues[0].teams.forEach(function (t) {
                    var side = espnSide({ team: t.team || t, score: 0 });
                    if (side.id && side.name) { list.push({ id: side.id, name: side.name }); }
                });
            } catch (e) { return cb('unexpected answer'); }
            cb(null, list);
        });
    }
    // One scoreboard per competition, cached: 20 s while a match is live or about to start (within
    // 30 min), 2 min otherwise and 5 min when it is empty. Five competitions = five fetches, not one
    // per club; two picks of the same sport share that one fetch but keep their own baselines.
    function compEvents(sportPath, cb) {
        var hit = compCache[sportPath];
        if (hit && Date.now() < hit.nextAt) { return cb(null, hit.events); }
        getJson('site.api.espn.com', '/apis/site/v2/sports/' + sportPath + '/scoreboard', {}, function (err, data) {
            if (err) { return cb(err); }
            var evs = (data && data.events) || [], live = false, soon = false, i, st, kick;
            for (i = 0; i < evs.length; i++) {
                st = (evs[i].status || {}).type || {};
                if (st.state === 'in') { live = true; }
                if (st.state === 'pre') {
                    kick = new Date(evs[i].date).getTime();
                    if (kick - Date.now() < 1800000) { soon = true; }
                }
            }
            var ttl = (live || soon) ? 20000 : (evs.length ? 120000 : 300000);
            compCache[sportPath] = { at: Date.now(), events: evs, nextAt: Date.now() + ttl };
            cb(null, evs);
        });
    }
    // The plain scoreboard only carries the current race. ESPN accepts one ?dates=YYYY per request
    // and answers with every event of that season, which is what the F1 picker needs.
    function seasonRaces(sportPath, cb) {
        var year = String(new Date().getFullYear()), key = sportPath + '|' + year, hit = seasonCache[key];
        if (hit && Date.now() < hit.nextAt) { return cb(null, hit.events); }
        getJson('site.api.espn.com', '/apis/site/v2/sports/' + sportPath + '/scoreboard?dates=' + year, {}, function (err, data) {
            if (err) { return cb(err); }
            var evs = (data && data.events) || [];
            if (!evs.length) { return cb('empty season'); }
            seasonCache[key] = { at: Date.now(), events: evs, nextAt: Date.now() + 21600000 }; // 6 h
            cb(null, evs);
        });
    }
    // Compare a race label with an ESPN event name ignoring common words and punctuation.
    function raceKey(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
            .replace(/\b(grand|prix|formula|f1|1|race|the|of|20\d\d)\b/g, ' ')
            .replace(/\s+/g, ' ').trim();
    }
    function findMatch(evs, sport, teamId, name) {
        var i, j, m, want, label, ev = null;
        if (sport === 'f1') {
            // A race pick carries the ESPN event id in `teamId`; older configs had only a label.
            // Match the id first, then a distinctive name. Never fall back to evs[0] for an explicit
            // pick: a stale id/name would silently follow a different Grand Prix and announce its
            // winner. Only the legacy generic pick (no id, no distinctive name) uses evs[0].
            if (teamId) {
                for (i = 0; i < evs.length; i++) {
                    if (String(evs[i].id) === String(teamId)) { ev = evs[i]; break; }
                }
            }
            want = raceKey(name);
            if (!ev && want.length >= 3) {
                for (i = 0; i < evs.length && !ev; i++) {
                    label = raceKey(evs[i].name || evs[i].shortName || evs[i].shortDisplayName || evs[i].displayName || '');
                    if (label.length >= 3 && (label === want || label.indexOf(want) > -1 || want.indexOf(label) > -1)) { ev = evs[i]; }
                }
            }
            if (!ev) {
                if (teamId || want.length >= 3) { return null; }
                ev = evs[0];
            }
            return ev ? { m: espnRaceNorm(ev), raw: ev } : null;
        }
        for (i = 0; i < evs.length; i++) {
            var cs = ((evs[i].competitions || [])[0] || {}).competitors || [];
            for (j = 0; j < cs.length; j++) {
                if (espnSide(cs[j]).id === teamId) {
                    m = espnNorm(evs[i]);
                    if (m) { return { m: m, raw: evs[i] }; }
                }
            }
        }
        return null;
    }
    // The summary adds scorer and substitutions. It is kept after the final whistle too: going back
    // to the scoreboard details at "post" made the last goal look new and repeat.
    function withSummary(sportPath, raw, m, cb) {
        if (m.race || m.state === 'pre' || sportPath.indexOf('soccer') !== 0) { return cb(); }
        var id = raw.id, hit = sumCache[id], ttl = m.state === 'post' ? 600000 : 60000;
        if (hit && Date.now() - hit.at < ttl) { m.events = hit.events; return cb(); }
        function finish() { if (sumCache[id]) { m.events = sumCache[id].events; } cb(); }
        // Two of my clubs in the same match used to fire two identical summary requests before
        // either filled the cache. Queue the second caller and give it the same result.
        if (sumPending[id]) {
            sumWait[id] = sumWait[id] || [];
            sumWait[id].push(finish);
            return;
        }
        sumPending[id] = true;
        getJson('site.api.espn.com', '/apis/site/v2/sports/' + sportPath + '/summary?event=' + id, {}, function (e2, sum) {
            if (!e2 && sum && sum.keyEvents) {
                if (Object.keys(sumCache).length > 60) { sumCache = {}; }
                sumCache[id] = { at: Date.now(), events: espnEvents(sum.keyEvents) };
            } else if (hit) { sumCache[id] = hit; }
            delete sumPending[id];
            var q = sumWait[id] || [], i;
            delete sumWait[id];
            for (i = 0; i < q.length; i++) { q[i](); }
            finish();
        });
    }

    // ---- next fixture: day-by-day scoreboard scan, shared by every club of a competition ---------
    function ymd(d) {
        return String(d.getFullYear()) + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
    }
    function dayEvents(path, day, cb) {
        var key = path + '|' + ymd(day), hit = dayCache[key];
        if (hit && Date.now() - hit.at < 3600000) { return cb(null, hit.events); }
        getJson('site.api.espn.com', '/apis/site/v2/sports/' + path + '/scoreboard?dates=' + ymd(day), {}, function (err, data) {
            if (err) { return cb(err); }
            var evs = (data && data.events) || [];
            dayCache[key] = { at: Date.now(), events: evs };
            if (Object.keys(dayCache).length > 80) {
                Object.keys(dayCache).forEach(function (k) {
                    if (Date.now() - dayCache[k].at > 7200000) { delete dayCache[k]; }
                });
            }
            cb(null, evs);
        });
    }
    function dateFromYmd(s) {
        var m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ''));
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
    }
    // The ESPN scoreboard accepts one date at a time (a date range returns 400). Scan day by day,
    // but start at the day of the last found fixture: normally fixtures do not move earlier, so
    // following 5 competitions costs one request instead of 5 x 5.
    function scanNext(w, cb) {
        var now = Date.now(), day = new Date(), hd, diff;
        day.setHours(0, 0, 0, 0);
        var hint = nextHint[w.key], dnum = 0, found = null;
        if (hint && (hd = dateFromYmd(hint.date))) {
            diff = Math.round((hd.getTime() - day.getTime()) / 86400000);
            if (diff >= 0 && diff <= 7) { dnum = diff; }
        }
        function nextDay() {
            if (found || dnum > 7) { return cb(found); }
            var d = new Date(day.getTime() + dnum * 86400000), comps = w.comps, ci = 0;
            function nextComp() {
                if (ci >= comps.length) { dnum++; return nextDay(); }
                var path = 'soccer/' + comps[ci++];
                // Today's scoreboard is already in compCache from the normal poll: reuse it.
                if (dnum === 0) {
                    var hit0 = compCache[path];
                    if (hit0 && Date.now() - hit0.at < 120000) { return use(hit0.events, nextComp); }
                }
                dayEvents(path, d, function (err, evs) { use(err ? [] : evs, nextComp); });
            }
            function use(evs, next) {
                var i, j, cs, m, t, comp = comps[ci - 1];
                for (i = 0; i < evs.length; i++) {
                    if (((evs[i].status || {}).type || {}).state !== 'pre') { continue; }
                    t = new Date(evs[i].date).getTime();
                    if (!(t > now - 1800000)) { continue; }
                    cs = ((evs[i].competitions || [])[0] || {}).competitors || [];
                    for (j = 0; j < cs.length; j++) {
                        if (espnSide(cs[j]).id !== w.teamId) { continue; }
                        m = espnNorm(evs[i]);
                        if (!m) { break; }
                        var g = {
                            key: w.key, id: m.id, club: w.name, comp: comp,
                            home: m.home.name, away: m.away.name,
                            date: evs[i].date, dateMs: t, line: fmtKick(t, w.lang)
                        };
                        if (!found || t < found.dateMs) { found = g; }
                        break;
                    }
                }
                next();
            }
            nextComp();
        }
        nextDay();
    }
    function sportPath(w, comp) {
        if (w.kind === 'club') { return 'soccer/' + comp; }
        return (OTHER[w.sport] || OTHER.basketball).espn;
    }
    // ESPN serves team crests as PNGs. Verify with a HEAD request before using a new sport path:
    // soccer/nba/nhl/nfl work; mlb/500/<id>.png is 404 for some ids, so it is simply left empty.
    function logoFor(kind, provider, sport, teamId) {
        if (!teamId || !/^\d{1,8}$/.test(String(teamId))) { return ''; }
        if (kind === 'club') {
            return provider === 'espn' ? 'https://a.espncdn.com/i/teamlogos/soccer/500/' + teamId + '.png' : '';
        }
        var map = { basketball: 'nba', baseball: 'mlb', hockey: 'nhl', nfl: 'nfl' };
        return map[sport] ? 'https://a.espncdn.com/i/teamlogos/' + map[sport] + '/500/' + teamId + '.png' : '';
    }

    return {
        espnSide: espnSide, espnEvent: espnEvent, espnEvents: espnEvents,
        espnNorm: espnNorm, espnRaceNorm: espnRaceNorm, espnTeams: espnTeams,
        compEvents: compEvents, seasonRaces: seasonRaces, findMatch: findMatch, withSummary: withSummary,
        ymd: ymd, dayEvents: dayEvents, scanNext: scanNext,
        sportPath: sportPath, logoFor: logoFor,
        cache: function (path) { return compCache[path]; },
        // A failed competition gets a short cache so it is retried in 2 min without holding back
        // the clubs whose competitions were analysed successfully.
        cacheFail: function (path) { compCache[path] = { at: Date.now(), events: [], nextAt: Date.now() + 120000 }; },
        hints: function () { return nextHint; },
        setHints: function (h) { nextHint = h && typeof h === 'object' ? h : {}; },
        clearHint: function (key) { if (!nextHint[key]) { return false; } delete nextHint[key]; return true; },
        cacheForTest: function (path) { return compCache[path]; },
        reset: function () {
            compCache = {}; sumCache = {}; sumPending = {}; sumWait = {}; dayCache = {}; nextHint = {};
        }
    };
};
