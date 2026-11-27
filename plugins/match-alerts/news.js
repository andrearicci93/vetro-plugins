'use strict';
// News module: public RSS feeds plus one Google News search per club with news enabled.
// Plain ES5. The Shard injects the HTTP client, config, status, scheduler and the one notify path.
module.exports = function (env) {
    var getUrl = env.getUrl, clean = env.clean, stripTags = env.stripTags, byId = env.byId;
    var FEEDS = env.FEEDS, GN = env.GN, MAX_FEEDS = env.MAX_FEEDS, MAX_CLUBS = env.MAX_CLUBS;
    var TXT = env.TXT, E = env.E;
    var banner = env.banner, addLog = env.addLog, cfg = env.cfg;
    var status = env.status, schedule = env.schedule, persistHistory = env.persistHistory;
    var newsSeen = {};             // feed id -> last seen item keys (persisted by the Shard)

    function rssTag(block, name) {
        var re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i');
        var m = re.exec(block);
        return m ? clean(stripTags(m[1]), 180) : '';
    }
    function rssItems(xml, max) {
        var blocks = (String(xml || '').match(/<item[\s\S]*?<\/item>/gi) || []), out = [], i;
        for (i = 0; i < blocks.length && out.length < max; i++) {
            out.push({ key: rssTag(blocks[i], 'link') || rssTag(blocks[i], 'title'), title: rssTag(blocks[i], 'title'), date: rssTag(blocks[i], 'pubDate') });
        }
        return out;
    }
    function googleNewsUrl(name, lang) {
        var q = encodeURIComponent('"' + name + '"');
        return GN + q + (lang === 'pt' ? '&hl=pt-PT&gl=PT&ceid=PT:pt-150' : '&hl=en-US&gl=US&ceid=US:en');
    }
    // Selected feeds plus one Google News feed per club that has "club news" on.
    function feedList(c) {
        var out = [], i, f;
        for (i = 0; i < c.news.feeds.length; i++) {
            f = byId(FEEDS, c.news.feeds[i]);
            if (f) { out.push(f); }
        }
        for (i = 0; i < c.football.clubs.length; i++) {
            if (c.football.clubs[i].news) {
                out.push({
                    id: 'club:' + c.football.clubs[i].id,
                    name: c.football.clubs[i].name,
                    url: googleNewsUrl(c.football.clubs[i].name, c.lang)
                });
            }
        }
        return out.slice(0, MAX_FEEDS + MAX_CLUBS);
    }

    var NEWS_MAX_PER_POLL = 4, NEWS_MIN_GAP = 1000;
    function sendNews(items, feed, c, budget, cb) {
        var i = 0, sent = 0;
        function step() {
            if (i >= items.length || budget.left <= 0) { return cb(sent); }
            var item = items[i++];
            var delay = Math.max(0, NEWS_MIN_GAP - (Date.now() - budget.lastAt));
            function fire() {
                if (env.isRunning && !env.isRunning()) { return cb(sent); }
                banner(E.news + ' ' + TXT[c.lang].news + ' \u00B7 ' + feed.name, item.title, 'info', E.news, c.news.seconds,
                    { category: 'news', sound: c.news.sound ? 'soft' : '', mode: c.news.mode, volume: c.news.volume });
                addLog('news', 'news', item.title);
                budget.left--; sent++;
                budget.lastAt = Date.now();
                step();
            }
            if (delay > 0) { setTimeout(fire, delay); } else { fire(); }
        }
        step();
    }
    function fetchFeed(feed, c, manual, budget, cb) {
        getUrl(feed.url, {}, false, function (err, xml) {
            if (err) { addLog('news', 'error', feed.name + ': ' + err); return cb(0); }
            var items = rssItems(xml, 5), seen = newsSeen[feed.id], i, fresh = [], keys;
            if (!items.length) { return cb(0); }
            if (!status.news.line) { status.news.line = items[0].title; status.news.state = feed.name; }
            keys = items.map(function (x) { return x.key; });
            if (!seen) {
                // First read of a feed is a baseline: the headlines already there are marked as seen
                // and not announced, so a restart (or a new install) does not repeat yesterday's news.
                newsSeen[feed.id] = keys;
                seen = keys;
                addLog('news', 'base', feed.name + ': baseline ' + items.length);
                if (!manual) { return cb(0); }
                if (items[0]) { fresh.push(items[0]); }
            } else {
                for (i = 0; i < items.length; i++) {
                    if (items[i].key && seen.indexOf(items[i].key) < 0) { fresh.push(items[i]); }
                }
            }
            if (!fresh.length) {
                // A test must show something even when nothing changed: fall back to the newest
                // headline of the feed. Only one banner per test, so it never floods the screen.
                if (manual && items[0]) { fresh.push(items[0]); }
                else { return cb(0); }
            }
            // One global budget per poll, shared by every feed (and club news). Headlines that do
            // not fit are NOT marked as seen, so they are announced in the next poll instead of
            // being lost. sendNews spaces them at least one second apart.
            var take = Math.min(fresh.length, c.news.count, budget.left);
            var chosen = fresh.slice(0, take);
            newsSeen[feed.id] = chosen.map(function (x) { return x.key; }).concat(seen).slice(0, 40);
            sendNews(chosen, feed, c, budget, cb);
        });
    }
    function pollNews(manual) {
        var c = cfg(), list = feedList(c);
        status.news.at = Date.now();
        status.news.error = '';
        status.news.line = ''; status.news.state = '';   // do not keep the previous source on screen
        if (!list.length) { status.news.line = ''; status.news.state = ''; return schedule('news', 300000); }
        var i = 0, sentDone = false, budget = { left: manual ? 1 : NEWS_MAX_PER_POLL, lastAt: 0 };
        function step() {
            if (sentDone || i >= list.length) { persistHistory(false); return schedule('news', c.news.interval * 60000); }
            var f = list[i++];
            fetchFeed(f, c, manual, budget, function (n) {
                if (manual && n > 0) { sentDone = true; }
                step();
            });
        }
        step();
    }

    return {
        rssTag: rssTag, rssItems: rssItems, feedList: feedList, pollNews: pollNews,
        load: function (h) { newsSeen = h && typeof h === 'object' ? h : {}; },
        seen: function () { return newsSeen; },
        clear: function () { newsSeen = {}; },
        // Keep the persisted history small: at most 40 seen keys per feed.
        trim: function () {
            var keys = Object.keys(newsSeen), i;
            for (i = 0; i < keys.length; i++) {
                if (Array.isArray(newsSeen[keys[i]]) && newsSeen[keys[i]].length > 40) {
                    newsSeen[keys[i]] = newsSeen[keys[i]].slice(-40);
                }
            }
            return newsSeen;
        }
    };
};
