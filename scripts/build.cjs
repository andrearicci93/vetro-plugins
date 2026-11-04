#!/usr/bin/env node
'use strict';
// Packs every folder in plugins/ into dist/<id>-<version>.vplugin and writes index.json.
//   node scripts/build.cjs           check every plugin, then rebuild dist/ and index.json
//   node scripts/build.cjs --check   check every plugin and fail if dist/ or index.json are out of date (CI)
//
// The bundle is byte for byte what `node scripts/vetro-plugin.cjs pack plugins/<id>` in the Vetro repo
// writes, so a contributor can pack locally and get the same SHA-256 as index.json.
// A `signature` that the list's maintainer added with `vetro-plugin.cjs sign` is kept for as long as the
// entry's id, version and SHA-256 are unchanged; any other change drops it and the entry has to be signed again.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const check = process.argv.includes('--check');

// Limits of the TV's installer (Vetro 0.4.0, app/service/plugin-host.js: checkManifest, checkBundle).
// Copied, not imported: CI does not have the Vetro repo. Re-read them when a new Vetro version changes the API.
const ID = /^[a-z][a-z0-9-]{1,31}$/, RESERVED = ['install', 'resume', 'developer'];
const PERMISSIONS = ['exec'];
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const MAX_FILES = 20, MAX_BYTES = 512 * 1024;

