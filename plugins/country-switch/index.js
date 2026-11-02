'use strict';
// Changes the TV's "service country" (db/comss/countrycode), the value Samsung TV Plus and the App Store read.
// Plain ES5 (the host runs on Node 4.4 TVs). Local only: it talks to the TV agent through ctx.execute and to no host.
//
// What it relies on (found by reading the Q80A firmware, not yet confirmed on a TV): the comss daemon watches
// db/comss/countrycode. When it changes, comss drops the stored access token and, if db/comss/reset_status is 0,
// asks Samsung's provisioning server for the service URLs of the new country. It never touches db/system/country
// (tuner, channels, rating lock).

module.exports = function (ctx) {
    var KEY = 'db/comss/countrycode';
    var READ_KEYS = [KEY, 'db/comss/reset_status', 'db/comss/mobilecountrycode', 'db/system/country', 'db/system/pnp_country',
        'db/sso/sa_user_country_code', 'db/comss/gpmurl/apps', 'rtc/db/comss/gpmurl/apps'];
    var busy = false;

    // Not an official list of where TV Plus or the Store exist: the server decides that. Only these codes can be written.
    var COUNTRIES = [
        ['AT', 'Austria'], ['AU', 'Australia'], ['BR', 'Brazil'], ['CA', 'Canada'], ['CH', 'Switzerland'],
        ['DE', 'Germany'], ['DK', 'Denmark'], ['ES', 'Spain'], ['FR', 'France'], ['GB', 'United Kingdom'],
        ['IE', 'Ireland'], ['IN', 'India'], ['IT', 'Italy'], ['KR', 'South Korea'], ['MX', 'Mexico'],
        ['NO', 'Norway'], ['PT', 'Portugal'], ['SE', 'Sweden'], ['US', 'United States']
    ];

    function allowed(code) {
        var i;
        if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return false;
        for (i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i][0] === code) return true;
        return false;
    }

    function wrap(s) { return 'echo ' + Buffer.from(s).toString('base64') + ' | base64 -d | sh'; }

    function json(res, body, code) {
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }

    function readBody(req, cb) {
        var chunks = [], size = 0, done = false;
        function finish(err, text) { if (!done) { done = true; cb(err, text); } }
        req.on('data', function (c) {
            size += c.length;
            if (size > 4096) { finish(new Error('Body too large')); return; }
            chunks.push(c);
        });
        req.on('end', function () { finish(null, Buffer.concat(chunks).toString('utf8')); });
        req.on('error', function (e) { finish(e); });
    }

    // `vconftool get` prints "<key>, value = <v> (<Type>)" on success; anything else is "unreadable".
    function parseReads(out) {
        var values = {};
        String(out || '').split('\n').forEach(function (line) {
            var at = line.indexOf('=>');
            var key, text, m;
            if (at < 0) return;
            key = line.slice(0, at);
            text = line.slice(at + 2);
            m = /value = (.*?)(?: \([A-Za-z0-9 ]*\))?\s*$/.exec(text);
            values[key] = m ? m[1] : null;
        });
        return values;
    }

    function readState() {
        var script = READ_KEYS.map(function (k) {
            return 'printf \'%s=>\' ' + "'" + k + "'" + '; vconftool get ' + "'" + k + "'" + ' 2>&1 | head -n 1; echo';
        }).join('\n');
        return ctx.execute(wrap(script), 12000).then(function (r) {
            var v;
            if (r.exit_code || r.timed_out) throw new Error('The TV agent could not read the settings');
            v = parseReads(r.stdout);
            return {
                country: v[KEY],
                resetStatus: v['db/comss/reset_status'],
                mobileCountry: v['db/comss/mobilecountrycode'],
                systemCountry: v['db/system/country'],
                pnpCountry: v['db/system/pnp_country'],
                accountCountry: v['db/sso/sa_user_country_code'],
                serviceUrl: v['db/comss/gpmurl/apps'] || v['rtc/db/comss/gpmurl/apps'] || null,
                original: ctx.config.get().original || null
            };
        });
    }

    function write(code) {
        if (!allowed(code)) return Promise.reject(new Error('Country not in the list'));
        return ctx.execute(wrap('vconftool set -f -t string ' + KEY + ' ' + code), 10000).then(function (r) {
            if (r.exit_code || r.timed_out) throw new Error('The TV refused the change: ' + String(r.stderr || r.stdout || r.exit_code).slice(0, 120));
        });
    }

    function afterWrite(wanted) {
        // comss reacts asynchronously: give it a moment, then report what the TV holds.
        return new Promise(function (resolve) { setTimeout(resolve, 3000); }).then(readState).then(function (s) {
            s.changed = s.country === wanted;
            return s;
        });
    }

    function apply(code) {
        return readState().then(function (before) {
            var cfg = ctx.config.get();
            if (!/^[A-Z]{2}$/.test(before.country || '')) {
                throw new Error('The current country could not be read, so nothing was changed');
            }
            if (before.resetStatus !== '0') {
                throw new Error('The TV is not ready (reset_status is ' + before.resetStatus + '), nothing was changed');
            }
            if (!cfg.original) { cfg.original = before.country; ctx.config.set(cfg); }
            return write(code).then(function () { return afterWrite(code); });
        });
    }

    function restore() {
        var original = ctx.config.get().original;
        if (!/^[A-Z]{2}$/.test(original || '')) return Promise.reject(new Error('No original country saved'));
        // The saved value came from the TV itself, so it may not be in COUNTRIES: write it anyway after the pattern check.
        return ctx.execute(wrap('vconftool set -f -t string ' + KEY + ' ' + original), 10000).then(function (r) {
            if (r.exit_code || r.timed_out) throw new Error('The TV refused the change');
            return afterWrite(original);
        });
    }

    function guarded(res, work) {
        if (busy) { json(res, { error: 'Another change is in progress' }, 409); return; }
        busy = true;
        work().then(function (s) { busy = false; json(res, s); }, function (e) { busy = false; json(res, { error: String(e.message || e) }, 502); });
    }

    var PAGE = '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">' +
        '<body style="font:16px system-ui;margin:24px;max-width:640px"><h2>Country switch</h2>' +
        '<p>The country Samsung TV Plus and the App Store use. It does not change the TV\'s language, channels or ratings.</p>' +
        '<table id="t" style="border-collapse:collapse;margin:12px 0"></table>' +
        '<p><select id="c"></select> <button id="a">Apply</button> <button id="r">Restore original</button> <button id="f">Refresh</button></p>' +
        '<p><label><input type="checkbox" id="ok"> I know this is experimental and I can restore the original country here.</label></p>' +
        '<p id="m" style="min-height:3em"></p><script>' +
        'var C=' + JSON.stringify(COUNTRIES) + ',o=document.getElementById("c");' +
        'C.forEach(function(x){var e=document.createElement("option");e.value=x[0];e.textContent=x[1]+" ("+x[0]+")";o.appendChild(e)});' +
        'function msg(s){document.getElementById("m").textContent=s}' +
        'function row(k,v){return "<tr><td style=\\"padding:2px 16px 2px 0;opacity:.7\\">"+k+"</td><td>"+(v==null?"unreadable":String(v).replace(/[<>&]/g,""))+"</td></tr>"}' +
        'function show(d){if(d.error){msg(d.error);return}document.getElementById("t").innerHTML=' +
        'row("Service country",d.country)+row("Saved original",d.original)+row("Ready (reset_status)",d.resetStatus)+row("Service URL (apps)",d.serviceUrl)+' +
        'row("TV system country (not changed)",d.systemCountry)+row("Samsung account country",d.accountCountry)+row("Phone country code",d.mobileCountry);' +
        'if(d.changed===true)msg("Written. Close and reopen TV Plus and the App Store to see it.");if(d.changed===false)msg("The TV did not keep the new value. Press Refresh in a few seconds.")}' +
        'function post(p,b){msg("Working…");fetch(p,{method:"POST",headers:{"Content-Type":"text/plain"},body:JSON.stringify(b||{})}).then(function(r){return r.json()}).then(show)}' +
        'document.getElementById("f").onclick=function(){fetch("state").then(function(r){return r.json()}).then(show)};' +
        'document.getElementById("a").onclick=function(){if(!document.getElementById("ok").checked){msg("Tick the box first.");return}post("apply",{country:o.value})};' +
        'document.getElementById("r").onclick=function(){post("restore")};' +
        'document.getElementById("f").onclick();</script></body>';

    return {
        start: function () {},
        stop: function () { busy = false; },
        status: function () { return { original: ctx.config.get().original || null }; },
        route: function (req, res, sub) {
            if (sub === 'ui' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(PAGE);
                return true;
            }
            if (sub === 'state' && req.method === 'GET') {
                readState().then(function (s) { json(res, s); }, function (e) { json(res, { error: String(e.message || e) }, 502); });
                return true;
            }
            if (sub === 'apply' && req.method === 'POST') {
                readBody(req, function (err, text) {
                    var body;
                    try { body = err ? null : JSON.parse(text); } catch (e) { body = null; }
                    if (!body || !allowed(body.country)) { json(res, { error: 'Pick a country from the list' }, 400); return; }
                    guarded(res, function () { return apply(body.country); });
                });
                return true;
            }
            if (sub === 'restore' && req.method === 'POST') {
                readBody(req, function () { guarded(res, restore); });
                return true;
            }
            return false;
        }
    };
};
