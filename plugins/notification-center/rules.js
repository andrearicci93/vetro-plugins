'use strict';
// Rules of the Notification Center that do not touch the network: sources (profiles), quiet hours, grouping of repeats and webhook templates.
// Pure functions, plain ES5 (older TVs run Node 4.4), so they can be tested on their own.
var LEVEL_RANK = { info: 0, ok: 0, warn: 1, alert: 2 };
var LEVELS = { info: 1, ok: 1, warn: 1, alert: 1 };
var MODES = { both: 1, banner: 1, full: 1 };
var SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
var HOOK_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
var KEY_RE = /^[A-Za-z0-9._~-]{8,64}$/;
var MAX_SOURCES = 20, MAX_HOOKS = 10, MAX_TEMPLATE = 200, MAX_RATE = 600;

function cleanSource(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return SOURCE_RE.test(s) ? s : '';
}
function cleanHookName(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return HOOK_RE.test(s) ? s : '';
}
function clampInt(v, lo, hi, def) {
    var n = parseInt(v, 10);
    if (!(n >= lo)) { return def; }
    return n > hi ? hi : n;
}

// Compares two keys without stopping at the first different character.
function sameKey(a, b) {
    a = String(a == null ? '' : a); b = String(b == null ? '' : b);
    var d = a.length ^ b.length, i, n = a.length > b.length ? a.length : b.length;
    for (i = 0; i < n; i++) { d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); }
    return d === 0;
}

// A stored profile. Only known fields are kept. `key` is kept as given (set by the Shard or by the user), never returned by GET.
// icon: cleaned by the caller (cleanIcon lives next to the emoji rules in index.js).
function sanitizeProfile(p, cleanIcon, old) {
    p = p || {}; old = old || {};
    var out = {
        enabled: p.enabled === false ? false : (p.enabled === true ? true : old.enabled !== false),
        icon: p.hasOwnProperty('icon') ? cleanIcon(p.icon) : (old.icon || ''),
        level: LEVELS[p.level] ? p.level : (p.hasOwnProperty('level') && !p.level ? '' : (old.level || '')),
        mode: MODES[p.mode] ? p.mode : (p.hasOwnProperty('mode') && !p.mode ? '' : (old.mode || '')),
        duration: p.hasOwnProperty('duration') ? clampInt(p.duration, 1, 60, 0) : (old.duration || 0),
        rate: p.hasOwnProperty('rate') ? clampInt(p.rate, 0, MAX_RATE, 0) : (old.rate || 0),
        key: old.key || ''
    };
    if (p.hasOwnProperty('key')) {
        if (!p.key) { out.key = ''; }
        else if (KEY_RE.test(String(p.key))) { out.key = String(p.key); }
        else { out.error = 'key must be 8-64 characters: letters, digits and . _ ~ -'; }
    }
    return out;
}
// What GET returns: everything except the key itself.
function publicProfile(p) {
    return { enabled: p.enabled !== false, icon: p.icon || '', level: p.level || '', mode: p.mode || '', duration: p.duration || 0, rate: p.rate || 0, hasKey: !!p.key };
}
// Fills in what the sender left out with the source's defaults. The sender's own values always win.
function applyProfile(body, p) {
    var out = {}, k;
    for (k in body) { if (body.hasOwnProperty(k)) { out[k] = body[k]; } }
    if (!p) { return out; }
    if ((out.icon == null || out.icon === '') && p.icon) { out.icon = p.icon; }
    if (!out.level && p.level) { out.level = p.level; }
    if (!out.mode && p.mode) { out.mode = p.mode; }
    if ((out.duration == null || out.duration === '') && p.duration) { out.duration = p.duration; }
    return out;
}

// Sliding one-minute window per source: returns true when another notification is allowed.
function makeLimiter() {
    var hits = {};
    return function allow(source, rate, now) {
        if (!rate) { return true; }
        var list = (hits[source] || []).filter(function (t) { return now - t < 60000; });
        if (list.length >= rate) { hits[source] = list; return false; }
        list.push(now);
        hits[source] = list;
        return true;
    };
}

