'use strict';
// What changes in the YouTube TV page: a prelude script after <head> (routing fetch/XHR JSON through window.JSON.parse and
// stripping player/feed ads cleanly), a script tag before </body>, and a Content-Security-Policy that allows them.
// Cobalt wants a CSP header on every page (without one it closes a few seconds after the page loads), so the original
// is replaced, not just removed.

var PRELUDE_PATH = '/vetro-youtube/prelude.js';
var SCRIPT_PATH = '/vetro-youtube/userscript.js';     // served by the proxy itself, on the youtube.com origin

var PRELUDE_BODY = [
    '(function (w) {',
    '  try {',
    '    if (!w || w.__vetroYtPrelude) return;',
    '    w.__vetroYtPrelude = true;',
    '    var J = w.JSON || (typeof JSON !== "undefined" ? JSON : null);',
    '    if (!J || typeof J.parse !== "function") return;',
    '    var LS = null;',
    '    try { LS = w.localStorage || (typeof localStorage !== "undefined" ? localStorage : null); } catch (e) {}',
    '    var rawParse = J.parse;',
    '    var depth = 0;',
    '    function adBlockEnabled() {',
    '      try {',
    '        if (!LS || typeof LS.getItem !== "function") return true;',
    '        var raw = LS.getItem("ytaf-configuration");',
    '        if (!raw) return true;',
    '        var cfg = rawParse.call(J, raw);',
    '        if (cfg && cfg.enableAdBlock === false) return false;',
    '      } catch (e) {}',
    '      return true;',
    '    }',
    '    function isNotAdItem(item) {',
    '      if (!item || typeof item !== "object") return true;',
    '      return !item.adSlotRenderer && !item.promotedSparklesWebRenderer && !(item.command && item.command.reelWatchEndpoint && item.command.reelWatchEndpoint.adClientParams && item.command.reelWatchEndpoint.adClientParams.isAd);',
    '    }',
    '    function stripPlayerAds(o) {',
    '      if (!o || typeof o !== "object" || Array.isArray(o)) return;',
    '      try {',
    '        if ("adPlacements" in o) o.adPlacements = [];',
    '        if ("adSlots" in o) o.adSlots = [];',
    '        if ("playerAds" in o) o.playerAds = false;',
    '        if ("adBreakHeartbeatParams" in o) delete o.adBreakHeartbeatParams;',
    '      } catch (e) {}',
    '    }',
    '    var ACTION_KEYS = ["onResponseReceivedActions", "onResponseReceivedEndpoints", "onResponseReceivedCommands"];',
    '    function sanitizeNode(node, level) {',
    '      if (!node || typeof node !== "object" || level > 32) return;',
    '      if (Array.isArray(node)) {',
    '        for (var i = 0; i < node.length; i++) sanitizeNode(node[i], level + 1);',
    '        return;',
    '      }',
    '      stripPlayerAds(node);',
    '      if (node.sectionListRenderer && Array.isArray(node.sectionListRenderer.contents)) {',
    '        node.sectionListRenderer.contents = node.sectionListRenderer.contents.filter(isNotAdItem);',
    '      }',
    '      if (node.sectionListContinuation && Array.isArray(node.sectionListContinuation.contents)) {',
    '        node.sectionListContinuation.contents = node.sectionListContinuation.contents.filter(isNotAdItem);',
    '      }',
    '      if (node.horizontalListContinuation && Array.isArray(node.horizontalListContinuation.items)) {',
    '        node.horizontalListContinuation.items = node.horizontalListContinuation.items.filter(isNotAdItem);',
    '      }',
    '      if (node.horizontalListRenderer && Array.isArray(node.horizontalListRenderer.items)) {',
    '        node.horizontalListRenderer.items = node.horizontalListRenderer.items.filter(isNotAdItem);',
    '      }',
    '      if (node.gridContinuation && Array.isArray(node.gridContinuation.items)) {',
    '        node.gridContinuation.items = node.gridContinuation.items.filter(isNotAdItem);',
    '      }',
    '      if (node.gridRenderer && Array.isArray(node.gridRenderer.items)) {',
    '        node.gridRenderer.items = node.gridRenderer.items.filter(isNotAdItem);',
    '      }',
    '      if (node.shelfRenderer && node.shelfRenderer.content) {',
    '        var sc = node.shelfRenderer.content;',
    '        if (sc.horizontalListRenderer && Array.isArray(sc.horizontalListRenderer.items)) {',
    '          sc.horizontalListRenderer.items = sc.horizontalListRenderer.items.filter(isNotAdItem);',
    '        }',
    '        if (sc.gridRenderer && Array.isArray(sc.gridRenderer.items)) {',
    '          sc.gridRenderer.items = sc.gridRenderer.items.filter(isNotAdItem);',
    '        }',
    '      }',
    '      for (var ak = 0; ak < ACTION_KEYS.length; ak++) {',
    '        var acts = node[ACTION_KEYS[ak]];',
    '        if (Array.isArray(acts)) {',
    '          for (var ai = 0; ai < acts.length; ai++) {',
    '            var act = acts[ai];',
    '            if (!act || typeof act !== "object") continue;',
    '            if (act.reloadContinuationItemsCommand && Array.isArray(act.reloadContinuationItemsCommand.continuationItems)) {',
    '              act.reloadContinuationItemsCommand.continuationItems = act.reloadContinuationItemsCommand.continuationItems.filter(isNotAdItem);',
    '            }',
    '            if (act.appendContinuationItemsAction && Array.isArray(act.appendContinuationItemsAction.continuationItems)) {',
    '              act.appendContinuationItemsAction.continuationItems = act.appendContinuationItemsAction.continuationItems.filter(isNotAdItem);',
    '            }',
    '          }',
    '        }',
    '      }',
    '      if (Array.isArray(node.entries)) {',
    '        node.entries = node.entries.filter(isNotAdItem);',
    '      }',
    '      var keys = Object.keys(node);',
    '      for (var k = 0; k < keys.length; k++) {',
    '        var val = node[keys[k]];',
    '        if (val && typeof val === "object") sanitizeNode(val, level + 1);',
    '      }',
    '    }',
    '    function sanitize(obj) {',
    '      sanitizeNode(obj, 0);',
    '      return obj;',
    '    }',
    '    function wrapParse(fn) {',
    '      return function () {',
    '        var res;',
    '        depth++;',
    '        try {',
    '          res = fn.apply(this, arguments);',
    '        } finally {',
    '          depth--;',
    '        }',
    '        if (depth === 0 && res && typeof res === "object" && adBlockEnabled()) {',
    '          try { res = sanitize(res); } catch (e) {}',
    '        }',
    '        return res;',
    '      };',
    '    }',
    '    var currentParse = wrapParse(rawParse);',
    '    var jDesc = null;',
    '    try { jDesc = Object.getOwnPropertyDescriptor(J, "parse"); } catch (e) {}',
    '    if (!jDesc || jDesc.configurable) {',
    '      Object.defineProperty(J, "parse", {',
    '        configurable: true,',
    '        enumerable: jDesc ? !!jDesc.enumerable : false,',
    '        get: function () { return currentParse; },',
    '        set: function (fn) { if (typeof fn === "function") currentParse = wrapParse(fn); }',
    '      });',
    '    } else if (jDesc.writable) {',
    '      J.parse = currentParse;',
    '    }',
    '    function parseXssiText(t) {',
    '      var s = typeof t === "string" && t.indexOf(")]}\'\\n") === 0 ? t.slice(5) : t;',
    '      return J.parse(s);',
    '    }',
    '    var R = w.Response || (typeof Response !== "undefined" ? Response : null);',
    '    var rPatched = false;',
    '    if (R && R.prototype && typeof R.prototype.json === "function") {',
    '      var rDesc = null;',
    '      try { rDesc = Object.getOwnPropertyDescriptor(R.prototype, "json"); } catch (e) {}',
    '      var rJson = function () { return this.text().then(parseXssiText); };',
    '      if (!rDesc || rDesc.writable) {',
    '        try { R.prototype.json = rJson; rPatched = (R.prototype.json === rJson); } catch (e) {}',
    '      }',
    '      if (!rPatched && rDesc && rDesc.configurable) {',
    '        try {',
    '          Object.defineProperty(R.prototype, "json", { configurable: true, enumerable: !!rDesc.enumerable, writable: true, value: rJson });',
    '          rPatched = (R.prototype.json === rJson);',
    '        } catch (e) {}',
    '      }',
    '    }',
    '    if (!rPatched && typeof w.fetch === "function") {',
    '      var origFetch = w.fetch;',
    '      w.fetch = function () {',
    '        return origFetch.apply(this, arguments).then(function (resp) {',
    '          if (resp && typeof resp.text === "function" && typeof resp.json === "function") {',
    '            var rFn = function () { return resp.text().then(parseXssiText); };',
    '            try { Object.defineProperty(resp, "json", { configurable: true, writable: true, value: rFn }); } catch (e) {}',
    '            if (resp.json !== rFn) {',
    '              try { resp.json = rFn; } catch (e2) {}',
    '            }',
    '          }',
    '          return resp;',
    '        });',
    '      };',
    '    }',
    '    var X = w.XMLHttpRequest || (typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest : null);',
    '    if (X && X.prototype) {',
    '      var rtDesc = null, respDesc = null;',
    '      try { rtDesc = Object.getOwnPropertyDescriptor(X.prototype, "responseType"); } catch (e) {}',
    '      try { respDesc = Object.getOwnPropertyDescriptor(X.prototype, "response"); } catch (e) {}',
    '      if (rtDesc && rtDesc.configurable && typeof rtDesc.get === "function" && typeof rtDesc.set === "function" && respDesc && respDesc.configurable && typeof respDesc.get === "function") {',
    '        var setHidden = function (obj, key, val) {',
    '          try { Object.defineProperty(obj, key, { configurable: true, writable: true, enumerable: false, value: val }); } catch (e) { obj[key] = val; }',
    '        };',
    '        var origOpen = typeof X.prototype.open === "function" ? X.prototype.open : null;',
    '        if (origOpen) {',
    '          try {',
    '            X.prototype.open = function () {',
    '              setHidden(this, "__vetroHasResp", false);',
    '              setHidden(this, "__vetroResp", null);',
    '              return origOpen.apply(this, arguments);',
    '            };',
    '          } catch (e) {}',
    '        }',
    '        var origSend = typeof X.prototype.send === "function" ? X.prototype.send : null;',
    '        if (origSend) {',
    '          try {',
    '            X.prototype.send = function () {',
    '              setHidden(this, "__vetroHasResp", false);',
    '              setHidden(this, "__vetroResp", null);',
    '              return origSend.apply(this, arguments);',
    '            };',
    '          } catch (e) {}',
    '        }',
    '        Object.defineProperty(X.prototype, "responseType", {',
    '          configurable: true,',
    '          enumerable: !!rtDesc.enumerable,',
    '          get: function () { return this.__vetroRtJson ? "json" : rtDesc.get.call(this); },',
    '          set: function (v) {',
    '            setHidden(this, "__vetroHasResp", false);',
    '            setHidden(this, "__vetroResp", null);',
    '            if (v === "json") { setHidden(this, "__vetroRtJson", true); rtDesc.set.call(this, "text"); }',
    '            else { setHidden(this, "__vetroRtJson", false); rtDesc.set.call(this, v); }',
    '          }',
    '        });',
    '        Object.defineProperty(X.prototype, "response", {',
    '          configurable: true,',
    '          enumerable: !!respDesc.enumerable,',
    '          get: function () {',
    '            if (!this.__vetroRtJson) {',
    '              var val = respDesc.get.call(this);',
    '              if (rtDesc.get.call(this) === "json" && val && typeof val === "object" && adBlockEnabled()) return sanitize(val);',
    '              return val;',
    '            }',
    '            if (this.readyState !== 4) return null;',
    '            if (this.__vetroHasResp) return this.__vetroResp;',
    '            var raw = respDesc.get.call(this);',
    '            var parsed = null;',
    '            if (typeof raw === "string" && raw) {',
    '              try { parsed = parseXssiText(raw); } catch (e) { parsed = null; }',
    '            }',
    '            setHidden(this, "__vetroHasResp", true);',
    '            setHidden(this, "__vetroResp", parsed);',
    '            return parsed;',
    '          }',
    '        });',
    '      }',
    '    }',
    '  } catch (e) {}',
    '})(typeof window !== "undefined" ? window : this);'
].join('\n');

