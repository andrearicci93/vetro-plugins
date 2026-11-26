'use strict';
// TV alerts: sport, weather and news banners for Samsung TVs through the Notification Center Shard.
// Plain ES5 (old TVs run Node 4.4). Outgoing: HTTPS GET to the public sources, POST notify on 127.0.0.1:8099.
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');

var NOTIFY = '/plugins/notification-center/api/notify';
var TITLE_PRE = 'PRE-MATCH';   // exact title for the kick-off warning, real or tested
var MAX_BODY = 32768, MAX_HTTP = 5000000, MAX_LOG = 60;
var MAX_CLUBS = 3, MAX_PICKS = 10, MAX_FEEDS = 12, MAX_COMPS = 8, MAX_PLACES = 10;
var E = {
    ball: String.fromCharCode(0x26BD),
    net: String.fromCharCode(0xD83E, 0xDD45),
    no: String.fromCharCode(0xD83D, 0xDEAB),
    flag: String.fromCharCode(0xD83C, 0xDFC1),
    whistle: String.fromCharCode(0x23F1, 0xFE0F),
    pause: String.fromCharCode(0x23F8, 0xFE0F),
    yellow: String.fromCharCode(0xD83D, 0xDFE8),
    red: String.fromCharCode(0xD83D, 0xDFE5),
    sub: String.fromCharCode(0xD83D, 0xDD01),
    sun: String.fromCharCode(0x2600),
    cloud: String.fromCharCode(0x2601),
    rain: String.fromCharCode(0xD83C, 0xDF27),
    storm: String.fromCharCode(0x26C8),
    warn: String.fromCharCode(0x26A0, 0xFE0F),
    news: String.fromCharCode(0xD83D, 0xDCF0),
    star: String.fromCharCode(0x2B50)
};

