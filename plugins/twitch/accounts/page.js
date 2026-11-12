'use strict';
var locales = require('../locales.json');

// Runs in Twitch's page. Match its settings label before falling back to the document or browser language.
function pageTranslations(catalog, settingsNames, backNames) {
    var languages = Object.keys(catalog);
    var errors = Object.keys(catalog.en).filter(function (key) { return /Error$/.test(key); });

    function normalize(value) { return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
    function language() {
        var settings = document.querySelector('a[href="/settings"]');
        var name = normalize(settings && (settings.getAttribute('aria-label') || settings.textContent));
        for (var i = 0; name && i < languages.length; i++) {
            var locale = languages[i];
            if (settingsNames[locale].some(function (label) { return normalize(label) === name; })) return locale;
        }
        var tag = document.documentElement && document.documentElement.lang || navigator.language || '';
        var code = tag.toLowerCase().split(/[-_]/)[0];
        return languages.indexOf(code) >= 0 ? code : 'en';
    }
    function text(key, locale, value) {
        var message = catalog[locale][key] || catalog.en[key];
        return value === undefined ? message : message.replace('{value}', function () { return String(value); });
    }
    function error(message, locale) {
        for (var i = 0; i < errors.length; i++) {
            if (catalog.en[errors[i]] === message) return text(errors[i], locale);
        }
        return text('errorGeneric', locale);
    }
    function isBack(value) {
        var name = normalize(value);
        return backNames.some(function (label) { return normalize(label) === name; });
    }
    return { language: language, text: text, error: error, isBack: isBack };
}

// Pass only the strings needed by the injected surface. The TV page cannot require Shard files.
function translationSource(surface) {
    var catalog = {}, settings = {}, back = [];
    Object.keys(locales).forEach(function (code) {
        var locale = locales[code];
        catalog[code] = locale[surface];
        settings[code] = locale.native.settings;
        if (surface === 'accounts') back = back.concat(locale.native.loginBack);
    });
    return '(' + pageTranslations.toString() + ')(' + JSON.stringify(catalog) + ',' + JSON.stringify(settings) + ',' + JSON.stringify(back) + ')';
}

var ACCOUNT_TRANSLATIONS = translationSource('accounts');

function readNativeSession(includeClient) {
    var root = null, nodes = document.querySelectorAll('#__next,#__next > *,body > *'), count = 0;
    for (var i = 0; i < nodes.length && i < 25 && !root; i++) {
        var names = Object.keys(nodes[i]);
        for (var j = 0; j < names.length && !root; j++) {
            if (/^__react(?:Fiber|Container)\$/.test(names[j])) root = nodes[i][names[j]];
            else if (names[j] === '_reactRootContainer' && nodes[i][names[j]]) root = nodes[i][names[j]]._internalRoot.current;
        }
    }
    if (root) { while (root.return && count++ < 100) root = root.return; if (root.stateNode && root.stateNode.current) root = root.stateNode.current; }
    var stack = root ? [root] : [], result = { signedIn: null, clientId: null };
    while (stack.length && count++ < 18000) {
        var fiber = stack.pop(), value = fiber.memoizedProps && fiber.memoizedProps.value;
        if (includeClient && value && typeof value.clientId === 'string' && /^[a-z0-9]{20,40}$/i.test(value.clientId)) result.clientId = value.clientId;
        if (value && value.authCookieName === 'auth-token' && typeof value.loggedIn === 'boolean' && typeof value.logout === 'function') result.signedIn = value.loggedIn;
        if (result.signedIn !== null && (!includeClient || result.clientId)) break;
        if (fiber.child) stack.push(fiber.child); if (fiber.sibling) stack.push(fiber.sibling);
    }
    return result;
}

function install(readNativeSession, origin, translations) {
    if (window.top !== window || location.protocol !== 'https:' || !/(^|\.)tv\.twitch\.tv$/.test(location.hostname) ||
        (origin && location.origin !== origin) || window.__vetroTwitchAccounts) return;
    var host, style, hint, returnFocus, lastModel, confirmation, locale, action = null;
    var entry, entryWrapper, settingsLink, lastEntry;
    var entryKeys = {};
    var buttons = [], focus = 0, sequence = 0, model = {}, stopped = false, heldBack = false, heldLoginSelect = false;
    var instance = String(Date.now()) + ':' + Math.random().toString(36).slice(2);

    function element(tag, text) {
        var node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function label(key, value) { return translations.text(key, locale, value); }
    function send(type, id) {
        if (model.busy || action) return;
        action = { type: type, id: id || null, sequence: ++sequence };
        render();
    }
    function installStyles() {
        if (style) return;
        style = element('style');
        style.textContent = [
            '#vetro-twitch-accounts{position:fixed;inset:0;z-index:2147483646;box-sizing:border-box;background:radial-gradient(ellipse at 50% 100%,#291745 0%,#14101e 56%,#101014 100%);color:#efeff1;font:24px Inter,sans-serif;text-align:center;overflow:auto}',
            '#vetro-twitch-accounts .vt-panel{box-sizing:border-box;min-height:100%;padding:6vh 6vw;display:flex;flex-direction:column;align-items:center;justify-content:center}',
            '#vetro-twitch-accounts h1{font:600 clamp(32px,3vw,56px) Inter,sans-serif;color:inherit;margin:0 0 6vh}',
            '#vetro-twitch-accounts p{font:500 20px Inter,sans-serif;color:#d3cce0;margin:0 0 3vh;max-width:42em}',
            '#vetro-twitch-accounts .vt-profiles{display:flex;flex-wrap:wrap;justify-content:center;gap:3vh 2.4vw;max-width:68em}',
            '#vetro-twitch-accounts .vt-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-top:6vh}',
            '#vetro-twitch-accounts button{border:0;color:inherit;outline:none;font:600 20px Inter,sans-serif;cursor:pointer}',
            '#vetro-twitch-accounts .vt-profile{display:flex;flex-direction:column;align-items:center;gap:10px;background:none;padding:4px;width:clamp(144px,13vw,230px);max-width:100%}',
            '#vetro-twitch-accounts .vt-avatar{position:relative;box-sizing:border-box;display:grid;place-items:center;width:clamp(110px,20vh,200px);height:clamp(110px,20vh,200px);border-radius:50%;border:3px solid transparent;color:white;font-size:clamp(38px,7vh,76px);line-height:1}',
            '#vetro-twitch-accounts .vt-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%}',
            '#vetro-twitch-accounts .vt-profile[data-selected=true] .vt-avatar{border-color:white;box-shadow:0 0 0 4px #bf94ff}',
            '#vetro-twitch-accounts .vt-profile strong{max-width:100%;overflow-wrap:anywhere}',
            '#vetro-twitch-accounts small{font:500 15px Inter,sans-serif;color:#d3cce0}',
            '#vetro-twitch-accounts .vt-chip{background:#30263e;border-radius:999px;padding:12px 22px;font-size:18px}',
            '#vetro-twitch-accounts .vt-chip[data-selected=true]{background:#efeff1;color:#18131f}',
            '[data-vetro-account-entry]{white-space:nowrap}',
            'a[href="/settings"][data-vetro-accounts-focused]{background-color:var(--color-background-button-overlay-text-default,transparent)!important;color:var(--color-text-alt,#efeff1)!important;border-color:transparent!important;box-shadow:none!important;outline:none!important}',
            '#vetro-twitch-account-entry{display:inline-flex;align-items:center;justify-content:center;vertical-align:top;gap:.45em;margin-left:.55em;padding:0 .7em;border:0;border-radius:.35em;background:#26262c;color:#efeff1;font:600 1em Inter,sans-serif;line-height:1;cursor:pointer}',
            '#vetro-twitch-account-entry:focus{outline:2px solid #bf94ff;outline-offset:2px;background:#3c2b50}',
            '#vetro-twitch-account-entry .vt-entry-name{max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '#vetro-twitch-account-entry .vt-entry-avatar{position:relative;display:grid;place-items:center;width:1.25em;height:1.25em;flex:none;border-radius:50%;overflow:hidden;background:#6441a5}',
            '#vetro-twitch-account-entry .vt-entry-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
            '#vetro-twitch-account-entry .vt-entry-initials{font-size:.52em}',
            '#vetro-twitch-account-entry .vt-account-icon,#vetro-twitch-accounts .vt-account-icon{position:relative;display:inline-block;width:1em;height:1em;flex:none}',
            '#vetro-twitch-account-entry .vt-account-icon:before,#vetro-twitch-account-entry .vt-account-icon:after,#vetro-twitch-accounts .vt-account-icon:before,#vetro-twitch-accounts .vt-account-icon:after{content:"";position:absolute;background:currentColor;left:50%;transform:translateX(-50%)}',
            '#vetro-twitch-account-entry .vt-account-icon:before,#vetro-twitch-accounts .vt-account-icon:before{top:0;width:.42em;height:.42em;border-radius:50%}',
            '#vetro-twitch-account-entry .vt-account-icon:after,#vetro-twitch-accounts .vt-account-icon:after{bottom:0;width:.86em;height:.45em;border-radius:.5em .5em .14em .14em}'
        ].join('\n');
        document.documentElement.appendChild(style);
    }
    function removeEntry() {
        if (entry && entry.parentNode) entry.parentNode.removeChild(entry);
        if (settingsLink) settingsLink.removeAttribute('data-vetro-accounts-focused');
        if (entryWrapper) entryWrapper.removeAttribute('data-vetro-account-entry');
        entry = entryWrapper = settingsLink = lastEntry = null;
    }
    function renderEntry() {
        var current = model.homeAccount;
        var login = current && current.login, avatarUrl = login && current.avatarUrl;
        var name = login || (current && current.guest ? label('guest') : label('accounts'));
        var accessibleName = current ? label('switchAccount', name) : name;
        var signature = JSON.stringify([accessibleName, login, avatarUrl]);
        if (lastEntry === signature) return;
        lastEntry = signature;
        entry.setAttribute('aria-label', accessibleName);
        entry.textContent = '';
        var avatar = element('span');
        avatar.setAttribute('aria-hidden', 'true');
        if (login) {
            avatar.className = 'vt-entry-avatar';
            var initials = element('span', login.slice(0, 2).toUpperCase());
            initials.className = 'vt-entry-initials';
            avatar.appendChild(initials);
            appendAvatarImage(avatar, avatarUrl);
        } else {
            avatar.className = 'vt-account-icon';
        }
        var title = element('span', name);
        title.className = 'vt-entry-name';
        entry.appendChild(avatar);
        entry.appendChild(title);
    }
    function syncEntry() {
        var link = location.pathname === '/' && !model.adding && document.querySelector('a[href="/settings"]');
        if (link && link === settingsLink && entry && entry.parentNode === link.parentNode) {
            renderEntry();
            return;
        }
        removeEntry();
        if (!link || !link.parentNode) return;
        installStyles();
        settingsLink = link;
        entryWrapper = link.parentNode;
        entryWrapper.setAttribute('data-vetro-account-entry', '');
        entry = element('button');
        entry.id = 'vetro-twitch-account-entry';
        entry.type = 'button';
        renderEntry();
        var height = link.getBoundingClientRect().height;
        if (height) {
            entry.style.height = height + 'px';
            entry.style.fontSize = Math.round(height * 0.34) + 'px';
        }
        entry.onclick = function () { send('choose'); };
        // Twitch keeps its Settings highlight until its own spatial focus changes.
        entry.addEventListener('focus', function () { link.setAttribute('data-vetro-accounts-focused', ''); });
        entry.addEventListener('blur', function () { link.removeAttribute('data-vetro-accounts-focused'); });
        entryWrapper.insertBefore(entry, link.nextSibling);
    }
    function button(parent, text, callback) {
        var control = element('button', text);
        control.type = 'button';
        control.className = 'vt-chip';
        control.onclick = callback;
        buttons.push(control);
        parent.appendChild(control);
        return control;
    }
    function appendAvatarImage(avatar, url) {
        if (!url) return;
        var picture = element('img');
        picture.alt = '';
        picture.referrerPolicy = 'no-referrer';
        picture.style.visibility = 'hidden';
        picture.onload = function () { picture.style.visibility = ''; };
        picture.onerror = function () { if (picture.parentNode) picture.parentNode.removeChild(picture); };
        picture.src = url;
        avatar.appendChild(picture);
    }
    function tile(parent, title, initials, colour, callback, subtitle, avatarUrl) {
        var control = button(parent, '', callback);
        control.className = 'vt-profile';
        var avatar = element('span', initials);
        avatar.className = 'vt-avatar';
        avatar.style.background = colour;
        avatar.setAttribute('aria-hidden', 'true');
        appendAvatarImage(avatar, avatarUrl);
        control.appendChild(avatar);
        control.appendChild(element('strong', title));
        if (subtitle) control.appendChild(element('small', subtitle));
        return avatar;
    }
    function highlight() {
        buttons.forEach(function (control, i) {
            control.setAttribute('data-selected', i === focus ? 'true' : 'false');
            control.tabIndex = i === focus ? 0 : -1;
        });
        if (buttons[focus]) buttons[focus].focus();
    }
    function hidePicker() {
        if (host && host.parentNode) host.parentNode.removeChild(host);
        if (returnFocus && document.documentElement.contains(returnFocus)) returnFocus.focus();
        returnFocus = null;
    }
    function managingLogin() { return model.adding && !model.visible && location.pathname === '/login'; }
    function isLoginBack(control) {
        var text = control && (control.getAttribute('aria-label') || control.textContent);
        return translations.isBack(text);
    }
    function backControl(target) {
        if (!target || target.nodeType !== 1) return false;
        return isLoginBack(target.closest('button,[role="button"]'));
    }
    function syncLoginHint() {
        if (!document.body) return;
        var text = '';
        if (managingLogin()) {
            if (action && action.type === 'cancel') text = label('cancellingSignIn');
            else if (!Array.prototype.some.call(document.querySelectorAll('button,[role="button"]'), isLoginBack)) {
                text = model.busy ? label('savingAccount')
                    : label('addingAccount');
            }
        }
        if (!text) { if (hint && hint.parentNode) hint.parentNode.removeChild(hint); return; }
        if (!hint) {
            hint = element('div');
            hint.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:2147483646;pointer-events:none;background:#252135;color:#fff;padding:12px 18px;border-radius:8px;font:22px sans-serif;';
            hint.setAttribute('role', 'status');
        }
        if (hint.textContent !== text) hint.textContent = text;
        if (!hint.parentNode) document.body.appendChild(hint);
    }
    function render() {
        if (!document.body || stopped) return;
        locale = translations.language();
        syncEntry();
        syncLoginHint();
        if (!model.visible) { hidePicker(); return; }
        installStyles();
        if (!host) {
            host = element('div');
            host.id = 'vetro-twitch-accounts';
            host.setAttribute('role', 'dialog');
            host.setAttribute('aria-modal', 'true');
            host.setAttribute('aria-labelledby', 'vt-account-title');
        }
        if (!host.parentNode) {
            returnFocus = document.activeElement;
            document.body.appendChild(host);
        }
        host.textContent = '';
        buttons = [];
        var panel = element('section');
        panel.className = 'vt-panel';
        host.appendChild(panel);
        var profiles = model.profiles || [], managing = model.mode === 'manage';
        var title = confirmation ? label('forgetTitle')
            : managing ? label('manageAccounts')
            : label('chooseAccount');
        var heading = element('h1', title);
        heading.id = 'vt-account-title';
        panel.appendChild(heading);
        var message = model.message && translations.error(model.message, locale);
        if (model.busy || action) message = label('wait');
        else if (confirmation) message = label('forgetDescription', confirmation.login);
        else if (model.adding) message = label('finishSignIn');
        if (message) {
            var status = element('p', message);
            status.setAttribute('role', 'status');
            panel.appendChild(status);
        }
        if (model.busy || action) return;
        var grid = element('div');
        grid.className = 'vt-profiles';
        panel.appendChild(grid);
        var actions = element('div');
        actions.className = 'vt-actions';
        if (confirmation) {
            button(grid, label('cancel'), function () { confirmation = null; focus = 0; render(); });
            button(grid, label('forgetAccount', confirmation.login), function () {
                var id = confirmation.id;
                confirmation = null;
                send('forget', id);
            });
        } else if (model.adding) {
            button(grid, label('continueSignIn'), function () { send('dismiss'); });
            button(grid, label('cancelSignIn'), function () { send('cancel'); });
        } else if (managing) {
            profiles.forEach(function (profile) {
                button(grid, label('forgetAccount', profile.login), function () { confirmation = profile; focus = 0; render(); });
            });
            button(actions, label('backToProfiles'), function () { send('choose'); });
        } else {
            var colours = ['#6441a5', '#285c8e', '#91476b', '#326c61'];
            profiles.forEach(function (profile, index) {
                var subtitle = profile.state === 'sign-in-required' ? label('signInAgain')
                    : profile.active ? label('currentAccount') : '';
                tile(grid, profile.login, profile.login.slice(0, 2).toUpperCase(), colours[index % colours.length],
                    function () { send('switch', profile.id); }, subtitle, profile.avatarUrl);
            });
            var guest = tile(grid, label('guest'), '', '#30263e', function () { send('guest'); },
                model.guest ? label('currentSession') : '');
            var guestIcon = element('span');
            guestIcon.className = 'vt-account-icon';
            guest.appendChild(guestIcon);
            if (profiles.length < 8) {
                tile(grid, label('addAccount'), '+', '#312a3b', function () { send('add'); });
            }
            if (model.canCapture) button(actions, label('saveAccount'), function () { send('capture'); });
            if (profiles.length) button(actions, label('manageAccounts'), function () { send('manage'); });
            button(actions, label('back'), function () { send('dismiss'); });
        }
        if (actions.childNodes.length) panel.appendChild(actions);
        focus = Math.min(focus, buttons.length - 1);
        highlight();
    }
    function consume(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
    function click(event) {
        if (!managingLogin() || !backControl(event.target)) return;
        consume(event);
        send('cancel');
    }
    // Connect the profile button to Twitch's native Settings focus target.
    function entryNavigation(event, code) {
        if (event.type === 'keyup' && entryKeys[code]) {
            delete entryKeys[code];
            consume(event);
            return true;
        }
        if (model.visible || !entry || event.type !== 'keydown') return false;
        if (document.activeElement === settingsLink && code === 39) {
            entryKeys[code] = true;
            consume(event);
            if (!event.repeat) entry.focus();
            return true;
        }
        if (document.activeElement !== entry) return false;
        if (code === 13 || code === 37 || code === 39) {
            entryKeys[code] = true;
            consume(event);
            if (!event.repeat && code === 13) send('choose');
            if (!event.repeat && code === 37) settingsLink.focus();
            return true;
        }
        if (code === 38 || code === 40 || code === 27 || code === 10009) settingsLink.focus();
        return false;
    }
    function key(event) {
        if (stopped) return;
        var code = event.keyCode || event.which, back = code === 27 || code === 10009;
        if (entryNavigation(event, code)) return;
        if (back && heldBack && event.type === 'keyup') { consume(event); heldBack = false; return; }
        if (code === 13 && heldLoginSelect && event.type === 'keyup') { consume(event); heldLoginSelect = false; return; }
        if (managingLogin() && (back || code === 13 && (backControl(event.target) || backControl(document.activeElement)))) {
            consume(event);
            if (event.type === 'keydown') {
                if (back) heldBack = true; else heldLoginSelect = true;
                if (!event.repeat) send('cancel');
            }
            return;
        }
        if (!model.visible || [9, 13, 27, 37, 38, 39, 40, 10009].indexOf(code) < 0) return;
        consume(event);
        if (event.type !== 'keydown' || event.repeat || model.busy || action || !buttons.length) return;
        if (back) {
            heldBack = true;
            if (confirmation) { confirmation = null; focus = 0; render(); }
            else send(model.mode === 'manage' && !model.adding ? 'choose' : 'dismiss');
            return;
        }
        if (code === 13) { buttons[focus].click(); return; }
        if (code === 9) { focus = (focus + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length; highlight(); return; }
        var origin = buttons[focus].getBoundingClientRect(), best = -1, score = Infinity;
        if (origin.width && origin.height) buttons.forEach(function (control, i) {
            if (i === focus) return;
            var rect = control.getBoundingClientRect(), dx = (rect.left + rect.right - origin.left - origin.right) / 2, dy = (rect.top + rect.bottom - origin.top - origin.bottom) / 2;
            var forward = code === 37 ? -dx : code === 39 ? dx : code === 38 ? -dy : dy;
            var sideways = code === 37 || code === 39 ? Math.abs(dy) : Math.abs(dx), candidate = forward + sideways * 4;
            if (forward > 1 && candidate < score) { score = candidate; best = i; }
        });
        if (best >= 0) focus = best;
        else if (!origin.width) focus = Math.max(0, Math.min(buttons.length - 1, focus + (code === 37 || code === 38 ? -1 : 1)));
        highlight();
    }
    window.addEventListener('keydown', key, true); window.addEventListener('keyup', key, true); window.addEventListener('click', click, true);
    window.__vetroTwitchAccounts = {
        set: function (next) {
            if (stopped) return;
            var serialized = JSON.stringify(next);
            var acknowledged = action && next.ack >= action.sequence;
            var opening = next.visible && (!model.visible || model.mode !== next.mode);
            if (opening) {
                confirmation = null;
                focus = 0;
                if (next.mode === 'choose') {
                    var saved = next.profiles || [];
                    var active = saved.some(function (profile, index) {
                        if (!profile.active) return false;
                        focus = index;
                        return true;
                    });
                    if (!active && next.guest) focus = saved.length;
                }
            }
            model = next;
            if (acknowledged) action = null;
            if (serialized !== lastModel || acknowledged || translations.language() !== locale) render();
            lastModel = serialized;
        },
        read: function (deep) {
            if (translations.language() !== locale || model.visible && (!host || !host.parentNode)) render();
            else {
                syncEntry();
                if (model.adding || hint && hint.parentNode) syncLoginHint();
            }
            var pairs = document.cookie.split(';'), profile = null, tokenPresent = false;
            pairs.forEach(function (entry) { var at = entry.indexOf('='), name = entry.slice(0, at).trim();
                if (name === 'auth-token') tokenPresent = !!entry.slice(at + 1);
                if (name === 'tachyon-user') {
                    try {
                        var value = JSON.parse(decodeURIComponent(entry.slice(at + 1)));
                        if (/^\d{1,32}$/.test(value.id) && /^[a-zA-Z0-9_]{1,32}$/.test(value.login)) {
                            profile = { id: String(value.id), login: value.login };
                        }
                    } catch (e) {}
                }
            });
            return { instance: instance, ready: document.readyState === 'complete', renderable: !!document.body, visible: document.visibilityState === 'visible', path: location.pathname,
                profile: profile, tokenPresent: tokenPresent, auth: deep ? readNativeSession(false).signedIn : null, action: action };
        },
        stop: function () {
            stopped = true;
            window.removeEventListener('keydown', key, true);
            window.removeEventListener('keyup', key, true);
            window.removeEventListener('click', click, true);
            hidePicker();
            removeEntry();
            if (style && style.parentNode) style.parentNode.removeChild(style);
            if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
            delete window.__vetroTwitchAccounts;
        }
    };
}
function source(origin) {
    return '(' + install.toString() + ')(' + readNativeSession.toString() + ',' + JSON.stringify(origin || null) + ',' + ACCOUNT_TRANSLATIONS + ');';
}
module.exports = { source: source, readNativeSession: readNativeSession, translationSource: translationSource };