var CSP = "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:; media-src * data: blob:; " +
    "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; style-src * data: blob: 'unsafe-inline'; connect-src * ws: wss: data: blob:; font-src * data:";

var META_CSP_RE = /<meta\b[^>]*http-equiv\s*=\s*(?:["']Content-Security-Policy(?:-Report-Only)?["']|Content-Security-Policy(?:-Report-Only)?(?=[>\s\/]))[^>]*>/gi;

// The TV app's start page: /tv or /tv/ (with or without query/hash), not /tv_config or anything else that merely starts with /tv.
function isTvPage(url) {
    return url === '/tv' || url === '/tv/' ||
        url.indexOf('/tv?') === 0 || url.indexOf('/tv/?') === 0 ||
        url.indexOf('/tv#') === 0 || url.indexOf('/tv/#') === 0;
}

function preludeTag(version) { return '<script src="' + PRELUDE_PATH + '?v=' + encodeURIComponent(version) + '"></script>'; }
function scriptTag(version) { return '<script src="' + SCRIPT_PATH + '?v=' + encodeURIComponent(version) + '"></script>'; }

// -> {html, injected}. Injects prelude right after <head> (or before tag if no <head>) and tag before </body> (or at end).
function rewritePage(html, tag, prelude) {
    var text = String(html).replace(META_CSP_RE, '');
    var headPlaced = !prelude;
    if (prelude) {
        var hm = /<head(?:\s[^>]*)?>/i.exec(text);
        if (hm) {
            var headEnd = hm.index + hm[0].length;
            text = text.slice(0, headEnd) + prelude + text.slice(headEnd);
            headPlaced = true;
        }
    }
    var m, at = -1, re = /<\/body\s*>/gi;
    while ((m = re.exec(text)) !== null) at = m.index;
    var bodyInsert = headPlaced ? tag : (prelude + tag);
    if (at < 0) return { html: text + bodyInsert, injected: false };
    return { html: text.slice(0, at) + bodyInsert + text.slice(at), injected: true };
}

// Response headers of the rewritten page: no CSP from YouTube, ours instead; length, encoding and cache validators are recomputed.
function pageHeaders(upstream, byteLength) {
    var h = {};
    Object.keys(upstream).forEach(function (k) {
        if (k === 'content-security-policy' || k === 'content-security-policy-report-only' || k === 'content-length' ||
            k === 'content-encoding' || k === 'alt-svc' || k === 'etag' || k === 'last-modified' ||
            k === 'expires' || k === 'cache-control' || k === 'pragma' || k === 'age') return;
        h[k] = upstream[k];
    });
    h['content-security-policy'] = CSP;
    h['cache-control'] = 'no-store, no-cache, must-revalidate';
    h['content-length'] = byteLength;
    return h;
}

// Headers of everything else: unchanged, except an alt-svc that would send the app to YouTube over QUIC, around the proxy.
function passHeaders(upstream) {
    var h = {};
    Object.keys(upstream).forEach(function (k) { if (k !== 'alt-svc') h[k] = upstream[k]; });
    return h;
}

// Only these hosts are opened up and rewritten; every other host is a plain tunnel.
var MITM_HOSTS = { 'www.youtube.com': 1, 'youtube.com': 1 };

module.exports = { PRELUDE_PATH: PRELUDE_PATH, PRELUDE_BODY: PRELUDE_BODY, SCRIPT_PATH: SCRIPT_PATH, CSP: CSP, isTvPage: isTvPage,
    preludeTag: preludeTag, scriptTag: scriptTag, rewritePage: rewritePage, pageHeaders: pageHeaders, passHeaders: passHeaders, MITM_HOSTS: MITM_HOSTS };