// What this list asks on top of what the TV checks (see CONTRIBUTING.md). Mechanical only: a person still reads the code.
const SEMVER = /^\d+\.\d+\.\d+$/;
const BANNED = [[/\beval\s*\(/, 'eval()'], [/\bnew\s+Function\b/, 'new Function']];

function text(folder, rel) { return fs.readFileSync(path.join(folder, rel), 'utf8'); }

function validate(id, m, files) {
    const e = [];
    if (!ID.test(id) || RESERVED.indexOf(id) >= 0) e.push('the folder name is not a valid id (2-32 chars, a-z 0-9 -, starts with a letter; not ' + RESERVED.join(', ') + ')');
    if (m.id !== id) e.push('manifest id "' + m.id + '" must equal the folder name');
    if (m.apiVersion !== 1) e.push('apiVersion must be 1');
    const str = (k, min, max, required) => {
        if (m[k] == null) { if (required) e.push(k + ' is required'); return; }
        if (typeof m[k] !== 'string' || m[k].length < min || m[k].length > max) e.push(k + ' must be a string of ' + min + '-' + max + ' characters');
    };
    str('name', 1, 40, true); str('version', 1, 24, true); str('description', 1, 160, true); str('author', 1, 60, true);
    if (typeof m.version === 'string' && !SEMVER.test(m.version)) e.push('version must look like 1.2.3');
    if (m.author === 'your-github-login') e.push('author is still the template placeholder: use your GitHub login');
    if (m.description && /^One line that says/.test(m.description)) e.push('description is still the template placeholder');
    const perms = m.permissions == null ? [] : m.permissions;
    if (!Array.isArray(perms)) e.push('permissions must be a list');
    else perms.forEach(p => { if (PERMISSIONS.indexOf(p) < 0) e.push('unknown permission "' + p + '" (the TV knows: ' + PERMISSIONS.join(', ') + ')'); });
    if (m.ui != null && (typeof m.ui.label !== 'string' || !m.ui.label || m.ui.label.length > 24)) e.push('ui.label must be 1-24 characters');
    if (m.main != null && (typeof m.main !== 'string' || !FILE.test(m.main))) e.push('main must be a file name inside the plugin folder');
    const names = Object.keys(files);
    if (names.length > MAX_FILES) e.push('a bundle holds at most ' + MAX_FILES + ' files (this one has ' + names.length + ')');
    const total = names.reduce((n, f) => n + Buffer.byteLength(files[f]), 0);
    if (total > MAX_BYTES) e.push('files add up to ' + total + ' bytes; the TV accepts at most ' + MAX_BYTES);
    names.forEach(f => { if (!FILE.test(f)) e.push('file name not allowed on the TV: ' + f); });
    if (typeof files[m.main || 'index.js'] !== 'string') e.push('entry file ' + (m.main || 'index.js') + ' is missing');
    if (m.ui && typeof files[m.main || 'index.js'] === 'string' && !/['"]ui['"]/.test(files[m.main || 'index.js'])) e.push('manifest.ui is set but the entry file never mentions the "ui" route');

    if (typeof files['README.md'] !== 'string') e.push('README.md is missing (start from template/README.md)');
    else if (perms.indexOf('exec') >= 0 && !/^#{1,6}\s+Commands\b/mi.test(files['README.md'])) e.push('asks for exec, so README.md needs a "Commands it runs" section listing every command and why');
    names.filter(f => /\.(c|m)?js$/.test(f)).forEach(f => BANNED.forEach(b => { if (b[0].test(files[f])) e.push(f + ' uses ' + b[1] + ', which this list does not accept'); }));
    return e;
}

function pack(folder, id) {
    const manifest = JSON.parse(text(folder, 'manifest.json'));
    const files = {}, errors = [];
    (function walk(dir, prefix) {
        for (const n of fs.readdirSync(dir).sort()) {
            if (n.charAt(0) === '.' || n === 'node_modules' || n === 'config.json') continue;
            const full = path.join(dir, n), rel = prefix + n;
            if (fs.statSync(full).isDirectory()) { walk(full, rel + '/'); continue; }
            if (rel === 'manifest.json') continue;
            const buf = fs.readFileSync(full);
            if (buf.includes(0)) errors.push(rel + ' is a binary file; a bundle holds text only');
            else files[rel] = buf.toString('utf8');
        }
    })(folder, '');
    errors.push(...validate(id, manifest, files));
    // Registry-only fields (author, description) stay in the manifest: the TV ignores what it does not know.
    return { manifest, errors, text: JSON.stringify({ format: 'vetro-plugin', version: 1, manifest, files }) + '\n' };
}

let previous = [];
try { previous = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')).plugins || []; } catch (e) { /* first build */ }

const out = {}, problems = [];
const index = { format: 'vetro-plugin-index', version: 1, plugins: [] };
for (const id of fs.readdirSync(path.join(root, 'plugins')).sort()) {
    const dir = path.join(root, 'plugins', id);
    if (!fs.statSync(dir).isDirectory() || id.charAt(0) === '.') continue;
    let r;
    try { r = pack(dir, id); } catch (e) { problems.push(id + ': ' + e.message); continue; }
    r.errors.forEach(msg => problems.push(id + ': ' + msg));
    if (r.errors.length) continue;
    const m = r.manifest, name = id + '-' + m.version + '.vplugin';
    const entry = {
        id, name: m.name, version: m.version, author: m.author || '', description: m.description || '',
        permissions: m.permissions || [], url: 'dist/' + name,
        sha256: crypto.createHash('sha256').update(r.text).digest('hex'), size: Buffer.byteLength(r.text)
    };
    const old = previous.find(p => p.id === id);
    if (old && old.signature && old.version === entry.version && old.sha256 === entry.sha256) entry.signature = old.signature;
    out['dist/' + name] = r.text;
    index.plugins.push(entry);
}
if (problems.length) { console.error('Plugin checks failed:\n  ' + problems.join('\n  ')); process.exit(1); }
out['index.json'] = JSON.stringify(index, null, 2) + '\n';

const stale = [];
if (!check) { fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true }); fs.mkdirSync(path.join(root, 'dist')); }
for (const [file, body] of Object.entries(out)) {
    const full = path.join(root, file);
    if (check) { if (!fs.existsSync(full) || fs.readFileSync(full, 'utf8') !== body) stale.push(file); }
    else fs.writeFileSync(full, body);
}
if (check) {
    const have = fs.existsSync(path.join(root, 'dist')) ? fs.readdirSync(path.join(root, 'dist')).map(n => 'dist/' + n) : [];
    have.filter(f => !out[f]).forEach(f => stale.push(f + ' (no longer built)'));
    if (stale.length) { console.error('Out of date, run node scripts/build.cjs:\n  ' + stale.join('\n  ')); process.exit(1); }
    console.log('Plugins are valid; dist/ and index.json are up to date');
} else console.log('Built ' + index.plugins.length + ' plugin(s): ' + index.plugins.map(p => p.id + ' ' + p.version).join(', '));
