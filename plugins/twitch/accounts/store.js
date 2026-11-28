'use strict';
// Stores the account list and the recovery record in the same encrypted file. The manager
// acquires the lock before using the vault and keeps it through recovery on shutdown.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var NAMES = ['auth-token', 'auth-token_samesite_compat', 'tachyon-user', 'tachyon-user_samesite_compat'];
var MAX_ACCOUNTS = 8, MAX_BYTES = 262144, AAD = 'vetro:twitch:accounts:v1';
function fail() { throw new Error('Saved accounts could not be read or saved securely'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function cookies(input) {
    if (!Array.isArray(input) || input.length > 4) fail();
    var seen = {};
    var result = input.map(function (c) {
        if (!c || NAMES.indexOf(c.name) < 0 || seen[c.name] || !/^\.?twitch\.tv$/.test(c.domain) || c.path !== '/' ||
            typeof c.value !== 'string' || !c.value || c.value.length > 4096 || c.secure !== true || typeof c.httpOnly !== 'boolean') fail();
        seen[c.name] = true;
        var r = { name: c.name, value: c.value, domain: c.domain, path: '/', secure: true, httpOnly: c.httpOnly, session: c.session === true };
        if (c.sameSite !== undefined) { if (['None', 'Lax', 'Strict'].indexOf(c.sameSite) < 0) fail(); r.sameSite = c.sameSite; }
        if (c.priority !== undefined) { if (['Low', 'Medium', 'High'].indexOf(c.priority) < 0) fail(); r.priority = c.priority; }
        if (!r.session) { if (typeof c.expires !== 'number' || !isFinite(c.expires) || c.expires < 0) fail(); r.expires = c.expires; }
        return r;
    });
    if (result.length && (!seen['auth-token'] || !seen['tachyon-user'])) fail();
    return result;
}
function identity(input) {
    var profile = input.filter(function (c) { return c.name === 'tachyon-user'; })[0];
    if (!profile) return null;
    var value;
    try { value = JSON.parse(decodeURIComponent(profile.value)); } catch (e) { fail(); }
    if (!value || !/^\d{1,32}$/.test(value.id) || !/^[a-zA-Z0-9_]{1,32}$/.test(value.login)) fail();
    return { id: String(value.id), login: value.login };
}
function validate(data) {
    if (!data || data.format !== 1 || typeof data.initialized !== 'boolean' || !Array.isArray(data.profiles) || data.profiles.length > MAX_ACCOUNTS) fail();
    var seen = {};
    data.profiles.forEach(function (p) {
        if (!p || !/^\d{1,32}$/.test(p.id) || seen[p.id] || !/^[a-zA-Z0-9_]{1,32}$/.test(p.login) ||
            ['ready', 'sign-in-required'].indexOf(p.state) < 0 || typeof p.savedAt !== 'number' || !isFinite(p.savedAt)) fail();
        seen[p.id] = true;
        var current = identity(cookies(p.cookies));
        if (!current || current.id !== p.id || current.login.toLowerCase() !== p.login.toLowerCase()) fail();
    });
    if (data.pending !== null) {
        var pending = data.pending;
        if (!pending || ['add', 'switch'].indexOf(pending.kind) < 0 || typeof pending.startedAt !== 'number' || !isFinite(pending.startedAt) ||
            (pending.targetId !== null && !/^\d{1,32}$/.test(pending.targetId))) fail();
        cookies(pending.previousCookies);
    }
    return clone(data);
}
function privateStat(file, directory) {
    var stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 511) !== (directory ? 448 : 384) ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail();
    return stat;
}
function create(pluginDir) {
    if (!pluginDir || typeof pluginDir !== 'string') fail();
    var directory = path.join(path.dirname(pluginDir), '.twitch-accounts');
    var keyFile = path.join(directory, 'key'), dataFile = path.join(directory, 'vault.json'), lockFile = path.join(directory, 'lock');
    var key = null, current = null, lockOwner = null;
    function processStamp(pid) {
        try { var stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]; } catch (e) { return null; }
    }
    function acquire() {
        if (!fs.existsSync(directory)) fs.mkdirSync(directory, 448);
        privateStat(directory, true);
        if (fs.existsSync(lockFile)) {
            privateStat(lockFile, false);
            var held;
            try { held = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (e) { fail(); }
            if (!held || typeof held.pid !== 'number' || held.pid < 1 || Math.floor(held.pid) !== held.pid || !/^([a-f0-9]{32})$/.test(held.nonce) || (held.start !== null && !/^\d+$/.test(held.start))) fail();
            var active = false;
            try { process.kill(held.pid, 0); active = held.start === null || processStamp(held.pid) === held.start; } catch (e) { if (e.code !== 'ESRCH') active = true; }
            if (active) throw new Error('Another account manager is still closing; try again shortly');
            fs.unlinkSync(lockFile);
        }
        var owner = { pid: process.pid, start: processStamp(process.pid), nonce: crypto.randomBytes(16).toString('hex') };
        fs.writeFileSync(lockFile, JSON.stringify(owner), { flag: 'wx', mode: 384 }); lockOwner = owner;
    }
    function release() {
        if (lockOwner) {
            try {
                var held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
                if (held.nonce === lockOwner.nonce) fs.unlinkSync(lockFile);
            } catch (e) {}
        }
        lockOwner = null;
        if (key) key.fill(0); key = null; current = null;
    }
    function syncDirectory() {
        var fd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    function readKey(createMissing) {
        if (!fs.existsSync(directory)) {
            if (key || !createMissing) fail();
            fs.mkdirSync(directory, 448);
        }
        privateStat(directory, true);
        if (!fs.existsSync(keyFile)) {
            if (key || !createMissing || fs.existsSync(dataFile)) fail();
            var fd = fs.openSync(keyFile, 'wx', 384);
            try { fs.writeSync(fd, crypto.randomBytes(32), 0, 32); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            syncDirectory();
        }
        if (privateStat(keyFile, false).size !== 32) fail();
        var savedKey = fs.readFileSync(keyFile);
        // A missing or replaced key must never produce a vault that the current installation cannot reopen.
        if (key && !savedKey.equals(key)) fail();
        if (!key) key = savedKey;
        return key;
    }
    function load() {
        var hasDirectory = fs.existsSync(directory);
        if (hasDirectory) privateStat(directory, true);
        if (!hasDirectory || !fs.existsSync(dataFile)) {
            if (hasDirectory && fs.existsSync(keyFile)) readKey(false);
            current = { format: 1, initialized: false, profiles: [], pending: null };
            return clone(current);
        }
        try {
            if (privateStat(dataFile, false).size > MAX_BYTES) fail();
            var envelope = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
            if (envelope.format !== 1 || !/^[a-f0-9]{24}$/.test(envelope.iv) || !/^[a-f0-9]{32}$/.test(envelope.tag) ||
                typeof envelope.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.data)) fail();
            var decipher = crypto.createDecipheriv('aes-256-gcm', readKey(false), new Buffer(envelope.iv, 'hex'));
            decipher.setAAD(new Buffer(AAD, 'utf8')); decipher.setAuthTag(new Buffer(envelope.tag, 'hex'));
            current = validate(JSON.parse(Buffer.concat([decipher.update(new Buffer(envelope.data, 'base64')), decipher.final()]).toString('utf8')));
            return clone(current);
        } catch (e) { fail(); }
    }
    function save(value) {
        var next = validate(value), temporary;
        try {
            var secret = readKey(true), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
            cipher.setAAD(new Buffer(AAD, 'utf8'));
            var encrypted = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
            var body = JSON.stringify({ format: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('base64') });
            if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) fail();
            temporary = path.join(directory, '.write-' + crypto.randomBytes(8).toString('hex'));
            var fd = fs.openSync(temporary, 'wx', 384);
            try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            if (fs.existsSync(dataFile)) privateStat(dataFile, false);
            fs.renameSync(temporary, dataFile); syncDirectory(); current = next;
            return clone(current);
        } catch (e) { if (temporary) { try { fs.unlinkSync(temporary); } catch (ignored) {} } fail(); }
    }
    return { load: load, save: save, acquire: acquire, release: release, read: function () { return current ? clone(current) : load(); } };
}
module.exports = { create: create, cookies: cookies, identity: identity, maxAccounts: MAX_ACCOUNTS, names: NAMES };
