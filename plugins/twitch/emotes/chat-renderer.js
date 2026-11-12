'use strict';
// Retain React's text nodes and render message tokens without parsing them as HTML.
function install() {
    if (!/(^|\.)tv\.twitch\.tv$/.test(location.hostname) || window.__vetro7TV) return;
    var active = true, catalogue = Object.create(null), broken = Object.create(null), roots = [], queue = [], batch = null;
    var stats = { emotes: 0, replaced: 0, imageErrors: 0, chatRoots: 0 };
    var rootSelector = 'main > aside, [data-a-target="chat-scroller"], [data-test-selector="chat-scrollable-area__message-container"]';
    function eligible(node) {
        var p = node.parentElement;
        if (!p || p.closest('a, button, [role="button"], script, style, textarea, input, [contenteditable="true"], [data-vetro-7tv], [data-a-target="chat-message-username"]')) return false;
        // The TV layout fallback treats the final direct span as the message body.
        // Semantic message selectors do not need this span-position rule.
        if (p.closest('[data-a-target="chat-line-message-body"], [data-test-selector="chat-message-text"]')) return true;
        var row = p.closest('main > aside .r-1xq2hnv');
        if (!row) return false;
        var line = row.firstElementChild, spans = line ? Array.prototype.filter.call(line.children, function (n) { return n.tagName === 'SPAN'; }) : [];
        var body = spans.length ? spans[spans.length - 1] : null;
        return body && body.contains(node);
    }
    function removeWrapper(wrapper, restore) {
        var anchor = wrapper.__vetroAnchor;
        if (anchor && anchor.parentNode === wrapper.parentNode) {
            if (restore && anchor.nodeValue === '') anchor.nodeValue = wrapper.__vetroOriginal;
            delete anchor.__vetroWrapper;
        }
        if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    }
    function restore() {
        var wrappers = document.querySelectorAll('span[data-vetro-7tv="wrapper"]');
        for (var i = 0; i < wrappers.length; i++) removeWrapper(wrappers[i], true);
    }
    function image(part, emote, anchor, wrapper) {
        var img = document.createElement('img'); img.alt = part; img.title = part + ' · 7TV';
        img.setAttribute('data-vetro-7tv', 'image'); img.setAttribute('referrerpolicy', 'no-referrer');
        img.style.height = '1.35em'; img.style.width = 'auto'; img.style.maxWidth = '5em'; img.style.verticalAlign = 'middle'; img.style.objectFit = 'contain';
        img.onerror = function () {
            if (!active) return;
            if (!broken[emote.url]) stats.imageErrors++;
            broken[emote.url] = true;
            // Restoring the original text preserves any newer update made by React.
            removeWrapper(wrapper, true); enqueue(anchor);
        };
        img.src = emote.url; return img;
    }
    function renderText(anchor) {
        if (!anchor.parentNode) return;
        if (anchor.__vetroWrapper && anchor.nodeValue !== '') removeWrapper(anchor.__vetroWrapper, false);
        if (!eligible(anchor) || !anchor.nodeValue.trim()) return;
        var original = anchor.nodeValue, parts = original.split(/(\s+)/), match = parts.some(function (part) {
            return Object.prototype.hasOwnProperty.call(catalogue, part) && !broken[catalogue[part].url];
        });
        if (!match) return;
        var wrapper = document.createElement('span'), lastEmote = null;
        wrapper.setAttribute('data-vetro-7tv', 'wrapper'); wrapper.__vetroAnchor = anchor; wrapper.__vetroOriginal = original;
        parts.forEach(function (part) {
            var emote = catalogue[part];
            if (!emote || broken[emote.url]) {
                wrapper.appendChild(document.createTextNode(part));
                if (/\S/.test(part)) lastEmote = null;
                return;
            }
            var img = image(part, emote, anchor, wrapper);
            if (emote.zeroWidth && lastEmote) {
                img.style.position = 'absolute'; img.style.left = '50%'; img.style.bottom = '0'; img.style.transform = 'translateX(-50%)'; lastEmote.appendChild(img);
            } else {
                lastEmote = document.createElement('span'); lastEmote.style.display = 'inline-block'; lastEmote.style.position = 'relative';
                lastEmote.appendChild(img); wrapper.appendChild(lastEmote);
            }
            stats.replaced++;
        });
        anchor.__vetroWrapper = wrapper;
        anchor.nodeValue = ''; anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);
    }
    function render(root) {
        if (root.nodeType === 3) { renderText(root); return; }
        var walker = document.createTreeWalker(root, 4, null, false), nodes = [], node;
        while ((node = walker.nextNode()) && nodes.length < 1000) nodes.push(node);
        nodes.forEach(renderText);
    }
    var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
            if (mutation.type === 'characterData') enqueue(mutation.target);
            else Array.prototype.forEach.call(mutation.addedNodes, enqueue);
        });
    });
    function observe() { roots.forEach(function (root) { observer.observe(root, { childList: true, subtree: true, characterData: true }); }); }
    function flush() {
        batch = null; if (!active) return;
        observer.disconnect(); var pending = queue; queue = [];
        pending.forEach(function (node) { if (node.isConnected !== false) render(node); }); observe();
    }
    function enqueue(node) {
        if (!active || queue.length >= 200) return;
        queue.push(node); if (!batch) batch = setTimeout(flush, 100);
    }
    function discover() {
        if (!active) return;
        var found = Array.prototype.slice.call(document.querySelectorAll(rootSelector));
        if (found.length !== roots.length || found.some(function (root, i) { return root !== roots[i]; })) {
            observer.disconnect(); roots = found; stats.chatRoots = roots.length; roots.forEach(render); observe();
        }
        var wrappers = document.querySelectorAll('span[data-vetro-7tv="wrapper"]');
        for (var i = 0; i < wrappers.length; i++) {
            var anchor = wrappers[i].__vetroAnchor;
            if (!anchor || anchor.parentNode !== wrappers[i].parentNode) removeWrapper(wrappers[i], false);
        }
    }
    var discovery = setInterval(discover, 2000);
    document.addEventListener('DOMContentLoaded', discover);
    window.__vetro7TV = {
        instance: String(Date.now()) + ':' + String(Math.random()),
        channel: function () {
            var path = location.pathname.split('/').filter(function (s) { return !!s; });
            var reserved = /^(?:app-shell|search|following|browse|directory|settings|videos|collections|home|login|activate)$/i;
            return path.length === 1 && /^[A-Za-z0-9_]{1,25}$/.test(path[0]) && !reserved.test(path[0]) ? path[0].toLowerCase() : null;
        },
        set: function (entries, expectedChannel) {
            if (!active) return false;
            if (expectedChannel !== undefined && window.__vetro7TV.channel() !== expectedChannel) return false;
            observer.disconnect(); restore(); catalogue = Object.create(null);
            (entries || []).slice(0, 3000).forEach(function (entry) {
                if (!entry || typeof entry.name !== 'string' || !/^\S{1,64}$/.test(entry.name) || typeof entry.url !== 'string' ||
                    !/^https:\/\/cdn\.7tv\.app\/emote\/[A-Za-z0-9]+\/[1-4]x\.(?:webp|gif|png)$/.test(entry.url)) return;
                catalogue[entry.name] = { url: entry.url, zeroWidth: entry.zeroWidth === true };
            });
            stats.emotes = Object.keys(catalogue).length; discover(); roots.forEach(render); observe(); return true;
        },
        status: function () { return { emotes: stats.emotes, replaced: stats.replaced, imageErrors: stats.imageErrors, chatRoots: stats.chatRoots }; },
        stop: function () {
            active = false; if (batch) clearTimeout(batch); clearInterval(discovery); observer.disconnect();
            document.removeEventListener('DOMContentLoaded', discover); restore(); queue = []; roots = []; delete window.__vetro7TV;
        }
    };
    discover();
}
module.exports = { source: '(' + install.toString() + ')();', stop: 'if(window.__vetro7TV)window.__vetro7TV.stop();',
    state: 'window.__vetro7TV ? {channel:window.__vetro7TV.channel(),instance:window.__vetro7TV.instance} : null',
    status: 'window.__vetro7TV ? window.__vetro7TV.status() : null' };
