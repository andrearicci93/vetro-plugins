'use strict';
var storage = require('./store.js'), sessions = require('./session.js'), publicData = require('../public-data.js');
var POLL_MS = 750, VERIFY_MS = 15000;
module.exports = function (context) {
    var vault = null, data = null, connection = null, avatars = null, running = false, foreground = false, chooserOnLaunch = true;
    var generation = 0, attachmentTask = null, work = Promise.resolve(), pollTimer = null, polling = false;
    var model = { phase: 'stopped', error: null, activeId: null, visible: false, mode: 'choose', busy: false, adding: false, canCapture: false, guest: false };
    var launchPending = true, pageInstance = null, actionSequence = 0, addingHere = false, nextCaptureAt = 0, nextValidationAt = 0;
    var homeAccount = null;
    function requireCurrent(expected) { if (!running || expected !== generation || !connection || !connection.connected()) throw new Error('Account operation cancelled'); }
    function profiles(includeAvatars) {
        return data ? data.profiles.map(function (p) {
            var profile = { id: p.id, login: p.login, state: p.state, active: p.id === model.activeId };
            if (includeAvatars && avatars) profile.avatarUrl = avatars.get(p.id);
            return profile;
        }) : [];
    }
    function status() { return { attached: !!connection && connection.connected(), phase: model.phase, busy: model.busy, adding: model.adding,
        activeId: model.activeId, profiles: profiles(), canCapture: model.canCapture, error: model.error }; }
    function publish() {
        if (!connection || !connection.connected()) return Promise.resolve();
        var showingProfiles = foreground && model.visible && model.mode === 'choose' && !model.adding;
        var home = foreground && !model.adding && !data.pending ? homeAccount : null;
        var current = home && (home.guest ? { guest: true } : { login: home.login });
        if (avatars && (showingProfiles || (home && home.id))) {
            var savedIds = data.profiles.map(function (p) { return p.id; });
            var requested = showingProfiles ? savedIds.slice() : [];
            if (home && home.id && requested.indexOf(home.id) < 0) requested.push(home.id);
            avatars.refresh(requested, home && home.id ? savedIds.concat(home.id) : savedIds);
            if (home && home.id) current.avatarUrl = avatars.get(home.id);
        }
        return connection.publish({ visible: model.visible, mode: model.mode, busy: model.busy, adding: model.adding, canCapture: model.canCapture,
            profiles: profiles(showingProfiles), guest: model.guest, homeAccount: current, message: model.error, ack: actionSequence });
    }
    function save(next) { data = vault.save(next); }
    function upsert(identity, cookies, completeAdd) {
        var next = vault.read(), at = next.profiles.map(function (p) { return p.id; }).indexOf(identity.id);
        if (at < 0 && next.profiles.length >= storage.maxAccounts) throw new Error('At most eight accounts can be saved');
        var profile = { id: identity.id, login: identity.login, cookies: storage.cookies(cookies), savedAt: Date.now(), state: 'ready' };
        if (at < 0) next.profiles.push(profile); else next.profiles[at] = profile;
        if (completeAdd) next.pending = null;
        next.initialized = true; save(next);
    }
    function exclusive(action) {
        var task = work.then(action);
        work = task.catch(function () {}); return task;
    }
    function currentSnapshot(expected) {
        requireCurrent(expected);
        return connection.read(true).then(function (page) {
            requireCurrent(expected);
            if (!foreground || !page || !page.visible || !page.ready || page.auth === null) throw new Error('Open Twitch on the TV and wait for it to finish loading');
            return connection.cookies().then(function (cookies) { return { page: page, cookies: cookies }; });
        });
    }
    function capture(expected, completeAdd) {
        return currentSnapshot(expected).then(function (snapshot) {
            if (!snapshot.page.auth || !snapshot.cookies.length) throw new Error('Sign in to Twitch before saving an account');
            return connection.validate(snapshot.cookies).then(function (identity) {
                requireCurrent(expected);
                var profile = storage.identity(snapshot.cookies);
                if (!identity || !profile || identity.id !== profile.id || identity.login.toLowerCase() !== profile.login.toLowerCase()) throw new Error('Twitch did not confirm this account');
                upsert(identity, snapshot.cookies, completeAdd);
                model.activeId = identity.id;
                model.canCapture = false;
                nextValidationAt = Date.now() + 3600000;
            });
        });
    }
    function refreshSavedAccount(snapshot, expected) {
        var profile = snapshot.page.profile;
        var saved = profile && data.profiles.some(function (account) { return account.id === profile.id; });
        // The recovery journal preserves unsaved sessions without adding them back to the profile list.
        return snapshot.page.auth && saved ? capture(expected) : Promise.resolve();
    }
    function verify(identity, expected) {
        var deadline = Date.now() + VERIFY_MS;
        function check() {
            requireCurrent(expected);
            return connection.read(true).then(function (page) {
                requireCurrent(expected);
                if (!foreground || !page || !page.visible) throw new Error('Keep Twitch open until the account change finishes');
                var correctProfile = identity ? page.profile && page.profile.id === identity.id : !page.profile;
                if (page.ready && page.auth === !!identity && correctProfile && page.tokenPresent === !!identity) return page;
                if (Date.now() >= deadline) throw new Error('Twitch did not confirm the account change');
                return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(check);
            });
        }
        return check();
    }
    function restorePending() {
        if (!data || !data.pending) return Promise.resolve();
        var pending = data.pending, previous = pending.previousCookies;
        if (!connection || !connection.connected()) return Promise.reject(new Error('Reopen Twitch to restore the previous account'));
        return connection.replace(previous).then(function () { return connection.reload(); }).then(function () {
            var next = vault.read(); next.pending = null; save(next); addingHere = false; model.adding = false;
            var identity = storage.identity(previous); model.activeId = identity ? identity.id : null; model.guest = !identity;
            model.phase = running ? 'ready' : 'stopped';
        }).catch(function () { throw new Error('Previous account recovery is pending; reopen Twitch with account management enabled'); });
    }
    function journal(kind, previous, targetId) {
        var next = vault.read();
        if (next.pending) throw new Error('Finish or cancel the pending account change first');
        next.pending = { kind: kind, previousCookies: storage.cookies(previous), targetId: targetId || null, startedAt: Date.now() }; save(next);
    }
    function beginAdd(expected, targetId) {
        if (!targetId && data.profiles.length >= storage.maxAccounts) return Promise.reject(new Error('Forget an account before adding another'));
        return currentSnapshot(expected).then(function (snapshot) {
            return refreshSavedAccount(snapshot, expected).then(function () {
                requireCurrent(expected);
                journal('add', snapshot.cookies, targetId);
                addingHere = true;
                model.adding = true;
                nextCaptureAt = 0;
                return connection.replace([]).then(function () { requireCurrent(expected); return connection.signIn(); }).then(function () {
                    model.visible = false; launchPending = false; model.phase = 'signing-in';
                });
            });
        }).catch(rollbackChange);
    }
    function changeSession(snapshot, identity, cookies, expected) {
        requireCurrent(expected);
        journal('switch', snapshot.cookies, identity && identity.id);
        return connection.replace(cookies).then(function () {
            requireCurrent(expected);
            return connection.reload();
        }).then(function () { return verify(identity, expected); }).then(function () {
            if (identity) return capture(expected);
        }).then(function () {
            requireCurrent(expected);
            var next = vault.read();
            next.pending = null;
            next.initialized = true;
            save(next);
            model.activeId = identity ? identity.id : null;
            model.guest = !identity;
            homeAccount = identity ? { id: identity.id, login: identity.login } : { guest: true };
            model.canCapture = false;
            model.visible = false;
            launchPending = false;
            model.phase = 'ready';
        });
    }
    function rollbackChange(error) {
        if (!data.pending) throw error;
        return restorePending().then(function () { model.visible = true; model.mode = 'choose'; throw error; });
    }
    function switchAccount(id, expected) {
        var target = data.profiles.filter(function (p) { return p.id === id; })[0];
        if (!target) return Promise.reject(new Error('Unknown saved account'));
        if (target.state === 'sign-in-required') return beginAdd(expected, id);
        return connection.validate(target.cookies).then(function (identity) {
            requireCurrent(expected);
            if (!identity || identity.id !== target.id) {
                var next = vault.read(); next.profiles.forEach(function (p) { if (p.id === id) p.state = 'sign-in-required'; }); save(next);
                throw new Error('This account needs to sign in again. Select it again to reconnect.');
            }
            return currentSnapshot(expected).then(function (snapshot) {
                if (snapshot.page.profile && snapshot.page.profile.id === id && snapshot.page.auth) { model.visible = false; launchPending = false; return; }
                return refreshSavedAccount(snapshot, expected).then(function () {
                    return changeSession(snapshot, identity, target.cookies, expected);
                });
            });
        }).catch(rollbackChange);
    }
    function chooseGuest(expected) {
        return currentSnapshot(expected).then(function (snapshot) {
            if (snapshot.page.auth || snapshot.page.tokenPresent || snapshot.cookies.length) return changeSession(snapshot, null, [], expected);
            model.activeId = null;
            model.guest = true;
            model.canCapture = false;
            model.visible = false;
            launchPending = false;
        }).catch(rollbackChange);
    }
    function action(type, id) {
        if (!running || !data || !connection || !connection.connected()) return Promise.reject(new Error('Open Twitch to manage accounts'));
        if (model.busy) return Promise.reject(new Error('An account change is already in progress'));
        var expected = generation;
        model.busy = true; model.error = null;
        return exclusive(function () {
            requireCurrent(expected);
            if (!foreground && ['forget', 'forget-all'].indexOf(type) < 0) throw new Error('Open Twitch on the TV to manage accounts');
            return publish().then(function () {
                requireCurrent(expected);
                if (data.pending && type !== 'cancel' && type !== 'dismiss' && type !== 'manage' && type !== 'choose') throw new Error('Finish signing in, or cancel the account change');
                if (type === 'capture') return capture(expected);
                if (type === 'add') return beginAdd(expected, null);
                if (type === 'switch') return switchAccount(id, expected);
                if (type === 'guest') return chooseGuest(expected);
                if (type === 'cancel') return restorePending().then(function () { model.visible = true; model.mode = 'choose'; model.phase = 'ready'; });
                if (type === 'manage' || type === 'choose') { model.visible = true; model.mode = type; launchPending = false; return; }
                if (type === 'dismiss') { model.visible = false; launchPending = false; return; }
                if (type === 'forget' || type === 'forget-all') {
                    if (type === 'forget' && !data.profiles.some(function (p) { return p.id === id; })) throw new Error('Unknown saved account');
                    var next = vault.read(); next.profiles = type === 'forget-all' ? [] : next.profiles.filter(function (p) { return p.id !== id; }); next.initialized = true; save(next); return;
                }
                throw new Error('Unknown account action');
            });
        }).then(function () { model.busy = false; return publish().then(status); }, function (error) {
            model.busy = false; model.error = error.message; return publish().catch(function () {}).then(function () { throw error; });
        });
    }
    function poll() {
        if (!running || !connection || !connection.connected() || !foreground || polling || model.busy) return;
        polling = true; var expected = generation;
        exclusive(function () {
            requireCurrent(expected);
            return connection.read(false).then(function (page) {
                requireCurrent(expected);
                if (!foreground || !page || !page.visible || (!page.ready && !page.renderable)) return;
                if (page.instance !== pageInstance) { pageInstance = page.instance; actionSequence = 0; }
                model.activeId = page.profile && page.tokenPresent ? page.profile.id : null;
                model.guest = !page.tokenPresent && !page.profile;
                homeAccount = null;
                if (page.path === '/') {
                    if (model.activeId) homeAccount = { id: String(model.activeId), login: page.profile.login };
                    else if (page.ready && model.guest) homeAccount = { guest: true };
                }
                model.canCapture = !!model.activeId && !data.profiles.some(function (p) { return p.id === model.activeId; });
                if (page.ready && data.pending && !addingHere) return restorePending();
                if (page.action && page.action.sequence > actionSequence && (page.ready || page.action.type === 'dismiss')) {
                    actionSequence = page.action.sequence;
                    return { action: page.action };
                }
                if (launchPending && !data.pending && !addingHere) {
                    launchPending = false;
                    if (chooserOnLaunch && data.profiles.length >= 2) {
                        model.mode = 'choose';
                        model.visible = true;
                        return publish();
                    }
                }
                if (!page.ready) {
                    if (model.visible || homeAccount) return publish();
                    return;
                }
                if (addingHere && page.tokenPresent && page.profile && Date.now() >= nextCaptureAt) {
                    nextCaptureAt = Date.now() + 5000;
                    var targetId = data.pending.targetId;
                    if (targetId && targetId !== page.profile.id) return restorePending().then(function () { model.visible = true; model.mode = 'choose'; throw new Error('Sign in to the selected account, or use Add account'); });
                    model.busy = true;
                    return publish().then(function () { return capture(expected, true); }).then(function () {
                        addingHere = model.adding = false;
                        model.phase = 'ready';
                        model.mode = 'choose';
                        model.visible = true;
                        model.error = null;
                        launchPending = false;
                    }).then(function () { model.busy = false; }, function (error) { model.busy = false; throw error; });
                }
                if (!data.initialized && !data.pending) {
                    if (page.tokenPresent) {
                        if (Date.now() < nextCaptureAt) return publish();
                        nextCaptureAt = Date.now() + 5000;
                        return capture(expected);
                    }
                    var next = vault.read(); next.initialized = true; save(next);
                }
                if (!model.visible && !data.pending && page.tokenPresent && page.profile && Date.now() >= nextValidationAt) {
                    nextValidationAt = Date.now() + 30000;
                    return connection.cookies().then(function (cookies) { return connection.validate(cookies).then(function (identity) {
                        requireCurrent(expected); nextValidationAt = Date.now() + 3600000;
                        if (!identity) {
                            var next = vault.read(); next.profiles.forEach(function (p) { if (p.id === page.profile.id) p.state = 'sign-in-required'; }); save(next);
                            model.error = 'The current account needs to sign in again';
                        } else if (data.profiles.some(function (p) { return p.id === identity.id; })) upsert(identity, cookies);
                    }); });
                }
                return publish();
            });
        }).then(function (result) {
            polling = false;
            if (result && result.action) return action(result.action.type, result.action.id).catch(function () {});
        }).catch(function (error) { polling = false; model.error = error.message; return publish().catch(function () {}); });
    }
    function detach() {
        generation++; if (pollTimer) clearInterval(pollTimer); pollTimer = null;
        return (attachmentTask ? attachmentTask.catch(function () {}) : Promise.resolve()).then(function () { return work; }).then(function () {
            return restorePending().catch(function () { model.error = 'Previous account recovery is pending; enable account management and reopen Twitch'; });
        }).then(function () {
            var old = connection; connection = null; homeAccount = null; addingHere = false; model.adding = false; model.visible = false; model.busy = false;
            return old ? old.close() : null;
        });
    }
    function openVault() {
        try { vault = storage.create(context.dir); vault.acquire(); data = vault.load(); model.error = null; }
        catch (e) { if (vault) vault.release(); model.error = 'Saved accounts are unavailable or still closing; existing data was left untouched'; data = null; }
    }
    return {
        start: function () {
            running = true; model.phase = 'waiting-for-twitch'; model.error = null;
            avatars = publicData.createAvatarCatalogue();
            openVault();
        },
        stop: function () {
            running = false; model.phase = 'stopped';
            if (avatars) avatars.stop();
            avatars = null;
            return detach().then(function () { if (vault) vault.release(); vault = null; data = null; model.activeId = null; });
        },
        connected: function () { return !!connection && connection.connected(); },
        setChooser: function (enabled) { chooserOnLaunch = enabled === true; },
        setForeground: function (value) {
            var enteredForeground = value === true && !foreground;
            foreground = value === true;
            if (!foreground) model.visible = false;
            if (enteredForeground) { launchPending = true; poll(); }
        },
        attach: function (port) {
            if (!data && running) openVault();
            if (!data || !running || connection || attachmentTask) return Promise.reject(new Error(model.error || 'Account attachment is unavailable'));
            var expected = ++generation; launchPending = true; pageInstance = null; nextValidationAt = 0;
            attachmentTask = sessions.open(port, function () { if (!running || expected !== generation) throw new Error('Account attachment cancelled'); }).then(function (session) {
                if (!running || expected !== generation) return session.close().then(function () { throw new Error('Account attachment cancelled'); });
                connection = session; model.phase = 'ready';
                pollTimer = setInterval(poll, POLL_MS); if (pollTimer.unref) pollTimer.unref(); poll();
            }).then(function () { attachmentTask = null; }, function (error) { attachmentTask = null; throw error; });
            return attachmentTask;
        },
        detach: detach, status: status, action: action
    };
};
