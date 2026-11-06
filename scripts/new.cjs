#!/usr/bin/env node
'use strict';
// Starts a Shard (a plugin) from template/.
//   node scripts/new.cjs <id> ["Display name"]
// Creates plugins/<id>/ with manifest.json, index.js and README.md. The id is the folder name.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const ID = /^[a-z][a-z0-9-]{1,31}$/, RESERVED = ['install', 'resume', 'developer', 'launcher'];   // launcher: a Shard that ships inside Vetro 0.5.0

const id = process.argv[2], given = process.argv[3];
if (!ID.test(id || '') || RESERVED.indexOf(id) >= 0) {
    console.error('usage: node scripts/new.cjs <id> ["Display name"]\n  id: 2-32 chars, a-z 0-9 and -, starting with a letter; not ' + RESERVED.join(', '));
    process.exit(2);
}
const dest = path.join(root, 'plugins', id);
if (fs.existsSync(dest)) { console.error(path.relative(root, dest) + ' already exists'); process.exit(1); }

const name = (given || id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ')).slice(0, 40);
const label = name.slice(0, 24);
fs.mkdirSync(dest, { recursive: true });
for (const f of ['manifest.json', 'index.js', 'README.md']) {
    const text = fs.readFileSync(path.join(root, 'template', f), 'utf8')
        .replace(/"id": "my-shard"/, '"id": "' + id + '"')
        .replace(/"name": "My Shard"/, '"name": ' + JSON.stringify(name))
        .replace(/"label": "My Shard"/, '"label": ' + JSON.stringify(label))
        .replace(/<h2>My Shard<\/h2>/, '<h2>' + name.replace(/[<>&]/g, '') + '</h2>')
        .replace(/^\/\/ My Shard:/m, '// ' + name + ':')
        .replace(/^# My Shard$/m, '# ' + name);
    fs.writeFileSync(path.join(dest, f), text);
}
console.log('Created plugins/' + id + '/\nNext: edit it, set "author" to your GitHub login, then run `node scripts/build.cjs`.\nGuide: docs/writing-a-plugin.md (writing a Shard)');