// Places offered in the panel. Coordinates only; no personal data.
var PLACES = [
    { id: 'lisbon', name: 'Lisboa', lat: 38.7223, lon: -9.1393 },
    { id: 'porto', name: 'Porto', lat: 41.1579, lon: -8.6291 },
    { id: 'braga', name: 'Braga', lat: 41.5454, lon: -8.4265 },
    { id: 'coimbra', name: 'Coimbra', lat: 40.2033, lon: -8.4103 },
    { id: 'faro', name: 'Faro', lat: 37.0194, lon: -7.9304 },
    { id: 'fun-chal', name: 'Funchal', lat: 32.6484, lon: -16.9108 },
    { id: 'ponta', name: 'Ponta Delgada', lat: 37.7412, lon: -25.6756 },
    { id: 'madrid', name: 'Madrid', lat: 40.4168, lon: -3.7038 },
    { id: 'barcelona', name: 'Barcelona', lat: 41.3874, lon: 2.1686 },
    { id: 'london', name: 'London', lat: 51.5074, lon: -0.1278 },
    { id: 'paris', name: 'Paris', lat: 48.8566, lon: 2.3522 },
    { id: 'rome', name: 'Roma', lat: 41.9028, lon: 12.4964 }
];
var WEATHER_PROVIDERS = [
    { id: 'openmeteo', name: 'Open-Meteo (no key)' },
    { id: 'ipma', name: 'IPMA (Portugal, no key)' }
];
var WEATHER_WHEN = [
    { id: 'always', name: 'Always' },
    { id: 'morning', name: 'Morning until 10h (today)' },
    { id: 'night', name: 'Night after 18h (tomorrow)' }
];
// IPMA warning areas (idAreaAviso -> district), from the official distrits-islands.json feed.
var CIV_AREAS = [
    { id: 'ACE', name: 'Angra do Hero\u00EDsmo' }, { id: 'AOC', name: 'Santa Cruz das Flores' },
    { id: 'AOR', name: 'Vila do Porto' }, { id: 'AVR', name: 'Aveiro' },
    { id: 'BGC', name: 'Bragan\u00E7a' }, { id: 'BJA', name: 'Beja' },
    { id: 'BRG', name: 'Braga' }, { id: 'CBO', name: 'Castelo Branco' },
    { id: 'CBR', name: 'Coimbra' }, { id: 'EVR', name: '\u00C9vora' },
    { id: 'FAR', name: 'Faro' }, { id: 'GDA', name: 'Guarda' },
    { id: 'LRA', name: 'Leiria' }, { id: 'LSB', name: 'Lisboa' },
    { id: 'MCS', name: 'Funchal' }, { id: 'MPS', name: 'Porto Santo' },
    { id: 'PTG', name: 'Portalegre' }, { id: 'PTO', name: 'Porto' },
    { id: 'STB', name: 'Set\u00FAbal' }, { id: 'STM', name: 'Santar\u00E9m' },
    { id: 'VCT', name: 'Viana do Castelo' }, { id: 'VIS', name: 'Viseu' },
    { id: 'VRL', name: 'Vila Real' }
];
// Public RSS feeds, no key, all verified reachable from the TV network. Reuters and AP have no
// public RSS any more, so they go through Google News, which indexes their articles.
var GN = 'https://news.google.com/rss/search?q=';
var FEEDS = [
    { id: 'rtp', name: 'RTP Noticias (PT)', url: 'https://www.rtp.pt/noticias/rss' },
    { id: 'publico', name: 'Publico (PT)', url: 'https://feeds.feedburner.com/PublicoRSS' },
    { id: 'observador', name: 'Observador (PT)', url: 'https://observador.pt/feed/' },
    { id: 'record', name: 'Record (PT, desporto)', url: 'https://www.record.pt/rss' },
    { id: 'maisfutebol', name: 'Maisfutebol (PT, desporto)', url: 'https://maisfutebol.iol.pt/rss' },
    { id: 'bbc', name: 'BBC World (EN)', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { id: 'cnn', name: 'CNN (EN)', url: 'http://rss.cnn.com/rss/edition.rss' },
    { id: 'sky', name: 'Sky News (EN)', url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
    { id: 'nyt', name: 'New York Times (EN)', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
    { id: 'wsj', name: 'Wall Street Journal (EN)', url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml' },
    { id: 'espn', name: 'ESPN (EN, desporto)', url: 'https://www.espn.com/espn/rss/news' },
    { id: 'reuters', name: 'Reuters (via Google News)', url: GN + 'site:reuters.com&hl=en-US&gl=US&ceid=US:en' },
    { id: 'ap', name: 'AP (via Google News)', url: GN + 'site:apnews.com&hl=en-US&gl=US&ceid=US:en' },
    { id: 'gnewspt', name: 'Google News (PT)', url: 'https://news.google.com/rss?hl=pt-PT&gl=PT&ceid=PT:pt-150' }
];
// Football competitions. `af` is the API-Football league id, used only by that provider.
// All slugs were checked against ESPN; a wrong slug answers 400 and is logged, never fatal.
var COMPS = [
    { id: 'por.1', name: 'Liga Portugal', country: 'pt', af: 94 },
    { id: 'por.taca.portugal', name: 'Taca de Portugal', country: 'pt', af: 96 },
    { id: 'eng.1', name: 'Premier League', country: 'en', af: 39 },
    { id: 'eng.2', name: 'Championship', country: 'en', af: 40 },
    { id: 'eng.fa', name: 'FA Cup', country: 'en', af: 45 },
    { id: 'eng.league_cup', name: 'League Cup', country: 'en', af: 48 },
    { id: 'esp.1', name: 'La Liga', country: 'es', af: 140 },
    { id: 'esp.2', name: 'LaLiga 2', country: 'es', af: 141 },
    { id: 'esp.copa_del_rey', name: 'Copa del Rey', country: 'es', af: 143 },
    { id: 'ita.1', name: 'Serie A', country: 'it', af: 135 },
    { id: 'ita.2', name: 'Serie B', country: 'it', af: 136 },
    { id: 'ita.coppa_italia', name: 'Coppa Italia', country: 'it', af: 137 },
    { id: 'ger.1', name: 'Bundesliga', country: 'de', af: 78 },
    { id: 'ger.2', name: '2. Bundesliga', country: 'de', af: 79 },
    { id: 'ger.dfb_pokal', name: 'DFB Pokal', country: 'de', af: 81 },
    { id: 'fra.1', name: 'Ligue 1', country: 'fr', af: 61 },
    { id: 'fra.2', name: 'Ligue 2', country: 'fr', af: 62 },
    { id: 'fra.coupe_de_france', name: 'Coupe de France', country: 'fr', af: 66 },
    { id: 'ned.1', name: 'Eredivisie', country: 'nl', af: 88 },
    { id: 'uefa.champions', name: 'Champions League', country: 'eu', af: 2 },
    { id: 'uefa.europa', name: 'Europa League', country: 'eu', af: 3 },
    { id: 'uefa.europa.conf', name: 'Conference League', country: 'eu', af: 848 }
];
// Leagues whose team list the panel can load when adding a club.
var CLUB_LEAGUES = ['por.1', 'eng.1', 'eng.2', 'esp.1', 'esp.2', 'ita.1', 'ita.2',
    'ger.1', 'ger.2', 'fra.1', 'fra.2', 'ned.1'];
// Other sports. `espn` is the scoreboard path; `teams` says whether a team picker makes sense.
var OTHER = {
    basketball: { label: 'Basketball (NBA)', espn: 'basketball/nba', teams: true },
    baseball: { label: 'Baseball (MLB)', espn: 'baseball/mlb', teams: true },
    hockey: { label: 'Hockey (NHL)', espn: 'hockey/nhl', teams: true },
    nfl: { label: 'American football (NFL)', espn: 'football/nfl', teams: true },
    f1: { label: 'Formula 1 (whole race)', espn: 'racing/f1', teams: false }
};
// Notification styles offered by the Notification Center 0.8.0+. Older versions accept the
// request but store/show it as a banner.
var MODES = [
    { id: 'banner', name: 'Banner (over the running app)' },
    { id: 'full', name: 'Full screen card' },
    { id: 'overlay', name: 'Overlay bar (over the picture)' }
];
var DEFAULTS = {
    modules: { sport: true, weather: false, news: false },
    football: {
        provider: 'espn', clubs: [],
        alerts: { goal: true, against: true, card: true, sub: true, varNo: true, penalty: true, penMiss: true, start: true, half: true, end: true },
        goalSeconds: 30, otherSeconds: 10, sound: true, mode: 'overlay', volume: 100,
        nextGame: { enabled: true, minutes: 30 }
    },
    others: {
        picks: [],
        alerts: { start: true, half: true, end: true, score: false },
        seconds: 10, sound: true, mode: 'overlay', volume: 100
    },
    civ: {
        enabled: true, district: 'LRA',
        levels: { yellow: false, orange: true, red: true },
        anepc: true, news: false,
        keywords: 'emerg\u00EAncia,estado de alerta,evacua\u00E7\u00E3o,corte,sismo,inc\u00EAndio,inunda\u00E7\u00E3o,acidente grave,INEM,GNR,PSP,fecho',
        interval: 10, seconds: 20, sound: true, mode: 'overlay', volume: 100
    },
    // Test-only goal buttons in the Match panel. Separate from the clubs the Shard actually follows.
    sim: {
        clubs: [
            { id: '2250', name: 'Sporting', level: 'ok', msg: 'Sporting 1-0 Benfica' },
            { id: '1929', name: 'Benfica', level: 'alert', msg: 'Sporting 0-1 Benfica' },
            { id: '437', name: 'Porto', level: 'info', msg: 'Porto 1-0 Feyenoord' },
            { id: '142', name: 'Feyenoord', level: 'alert', msg: 'Porto 0-1 Feyenoord' }
        ]
    },
    weather: { place: 'lisbon', custom: [], provider: 'openmeteo', when: 'always', interval: 60, seconds: 12, quiet: true, sound: false, mode: 'banner', volume: 100,
        proactive: { enabled: true, minutes: 120, rain: true, wind: true, heat: true, storm: true,
            rainPct: 60, windKmh: 50, heatC: 35, stormCode: 95 } },
    news: { feeds: ['gnewspt'], interval: 30, seconds: 12, quiet: true, count: 1, sound: false, mode: 'banner', volume: 100 },
    lang: 'en'
};
var TXT = {
    en: {
        goal: 'GOAL', against: 'Goal for ', cardY: 'Yellow card', cardR: 'Red card', sub: 'Substitution',
        varNo: 'Goal disallowed', penalty: 'Penalty awarded', penMiss: 'Penalty missed', start: 'Kick-off', half: 'Half-time', end: 'Full time', score: 'Score update',
        test: 'Test', weather: 'Weather', news: 'News', quiet: 'Quiet hours', rain: 'Rain',
        win: 'WIN', lose: 'LOSS', team: 'Team', clubNews: 'Club news', soon: TITLE_PRE,
        today: 'today', tomorrow: 'tomorrow', weatherSoon: 'Weather ahead',
        wRain: 'Rain', wWind: 'Wind', wHeat: 'Heat', wStorm: 'Thunderstorm'
    },
    pt: {
        goal: 'GOLO', against: 'Golo do ', cardY: 'Cart\u00E3o amarelo', cardR: 'Cart\u00E3o vermelho',
        sub: 'Substitui\u00E7\u00E3o', varNo: 'Golo anulado', penalty: 'Penalty marcado', penMiss: 'Penalty falhado', start: 'Come\u00E7ou o jogo', half: 'Intervalo',
        end: 'Fim do jogo', score: 'Resultado atualizado', test: 'Teste', weather: 'Tempo', news: 'Not\u00EDcias',
        quiet: 'Hor\u00E1rio de sil\u00EAncio', rain: 'Chuva', win: 'VIT\u00D3RIA', lose: 'DERROTA', team: 'Equipa',
        clubNews: 'Not\u00EDcias do clube', soon: TITLE_PRE,
        today: 'hoje', tomorrow: 'amanh\u00E3', weatherSoon: 'Tempo a caminho',
        wRain: 'Chuva', wWind: 'Vento', wHeat: 'Calor', wStorm: 'Trovoada'
    }
};

module.exports = function (ctx) {
    var running = false, stopped = false;
    // Shown next to the panel title. Read once from the manifest so it cannot drift from the bundle.
    var VERSION = '';
    try { VERSION = String(JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')).version || ''); } catch (e) { VERSION = ''; }
    var timers = { sport: null, weather: null, news: null, civ: null };
    var busy = { sport: false, weather: false, news: false, civ: false };
    var historyAt = 0;             // last time the history was written to ctx.config
    var last = {};                 // "<watch>|<match>" -> baseline for score/state/events (persisted)
    var watchStatus = {};          // "<watch>" -> last line/state shown in the panel
    var seenEvent = {};            // dedupe across watches: two of my clubs in the same match (persisted)
    var nextGame = {};                 // watch key -> { at, game } for the next fixture of that club
    var nextWarned = {};               // fixture id -> true, so the pre-kick-off banner is sent once
    var weatherWarned = {};            // "type|hour" -> true, so a proactive weather alert is sent once
    var teamsCache = {}, log = [];
    var providerHealth = {};        // provider -> { okAt, failAt, fails, last }
    var HEALTH_HOSTS = {
        'site.api.espn.com': 'espn',
        'api.open-meteo.com': 'open-meteo',
        'geocoding-api.open-meteo.com': 'open-meteo',
        'api.ipma.pt': 'civ', 'prociv.gov.pt': 'civ', 'www.noticiasaominuto.com': 'civ'
    };
    var status = {
        sport: { at: 0, error: '', line: '', state: '', next: 0 },
        weather: { at: 0, error: '', line: '', state: '', next: 0 },
        civ: { at: 0, error: '', line: '', state: '', next: 0 },
        news: { at: 0, error: '', line: '', state: '', next: 0 }
    };
    var allowedSounds = null, soundTimer = null;
    var civAlerts = [], civSeen = {}, civAreas = {};

    // Split providers: all HTTP and notification code stays in this file; the modules only keep
    // their own caches and expose plain ES5 functions. require() of a file inside the bundle is
    // supported by the Vetro host (it unpacks subfolders before loading the entry file).
    var espn = require('./providers/espn')({
        getJson: getJson, clean: clean, addLog: addLog, fmtKick: fmtKick, OTHER: OTHER
    });
    var afApi = require('./providers/af')({
        getJson: getJson, clean: clean, byId: byId, COMPS: COMPS,
        getKey: function () { var k = rawCfg().keys || {}; return k.apifootball || ''; }
    });
    var newsApi = require('./news')({
        getUrl: getUrl, clean: clean, stripTags: stripTags, byId: byId,
        FEEDS: FEEDS, GN: GN, MAX_FEEDS: MAX_FEEDS, MAX_CLUBS: MAX_CLUBS,
        quietNow: quietNow, TXT: TXT, E: E, banner: banner, addLog: addLog,
        cfg: cfg, status: status, schedule: schedule, persistHistory: persistHistory,
        isRunning: function () { return running && !stopped; }
    });
    // Thin local names keep the polling code below readable and make the move behaviour-neutral.
    function espnTeams(s, l, cb) { return espn.espnTeams(s, l, cb); }
    function compEvents(p, cb) { return espn.compEvents(p, cb); }
    function espnRaces(cb) { return espn.seasonRaces('racing/f1', cb); }
    function raceRows(evs) {
        var out = [], i, e, st;
        for (i = 0; i < (evs || []).length && out.length < 40; i++) {
            e = evs[i]; st = (e.status && e.status.type) || {};
            out.push({
                id: String(e.id || ''),
                name: clean(e.name || e.shortName || e.shortDisplayName || ('Race ' + e.id), 80),
                date: String(e.date || ''), state: String(st.state || ''), past: st.state === 'post'
            });
        }
        out.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
        return out;
    }
    function findMatch(e, s, t, n) { return espn.findMatch(e, s, t, n); }
    function withSummary(p, raw, m, cb) { return espn.withSummary(p, raw, m, cb); }
    function ymd(d) { return espn.ymd(d); }
    function dayEvents(p, d, cb) { return espn.dayEvents(p, d, cb); }
    function scanNext(w, cb) { return espn.scanNext(w, cb); }
    function sportPath(w, c) { return espn.sportPath(w, c); }
    function logoFor(k, p, s, t) { return espn.logoFor(k, p, s, t); }
    function afGet(p, cb) { return afApi.afGet(p, cb); }
    function afNorm(f) { return afApi.afNorm(f); }
    function afTeams(l, cb) { return afApi.afTeams(l, cb); }
    function rssItems(xml, max) { return newsApi.rssItems(xml, max); }
    function pollNews(manual) { return newsApi.pollNews(manual); }

    // ---- small helpers --------------------------------------------------------------------------------------------------------
    function clamp(v, lo, hi, def) { var n = parseInt(v, 10); if (!(n >= lo)) { return def; } return n > hi ? hi : n; }
    function clean(s, max) { return String(s == null ? '' : s).replace(/[\x00-\x1f]/g, ' ').slice(0, max); }
    function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
    // /api/last is meant for widgets and a small read-only site: allow cross-origin reads and
    // never include ctx.config, keys or any secret in the answer.
    function sendPublicJson(res, code, obj) {
        res.writeHead(code, {
            'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS'
        });
        res.end(JSON.stringify(obj));
    }
    function readBody(req, cb) {
        var s = '';
        req.on('data', function (d) { s += d; if (s.length > MAX_BODY) { req.destroy(); } });
        req.on('end', function () { cb(s); });
    }
    function addLog(mod, kind, text) {
        log.unshift({ at: Date.now(), mod: mod, kind: kind, text: clean(text, 200) });
        if (log.length > MAX_LOG) { log.pop(); }
    }
    function byId(list, id) { var i; for (i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } } return null; }
    function dec(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
    // Feeds escape apostrophes as &#039; and friends. Decode every numeric entity plus the usual named
    // ones, otherwise the TV shows the raw code. &amp; goes last so "&amp;lt;" cannot become "<".
    function decodeEnt(s) {
        function num(n, base) {
            var c = parseInt(n, base);
            if (!(c > 0) || c > 0x10FFFF) { return null; }
            if (c > 0xFFFF) {
                c -= 0x10000;
                return String.fromCharCode(0xD800 + (c >> 10), 0xDC00 + (c & 0x3FF));
            }
            return String.fromCharCode(c);
        }
        return String(s == null ? '' : s)
            .replace(/&#(\d{1,7});/g, function (a, n) { var r = num(n, 10); return r === null ? a : r; })
            .replace(/&#x([0-9a-f]{1,6});/gi, function (a, n) { var r = num(n, 16); return r === null ? a : r; })
            .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&hellip;/g, '\u2026').replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013')
            .replace(/&lsquo;/g, '\u2018').replace(/&rsquo;/g, '\u2019')
            .replace(/&ldquo;/g, '\u201C').replace(/&rdquo;/g, '\u201D')
            .replace(/&euro;/g, '\u20AC').replace(/&pound;/g, '\u00A3').replace(/&deg;/g, '\u00B0')
            .replace(/&amp;/g, '&');
    }
    function stripTags(s) {
        return decodeEnt(String(s == null ? '' : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    }
    function quietNow() { var h = new Date().getHours(); return h >= 23 || h < 7; }
    // One banner per event, even when both clubs of the match are followed.
    function once(key) {
        var now = Date.now();
        if (seenEvent[key] && now - seenEvent[key] < 600000) { return false; }
        if (Object.keys(seenEvent).length > 300) { seenEvent = {}; }
        seenEvent[key] = now;
        return true;
    }

    // ---- HTTP -----------------------------------------------------------------------------------------------------------------
    function getRaw(host, p, headers, parse, cb) { getVia(https, host, p, headers, parse, cb); }
    function noteHealth(host, ok, err) {
        var h = String(host || ''), name = HEALTH_HOSTS[h];
        if (!name && /news\.google|rtp\.pt|publico\.pt|observador\.pt|record\.pt|maisfutebol\.pt|bbc\.|cnn\.|sky\.|nytimes\.|wsj\.|apnews\.|reuters\./.test(h)) { name = 'rss'; }
        if (!name) { return; }
        var p = providerHealth[name] || (providerHealth[name] = { okAt: 0, failAt: 0, fails: 0, last: '' });
        if (ok) { p.okAt = Date.now(); p.fails = 0; p.last = 'ok'; }
        else { p.failAt = Date.now(); p.fails++; p.last = clean(String(err || 'error'), 120); }
    }
    function getVia(lib, host, p, headers, parse, cb) {
        var done = false;
        function end(err, data) { if (!done) { done = true; noteHealth(host, !err, err); cb(err, data); } }
        var h = { 'Accept-Encoding': 'identity', 'User-Agent': 'vetro-tv-alerts' }, k;
        for (k in headers) { if (headers.hasOwnProperty(k)) { h[k] = headers[k]; } }
        try {
            var rq = lib.get({ host: host, path: p, headers: h, timeout: 12000 }, function (r) {
                var s = '';
                r.setEncoding('utf8');
                r.on('data', function (d) { s += d; if (s.length > MAX_HTTP) { r.destroy(); end('too large'); } });
                // A connection that dies mid-body used to leave the module without a next poll.
                r.on('error', function (e) { end(String(e && e.message || e)); });
                r.on('aborted', function () { end('aborted'); });
                r.on('end', function () {
                    if (r.statusCode !== 200) { return end('http ' + r.statusCode); }
                    if (!parse) { return end(null, s); }
                    try { end(null, JSON.parse(s)); } catch (e) { end('bad json'); }
                });
            });
            rq.on('error', function (e) { end(String(e && e.message || e)); });
            rq.on('timeout', function () { rq.destroy(); end('timeout'); });
        } catch (e) { end('request failed'); }
    }
    // Some feeds (CNN) are only served over plain HTTP; pick the module from the URL scheme.
    function getUrl(url, headers, parse, cb) {
        var m = /^(https?):\/\/([^\/]+)(\/.*)?$/.exec(String(url || ''));
        if (!m) { return cb('bad url'); }
        getVia(m[1] === 'http' ? http : https, m[2], m[3] || '/', headers, parse, cb);
    }
    function getJson(host, p, headers, cb) { getRaw(host, p, headers, true, cb); }
    // The Notification Center is local HTTP (not HTTPS) and describes itself. The list of sounds
    // has changed three times in a day, so read it instead of trusting a constant in this file.
    function localJson(p, cb) {
        var done = false;
        function end(err, data) { if (!done) { done = true; cb(err, data); } }
        try {
            var rq = http.get({ host: '127.0.0.1', port: 8099, path: p, timeout: 4000 }, function (r) {
                var s = '';
                r.setEncoding('utf8');
                r.on('data', function (d) { s += d; if (s.length > MAX_HTTP) { r.destroy(); end('too large'); } });
                r.on('error', function (e) { end(String(e && e.message || e)); });
                r.on('aborted', function () { end('aborted'); });
                r.on('end', function () {
                    if (r.statusCode !== 200) { return end('http ' + r.statusCode); }
                    try { end(null, JSON.parse(s)); } catch (e) { end('bad json'); }
                });
            });
            rq.on('error', function (e) { end(String(e && e.message || e)); });
            rq.on('timeout', function () { rq.destroy(); end('timeout'); });
        } catch (e) { end('request failed'); }
    }

    // ---- banners -------------------------------------------------------------------------------------------------------------
    // Refresh the list of sounds the installed Notification Center actually knows. Unknown sounds
    // are silently dropped there, so fall back to `alert` (present in every version) or no sound.
    function refreshSounds() {
        localJson('/plugins/notification-center/api/api', function (err, d) {
            if (err || !d || !d.enums || !d.enums.sound) { return; }
            var list = {}, i;
            for (i = 0; i < d.enums.sound.length; i++) { list[d.enums.sound[i]] = true; }
            allowedSounds = list;
        });
    }
    // Global rate limit across every module. The NC queue has only 5 slots and plays one sound per
    // 0.8 s, so flooding it hides important alerts. Excess banners wait in a small queue, but the
    // queue is bounded: once it is full the oldest (stale) banner is dropped and logged. Civil
    // protection `high` priority bypasses the limit and is never queued.
    var BANNER_MAX_MIN = 4, BANNER_GAP = 1000, BANNER_QUEUE_MAX = 12;
    var sendTimes = [], bannerQueue = [], bannerTimer = null;
    function bannerSend(text) {
        if (stopped) { return; }
        var failed = false;
        function fail(e) {
            if (failed) { return; }
            failed = true;
            addLog('notify', 'error', String(e && e.message || e || 'notify failed'));
        }
        try {
            var rq = http.request({
                host: '127.0.0.1', port: 8099, path: NOTIFY, method: 'POST', timeout: 5000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }
            }, function (r) {
                // Mocks in the tests may omit statusCode; real Node responses always have one.
                if (r && r.statusCode && r.statusCode !== 200) { fail('http ' + r.statusCode); }
                if (r && r.resume) { r.resume(); }
            });
            rq.on('error', fail);
            rq.on('timeout', function () { fail('Notification Center timeout'); rq.destroy(); });
            rq.write(text);
            rq.end();
        } catch (e) { fail(e); }
    }
    function drainBannerQueue() {
        // Cancel the handle that fired (or the one scheduled by the previous call). Clearing the
        // field first used to leave orphan timers running after stop().
        var fired = bannerTimer;
        bannerTimer = null;
        clearTimeout(fired);
        var now = Date.now(), wait;
        while (sendTimes.length && now - sendTimes[0] >= 60000) { sendTimes.shift(); }
        while (bannerQueue.length) {
            if (sendTimes.length >= BANNER_MAX_MIN) { break; }
            if (sendTimes.length && now - sendTimes[sendTimes.length - 1] < BANNER_GAP) { break; }
            bannerSend(bannerQueue.shift().text);
            sendTimes.push(Date.now());
            now = Date.now();
        }
        if (bannerQueue.length) {
            wait = sendTimes.length >= BANNER_MAX_MIN ?
                Math.max(100, 60000 - (now - sendTimes[0])) :
                Math.max(100, BANNER_GAP - (now - sendTimes[sendTimes.length - 1]));
            bannerTimer = setTimeout(drainBannerQueue, wait);
        }
    }
    // Notification Center 0.8.0: `source` labels the origin, `sound` plays a chime, `group:false`
    // shows every banner even when two look identical, `mode` picks banner / full / overlay.
    function banner(title, message, level, icon, seconds, opts) {
        if (stopped) { return; }
        opts = opts || {};
        var body = {
            title: clean(title, 40), message: clean(message, 200), level: level, icon: icon || '',
            mode: opts.mode || 'banner', duration: seconds, source: 'tv-alerts'
        };
        if (opts.sound) {
            var snd = opts.sound;
            if (allowedSounds && !allowedSounds[snd]) { snd = allowedSounds.alert ? 'alert' : ''; }
            if (snd) { body.sound = snd; }
        }
        if (opts.group === false) { body.group = false; }
        if (opts.volume >= 10 && opts.volume <= 100) { body.volume = opts.volume; }
        if (opts.theme === 'sport' || opts.theme === 'news') { body.theme = opts.theme; }
        // NC 0.8+: a PNG URL becomes the icon of the overlay bar; the emoji `icon` stays as fallback.
        if (opts.image && /^https?:\/\//.test(opts.image) && opts.image.length <= 290) { body.image = opts.image; }
        // NC 0.13+: high priority goes first and is shown even during quiet hours (civil protection).
        if (opts.priority === 'high') { body.priority = 'high'; }
        var item = { text: JSON.stringify(body), high: opts.priority === 'high' };
        if (item.high) {
            // Emergency notices never wait behind routine banners.
            bannerSend(item.text);
            sendTimes.push(Date.now());
            drainBannerQueue();
            return;
        }
        while (bannerQueue.length >= BANNER_QUEUE_MAX) {
            bannerQueue.shift();
            addLog('notify', 'queue', 'banner queue full (' + BANNER_QUEUE_MAX + '): oldest banner dropped');
        }
        bannerQueue.push(item);
        drainBannerQueue();
    }
    // Default sound for every sport notification: `reward` (present in all NC versions).
    // Muted when the module's sound switch is off; banner() falls back to `alert` if a sound is
    // ever unknown, so this list does not depend on the NC version.
    var SOUND = {
        goal: 'reward', against: 'reward', cardR: 'reward', cardY: 'reward', sub: 'reward', var: 'reward',
        penalty: 'reward', penMiss: 'reward', start: 'reward', half: 'reward', end: 'reward', score: 'reward', race: 'reward'
    };
    function lineOf(m) {
        if (m.race) { return clean(m.desc + ' \u00B7 ' + m.home.name, 160); }
        return clean(m.home.name + ' ' + m.home.score + '-' + m.away.score + ' ' + m.away.name + (m.clock ? ' (' + m.clock + ')' : ''), 160);
    }
    // `w` is a watch: { key, name, teamId, alerts, goalSeconds, otherSeconds, sound, mode, lang }.
    function announce(kind, w, m, ex) {
        ex = ex || {};
        var t = TXT[w.lang], line = lineOf(m), s = w.otherSeconds, title = '', level = 'info', icon = '', msg = line;
        // The scorer is the most useful piece of a goal banner: put it in the message and, when
        // known, in the title too (the NC title limit is 40 characters).
        if (ex.player) { msg = ex.player + (ex.minute ? ' (' + ex.minute + ')' : '') + ' \u00B7 ' + line; }
        if (kind === 'goal') {
            title = E.ball + ' ' + t.goal + ' ' + w.name.toUpperCase() + '!';
            if (ex.player) { title += ' ' + clean(ex.player, 16); }
            level = 'ok'; s = w.goalSeconds;
        }
        else if (kind === 'against') {
            title = t.against + (ex.team || '?');
            if (ex.player) { title += ' ' + clean(ex.player, 16); }
            level = 'warn'; icon = E.net;
        }
        else if (kind === 'cardY') { title = t.cardY + (ex.team ? ' \u00B7 ' + ex.team : ''); level = 'warn'; icon = E.yellow; }
        else if (kind === 'cardR') { title = t.cardR + (ex.team ? ' \u00B7 ' + ex.team : ''); level = 'alert'; icon = E.red; }
        else if (kind === 'sub') { title = t.sub + ' \u00B7 ' + w.name; }
        else if (kind === 'var') { title = t.varNo; level = 'warn'; icon = E.no; }
        else if (kind === 'penalty') { title = t.penalty; icon = E.whistle; }
        else if (kind === 'penMiss') { title = t.penMiss; level = 'warn'; icon = E.no; }
        else if (kind === 'start') { title = t.start; icon = E.whistle; }
        else if (kind === 'half') { title = t.half; icon = E.pause; }
        else if (kind === 'score') { title = t.score; icon = E.star; }
        else { title = t.end; icon = E.flag; }
        banner(title, msg, level, icon, s, {
            sound: w.sound ? (SOUND[kind] || 'chime') : '',
            group: false,
            mode: w.mode,
            image: w.logo || '',
            volume: w.volume
        });
        addLog('sport', kind, title + ' - ' + msg);
    }

    var PROVIDERS = {
        espn: { label: 'ESPN (public scoreboard, no key)', needsKey: false },
        apifootball: { label: 'API-Football (your key, 100 requests/day)', needsKey: true }
    };

    // ---- config ----------------------------------------------------------------------------------------------------------------
    function rawCfg() { return ctx.config.get() || {}; }
    function compsForClub(league) {
        var lg = byId(COMPS, league), country = lg ? lg.country : '';
        var out = [], i;
        for (i = 0; i < COMPS.length; i++) {
            if (COMPS[i].country === country || COMPS[i].country === 'eu') { out.push(COMPS[i].id); }
        }
        return out.slice(0, MAX_COMPS);
    }
    function normClub(x, lang) {
        if (!x || typeof x !== 'object') { return null; }
        var id = String(x.id || '');
        if (!/^\d{1,8}$/.test(id)) { return null; }
        var lg = byId(COMPS, String(x.league || ''));
        var comps = [], i, src = Array.isArray(x.comps) ? x.comps : [];
        for (i = 0; i < src.length && comps.length < MAX_COMPS; i++) {
            if (byId(COMPS, String(src[i])) && comps.indexOf(String(src[i])) < 0) { comps.push(String(src[i])); }
        }
        if (!comps.length && lg) { comps = compsForClub(lg.id); }
        // Optional per-club overrides: when absent, the global football alerts apply.
        var alerts = null;
        if (x.alerts && typeof x.alerts === 'object') {
            alerts = {};
            Object.keys(DEFAULTS.football.alerts).forEach(function (k) {
                if (typeof x.alerts[k] === 'boolean') { alerts[k] = x.alerts[k]; }
            });
            if (!Object.keys(alerts).length) { alerts = null; }
        }
        return {
            id: id, name: clean(x.name || id, 40), league: lg ? lg.id : 'por.1',
            comps: comps, news: x.news === true, alerts: alerts
        };
    }
    function normPick(x) {
        if (!x || typeof x !== 'object') { return null; }
        var sp = String(x.sport || '');
        if (!OTHER.hasOwnProperty(sp)) { return null; }
        var id = String(x.teamId || '');
        if (OTHER[sp].teams) {
            if (!/^\d{1,8}$/.test(id)) { return null; }
        } else if (id && !/^[A-Za-z0-9_-]{1,20}$/.test(id)) {
            id = '';   // a non-team pick may carry an ESPN event id; bad values fall back to the name
        }
        return {
            sport: sp, league: clean(x.league || sp, 20), teamId: id,
            name: clean(x.name || OTHER[sp].label, 40)
        };
    }
    // Identity of a pick. Two teams of the same sport are different picks; a race is identified by
    // its ESPN event id (older configs only have a name, which is then used instead).
    function pickKey(p) { return p.sport + '|' + (p.teamId || clean(p.name, 40)); }
    // A custom place is just a name and coordinates, added from the panel by searching Open-Meteo's
    // geocoder. The id comes from that geocoder (`c` + its numeric id), so a name can be typed in
    // Portuguese and the coordinates are never guessed by the user.
    function normPlace(x) {
        if (!x || typeof x !== 'object') { return null; }
        var id = String(x.id || '');
        if (!/^c\d{1,12}$/.test(id)) { return null; }
        var lat = parseFloat(x.lat), lon = parseFloat(x.lon);
        var name = clean(x.name || '', 60).trim();
        if (!name || !(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) { return null; }
        return { id: id, name: name, lat: lat, lon: lon };
    }
    function allPlaces(c) { return PLACES.concat(c.weather.custom || []); }
    function normSimClub(x) {
        if (!x || typeof x !== 'object') { return null; }
        var id = String(x.id || '');
        if (!/^\d{1,8}$/.test(id)) { return null; }
        var level = ['info', 'ok', 'warn', 'alert'].indexOf(String(x.level || '')) >= 0 ? String(x.level) : 'ok';
        return {
            id: id, name: clean(x.name || id, 30), level: level,
            msg: clean(x.msg || '', 120),
            logo: /^https?:\/\//.test(String(x.logo || '')) ? clean(x.logo, 290) :
                ('https://a.espncdn.com/i/teamlogos/soccer/500/' + id + '.png')
        };
    }
    function cfg() {
        var r = rawCfg(), d = DEFAULTS, o = {
            lang: r.lang === 'pt' ? 'pt' : 'en',
            modules: {}, football: {}, others: {}, weather: {}, news: {}
        };
        var m = r.modules || {}, f = {}, ob = {}, w = r.weather || {}, n = r.news || {};
        o.modules.sport = typeof m.sport === 'boolean' ? m.sport : d.modules.sport;
        o.modules.weather = typeof m.weather === 'boolean' ? m.weather : d.modules.weather;
        o.modules.news = typeof m.news === 'boolean' ? m.news : d.modules.news;

        var cv = r.civ && typeof r.civ === 'object' ? r.civ : {};
        o.civ = {
            enabled: !(cv.enabled === false),
            district: byId(CIV_AREAS, cv.district) ? cv.district : d.civ.district,
            levels: {}, anepc: !(cv.anepc === false), news: cv.news === true,
            keywords: clean(cv.keywords == null ? d.civ.keywords : cv.keywords, 220),
            interval: clamp(cv.interval, 5, 240, d.civ.interval),
            seconds: clamp(cv.seconds, 3, 60, d.civ.seconds),
            sound: !(cv.sound === false),
            mode: byId(MODES, cv.mode) ? cv.mode : d.civ.mode,
            volume: clamp(cv.volume, 10, 100, d.civ.volume)
        };
        Object.keys(d.civ.levels).forEach(function (k) {
            o.civ.levels[k] = typeof (cv.levels && cv.levels[k]) === 'boolean' ? cv.levels[k] : d.civ.levels[k];
        });

        var sv = r.sim && typeof r.sim === 'object' ? r.sim : {}, sl = Array.isArray(sv.clubs) ? sv.clubs : d.sim.clubs;
        o.sim = { clubs: [] };
        for (i = 0; i < sl.length && o.sim.clubs.length < 10; i++) {
            var sc = normSimClub(sl[i]);
            if (sc) { o.sim.clubs.push(sc); }
        }

        // 0.4.0 keeps `football`/`others`. Older configs had one team under `sport` (0.2-0.3) or
        // flat at the root (0.1); both are converted to a single club, never dropped.
        if (r.football && typeof r.football === 'object') {
            f = r.football;
        } else if (r.sport && typeof r.sport === 'object') {
            f = { provider: r.sport.provider, clubs: [], alerts: r.sport.on, goalSeconds: r.sport.goalSeconds,
                otherSeconds: r.sport.otherSeconds, sound: r.sport.sound, mode: r.sport.mode };
            if (r.sport.teamId) {
                f.clubs = [{ id: r.sport.teamId, name: r.sport.teamName, league: r.sport.league, news: false }];
            }
        } else if (r.teamId) {
            f = { provider: r.provider, clubs: [{ id: r.teamId, name: r.teamName, league: r.league, news: false }],
                alerts: r.on, goalSeconds: r.goalSeconds, otherSeconds: r.otherSeconds, sound: r.sound, mode: r.mode };
        }
        o.football.provider = PROVIDERS.hasOwnProperty(f.provider) ? f.provider : d.football.provider;
        o.football.clubs = [];
        var clubs = Array.isArray(f.clubs) ? f.clubs : [], i, cl;
        for (i = 0; i < clubs.length && o.football.clubs.length < MAX_CLUBS; i++) {
            cl = normClub(clubs[i], o.lang);
            if (cl && !byId(o.football.clubs, cl.id)) { o.football.clubs.push(cl); }
        }
        o.football.alerts = {};
        Object.keys(d.football.alerts).forEach(function (k) {
            o.football.alerts[k] = typeof (f.alerts && f.alerts[k]) === 'boolean' ? f.alerts[k] : d.football.alerts[k];
        });
        o.football.goalSeconds = clamp(f.goalSeconds, 5, 60, d.football.goalSeconds);
        o.football.otherSeconds = clamp(f.otherSeconds, 3, 30, d.football.otherSeconds);
        o.football.sound = !(f.sound === false);
        o.football.mode = byId(MODES, f.mode) ? f.mode : d.football.mode;
        o.football.volume = clamp(f.volume, 10, 100, d.football.volume);
        o.football.nextGame = {
            enabled: !(f.nextGame && f.nextGame.enabled === false),
            minutes: clamp(f.nextGame && f.nextGame.minutes, 0, 120, d.football.nextGame.minutes)
        };

        ob = r.others && typeof r.others === 'object' ? r.others : {};
        o.others.picks = [];
        var picks = Array.isArray(ob.picks) ? ob.picks : [], p, seenPicks = {};
        for (i = 0; i < picks.length && o.others.picks.length < MAX_PICKS; i++) {
            p = normPick(picks[i]);
            if (p && !seenPicks[pickKey(p)]) { seenPicks[pickKey(p)] = true; o.others.picks.push(p); }
        }
        o.others.alerts = {};
        Object.keys(d.others.alerts).forEach(function (k) {
            o.others.alerts[k] = typeof (ob.alerts && ob.alerts[k]) === 'boolean' ? ob.alerts[k] : d.others.alerts[k];
        });
        o.others.seconds = clamp(ob.seconds, 3, 30, d.others.seconds);
        o.others.sound = !(ob.sound === false);
        o.others.mode = byId(MODES, ob.mode) ? ob.mode : d.others.mode;
        o.others.volume = clamp(ob.volume, 10, 100, d.others.volume);

        o.weather.custom = [];
        var cps = Array.isArray(w.custom) ? w.custom : [], cp, seenCp = {};
        for (i = 0; i < cps.length && o.weather.custom.length < MAX_PLACES; i++) {
            cp = normPlace(cps[i]);
            if (cp && !seenCp[cp.id]) { seenCp[cp.id] = true; o.weather.custom.push(cp); }
        }
        o.weather.place = byId(allPlaces(o), w.place) ? w.place : d.weather.place;
        o.weather.interval = clamp(w.interval, 5, 240, d.weather.interval);
        o.weather.seconds = clamp(w.seconds, 3, 30, d.weather.seconds);
        o.weather.quiet = !(w.quiet === false);
        o.weather.sound = w.sound === true;
        o.weather.mode = byId(MODES, w.mode) ? w.mode : d.weather.mode;
        o.weather.volume = clamp(w.volume, 10, 100, d.weather.volume);
        o.weather.provider = byId(WEATHER_PROVIDERS, w.provider) ? w.provider : d.weather.provider;
        o.weather.when = byId(WEATHER_WHEN, w.when) ? w.when : d.weather.when;
        var wp = w.proactive || {}, dwp = d.weather.proactive;
        o.weather.proactive = {
            enabled: !(wp.enabled === false),
            minutes: clamp(wp.minutes, 30, 180, dwp.minutes),
            rain: wp.rain !== false, wind: wp.wind !== false,
            heat: wp.heat !== false, storm: wp.storm !== false,
            rainPct: clamp(wp.rainPct, 10, 100, dwp.rainPct),
            windKmh: clamp(wp.windKmh, 10, 120, dwp.windKmh),
            heatC: clamp(wp.heatC, 20, 50, dwp.heatC),
            stormCode: clamp(wp.stormCode, 80, 99, dwp.stormCode)
        };

        o.news.feeds = [];
        var feeds = Array.isArray(n.feeds) ? n.feeds : (n.feed ? [n.feed] : d.news.feeds);
        for (i = 0; i < feeds.length && o.news.feeds.length < MAX_FEEDS; i++) {
            if (byId(FEEDS, String(feeds[i])) && o.news.feeds.indexOf(String(feeds[i])) < 0) { o.news.feeds.push(String(feeds[i])); }
        }
        if (!o.news.feeds.length) { o.news.feeds = d.news.feeds.slice(0); }
        o.news.interval = clamp(n.interval, 5, 240, d.news.interval);
        o.news.seconds = clamp(n.seconds, 3, 30, d.news.seconds);
        o.news.quiet = !(n.quiet === false);
        o.news.count = clamp(n.count, 1, 3, d.news.count);
        o.news.sound = n.sound === true;
        o.news.mode = byId(MODES, n.mode) ? n.mode : d.news.mode;
        o.news.volume = clamp(n.volume, 10, 100, d.news.volume);
        return o;
    }
    function publicCfg() {
        var o = cfg(), keys = rawCfg().keys || {};
        o.version = VERSION;
        o.maxClubs = MAX_CLUBS;
        o.maxPicks = MAX_PICKS;
        o.hasKey = !!keys.apifootball;
        o.providers = Object.keys(PROVIDERS).map(function (k) { return { id: k, label: PROVIDERS[k].label, needsKey: PROVIDERS[k].needsKey }; });
        o.otherSports = Object.keys(OTHER).map(function (k) { return { id: k, label: OTHER[k].label, teams: OTHER[k].teams }; });
        o.comps = COMPS;
        o.clubLeagues = CLUB_LEAGUES.map(function (id) { var c = byId(COMPS, id); return { id: id, name: c ? c.name : id }; });
        o.places = allPlaces(o);
        o.civAreas = CIV_AREAS;
        o.weatherProviders = WEATHER_PROVIDERS;
        o.weatherWhen = WEATHER_WHEN;
        o.feeds = FEEDS;
        o.modes = MODES;
        return o;
    }
    // Public, read-only view of the last known state. Only status lines and match baselines:
    // event dedupe keys, ctx.config, the API key and the saved history of other modules stay out.
    function publicLast() {
        var out = {}, k, v;
        for (k in last) {
            if (!last.hasOwnProperty(k)) { continue; }
            v = last[k] || {};
            out[k] = { at: v.at || 0, state: v.state || '', desc: v.desc || '', our: v.our || 0, opp: v.opp || 0 };
        }
        return out;
    }

    // ---- watches: one per club and per other-sport pick ----------------------------------------------------------------
    function buildWatches(c) {
        var out = [], i, cl, p, sp;
        for (i = 0; i < c.football.clubs.length; i++) {
            cl = c.football.clubs[i];
            out.push({
                key: 'club:' + cl.id, kind: 'club', provider: c.football.provider, sport: 'soccer',
                league: cl.league, comps: cl.comps, teamId: cl.id, name: cl.name,
                alerts: cl.alerts || c.football.alerts, goalSeconds: c.football.goalSeconds,
                otherSeconds: c.football.otherSeconds, sound: c.football.sound,
                mode: c.football.mode, lang: c.lang, volume: c.football.volume,
                logo: logoFor('club', c.football.provider, 'soccer', cl.id)
            });
        }
        for (i = 0; i < c.others.picks.length; i++) {
            p = c.others.picks[i];
            sp = OTHER[p.sport];
            out.push({
                // One watch per pick, even for two teams of the same sport. Race picks have no
                // team id, so use the (unique) name instead of the shared "all" key.
                key: 'other:' + p.sport + ':' + (p.teamId || clean(p.name, 30)), kind: 'other', provider: 'espn',
                sport: p.sport, league: p.league, comps: [sp.espn], teamId: p.teamId, name: p.name,
                alerts: c.others.alerts, goalSeconds: c.others.seconds,
                otherSeconds: c.others.seconds, sound: c.others.sound,
                mode: c.others.mode, lang: c.lang, volume: c.others.volume,
                logo: logoFor('other', 'espn', p.sport, p.teamId)
            });
        }
        return out;
    }
    // ---- kick-off labels -------------------------------------------------------------------------------------------------------
    function fmtKick(ms, lang) {
        var d = new Date(ms), now = new Date();
        var a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        var b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        var diff = Math.round((a - b) / 86400000), day;
        if (diff === 0) { day = TXT[lang].today; }
        else if (diff === 1) { day = TXT[lang].tomorrow; }
        else {
            var en = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            var pt = ['domingo', 'segunda', 'ter\u00E7a', 'quarta', 'quinta', 'sexta', 's\u00E1bado'];
            day = (lang === 'pt' ? pt : en)[d.getDay()];
        }
        return day + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    // ---- persisted warnings and next-fixture hints -----------------------------------------------------------------------------
    // The warning must survive a Shard or TV restart: keep the already-warned fixture ids in
    // ctx.config (memory-only used to repeat the banner inside the pre-kick-off window).
    function persistNextWarned() {
        var store = rawCfg(), prev = store.nextNotified || {}, keys = Object.keys(nextWarned);
        var out = {}, i, list;
        for (i = 0; i < keys.length; i++) { out[keys[i]] = prev[keys[i]] || Date.now(); }
        list = Object.keys(out);
        if (list.length > 20) {
            list.sort(function (a, b) { return out[b] - out[a]; });
            out = {};
            for (i = 0; i < 20; i++) { out[list[i]] = prev[list[i]] || Date.now(); }
        }
        store.nextNotified = out;
        try { ctx.config.set(store); }
        catch (e) { addLog('sport', 'error', 'persist warning: ' + String(e && e.message || e)); }
    }
    function persistWeatherWarned() {
        var store = rawCfg(), prev = store.weatherNotified || {}, keys = Object.keys(weatherWarned);
        var out = {}, i, list;
        for (i = 0; i < keys.length; i++) { out[keys[i]] = prev[keys[i]] || Date.now(); }
        list = Object.keys(out);
        if (list.length > 60) {
            list.sort(function (a, b) { return out[b] - out[a]; });
            out = {};
            for (i = 0; i < 60; i++) { out[list[i]] = prev[list[i]] || Date.now(); }
        }
        store.weatherNotified = out;
        try { ctx.config.set(store); }
        catch (e) { addLog('weather', 'error', 'persist alert: ' + String(e && e.message || e)); }
    }
    function loadWeatherWarned() {
        var saved = rawCfg().weatherNotified || {}, k;
        for (k in saved) { if (saved.hasOwnProperty(k)) { weatherWarned[k] = true; } }
    }
    function persistNextHints() {
        var store = rawCfg(), keys = Object.keys(espn.hints()), out = {}, i, trimmed, hints;
        hints = espn.hints();
        if (keys.length > 20) {
            // Keep the most recently used hints, not whatever happened to be inserted last.
            keys.sort(function (a, b) { return (hints[b] && hints[b].at || 0) - (hints[a] && hints[a].at || 0); });
            keys = keys.slice(0, 20);
            trimmed = {};
            for (i = 0; i < keys.length; i++) { trimmed[keys[i]] = hints[keys[i]]; }
            espn.setHints(trimmed);
            hints = espn.hints();
        }
        for (i = 0; i < keys.length; i++) { out[keys[i]] = hints[keys[i]]; }
        store.nextHints = out;
        try { ctx.config.set(store); }
        catch (e) { addLog('sport', 'error', 'persist next hints: ' + String(e && e.message || e)); }
    }
    function loadNextHints() {
        var saved = rawCfg().nextHints || {};
        espn.setHints(saved && typeof saved === 'object' ? saved : {});
    }
    function warnIfDue(w, g, minutes) {
        if (!g || !(minutes > 0) || nextWarned[g.id]) { return; }
        var left = g.dateMs - Date.now();
        if (left <= 0 || left > minutes * 60000) { return; }
        nextWarned[g.id] = true;
        persistNextWarned();
        var msg = g.home + ' \u00D7 ' + g.away + ' \u00B7 ' + g.line;
        banner(TITLE_PRE, msg, 'info', E.whistle, w.otherSeconds,
            { sound: w.sound ? 'reward' : '', group: false, mode: w.mode, image: w.logo || '', volume: w.volume });
        addLog('sport', 'next', msg);
    }
    function checkNext(ws) {
        var c = cfg(), ng = c.football.nextGame;
        if (!ng.enabled || c.football.provider !== 'espn') { return; }
        var clubs = ws.filter(function (w) { return w.kind === 'club'; }), i;
        for (i = 0; i < clubs.length; i++) {
            (function (w) {
                var hit = nextGame[w.key];
                if (hit && Date.now() - hit.at < 3600000) { return warnIfDue(w, hit.game, ng.minutes); }
                scanNext(w, function (g) {
                    nextGame[w.key] = { at: Date.now(), game: g };
                    if (g) {
                        var hints = espn.hints();
                        hints[w.key] = { date: ymd(new Date(g.dateMs)), at: Date.now() };
                        persistNextHints();
                    }
                    warnIfDue(w, g, ng.minutes);
                });
            })(clubs[i]);
        }
    }
    function nextList() {
        var out = [], k, hit;
        for (k in nextGame) {
            if (nextGame.hasOwnProperty(k)) {
                hit = nextGame[k];
                if (hit && hit.game) { out.push(hit.game); }
            }
        }
        out.sort(function (a, b) { return a.dateMs - b.dateMs; });
        return out;
    }

    // ---- sport analysis -------------------------------------------------------------------------------------------------------
    function evKey(ev) {
        return (ev.kind || '') + '|' + (ev.teamId || '') + '|' + (ev.minute || '') + '|' + clean(ev.player || '', 30).toLowerCase();
    }
    function announceEvent(ev, w, m) {
        var side = ev.teamId === m.home.id ? m.home : m.away;
        var mine = ev.teamId === w.teamId;
        var team = mine ? w.name : side.short;
        var ex = { player: ev.player, minute: ev.minute, detail: ev.detail, team: team };
        if (ev.kind === 'goal') {
            if (!once('ev|' + m.id + '|' + evKey(ev))) { return; }
            announce(mine ? 'goal' : 'against', w, m, ex); return;
        }
        if (ev.kind === 'cardY' || ev.kind === 'cardR') {
            if (w.alerts.card && once('ev|' + m.id + '|' + evKey(ev))) { announce(ev.kind, w, m, ex); }
            return;
        }
        if (ev.kind === 'penalty' || ev.kind === 'penMiss') {
            // A saved/missed penalty has no goal, so it used to be silent. Announce the outcome
            // (and the taker) for either team, deduped like every other event.
            if (w.alerts[ev.kind] && once('ev|' + m.id + '|' + evKey(ev))) { announce(ev.kind, w, m, ex); }
            return;
        }
        if (ev.kind === 'sub' && w.alerts.sub && mine && once('ev|' + m.id + '|' + evKey(ev))) {
            announce('sub', w, m, ex);
        }
    }
    // ESPN describes the two halves as "First Half" / "Second Half": those are playing time,
    // not the break. Only the real interval ("Halftime", "Half Time", "HT", "Intervalo") counts,
    // otherwise a kick-off announced "Intervalo" together with "Come\u00E7ou o jogo".
    function isHalfTime(m) {
        var d = String(m.desc || '').replace(/^\s+|\s+$/g, '');
        return m.state === 'in' && /^(half[\s-]?time|ht|intervalo|descanso)\b/i.test(d);
    }
    function analyse(m, w) {
        var key = w.key + '|' + m.id, prev = last[key], keys = {}, i, ev, fresh = [], goals = [], us, them;
        // A baseline written by an older version may lack `keys`. Treat it as an empty one instead
        // of throwing inside an async provider callback (which used to stall sport polling forever).
        if (prev && !prev.keys) { prev = { keys: {}, our: 0, opp: 0, state: prev.state || '' }; }
        watchStatus[w.key] = { line: lineOf(m), state: m.desc, at: Date.now(), error: '' };
        if (m.state === 'in' || m.state === 'post') {
            nextGame[w.key] = null;
            if (espn.clearHint(w.key)) { persistNextHints(); }
        }
        if (m.race) {
            last[key] = { at: Date.now(), state: m.state, desc: m.desc, our: 0, opp: 0, keys: {} };
            if (prev && m.state === 'post' && prev.state !== 'post' && w.alerts.end && once('st|' + m.id + '|end')) {
                banner(TXT[w.lang].win + ': ' + m.home.name, lineOf(m), 'ok', E.flag, w.goalSeconds,
                    { sound: w.sound ? 'success' : '', group: false, mode: w.mode, volume: w.volume });
                addLog('sport', 'race', m.home.name + ' - ' + m.desc);
            }
            return;
        }
        us = m.home.id === w.teamId ? m.home : m.away;
        them = us === m.home ? m.away : m.home;
        for (i = 0; i < m.events.length; i++) { keys[evKey(m.events[i])] = true; }
        last[key] = { at: Date.now(), state: m.state, desc: m.desc, our: us.score, opp: them.score, keys: keys };
        if (!prev) { return; }                              // first sight: baseline only

        for (i = 0; i < m.events.length; i++) {
            ev = m.events[i];
            if (!prev.keys[evKey(ev)]) {
                fresh.push(ev);
                if (ev.kind === 'goal') { goals.push(ev); }
            }
        }
        // Two goals between polls: announce every new one, not just the first. The baseline is
        // already advanced above, so anything not announced here would be lost for good.
        for (i = 0; i < goals.length; i++) {
            ev = goals[i];
            if (ev.teamId === w.teamId ? w.alerts.goal : w.alerts.against) { announceEvent(ev, w, m); }
        }
        if (!goals.length && us.score > prev.our && w.alerts.goal && once('st|' + m.id + '|goal')) {
            // The scoreboard changed before the event details arrived: reuse a goal with a scorer
            // from the summary if one is already known, so the banner still says who scored.
            var sg = null, si;
            for (si = 0; si < m.events.length; si++) {
                if (m.events[si].kind === 'goal' && m.events[si].player) { sg = m.events[si]; break; }
            }
            announce('goal', w, m, sg ? { player: sg.player, minute: sg.minute } : {});
        } else if (!goals.length && them.score > prev.opp && w.alerts.against && once('st|' + m.id + '|against')) {
            var so = null, sj;
            for (sj = 0; sj < m.events.length; sj++) {
                if (m.events[sj].kind === 'goal' && m.events[sj].player) { so = m.events[sj]; break; }
            }
            announce('against', w, m, { team: them.short, player: so ? so.player : '', minute: so ? so.minute : '' });
        }
        if ((us.score < prev.our || them.score < prev.opp) && w.alerts.varNo && once('st|' + m.id + '|var')) {
            announce('var', w, m);
        }
        for (i = 0; i < fresh.length; i++) {
            if (fresh[i].kind !== 'goal') { announceEvent(fresh[i], w, m); }
        }
        if (w.kind === 'other' && w.alerts.score && (us.score !== prev.our || them.score !== prev.opp) && !goals.length && once('st|' + m.id + '|score')) {
            announce('score', w, m);
        }
        if (prev.state === 'pre' && m.state === 'in' && w.alerts.start && once('st|' + m.id + '|start')) { announce('start', w, m); }
        if (isHalfTime(m) && !isHalfTime(prev) && w.alerts.half && once('st|' + m.id + '|half')) { announce('half', w, m); }
        if (prev.state === 'in' && m.state === 'post' && w.alerts.end && once('st|' + m.id + '|end')) { announce('end', w, m); }
    }

    // ---- sport polling --------------------------------------------------------------------------------------------------------
    function pollEspn(ws, done) {
        var paths = [], i, j, p;
        for (i = 0; i < ws.length; i++) {
            if (ws[i].kind === 'club') {
                for (j = 0; j < ws[i].comps.length; j++) {
                    p = sportPath(ws[i], ws[i].comps[j]);
                    if (paths.indexOf(p) < 0) { paths.push(p); }
                }
            } else {
                p = sportPath(ws[i]);
                if (paths.indexOf(p) < 0) { paths.push(p); }
            }
        }
        var idx = 0, errs = [], ok = 0;
        function step() {
            if (idx >= paths.length) {
                // One bad competition must not hide the clubs playing in the good ones. Only a
                // complete failure is reported as an error for the whole module.
                if (errs.length && !ok) { return done(errs[0], 0); }
                var wait = 0, k, w, hit, m, raw, found, usedComp;
                for (k = 0; k < ws.length; k++) {
                    w = ws[k];
                    found = null; usedComp = '';
                    if (w.kind === 'club') {
                        for (j = 0; j < w.comps.length && !found; j++) {
                            hit = espn.cache(sportPath(w, w.comps[j]));
                            if (hit) {
                                found = findMatch(hit.events, 'soccer', w.teamId);
                                if (found) { usedComp = w.comps[j]; }
                            }
                        }
                    } else {
                        hit = espn.cache(sportPath(w));
                        if (hit) { found = findMatch(hit.events, w.sport, w.teamId, w.name); }
                    }
                    if (!found) { watchStatus[w.key] = { line: '', state: '', at: Date.now(), error: '' }; continue; }
                    m = found.m; raw = found.raw;
                    // Hard guard: only a match with one of my teams may ever reach the screen.
                    if (!m.race && m.home.id !== w.teamId && m.away.id !== w.teamId) { continue; }
                    withSummary(sportPath(w, usedComp), raw, m, (function (mm, ww) {
                        return function () {
                            try { analyse(mm, ww); }
                            catch (e) { addLog('sport', 'error', 'analyse: ' + String(e && e.message || e)); }
                        };
                    })(m, w));
                    var w2 = m.state === 'in' ? 20000 : (m.state === 'pre' ? 30000 : 120000);
                    wait = wait ? Math.min(wait, w2) : w2;
                }
                return done(null, wait || 180000);
            }
            var cur = paths[idx++];
            compEvents(cur, function (err, evs) {
                if (err) {
                    errs.push(cur + ': ' + err);
                    addLog('sport', 'error', cur + ': ' + err);
                    // A failed competition gets a short cache so it is retried in 2 min, without
                    // holding back the clubs that were analysed successfully this cycle.
                    espn.cacheFail(cur);
                } else { ok++; }
                step();
            });
        }
        step();
    }
    function pollAf(ws, done) {
        var af = afApi.state();
        var clubs = ws.filter(function (w) { return w.kind === 'club'; }), now = Date.now(), i;
        if (!clubs.length) { return done(null, 180000); }
        if (af.live) {
            return afGet('/fixtures?live=all', function (err, list) {
                if (err) { return done(err, 0); }
                var any = false;
                for (i = 0; i < clubs.length; i++) {
                    var f = null, j;
                    for (j = 0; j < (list || []).length && !f; j++) {
                        if (String(list[j].teams.home.id) === clubs[i].teamId || String(list[j].teams.away.id) === clubs[i].teamId) { f = list[j]; }
                    }
                    if (f) { any = true; analyse(afNorm(f), clubs[i]); }
                    else { watchStatus[clubs[i].key] = { line: '', state: '', at: now, error: '' }; }
                }
                af.live = any;
                done(null, any ? 100000 : 120000);
            });
        }
        // Nothing live: ask each club for its next fixture, at most once every two hours per club.
        var idx = 0, wait = 7200000;
        function step() {
            if (idx >= clubs.length) { return done(null, wait); }
            var cl = clubs[idx++];
            if (af.nextKick[cl.key] && now < af.nextKick[cl.key] - 300000) {
                wait = Math.min(wait, Math.max(af.nextKick[cl.key] - 300000 - now, 60000));
                return step();
            }
            afGet('/fixtures?team=' + cl.teamId + '&next=1', function (err, list) {
                if (err) { return done(err, 0); }
                var f = list && list[0], mm;
                af.nextKick[cl.key] = f ? new Date(f.fixture.date).getTime() : now + 7200000;
                if (f) {
                    mm = afNorm(f);
                    nextGame[cl.key] = { at: now, game: {
                        key: cl.key, id: mm.id, club: cl.name, comp: cl.league,
                        home: mm.home.name, away: mm.away.name,
                        date: f.fixture.date, dateMs: af.nextKick[cl.key], line: fmtKick(af.nextKick[cl.key], cl.lang)
                    } };
                    if (cfg().football.nextGame.enabled) { warnIfDue(cl, nextGame[cl.key].game, cfg().football.nextGame.minutes); }
                    if (af.nextKick[cl.key] - now < 300000) { af.live = true; }
                }
                wait = Math.min(wait, Math.max(af.nextKick[cl.key] - 300000 - Date.now(), 60000));
                step();
            });
        }
        step();
    }
    function pollSport() {
        var c = cfg(), ws = buildWatches(c);
        if (!ws.length) {
            status.sport.at = Date.now(); status.sport.error = ''; status.sport.line = ''; status.sport.state = '';
            addLog('sport', 'idle', 'no club or sport selected');
            return schedule('sport', 300000);
        }
        var runner = c.football.provider === 'apifootball' ? pollAf : pollEspn;
        runner(ws, function (err, wait) {
            status.sport.at = Date.now();
            if (err) {
                status.sport.error = String(err); addLog('sport', 'error', String(err));
                return schedule('sport', 120000);
            }
            status.sport.error = '';
            var i, k, best = '';
            for (k in watchStatus) {
                if (watchStatus.hasOwnProperty(k) && watchStatus[k].line && !best) { best = watchStatus[k].line; }
            }
            status.sport.line = best;
            status.sport.state = ws.length + (c.lang === 'pt' ? (ws.length === 1 ? ' acompanhado' : ' acompanhados') : (ws.length === 1 ? ' watch' : ' watches'));
            // The next fixture is fetched at most once an hour per competition (shared cache), so
            // this adds no work to the 20 s live poll and keeps the panel useful between matches.
            checkNext(ws);
            persistHistory(false);
            schedule('sport', wait || 120000);
        });
    }

    // ---- civil protection: IPMA warnings + ANEPC notices + filtered breaking news ------------------------------------------------
    // Include the level and the notice title/url: an orange warning upgraded to red (or a second
    // ANEPC notice on the same day) is a different alert and must be announced again.
    function civKey(a) {
        return a.source + '|' + a.area + '|' + a.type + '|' + a.startsAt + '|' + a.level + '|' + clean(a.title || a.url || '', 60);
    }
    function parseEuroDate(s) {
        var m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s || '').trim());
        return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime() : 0;
    }
    function civLevelName(l) {
        return l === 'red' ? 'Vermelho' : (l === 'orange' ? 'Laranja' : (l === 'yellow' ? 'Amarelo' : 'Verde'));
    }
    function ipmaAlerts(c, cb) {
        getJson('api.ipma.pt', '/open-data/forecast/warnings/warnings_www.json', {}, function (err, list) {
            if (err) { addLog('civ', 'error', 'IPMA: ' + err); return cb([]); }
            var out = [], i, w, lv, end;
            for (i = 0; i < (list || []).length; i++) {
                w = list[i] || {};
                if (w.idAreaAviso !== c.civ.district) { continue; }
                lv = String(w.awarenessLevelID || '').toLowerCase();
                if (lv !== 'yellow' && lv !== 'orange' && lv !== 'red') { continue; }
                end = new Date(w.endTime).getTime();
                if (end && end < Date.now() - 3600000) { continue; }
                out.push({
                    id: '', source: 'IPMA', area: w.idAreaAviso, type: String(w.awarenessTypeName || ''),
                    level: lv, title: civLevelName(lv) + ' \u00B7 ' + String(w.awarenessTypeName || ''),
                    message: String(w.text || ''), startsAt: w.startTime || '', endsAt: w.endTime || '',
                    url: 'https://www.ipma.pt/'
                });
            }
            cb(out);
        });
    }
    function anepcAlerts(c, cb) {
        if (!c.civ.anepc) { return cb([]); }
        getRaw('prociv.gov.pt', '/pt/avisos-a-populacao/', {}, false, function (err, html) {
            if (err) { addLog('civ', 'error', 'ANEPC: ' + err); return cb([]); }
            var parts = String(html || '').split('<div class="box-avisos">'), out = [], i, p, href, when, title, day;
            for (i = 1; i < parts.length && out.length < 8; i++) {
                p = parts[i];
                if (!/Ativo/.test(p.slice(0, 600))) { continue; }
                href = /window\.location\.href='([^']+)'/.exec(p);
                when = /<div class="fs-14">([^<]+)<\/div>/.exec(p);
                title = /<p class=h3-style[^>]*>([\s\S]*?)<\/p>/.exec(p);
                if (!href) { continue; }
                day = when ? clean(when[1], 20) : '';
                // The ANEPC page still marks some very old notices as "Ativo"; keep the last 30 days.
                if (day && parseEuroDate(day) && Date.now() - parseEuroDate(day) > 30 * 86400000) { continue; }
                title = title ? clean(stripTags(title[1]), 100) : '';
                if (!title) {
                    // Some older cards have no <p> title; a slug would look ugly on the TV.
                    title = 'Aviso ANEPC' + (day ? ' \u00B7 ' + day : '');
                }
                out.push({
                    id: '', source: 'ANEPC', area: '', type: 'Aviso \u00E0 popula\u00E7\u00E3o',
                    level: 'warn', title: title, message: 'Publicado a ' + day + '. Siga as orienta\u00E7\u00F5es oficiais.',
                    startsAt: day, endsAt: '', url: /^https?:\/\//.test(href[1]) ? href[1] : ('https://prociv.gov.pt' + (href[1].charAt(0) === '/' ? '' : '/') + href[1])
                });
            }
            cb(out);
        });
    }
    function civNewsAlerts(c, cb) {
        if (!c.civ.news) { return cb([]); }
        getUrl('https://www.noticiasaominuto.com/rss/ultima-hora', {}, false, function (err, xml) {
            if (err) { addLog('civ', 'error', 'RSS: ' + err); return cb([]); }
            var items = rssItems(xml, 30), words = c.civ.keywords.toLowerCase().split(','), out = [], i, j, title, hit;
            for (i = 0; i < items.length && out.length < 6; i++) {
                title = String(items[i].title || '');
                hit = false;
                for (j = 0; j < words.length; j++) {
                    if (words[j].trim() && title.toLowerCase().indexOf(words[j].trim()) >= 0) { hit = true; }
                }
                if (!hit) { continue; }
                out.push({
                    id: '', source: 'Not\u00EDcias ao Minuto', area: '', type: 'Ultima hora',
                    level: 'warn', title: clean(title, 140), message: '',
                    startsAt: String(items[i].date || ''), endsAt: '', url: String(items[i].key || '')
                });
            }
            cb(out);
        });
    }
    function civAnnounce(a, c) {
        var lv = a.level, icon = (lv === 'red') ? E.no : E.warn;
        var level = (lv === 'red') ? 'alert' : (lv === 'orange' ? 'warn' : 'info');
        var mode = (lv === 'yellow') ? 'banner' : c.civ.mode;
        var snd = (lv === 'yellow') ? '' : (c.civ.sound ? 'alert' : '');
        var title = icon + ' ' + (a.source === 'IPMA' ? 'Prote\u00E7\u00E3o Civil' : a.source) + ' \u00B7 ' + a.title;
        var msg = (a.message || a.type) + (a.endsAt ? ' \u00B7 at\u00E9 ' + clean(String(a.endsAt).slice(0, 16), 16) : '');
        // Civil-protection warnings are not routine: NC 0.13+ shows high priority even in quiet hours.
        banner(title, msg, level, icon, c.civ.seconds,
            { sound: snd, group: false, mode: mode, priority: (lv === 'yellow') ? '' : 'high', volume: c.civ.volume });
        addLog('civ', lv, title + ' - ' + msg);
    }
    function pollCiv(manual) {
        var c = cfg();
        status.civ.at = Date.now();
        status.civ.error = '';
        // A manual test must still show something when the module is switched off.
        if (!c.civ.enabled && !manual) { status.civ.line = ''; status.civ.state = ''; return schedule('civ', 300000); }
        ipmaAlerts(c, function (ipma) {
            anepcAlerts(c, function (anepc) {
                civNewsAlerts(c, function (news) {
                    var all = ipma.concat(anepc).concat(news), i, a, order = { red: 0, warn: 1, orange: 1, yellow: 2 };
                    for (i = 0; i < all.length; i++) {
                        a = all[i];
                        a.id = civKey(a);
                        if (order[a.level] == null) { order[a.level] = 3; }
                    }
                    all.sort(function (x, y) { return (order[x.level] - order[y.level]); });
                    civAlerts = all.slice(0, 8);
                    status.civ.line = civAlerts.length ? civAlerts[0].title : '';
                    status.civ.state = civAlerts.length + (c.lang === 'pt' ? ' avisos' : ' alerts');
                    var first = civSeen.__init !== true, sent = 0;
                    civSeen.__init = true;
                    for (i = 0; i < civAlerts.length; i++) {
                        a = civAlerts[i];
                        if (!c.civ.levels[a.level] && a.level !== 'warn') { continue; }
                        if (!civSeen[a.id]) {
                            civSeen[a.id] = true;
                            if (!first || manual) { civAnnounce(a, c); sent++; }
                        }
                    }
                    if (manual && !sent) {
                        // Unlike the real poll, the Test button must always produce a banner even
                        // when every active warning was already announced (or none is active).
                        var sample = null, sj;
                        for (sj = 0; sj < civAlerts.length; sj++) {
                            if (c.civ.levels[civAlerts[sj].level] || civAlerts[sj].level === 'warn') { sample = civAlerts[sj]; break; }
                        }
                        if (!sample) {
                            sample = {
                                level: 'orange', source: 'IPMA', type: c.lang === 'pt' ? 'Aviso de teste' : 'Test warning',
                                title: c.lang === 'pt' ? 'Teste de prote\u00E7\u00E3o civil' : 'Civil protection test',
                                message: c.lang === 'pt' ? 'Isto \u00E9 apenas um teste.' : 'This is only a test.', endsAt: ''
                            };
                        }
                        civAnnounce(sample, c);
                        sent++;
                        addLog('test', 'civ', sample.title);
                    }
                    if (Object.keys(civSeen).length > 120) { civSeen = { __init: true }; }
                    addLog('civ', 'poll', civAlerts.length + ' alerts, ' + sent + ' sent');
                    schedule('civ', c.civ.interval * 60000);
                });
            });
        });
    }

    // ---- weather -------------------------------------------------------------------------------------------------------------
    function wxText(code, lang) {
        var n = parseInt(code, 10) || 0, pt = lang === 'pt';
        if (n === 0) { return pt ? 'C\u00E9u limpo' : 'Clear sky'; }
        if (n <= 2) { return pt ? 'Algumas nuvens' : 'Partly cloudy'; }
        if (n === 3) { return pt ? 'Nublado' : 'Cloudy'; }
        if (n === 45 || n === 48) { return pt ? 'Nevoeiro' : 'Fog'; }
        if (n >= 51 && n <= 57) { return pt ? 'Garoa' : 'Drizzle'; }
        if (n >= 61 && n <= 67) { return pt ? 'Chuva' : 'Rain'; }
        if (n >= 71 && n <= 77) { return pt ? 'Neve' : 'Snow'; }
        if (n >= 80 && n <= 82) { return pt ? 'Chuva forte' : 'Showers'; }
        if (n >= 95) { return pt ? 'Trovoada' : 'Thunderstorm'; }
        return pt ? 'Tempo vari\u00E1vel' : 'Changeable';
    }
    var ipmaMeta = null, ipmaMetaAt = 0, ipmaTypes = null;
    function ipmaWeatherData(cb) {
        if (ipmaMeta && ipmaTypes && Date.now() - ipmaMetaAt < 86400000) { return cb(null); }
        getJson('api.ipma.pt', '/open-data/distrits-islands.json', {}, function (e1, d1) {
            if (e1) { return cb(String(e1)); }
            ipmaMeta = (d1 && d1.data) || [];
            getJson('api.ipma.pt', '/open-data/weather-type-classe.json', {}, function (e2, d2) {
                if (e2) { return cb(String(e2)); }
                ipmaTypes = {};
                var i, x;
                for (i = 0; i < ((d2 && d2.data) || []).length; i++) {
                    x = d2.data[i] || {};
                    ipmaTypes[String(x.idWeatherType)] = clean(x.descWeatherTypePT || '', 40);
                }
                ipmaMetaAt = Date.now();
                cb(null);
            });
        });
    }
    function ipmaFindPlace(place) {
        var name = String(place.name || '').replace(/\s*\([^)]*\)$/, '').trim().toLowerCase();
        var i, m, dlat, dlon, d, best = null, bd = 1e9;
        for (i = 0; i < ipmaMeta.length; i++) {
            m = ipmaMeta[i] || {};
            if (String(m.local || '').toLowerCase() === name) { return m; }
            dlat = parseFloat(m.latitude) - place.lat; dlon = parseFloat(m.longitude) - place.lon;
            d = dlat * dlat + dlon * dlon;
            if (d < bd) { bd = d; best = m; }
        }
        return best;
    }
    function openMeteoWeather(place, tomorrow, lang, cb) {
        var idx = tomorrow ? 1 : 0;
        var q = '/v1/forecast?latitude=' + place.lat + '&longitude=' + place.lon +
            '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m' +
            '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
            '&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m' +
            '&timezone=auto&forecast_days=2';
        getJson('api.open-meteo.com', q, {}, function (err, d) {
            if (err) { return cb(String(err)); }
            var cur = d.current || {}, daily = d.daily || {}, t = TXT[lang];
            var hi = Math.round(parseFloat((daily.temperature_2m_max || [])[idx]) || 0);
            var lo = Math.round(parseFloat((daily.temperature_2m_min || [])[idx]) || 0);
            var rain = parseInt((daily.precipitation_probability_max || [])[idx], 10) || 0;
            var code = tomorrow ? parseInt((daily.weather_code || [])[idx], 10) : parseInt(cur.weather_code, 10);
            var temp = Math.round(parseFloat(cur.temperature_2m) || 0);
            var line = place.name + ': ' + (tomorrow ? t.tomorrow + ' ' : temp + '\u00B0C, ') + wxText(code, lang) +
                '. Max ' + hi + '\u00B0 / Min ' + lo + '\u00B0. ' + t.rain + ' ' + rain + '%';
            var icon = (code >= 51) ? E.rain : ((code || 0) <= 1 ? E.sun : E.cloud);
            cb(null, { line: line, state: wxText(code, lang), icon: icon, rain: rain }, d);
        });
    }
    function ipmaWeather(place, tomorrow, lang, cb) {
        ipmaWeatherData(function (err) {
            if (err) { return cb(String(err)); }
            var loc = ipmaFindPlace(place);
            if (!loc) { return cb('no IPMA location for ' + place.name); }
            getJson('api.ipma.pt', '/open-data/forecast/meteorology/cities/daily/' + loc.globalIdLocal + '.json', {}, function (e, d) {
                if (e) { return cb(String(e)); }
                var data = (d && d.data) || [], row = data[0], i, key, now = new Date(Date.now()), day;
                if (tomorrow) {
                    day = new Date(now.getTime() + 86400000);
                    key = day.getFullYear() + '-' + ('0' + (day.getMonth() + 1)).slice(-2) + '-' + ('0' + day.getDate()).slice(-2);
                    for (i = 0; i < data.length; i++) { if (data[i] && data[i].forecastDate === key) { row = data[i]; break; } }
                    if (!row || row.forecastDate !== key) { row = data[1] || data[0]; }
                }
                if (!row) { return cb('no IPMA forecast'); }
                var rain = parseInt(row.precipitaProb, 10) || 0;
                var desc = ipmaTypes[String(row.idWeatherType)] || wxText(3, lang);
                var line = place.name + ': ' + (tomorrow ? TXT[lang].tomorrow + ' ' : '') + 'Max ' +
                    Math.round(parseFloat(row.tMax) || 0) + '\u00B0 / Min ' + Math.round(parseFloat(row.tMin) || 0) +
                    '\u00B0. ' + desc + '. ' + TXT[lang].rain + ' ' + rain + '%';
                var icon = (rain >= 60) ? E.rain : E.cloud;
                cb(null, { line: line, state: desc, icon: icon, rain: rain }, d);
            });
        });
    }
    // Proactive warnings from the hourly forecast: rain/wind/heat/storm before they start.
    // Only Open-Meteo provides hourly data; IPMA's public daily feed does not.
    function checkProactive(raw, place, c, w, manual, skip) {
        var p = w.proactive;
        if (!p || !p.enabled || !raw || !raw.hourly) { return; }
        // Advance warnings obey the same "when to notify" window as the regular weather banner.
        if (skip || (!manual && w.quiet && quietNow())) { return; }
        var h = raw.hourly, times = h.time || [], i, t, now = Date.now(), end = now + p.minutes * 60000;
        var found = {}, order = [];
        function add(kind, label, msg, icon, at, slot, severity) {
            var e = { kind: kind, label: label, msg: msg, icon: icon, at: at, slot: slot, severity: severity }, j;
            for (j = 0; j < order.length; j++) { if (order[j].kind === kind) { break; } }
            // Keep the strongest occurrence of each phenomenon in the window, not just the first.
            if (j < order.length && order[j].severity >= severity) { return; }
            if (j < order.length) { order[j] = e; } else { order.push(e); }
        }
        for (i = 0; i < times.length; i++) {
            t = new Date(times[i]).getTime();
            if (!(t >= now - 1800000 && t <= end)) { continue; }
            var d = new Date(t), when = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
            var slot = String(times[i] || '').slice(0, 13);   // Open-Meteo returns local time here
            var prob = parseInt((h.precipitation_probability || [])[i], 10) || 0;
            var wind = parseFloat((h.wind_speed_10m || [])[i]) || 0;
            var temp = parseFloat((h.temperature_2m || [])[i]) || 0;
            var code = parseInt((h.weather_code || [])[i], 10) || 0;
            if (p.rain && prob >= p.rainPct) {
                add('rain', TXT[c.lang].wRain, TXT[c.lang].wRain + ' ' + when + ' \u00B7 ' + prob + '%', E.rain, t, slot, prob);
            }
            if (p.wind && wind >= p.windKmh) {
                add('wind', TXT[c.lang].wWind, TXT[c.lang].wWind + ' ' + when + ' \u00B7 ' + Math.round(wind) + ' km/h', E.cloud, t, slot, wind);
            }
            if (p.heat && temp >= p.heatC) {
                add('heat', TXT[c.lang].wHeat, TXT[c.lang].wHeat + ' ' + when + ' \u00B7 ' + Math.round(temp) + '\u00B0C', E.sun, t, slot, temp);
            }
            if (p.storm && code >= p.stormCode) {
                add('storm', TXT[c.lang].wStorm, TXT[c.lang].wStorm + ' ' + when, E.storm, t, slot, code);
            }
        }
        for (i = 0; i < order.length; i++) {
            var a = order[i], key = w.place + '|' + a.kind + '|' + (a.slot || new Date(a.at).toISOString().slice(0, 13));
            if (weatherWarned[key]) { continue; }
            weatherWarned[key] = true;
            persistWeatherWarned();
            banner(E.warn + ' ' + TXT[c.lang].weatherSoon + ' \u00B7 ' + a.label, a.msg, 'warn', a.icon, w.seconds,
                { sound: '', mode: w.mode, volume: w.volume, group: false });
            addLog('weather', 'ahead', a.msg);
        }
    }
    function pollWeather(manual) {
        var c = cfg(), w = c.weather, place = byId(allPlaces(c), w.place) || PLACES[0];
        var hour = new Date(Date.now()).getHours(), tomorrow = (w.when === 'night');
        // " morning": only up to 10h, today's forecast. "night": only after 18h, tomorrow's forecast.
        var skip = !manual && ((w.when === 'morning' && hour >= 10) || (w.when === 'night' && hour < 18));
        function done(err, wx, raw) {
            status.weather.at = Date.now();
            if (err) {
                status.weather.error = String(err); addLog('weather', 'error', String(err));
                return schedule('weather', 300000);
            }
            status.weather.error = ''; status.weather.line = wx.line; status.weather.state = wx.state;
            checkProactive(raw, place, c, w, manual, skip);
            if (skip) { addLog('weather', 'skip', w.when + ': ' + wx.line); }
            else if (!manual && w.quiet && quietNow()) { addLog('weather', 'quiet', wx.line); }
            else {
                // NC limits the title to 40 characters: drop the region a custom place carries in
                // its name, keep the full name in the message line.
                var short = place.name.replace(/\s*\([^)]*\)$/, '');
                banner(wx.icon + ' ' + TXT[c.lang].weather + ' \u00B7 ' + short, wx.line,
                    (wx.rain >= 60 ? 'warn' : 'info'), wx.icon, w.seconds,
                    { sound: w.sound ? 'soft' : '', mode: w.mode, volume: w.volume });
                addLog('weather', 'weather', wx.line);
            }
            schedule('weather', w.interval * 60000);
        }
        if (w.provider === 'ipma') { ipmaWeather(place, tomorrow, c.lang, done); }
        else { openMeteoWeather(place, tomorrow, c.lang, done); }
    }

    // ---- scheduler -----------------------------------------------------------------------------------------------------------
    function schedule(name, ms) {
        busy[name] = false;
        if (!running) { return; }
        status[name].next = Date.now() + ms;
        clearTimeout(timers[name]);
        timers[name] = setTimeout(function () { poll(name); }, ms);
    }
    function poll(name, manual) {
        if (!running) { return; }
        if (name === 'all') { poll('sport'); poll('civ'); poll('weather'); poll('news'); return; }
        // A disabled module must not be polled again: "Check now" used to restart the timers of every
        // module, including the ones switched off. Manual tests are the exception: they must work
        // even when the module is off, but still go through the busy[] guard below.
        if (!manual && (name === 'civ' ? !cfg().civ.enabled : !cfg().modules[name])) { status[name].next = 0; return; }
        // One poll at a time per module: "Check now" plus the timer used to run two requests and
        // two banners for the same goal.
        if (busy[name]) { return; }
        busy[name] = true;
        clearTimeout(timers[name]);
        try {
            if (name === 'sport') { pollSport(); }
            else if (name === 'civ') { pollCiv(!!manual); }
            else if (name === 'weather') { pollWeather(!!manual); }
            else { pollNews(!!manual); }
        } catch (e) {
            busy[name] = false;
            addLog(name, 'error', String(e && e.message || e));
            schedule(name, 120000);
        }
    }
    function kick(name, delay) {
        clearTimeout(timers[name]);
        if (!running || (name === 'civ' ? !cfg().civ.enabled : !cfg().modules[name])) { status[name].next = 0; return; }
        timers[name] = setTimeout(function () { poll(name); }, delay);
    }

    function sendFile(res, name, type) {
        fs.readFile(path.join(__dirname, name), 'utf8', function (err, text) {
            if (err) { return sendJson(res, 500, { error: name + ' is missing' }); }
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
            res.end(text);
        });
    }
    function teams(sport, league, provider, cb) {
        var key = provider + '|' + sport + '|' + league, hit = teamsCache[key];
        if (hit && Date.now() - hit.at < 86400000) { return cb(null, hit.list); }
        function store(err, list) {
            if (err) { return cb(err); }
            list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
            teamsCache[key] = { at: Date.now(), list: list };
            cb(null, list);
        }
        if (provider === 'apifootball') { return afTeams(league, store); }
        espnTeams(sport, league, store);
    }
    // Baselines and dedupe keys live in ctx.config so a restart (or a TV reboot) does not re-announce
    // yesterday's news or lose a goal that happened while the Shard was down.
    function loadHistory() {
        var h = rawCfg().history || {};
        newsApi.load(h.newsSeen);
        last = h.last && typeof h.last === 'object' ? h.last : {};
        seenEvent = h.seenEvent && typeof h.seenEvent === 'object' ? h.seenEvent : {};
        historyAt = h.at || 0;
    }
    function persistHistory(force) {
        if (!force && Date.now() - historyAt < 60000) { return; }
        historyAt = Date.now();
        var store = rawCfg(), i, lk, ek;
        // Keep it small: 40 seen keys per feed (news module), 40 match baselines, 300 event keys.
        lk = Object.keys(last);
        if (lk.length > 40) {
            lk.sort(function (a, b) { return (last[b].at || 0) - (last[a].at || 0); });
            for (i = 40; i < lk.length; i++) { delete last[lk[i]]; }
        }
        ek = Object.keys(seenEvent);
        if (ek.length > 300) {
            ek.sort(function (a, b) { return seenEvent[b] - seenEvent[a]; });
            for (i = 300; i < ek.length; i++) { delete seenEvent[ek[i]]; }
        }
        store.history = { newsSeen: newsApi.trim(), last: last, seenEvent: seenEvent, at: historyAt };
        try { ctx.config.set(store); }
        catch (e) { addLog('sport', 'error', 'persist history: ' + String(e && e.message || e)); }
    }
    function resetSport() {
        last = {}; watchStatus = {}; seenEvent = {}; nextGame = {};
        espn.reset(); afApi.reset();
    }

    return {
        start: function () {
            running = true; stopped = false;
            bannerQueue.length = 0; sendTimes.length = 0;
            busy = { sport: false, weather: false, news: false, civ: false };
            loadHistory();
            loadWeatherWarned();
            loadNextHints();
            // Restore the ids already warned before a restart/TV reboot.
            var saved = rawCfg().nextNotified || {}, wk;
            for (wk in saved) { if (saved.hasOwnProperty(wk)) { nextWarned[wk] = true; } }
            refreshSounds();
            clearInterval(soundTimer);
            soundTimer = setInterval(refreshSounds, 600000);
            kick('sport', 3000); kick('civ', 5000); kick('weather', 8000); kick('news', 13000);
        },
        stop: function () {
            running = false; stopped = true;
            // Nothing queued before shutdown may be delivered later.
            bannerQueue.length = 0; sendTimes.length = 0;
            clearInterval(soundTimer); soundTimer = null;
            clearTimeout(bannerTimer); bannerTimer = null;
            Object.keys(timers).forEach(function (k) { clearTimeout(timers[k]); });
            busy = { sport: false, weather: false, news: false, civ: false };
            persistHistory(true);
            newsApi.clear(); civSeen = {}; resetSport();
        },
        status: function () {
            var s = status.sport, hk = Object.keys(providerHealth), hs = [], i, h;
            for (i = 0; i < hk.length; i++) {
                h = providerHealth[hk[i]];
                hs.push(hk[i] + ':' + (h.fails ? ('fail/' + h.fails) : 'ok'));
            }
            return {
                sport: s.line || null, weather: status.weather.line || null, news: status.news.line || null,
                civ: status.civ.line || null, error: s.error || null, health: hs.length ? hs.join(' ') : null
            };
        },
        // One card in the launcher's Control center (Vetro 0.7+): quick "Check now" actions
        // plus the current status lines. No extra permissions, no drawing on the TV.
        card: function () {
            var c = cfg(), next = nextList()[0], rows = [
                { id: 'check-sport', label: c.lang === 'pt' ? 'Verificar desporto' : 'Check sport', value: status.sport.line || (c.lang === 'pt' ? 'parado' : 'idle') },
                { id: 'check-weather', label: c.lang === 'pt' ? 'Verificar tempo' : 'Check weather', value: status.weather.line || (c.lang === 'pt' ? 'parado' : 'idle') },
                { id: 'check-news', label: c.lang === 'pt' ? 'Verificar noticias' : 'Check news', value: status.news.line || (c.lang === 'pt' ? 'parado' : 'idle') },
                { id: 'check-civ', label: c.lang === 'pt' ? 'Verificar proteccao civil' : 'Check civil protection', value: status.civ.line || (c.lang === 'pt' ? 'parado' : 'idle') }
            ];
            if (next) { rows.push({ id: 'next-game', label: c.lang === 'pt' ? 'Proximo jogo' : 'Next match', value: next.home + ' - ' + next.away + ' ' + next.line }); }
            return { rows: rows.slice(0, 7), note: c.lang === 'pt' ? 'Acoes rapidas' : 'Quick actions', choosable: true };
        },
        cardSelect: function (rowId) {
            if (!running) { return { ok: false, note: 'offline' }; }
            var names = { 'check-sport': 'sport', 'check-weather': 'weather', 'check-news': 'news', 'check-civ': 'civ' };
            if (names[rowId]) { poll(names[rowId], true); return { ok: true }; }
            return { ok: false, note: 'unknown action' };
        },
        route: function (req, res, sub) {
            // Vetro passes only the path in `sub`; the query string is in req.url.
            var full = String((req && req.url) || ''), qs = '', qi = full.indexOf('?');
            if (qi >= 0) { qs = full.slice(qi + 1); }
            else { qi = String(sub || '').indexOf('?'); if (qi >= 0) { qs = String(sub).slice(qi + 1); } }
            sub = String(sub || '').split('?')[0].replace(/^\/+|\/+$/g, '');
            if (sub === 'ui' && req.method === 'GET') { sendFile(res, 'ui.html', 'text/html; charset=utf-8'); return true; }
            if (sub === 'clearlog' && req.method === 'POST') { log.length = 0; sendJson(res, 200, { ok: true }); return true; }
            if (sub === 'state' && req.method === 'GET') {
                sendJson(res, 200, { config: publicCfg(), status: status, watches: watchStatus, next: nextList(), civ: civAlerts,
                    notify: { queued: bannerQueue.length, sentMinute: sendTimes.length }, health: providerHealth, log: log });
                return true;
            }
            // Public endpoint for widgets / a mini-site. Unlike /state it carries no config,
            // no key flag, no feeds list and no log text beyond the last few lines.
            if (sub === 'last' && (req.method === 'GET' || req.method === 'OPTIONS')) {
                sendPublicJson(res, 200, {
                    version: VERSION, at: Date.now(), historyAt: historyAt,
                    status: status, watches: watchStatus, next: nextList(),
                    civ: civAlerts, last: publicLast(),
                    notify: { queued: bannerQueue.length, sentMinute: sendTimes.length }, health: providerHealth,
                    log: log.slice(0, 10)
                });
                return true;
            }
            if (sub === 'teams' && (req.method === 'GET' || req.method === 'POST')) {
                var p = {}, parts = qs.split('&'), i, kv;
                for (i = 0; i < parts.length; i++) {
                    kv = parts[i].split('=');
                    if (kv[0]) { p[dec(kv[0])] = dec(kv[1] || ''); }
                }
                var answer = function () {
                    var sport = p.sport || 'soccer', league = p.league || 'por.1';
                    var prov = p.provider || cfg().football.provider;
                    teams(sport, league, prov, function (err, list) {
                        sendJson(res, err ? 502 : 200, err ? { error: String(err) } : { teams: list });
                    });
                };
                // POST keeps the arguments out of the URL: the Vetro frame does not always forward
                // the query string to the Shard.
                if (req.method === 'POST') {
                    readBody(req, function (raw) {
                        var b = {}; try { b = JSON.parse(raw) || {}; } catch (e) { b = {}; }
                        if (b.sport) { p.sport = String(b.sport); }
                        if (b.league) { p.league = String(b.league); }
                        if (b.provider) { p.provider = String(b.provider); }
                        answer();
                    });
                } else { answer(); }
                return true;
            }
            // Upcoming F1 races for the "Other sports" picker. Each pick stores the ESPN event id
            // so two races can be followed at once instead of both showing evs[0].
            if (sub === 'races' && (req.method === 'GET' || req.method === 'POST')) {
                var fallback = function () {
                    compEvents('racing/f1', function (err2, cur) {
                        if (err2) { return sendJson(res, 502, { error: String(err2) }); }
                        sendJson(res, 200, { races: raceRows(cur), season: false });
                    });
                };
                espnRaces(function (err, evs) {
                    if (err || !evs || !evs.length) { return fallback(); }
                    sendJson(res, 200, { races: raceRows(evs), season: true });
                });
                return true;
            }
            // Search a place by name: the user types "Caldas da Rainha" and the panel gets the
            // coordinates from Open-Meteo. POST is the reliable form in the Vetro panel frame.
            if (sub === 'geocode' && (req.method === 'GET' || req.method === 'POST')) {
                var gp = {}, gparts = qs.split('&'), gi, gkv;
                for (gi = 0; gi < gparts.length; gi++) {
                    gkv = gparts[gi].split('=');
                    if (gkv[0]) { gp[dec(gkv[0])] = dec(gkv[1] || ''); }
                }
                function search() {
                    var name = clean(gp.name || '', 80).trim();
                    if (name.length < 2) { return sendJson(res, 400, { error: 'type a place name' }); }
                    var lang = cfg().lang === 'pt' ? 'pt' : 'en';
                    var q = '/v1/search?name=' + encodeURIComponent(name) + '&count=8&language=' + lang + '&format=json';
                    getJson('geocoding-api.open-meteo.com', q, {}, function (err, d) {
                        if (err) { return sendJson(res, 502, { error: String(err) }); }
                        var out = [], i, r, lat, lon, nm, region;
                        var list = (d && d.results) || [];
                        for (i = 0; i < list.length; i++) {
                            r = list[i] || {};
                            lat = parseFloat(r.latitude); lon = parseFloat(r.longitude);
                            nm = clean(r.name || '', 50).trim();
                            if (!nm || !(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) { continue; }
                            region = clean(r.admin1 || '', 40);
                            if (r.country) { region += (region ? ', ' : '') + clean(r.country, 30); }
                            out.push({
                                id: 'c' + String(r.id || (Date.now() + i)),
                                name: nm + (region ? ' (' + region + ')' : ''),
                                lat: lat, lon: lon
                            });
                        }
                        sendJson(res, 200, { places: out });
                    });
                }
                if (req.method === 'POST') {
                    readBody(req, function (raw) {
                        var b = {}; try { b = JSON.parse(raw) || {}; } catch (e) { b = {}; }
                        if (b.name) { gp.name = String(b.name); }
                        search();
                    });
                } else { search(); }
                return true;
            }
            if (sub === 'poll' && req.method === 'POST') {
                readBody(req, function (raw) {
                    var b = {}; try { b = JSON.parse(raw) || {}; } catch (e) { b = {}; }
                    if (b.module === 'sport' || b.module === 'civ' || b.module === 'weather' || b.module === 'news') { poll(b.module); }
                    else { poll('all'); }
                    sendJson(res, 200, { ok: true });
                });
                return true;
            }
            if (sub === 'keycheck' && req.method === 'POST') {
                afGet('/status', function (err, d) {
                    if (err) { return sendJson(res, 502, { error: String(err) }); }
                    var r = d && d.response || {}, q = r.requests || {}, s2 = r.subscription || {};
                    var limit = parseInt(q.limit_day, 10) || 0, used = parseInt(q.current, 10) || 0;
                    sendJson(res, 200, { ok: true, plan: s2.plan || '', limit: limit, used: used, remaining: Math.max(0, limit - used) });
                });
                return true;
            }
            if (sub === 'config' && req.method === 'POST') {
                readBody(req, function (raw) {
                    var b = {}, store = rawCfg(), c = cfg();
                    var rawBefore = JSON.parse(JSON.stringify(store));
                    var before = {
                        clubs: JSON.stringify(c.football.clubs), prov: c.football.provider,
                        feeds: c.news.feeds.join(','), place: c.weather.place,
                        custom: JSON.stringify(c.weather.custom),
                        wprov: c.weather.provider, wwhen: c.weather.when,
                        civ: JSON.stringify(c.civ),
                        mods: { sport: c.modules.sport, weather: c.modules.weather, news: c.modules.news }
                    };
                    try { b = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); }
                    b = b || {};
                    // Wrong types must be refused instead of silently clamped to a default.
                    var numeric = [
                        ['weather', 'interval'], ['weather', 'seconds'], ['weather', 'volume'],
                        ['weather', 'proactive', 'minutes'], ['weather', 'proactive', 'rainPct'],
                        ['weather', 'proactive', 'windKmh'], ['weather', 'proactive', 'heatC'], ['weather', 'proactive', 'stormCode'],
                        ['news', 'interval'], ['news', 'seconds'], ['news', 'count'], ['news', 'volume'],
                        ['civ', 'interval'], ['civ', 'seconds'], ['civ', 'volume'],
                        ['football', 'goalSeconds'], ['football', 'otherSeconds'], ['football', 'volume'],
                        ['others', 'seconds'], ['others', 'volume']
                    ];
                    for (var np = 0; np < numeric.length; np++) {
                        var node = b, ni;
                        for (ni = 0; ni < numeric[np].length && node; ni++) { node = node[numeric[np][ni]]; }
                        if (node !== undefined && typeof node !== 'number') {
                            return sendJson(res, 400, { error: 'expected a number: ' + numeric[np].join('.') });
                        }
                    }
                    var f = b.football || {}, ob = b.others || {}, we = b.weather || {}, ne = b.news || {}, mo = b.modules || {}, cv = b.civ || {}, sv = b.sim || {};
                    if (b.lang === 'en' || b.lang === 'pt') { c.lang = b.lang; }
                    Object.keys(c.modules).forEach(function (k) { if (typeof mo[k] === 'boolean') { c.modules[k] = mo[k]; } });

                    if (f.provider !== undefined) {
                        if (!PROVIDERS.hasOwnProperty(f.provider)) { return sendJson(res, 400, { error: 'unknown provider' }); }
                        c.football.provider = f.provider;
                    }
                    if (f.clubs !== undefined) {
                        if (!Array.isArray(f.clubs)) { return sendJson(res, 400, { error: 'clubs must be a list' }); }
                        if (f.clubs.length > MAX_CLUBS) { return sendJson(res, 400, { error: 'too many clubs' }); }
                        var i, cl, list = [];
                        for (i = 0; i < f.clubs.length; i++) {
                            cl = normClub(f.clubs[i], c.lang);
                            if (!cl) { return sendJson(res, 400, { error: 'bad club' }); }
                            if (!byId(list, cl.id)) { list.push(cl); }
                        }
                        c.football.clubs = list;
                    }
                    if (f.alerts && typeof f.alerts === 'object') {
                        Object.keys(c.football.alerts).forEach(function (k) { if (typeof f.alerts[k] === 'boolean') { c.football.alerts[k] = f.alerts[k]; } });
                    }
                    if (f.goalSeconds !== undefined) { c.football.goalSeconds = clamp(f.goalSeconds, 5, 60, c.football.goalSeconds); }
                    if (f.otherSeconds !== undefined) { c.football.otherSeconds = clamp(f.otherSeconds, 3, 30, c.football.otherSeconds); }
                    if (typeof f.sound === 'boolean') { c.football.sound = f.sound; }
                    if (f.mode !== undefined) { if (byId(MODES, f.mode)) { c.football.mode = f.mode; } }
                    if (f.volume !== undefined) { c.football.volume = clamp(f.volume, 10, 100, c.football.volume); }
                    if (f.nextGame && typeof f.nextGame === 'object') {
                        if (typeof f.nextGame.enabled === 'boolean') { c.football.nextGame.enabled = f.nextGame.enabled; }
                        if (f.nextGame.minutes !== undefined) {
                            c.football.nextGame.minutes = clamp(f.nextGame.minutes, 0, 120, c.football.nextGame.minutes);
                        }
                    }

                    if (ob.picks !== undefined) {
                        if (!Array.isArray(ob.picks)) { return sendJson(res, 400, { error: 'picks must be a list' }); }
                        if (ob.picks.length > MAX_PICKS) { return sendJson(res, 400, { error: 'too many picks' }); }
                        var j, pk, picks = [], seen = {};
                        for (j = 0; j < ob.picks.length; j++) {
                            pk = normPick(ob.picks[j]);
                            if (!pk) { return sendJson(res, 400, { error: 'bad pick' }); }
                            var pk2 = pickKey(pk);
                            if (!seen[pk2]) { seen[pk2] = true; picks.push(pk); }
                        }
                        c.others.picks = picks;
                    }
                    if (ob.alerts && typeof ob.alerts === 'object') {
                        Object.keys(c.others.alerts).forEach(function (k) { if (typeof ob.alerts[k] === 'boolean') { c.others.alerts[k] = ob.alerts[k]; } });
                    }
                    if (ob.seconds !== undefined) { c.others.seconds = clamp(ob.seconds, 3, 30, c.others.seconds); }
                    if (typeof ob.sound === 'boolean') { c.others.sound = ob.sound; }
                    if (ob.mode !== undefined) { if (byId(MODES, ob.mode)) { c.others.mode = ob.mode; } }
                    if (ob.volume !== undefined) { c.others.volume = clamp(ob.volume, 10, 100, c.others.volume); }

                    if (we.custom !== undefined) {
                        if (!Array.isArray(we.custom)) { return sendJson(res, 400, { error: 'custom must be a list' }); }
                        if (we.custom.length > MAX_PLACES) { return sendJson(res, 400, { error: 'too many places' }); }
                        var cpl = [], cseen = {}, cj, cn;
                        for (cj = 0; cj < we.custom.length; cj++) {
                            cn = normPlace(we.custom[cj]);
                            if (!cn) { return sendJson(res, 400, { error: 'bad place' }); }
                            if (!cseen[cn.id]) { cseen[cn.id] = true; cpl.push(cn); }
                        }
                        c.weather.custom = cpl;
                        // The place that was removed cannot stay selected.
                        if (c.weather.place && c.weather.place.charAt(0) === 'c' && !byId(cpl, c.weather.place)) {
                            c.weather.place = DEFAULTS.weather.place;
                        }
                    }
                    if (typeof cv.enabled === 'boolean') { c.civ.enabled = cv.enabled; }
                    if (cv.district !== undefined) {
                        if (!byId(CIV_AREAS, cv.district)) { return sendJson(res, 400, { error: 'unknown district' }); }
                        c.civ.district = cv.district;
                    }
                    if (cv.levels && typeof cv.levels === 'object') {
                        Object.keys(c.civ.levels).forEach(function (k) {
                            if (typeof cv.levels[k] === 'boolean') { c.civ.levels[k] = cv.levels[k]; }
                        });
                    }
                    if (typeof cv.anepc === 'boolean') { c.civ.anepc = cv.anepc; }
                    if (typeof cv.news === 'boolean') { c.civ.news = cv.news; }
                    if (cv.keywords !== undefined) { c.civ.keywords = clean(cv.keywords, 220); }
                    if (cv.interval !== undefined) { c.civ.interval = clamp(cv.interval, 5, 240, c.civ.interval); }
                    if (cv.seconds !== undefined) { c.civ.seconds = clamp(cv.seconds, 3, 60, c.civ.seconds); }
                    if (typeof cv.sound === 'boolean') { c.civ.sound = cv.sound; }
                    if (cv.mode !== undefined) { if (byId(MODES, cv.mode)) { c.civ.mode = cv.mode; } }
                    if (cv.volume !== undefined) { c.civ.volume = clamp(cv.volume, 10, 100, c.civ.volume); }

                    if (sv.clubs !== undefined) {
                        if (!Array.isArray(sv.clubs)) { return sendJson(res, 400, { error: 'clubs must be a list' }); }
                        if (sv.clubs.length > 10) { return sendJson(res, 400, { error: 'too many test clubs' }); }
                        var scl = [], sn, si;
                        for (si = 0; si < sv.clubs.length; si++) {
                            sn = normSimClub(sv.clubs[si]);
                            if (!sn) { return sendJson(res, 400, { error: 'bad test club' }); }
                            scl.push(sn);
                        }
                        c.sim.clubs = scl;
                    }

                    if (we.place !== undefined) {
                        if (!byId(allPlaces(c), we.place)) { return sendJson(res, 400, { error: 'unknown place' }); }
                        c.weather.place = we.place;
                    }
                    if (we.interval !== undefined) { c.weather.interval = clamp(we.interval, 5, 240, c.weather.interval); }
                    if (we.seconds !== undefined) { c.weather.seconds = clamp(we.seconds, 3, 30, c.weather.seconds); }
                    if (typeof we.quiet === 'boolean') { c.weather.quiet = we.quiet; }
                    if (typeof we.sound === 'boolean') { c.weather.sound = we.sound; }
                    if (we.mode !== undefined) { if (byId(MODES, we.mode)) { c.weather.mode = we.mode; } }
                    if (we.volume !== undefined) { c.weather.volume = clamp(we.volume, 10, 100, c.weather.volume); }
                    if (we.provider !== undefined) {
                        if (!byId(WEATHER_PROVIDERS, we.provider)) { return sendJson(res, 400, { error: 'unknown weather provider' }); }
                        c.weather.provider = we.provider;
                    }
                    if (we.when !== undefined) {
                        if (!byId(WEATHER_WHEN, we.when)) { return sendJson(res, 400, { error: 'unknown weather schedule' }); }
                        c.weather.when = we.when;
                    }
                    if (we.proactive && typeof we.proactive === 'object') {
                        var wpa = we.proactive;
                        if (typeof wpa.enabled === 'boolean') { c.weather.proactive.enabled = wpa.enabled; }
                        if (wpa.minutes !== undefined) { c.weather.proactive.minutes = clamp(wpa.minutes, 30, 180, c.weather.proactive.minutes); }
                        if (typeof wpa.rain === 'boolean') { c.weather.proactive.rain = wpa.rain; }
                        if (typeof wpa.wind === 'boolean') { c.weather.proactive.wind = wpa.wind; }
                        if (typeof wpa.heat === 'boolean') { c.weather.proactive.heat = wpa.heat; }
                        if (typeof wpa.storm === 'boolean') { c.weather.proactive.storm = wpa.storm; }
                        if (wpa.rainPct !== undefined) { c.weather.proactive.rainPct = clamp(wpa.rainPct, 10, 100, c.weather.proactive.rainPct); }
                        if (wpa.windKmh !== undefined) { c.weather.proactive.windKmh = clamp(wpa.windKmh, 10, 120, c.weather.proactive.windKmh); }
                        if (wpa.heatC !== undefined) { c.weather.proactive.heatC = clamp(wpa.heatC, 20, 50, c.weather.proactive.heatC); }
                        if (wpa.stormCode !== undefined) { c.weather.proactive.stormCode = clamp(wpa.stormCode, 80, 99, c.weather.proactive.stormCode); }
                    }

                    if (ne.feeds !== undefined) {
                        if (!Array.isArray(ne.feeds)) { return sendJson(res, 400, { error: 'feeds must be a list' }); }
                        var k2, fl = [];
                        for (k2 = 0; k2 < ne.feeds.length && fl.length < MAX_FEEDS; k2++) {
                            if (!byId(FEEDS, String(ne.feeds[k2]))) { return sendJson(res, 400, { error: 'unknown feed' }); }
                            if (fl.indexOf(String(ne.feeds[k2])) < 0) { fl.push(String(ne.feeds[k2])); }
                        }
                        if (!fl.length) { return sendJson(res, 400, { error: 'choose at least one feed' }); }
                        c.news.feeds = fl;
                    }
                    if (ne.interval !== undefined) { c.news.interval = clamp(ne.interval, 5, 240, c.news.interval); }
                    if (ne.seconds !== undefined) { c.news.seconds = clamp(ne.seconds, 3, 30, c.news.seconds); }
                    if (typeof ne.quiet === 'boolean') { c.news.quiet = ne.quiet; }
                    if (ne.count !== undefined) { c.news.count = clamp(ne.count, 1, 3, c.news.count); }
                    if (typeof ne.sound === 'boolean') { c.news.sound = ne.sound; }
                    if (ne.mode !== undefined) { if (byId(MODES, ne.mode)) { c.news.mode = ne.mode; } }
                    if (ne.volume !== undefined) { c.news.volume = clamp(ne.volume, 10, 100, c.news.volume); }

                    if (b.apiKey !== undefined) {
                        var key = String(b.apiKey).trim();
                        if (key && !/^[A-Za-z0-9_-]{8,80}$/.test(key)) { return sendJson(res, 400, { error: 'that does not look like an API key' }); }
                        store.keys = store.keys || {};
                        if (key) { store.keys.apifootball = key; } else { delete store.keys.apifootball; }
                    }
                    store.lang = c.lang; store.modules = c.modules;
                    store.football = c.football; store.others = c.others;
                    store.weather = c.weather; store.news = c.news; store.civ = c.civ; store.sim = c.sim;
                    delete store.sport;                       // migrated into football
                    ctx.config.set(store);
                    // Only restart what actually changed: saving anything used to reset the news
                    // baseline and re-poll every module, repeating the same banner.
                    var sportReset = before.clubs !== JSON.stringify(c.football.clubs) || before.prov !== c.football.provider;
                    if (sportReset) { resetSport(); }
                    if (before.feeds !== c.news.feeds.join(',')) { newsApi.clear(); }
                    if (before.civ !== JSON.stringify(c.civ)) { civSeen = {}; }
                    sendJson(res, 200, { config: publicCfg() });
                    if (sportReset || (!rawBefore.modules || !rawBefore.modules.sport) && c.modules.sport) { kick('sport', 1000); }
                    if (before.place !== c.weather.place || before.custom !== JSON.stringify(c.weather.custom) ||
                        before.wprov !== c.weather.provider || before.wwhen !== c.weather.when ||
                        (!rawBefore.modules || !rawBefore.modules.weather) && c.modules.weather) { kick('weather', 2000); }
                    if (before.feeds !== c.news.feeds.join(',') || (!rawBefore.modules || !rawBefore.modules.news) && c.modules.news) { kick('news', 3000); }
                    if (before.civ !== JSON.stringify(c.civ) || (!rawBefore.civ && c.civ.enabled)) { kick('civ', 4000); }
                });
                return true;
            }
            // Goal simulation buttons: same notify path as real goals, but silent and without
            // touching the clubs the Shard actually follows.
            if (sub === 'test-club' && req.method === 'POST') {
                readBody(req, function (raw) {
                    var b = {}, c = cfg();
                    try { b = JSON.parse(raw) || {}; } catch (e) { b = {}; }
                    var cl = byId(c.sim.clubs, String(b.id || ''));
                    if (!cl) { return sendJson(res, 400, { error: 'unknown test club' }); }
                    var title = 'Golo! ' + cl.name, msg = cl.msg || ('Golo do ' + cl.name);
                    banner(title, msg, cl.level, '', 8, {
                        mode: 'overlay', theme: 'sport', image: cl.logo, group: false
                    });
                    addLog('test', 'goalSim', title + ' - ' + msg);
                    sendJson(res, 200, { ok: true, title: title, message: msg });
                });
                return true;
            }
            if (sub === 'test' && req.method === 'POST') {
                readBody(req, function (raw) {
                    var b = {}, c = cfg(), t = TXT[c.lang];
                    try { b = JSON.parse(raw) || {}; } catch (e) { b = {}; }
                    var kind = b.kind || 'goal';
                    var club = byId(c.football.clubs, String(b.club || '')) || c.football.clubs[0];
                    if (kind === 'next') {
                        // Test the kick-off warning without consuming the real one (nextWarned untouched).
                        var ng = nextList()[0];
                        var title = TITLE_PRE;
                        var msg = ng ? (ng.home + ' \u00D7 ' + ng.away + ' \u00B7 ' + ng.line) :
                            (t.team + ' \u00D7 ' + t.test + ' \u00B7 ' + t.today + ' 20:30');
                        banner(title, msg, 'info', E.whistle, c.football.otherSeconds,
                            { sound: c.football.sound ? 'reward' : '', group: false, mode: c.football.mode,
                              image: logoFor('club', c.football.provider, 'soccer', club ? club.id : ''),
                              volume: c.football.volume });
                        addLog('test', 'next', msg);
                        sendJson(res, 200, { ok: true });
                        return;
                    }
                    if (kind === 'weather' || kind === 'news' || kind === 'civ') {
                        sendJson(res, 200, { ok: true });
                        if (kind === 'weather') { poll('weather', true); }
                        else if (kind === 'news') { poll('news', true); }
                        else { poll('civ', true); }
                        return;
                    }
                    var w = {
                        key: 'test', kind: 'club', name: club ? club.name : t.team, teamId: club ? club.id : '0',
                        alerts: club && club.alerts ? club.alerts : c.football.alerts,
                        goalSeconds: c.football.goalSeconds,
                        otherSeconds: c.football.otherSeconds, sound: c.football.sound,
                        mode: c.football.mode, lang: c.lang, volume: c.football.volume,
                        logo: logoFor('club', c.football.provider, 'soccer', club ? club.id : '')
                    };
                    if (kind === 'score') {
                        w = { key: 'test', kind: 'other', name: t.team, teamId: '0', alerts: c.others.alerts,
                            goalSeconds: c.others.seconds, otherSeconds: c.others.seconds,
                            sound: c.others.sound, mode: c.others.mode, lang: c.lang, volume: c.others.volume };
                    }
                    var known = { goal: 1, against: 1, cardY: 1, cardR: 1, sub: 1, var: 1, penalty: 1, penMiss: 1, start: 1, half: 1, end: 1, score: 1 };
                    if (kind === 'card') { kind = 'cardY'; }
                    var line = status.sport.line || (w.name + ' 1-0 ' + t.test);
                    var m = {
                        id: 'test', state: 'in', desc: t.test, clock: "22'",
                        home: { name: w.name, short: w.name, score: 1, id: w.teamId },
                        away: { name: t.test, short: t.test, score: 0, id: '0' }
                    };
                    announce(known[kind] ? kind : 'goal', w, m, { player: t.test, minute: "22'", detail: t.test, team: t.test });
                    addLog('test', kind, line);
                    sendJson(res, 200, { ok: true });
                });
                return true;
            }
            return false;
        }
    };
};
