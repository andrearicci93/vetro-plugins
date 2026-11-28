'use strict';
// Owns the account chooser and the order of account changes. session.js talks to the Twitch
// page and its cookies. store.js keeps saved accounts and the recovery record on the TV.
// A cookie change starts only after the original session has been recorded for recovery.

var storage = require('./store.js');
var sessions = require('./session.js');
var publicData = require('../public-data.js');
var POLL_MS = 750;
var VERIFY_MS = 15000;
var VERIFY_STEP_MS = 250;
var CAPTURE_RETRY_MS = 5000;
var VALIDATION_RETRY_MS = 30000;
var VALIDATION_INTERVAL_MS = 60 * 60 * 1000;

module.exports = function (context) {
    var vault = null, data = null, connection = null, avatars = null, running = false, foreground = false, chooserOnLaunch = true;
    var generation = 0, attachmentTask = null, work = Promise.resolve(), pollTimer = null, polling = false;
    var model = { phase: 'stopped', error: null, activeId: null, visible: false, mode: 'choose', busy: false, canCapture: false, guest: false };
    var chooserPending = true, pageInstance = null, actionSequence = 0;
    var signInStartedHere = false, nextCaptureAt = 0, nextValidationAt = 0;
    var homeAccount = null;

    function connected() { return !!connection && connection.connected(); }
    function requireCurrent(expected) {
        if (!running || expected !== generation || !connected()) throw new Error('Account operation cancelled');
    }
    function profiles(includeAvatars) {
        return data ? data.profiles.map(function (p) {
            var profile = { id: p.id, login: p.login, state: p.state, active: p.id === model.activeId };
            if (includeAvatars && avatars) profile.avatarUrl = avatars.get(p.id);
            return profile;
        }) : [];
    }
    function status() {
        return { attached: connected(), phase: model.phase, busy: model.busy, adding: signInStartedHere,
            activeId: model.activeId, profiles: profiles(), canCapture: model.canCapture, error: model.error };
    }
    function publish() {
        if (!connected()) return Promise.resolve();
        var showingProfiles = foreground && model.visible && model.mode === 'choose' && !signInStartedHere;
        var home = foreground && !signInStartedHere && !data.pending ? homeAccount : null;
        var current = home && (home.guest ? { guest: true } : { login: home.login });
        if (avatars && (showingProfiles || (home && home.id))) {
            var savedIds = data.profiles.map(function (p) { return p.id; });
            var requested = showingProfiles ? savedIds.slice() : [];
            if (home && home.id && requested.indexOf(home.id) < 0) requested.push(home.id);
            avatars.refresh(requested, home && home.id ? savedIds.concat(home.id) : savedIds);
            if (home && home.id) current.avatarUrl = avatars.get(home.id);
        }
        return connection.publish({ visible: model.visible, mode: model.mode, busy: model.busy, adding: signInStartedHere, canCapture: model.canCapture,
            profiles: profiles(showingProfiles), guest: model.guest, homeAccount: current, message: model.error, ack: actionSequence });
    }
    function save(next) { data = vault.save(next); }
    function markSignInRequired(id) {
        var next = vault.read();
        next.profiles.forEach(function (profile) {
            if (profile.id === id) profile.state = 'sign-in-required';
        });
        save(next);
    }
    function upsert(identity, cookies, completeAdd) {
        var next = vault.read(), at = next.profiles.map(function (p) { return p.id; }).indexOf(identity.id);
        if (at < 0 && next.profiles.length >= storage.maxAccounts) throw new Error('At most eight accounts can be saved');
        var profile = { id: identity.id, login: identity.login, cookies: storage.cookies(cookies), savedAt: Date.now(), state: 'ready' };
        if (at < 0) next.profiles.push(profile); else next.profiles[at] = profile;
        if (completeAdd) next.pending = null;
        next.initialized = true; save(next);
    }
    // Page polling and user actions share one queue. Detach waits for it before restoring cookies.
    function serial(job) {
        var task = work.then(job);
        work = task.catch(function () {});
        return task;
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
                nextValidationAt = Date.now() + VALIDATION_INTERVAL_MS;
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
                return new Promise(function (resolve) { setTimeout(resolve, VERIFY_STEP_MS); }).then(check);
            });
        }
        return check();
    }
    function restorePreviousSession() {
        if (!data || !data.pending) return Promise.resolve();
        if (!connected()) return Promise.reject(new Error('Reopen Twitch to restore the previous account'));
        var previousCookies = data.pending.previousCookies;
        return connection.replace(previousCookies).then(function () {
            return connection.reload();
        }).then(function () {
            // Until Twitch reloads and this save succeeds, the next attachment can still recover.
            var next = vault.read();
            next.pending = null;
            save(next);
            signInStartedHere = false;
            var identity = storage.identity(previousCookies);
            model.activeId = identity ? identity.id : null;
            model.guest = !identity;
            model.phase = running ? 'ready' : 'stopped';
        }).catch(function () { throw new Error('Previous account recovery is pending; reopen Twitch with account management enabled'); });
    }
    function recordPreviousSession(kind, previous, targetId) {
        var next = vault.read();
        if (next.pending) throw new Error('Finish or cancel the pending account change first');
        next.pending = { kind: kind, previousCookies: storage.cookies(previous), targetId: targetId || null, startedAt: Date.now() };
        save(next);
    }
    // The native sign-in may outlive this call. Polling saves the new account once Twitch confirms it.
    function beginAdd(expected, targetId) {
        if (!targetId && data.profiles.length >= storage.maxAccounts) return Promise.reject(new Error('Forget an account before adding another'));
        return currentSnapshot(expected).then(function (snapshot) {
            return refreshSavedAccount(snapshot, expected).then(function () {
                requireCurrent(expected);
                recordPreviousSession('add', snapshot.cookies, targetId);
                signInStartedHere = true;
                nextCaptureAt = 0;
                return connection.replace([]).then(function () {
                    requireCurrent(expected);
                    return connection.signIn();
                }).then(function () {
                    model.visible = false;
                    chooserPending = false;
                    model.phase = 'signing-in';
                });
            });
        }).catch(rollbackChange);
    }
    // Saved account and Guest use the same sequence. Commit only after the native page confirms the change.
    function changeSession(snapshot, identity, cookies, expected) {
        requireCurrent(expected);
        recordPreviousSession('switch', snapshot.cookies, identity && identity.id);
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
            chooserPending = false;
            model.phase = 'ready';
        });
    }
    function rollbackChange(error) {
        if (!data.pending) throw error;
        return restorePreviousSession().then(function () {
            model.visible = true;
            model.mode = 'choose';
            throw error;
        });
    }
    function switchAccount(id, expected) {
        var target = data.profiles.filter(function (p) { return p.id === id; })[0];
        if (!target) return Promise.reject(new Error('Unknown saved account'));
        if (target.state === 'sign-in-required') return beginAdd(expected, id);
        return connection.validate(target.cookies).then(function (identity) {
            requireCurrent(expected);
            if (!identity || identity.id !== target.id) {
                markSignInRequired(id);
                throw new Error('This account needs to sign in again. Select it again to reconnect.');
            }
            return currentSnapshot(expected).then(function (snapshot) {
                if (snapshot.page.profile && snapshot.page.profile.id === id && snapshot.page.auth) { model.visible = false; chooserPending = false; return; }
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
            chooserPending = false;
        }).catch(rollbackChange);
    }
    function action(type, id) {
        if (!running || !data || !connected()) return Promise.reject(new Error('Open Twitch to manage accounts'));
        if (model.busy) return Promise.reject(new Error('An account change is already in progress'));
        var expected = generation;
        model.busy = true; model.error = null;
        return serial(function () {
            requireCurrent(expected);
            if (!foreground && ['forget', 'forget-all'].indexOf(type) < 0) throw new Error('Open Twitch on the TV to manage accounts');
            return publish().then(function () {
                requireCurrent(expected);
                if (data.pending && type !== 'cancel' && type !== 'dismiss' && type !== 'manage' && type !== 'choose') throw new Error('Finish signing in, or cancel the account change');
                switch (type) {
                    case 'capture': return capture(expected);
                    case 'add': return beginAdd(expected, null);
                    case 'switch': return switchAccount(id, expected);
                    case 'guest': return chooseGuest(expected);
                    case 'cancel':
                        return restorePreviousSession().then(function () {
                            model.visible = true;
                            model.mode = 'choose';
                            model.phase = 'ready';
                        });
                    case 'manage':
                    case 'choose':
                        model.visible = true;
                        model.mode = type;
                        chooserPending = false;
                        return;
                    case 'dismiss':
                        model.visible = false;
                        chooserPending = false;
                        return;
                    case 'forget':
                    case 'forget-all':
                        if (type === 'forget' && !data.profiles.some(function (p) { return p.id === id; })) throw new Error('Unknown saved account');
                        var next = vault.read();
                        next.profiles = type === 'forget-all' ? [] : next.profiles.filter(function (p) { return p.id !== id; });
                        next.initialized = true;
                        save(next);
                        return;
                    default: throw new Error('Unknown account action');
                }
            });
        }).then(function () { model.busy = false; return publish().then(status); }, function (error) {
            model.busy = false; model.error = error.message; return publish().catch(function () {}).then(function () { throw error; });
        });
    }
    function updatePageState(page) {
        if (page.instance !== pageInstance) {
            pageInstance = page.instance;
            actionSequence = 0;
        }
        model.activeId = page.profile && page.tokenPresent ? page.profile.id : null;
        model.guest = !page.tokenPresent && !page.profile;
        model.canCapture = !!model.activeId && !data.profiles.some(function (profile) { return profile.id === model.activeId; });

        homeAccount = null;
        if (page.path !== '/') return;
        if (model.activeId) homeAccount = { id: String(model.activeId), login: page.profile.login };
        else if (page.ready && model.guest) homeAccount = { guest: true };
    }
    function finishSignIn(profile, expected) {
        nextCaptureAt = Date.now() + CAPTURE_RETRY_MS;
        var targetId = data.pending.targetId;
        if (targetId && targetId !== profile.id) {
            return rollbackChange(new Error('Sign in to the selected account, or use Add account'));
        }

        model.busy = true;
        return publish().then(function () {
            return capture(expected, true);
        }).then(function () {
            signInStartedHere = false;
            model.phase = 'ready';
            model.mode = 'choose';
            model.visible = true;
            model.error = null;
            chooserPending = false;
        }).then(function () {
            model.busy = false;
        }, function (error) {
            model.busy = false;
            throw error;
        });
    }
    function checkCurrentAccount(profile, expected) {
        nextValidationAt = Date.now() + VALIDATION_RETRY_MS;
        return connection.cookies().then(function (cookies) {
            return connection.validate(cookies).then(function (identity) {
                requireCurrent(expected);
                nextValidationAt = Date.now() + VALIDATION_INTERVAL_MS;
                if (!identity) {
                    markSignInRequired(profile.id);
                    model.error = 'The current account needs to sign in again';
                } else if (data.profiles.some(function (saved) { return saved.id === identity.id; })) {
                    upsert(identity, cookies);
                }
            });
        });
    }

    // Recovery takes priority over page actions and automatic account checks.
    function handlePage(page, expected) {
        requireCurrent(expected);
        if (!foreground || !page || !page.visible || (!page.ready && !page.renderable)) return;
        updatePageState(page);
        if (page.ready && data.pending && !signInStartedHere) return restorePreviousSession();
        if (page.action && page.action.sequence > actionSequence && (page.ready || page.action.type === 'dismiss')) {
            actionSequence = page.action.sequence;
            return { action: page.action };
        }

        if (chooserPending && !data.pending && !signInStartedHere) {
            chooserPending = false;
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

        if (signInStartedHere && page.tokenPresent && page.profile && Date.now() >= nextCaptureAt) {
            return finishSignIn(page.profile, expected);
        }
        if (!data.initialized && !data.pending) {
            if (page.tokenPresent) {
                if (Date.now() < nextCaptureAt) return publish();
                nextCaptureAt = Date.now() + CAPTURE_RETRY_MS;
                return capture(expected);
            }
            var next = vault.read();
            next.initialized = true;
            save(next);
        }
        if (!model.visible && !data.pending && page.tokenPresent && page.profile && Date.now() >= nextValidationAt) {
            return checkCurrentAccount(page.profile, expected);
        }
        return publish();
    }

    function poll() {
        if (!running || !connected() || !foreground || polling || model.busy) return;
        polling = true;
        var expected = generation;
        serial(function () {
            requireCurrent(expected);
            return connection.read(false).then(function (page) { return handlePage(page, expected); });
        }).then(function (result) {
            polling = false;
            // action() uses the same queue, so it must run after the poll has left it.
            if (result && result.action) return action(result.action.type, result.action.id).catch(function () {});
        }).catch(function (error) {
            polling = false;
            model.error = error.message;
            return publish().catch(function () {});
        });
    }
    function detach() {
        generation++;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;

        // Wait for attachment and queued work before using the connection for recovery and closing it.
        var waitForAttachment = attachmentTask ? attachmentTask.catch(function () {}) : Promise.resolve();
        return waitForAttachment.then(function () {
            return work;
        }).then(function () {
            return restorePreviousSession().catch(function () {
                model.error = 'Previous account recovery is pending; enable account management and reopen Twitch';
            });
        }).then(function () {
            var old = connection;
            connection = null;
            homeAccount = null;
            signInStartedHere = false;
            model.visible = false;
            model.busy = false;
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
        connected: connected,
        setChooser: function (enabled) { chooserOnLaunch = enabled === true; },
        setForeground: function (value) {
            var enteredForeground = value === true && !foreground;
            foreground = value === true;
            if (!foreground) model.visible = false;
            if (enteredForeground) { chooserPending = true; poll(); }
        },
        attach: function (port) {
            if (!data && running) openVault();
            if (!data || !running || connection || attachmentTask) return Promise.reject(new Error(model.error || 'Account attachment is unavailable'));
            var expected = ++generation; chooserPending = true; pageInstance = null; nextValidationAt = 0;
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
