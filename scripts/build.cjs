#!/usr/bin/env node
'use strict';
// Packs every folder in plugins/ into dist/<id>-<version>.vplugin and writes index.json.
//   node scripts/build.cjs           rebuild
//   node scripts/build.cjs --check   fail if dist/ or index.json are out of date (used by CI)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const check = process.argv.includes('--check');
const ID = /^[a-z][a-z0-9-]{1,31}$/;

function pack(folder) {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    const files = {};
    (function walk(dir, prefix) {
        for (const n of fs.readdirSync(dir).sort()) {
            if (n.charAt(0) === '.' || n === 'node_modules') continue;
            const full = path.join(dir, n), rel = prefix + n;
            if (fs.statSync(full).isDirectory()) walk(full, rel + '/');
            else if (rel !== 'manifest.json') files[rel] = fs.readFileSync(full, 'utf8');
        }
    })(folder, '');
    // Registry-only fields (author, description) stay in the manifest: the TV ignores what it does not know.
    return { manifest, text: JSON.stringify({ format: 'vetro-plugin', version: 1, manifest, files }) + '\n' };
}

const out = {};
const index = { format: 'vetro-plugin-index', version: 1, plugins: [] };
for (const id of fs.readdirSync(path.join(root, 'plugins')).sort()) {
    const dir = path.join(root, 'plugins', id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const { manifest, text } = pack(dir);
    if (manifest.id !== id || !ID.test(id)) throw new Error(id + ': manifest id must equal the folder name');
    if (manifest.apiVersion !== 1) throw new Error(id + ': apiVersion must be 1');
    const name = id + '-' + manifest.version + '.vplugin';
    out['dist/' + name] = text;
    index.plugins.push({
        id, name: manifest.name, version: manifest.version, author: manifest.author || '', description: manifest.description || '',
        permissions: manifest.permissions || [], url: 'dist/' + name,
        sha256: crypto.createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text)
    });
}
out['index.json'] = JSON.stringify(index, null, 2) + '\n';

let stale = [];
if (!check) { fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true }); fs.mkdirSync(path.join(root, 'dist')); }
for (const [file, text] of Object.entries(out)) {
    const full = path.join(root, file);
    if (check) { if (!fs.existsSync(full) || fs.readFileSync(full, 'utf8') !== text) stale.push(file); }
    else fs.writeFileSync(full, text);
}
if (check) {
    const have = fs.existsSync(path.join(root, 'dist')) ? fs.readdirSync(path.join(root, 'dist')).map(n => 'dist/' + n) : [];
    have.filter(f => !out[f]).forEach(f => stale.push(f + ' (no longer built)'));
    if (stale.length) { console.error('Out of date, run node scripts/build.cjs:\n  ' + stale.join('\n  ')); process.exit(1); }
    console.log('dist/ and index.json are up to date');
} else console.log('Built ' + index.plugins.length + ' plugin(s): ' + index.plugins.map(p => p.id + ' ' + p.version).join(', '));