function minutes(hhmm) {
    var m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
}
// settings.quiet = { enabled, from: "22:00", to: "07:00", allow: "alert" | "warn" | "none" }: levels at or above `allow` still get through.
function sanitizeSettings(s, old) {
    s = s || {}; old = old || {};
    var q = s.quiet || {}, oq = old.quiet || {};
    var from = minutes(q.from) >= 0 ? q.from : (oq.from || '22:00'), to = minutes(q.to) >= 0 ? q.to : (oq.to || '07:00');
    var allow = q.allow === 'warn' || q.allow === 'alert' || q.allow === 'none' ? q.allow : (oq.allow || 'alert');
    return {
        quiet: { enabled: q.hasOwnProperty('enabled') ? q.enabled === true : oq.enabled === true, from: from, to: to, allow: allow },
        groupSeconds: s.hasOwnProperty('groupSeconds') ? clampInt(s.groupSeconds, 0, 3600, 0) : (old.hasOwnProperty('groupSeconds') ? old.groupSeconds : 60),
        strict: s.hasOwnProperty('strict') ? s.strict === true : old.strict === true
    };
}
function defaultSettings() { return sanitizeSettings({}, {}); }
// `now` is a Date in the TV's local time.
function isQuiet(settings, level, now) {
    var q = settings && settings.quiet;
    if (!q || !q.enabled) { return false; }
    var a = minutes(q.from), b = minutes(q.to), t = now.getHours() * 60 + now.getMinutes(), inside;
    if (a < 0 || b < 0 || a === b) { return false; }
    inside = a < b ? (t >= a && t < b) : (t >= a || t < b);
    if (!inside) { return false; }
    if (q.allow === 'none') { return true; }
    return (LEVEL_RANK[level] || 0) < (q.allow === 'warn' ? 1 : 2);
}

// Webhook templates: "{{a.b.0.c}}" is replaced by that value of the JSON the sender posted. Plain text replacement, nothing is evaluated.
function lookup(data, pathText) {
    var parts = String(pathText).split('.'), cur = data, i;
    for (i = 0; i < parts.length; i++) {
        if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, parts[i])) { return ''; }
        cur = cur[parts[i]];
    }
    if (cur == null) { return ''; }
    return typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
}
function render(tpl, data) {
    return String(tpl == null ? '' : tpl).replace(/\{\{\s*([A-Za-z0-9_.-]{1,60})\s*\}\}/g, function (m, p) { return lookup(data, p); });
}
function sanitizeHook(h) {
    h = h || {};
    var t = function (v, max) { return String(v == null ? '' : v).replace(/[\x00-\x1f]/g, ' ').slice(0, max || MAX_TEMPLATE); };
    return {
        title: t(h.title), message: t(h.message), level: t(h.level, 40), icon: t(h.icon, 40),
        mode: MODES[h.mode] ? h.mode : '', duration: clampInt(h.duration, 1, 60, 0), source: cleanSource(h.source)
    };
}
// Builds the notify body from a hook definition and the posted data.
function buildFromHook(hook, data) {
    var level = render(hook.level, data).trim().toLowerCase();
    var b = { title: render(hook.title, data), message: render(hook.message, data), icon: render(hook.icon, data) };
    if (LEVELS[level]) { b.level = level; }
    if (hook.mode) { b.mode = hook.mode; }
    if (hook.duration) { b.duration = hook.duration; }
    return b;
}

module.exports = {
    LEVEL_RANK: LEVEL_RANK, MAX_SOURCES: MAX_SOURCES, MAX_HOOKS: MAX_HOOKS, MAX_TEMPLATE: MAX_TEMPLATE, MAX_RATE: MAX_RATE,
    cleanSource: cleanSource, cleanHookName: cleanHookName, sameKey: sameKey, KEY_RE: KEY_RE,
    sanitizeProfile: sanitizeProfile, publicProfile: publicProfile, applyProfile: applyProfile, makeLimiter: makeLimiter,
    sanitizeSettings: sanitizeSettings, defaultSettings: defaultSettings, isQuiet: isQuiet,
    render: render, sanitizeHook: sanitizeHook, buildFromHook: buildFromHook
};
