# Vetro Shards

The Shard catalog for [Vetro](https://github.com/andrearicci93/vetro), the dashboard that runs on a Samsung TV.

**Vetro Shards** is Vetro's plugin system, and a **Shard** is one plugin: a small feature added to Vetro, such as a
page in the dashboard, a few HTTP routes or a timer that checks something. This repository holds the list the
dashboard shows under **Vetro Shards → Load plugin catalog**, the source of every Shard on it, and the tools to write a new one.

| Shard | What it does | Permissions | Author |
| --- | --- | --- | --- |
| [`shell`](plugins/shell) | A root shell on the TV, laid out like a terminal; one command at a time, `cd` remembered | `exec` | piecifra |
| [`tv-uptime`](plugins/tv-uptime) | How long the TV has been on | `exec` | andrearicci93 |
| [`youtube`](plugins/youtube) | **Ad-free YouTube**: Samsung's own YouTube with ads blocked, Shorts hidden and sponsors skipped (TizenTube + SponsorBlock), nothing installed on the TV | `exec` | andrearicci93 |

> **A Shard is code that runs inside Vetro on the TV, with the same access as Vetro, including running commands as
> root.** The `permissions` field is a label the author writes; Vetro does not enforce it. Every Shard here is read by
> a maintainer before it is merged, but that is a spot check, not an audit. Read
> [what a Shard can and cannot do](docs/what-a-plugin-can-do.md) before you install or write one.

## Names

Vetro 0.5.0 renamed the plugin system to Vetro Shards. Only the name shown to people changed. Everything a program
reads keeps its old name, so every Vetro version, 0.4.0 included, still works with this catalog and nothing had to move:

| New (what people read) | Unchanged (what programs read) |
| --- | --- |
| Vetro Shards, Shard, Shard catalog | this repository's name and URL (`vetro-plugins`) and the catalog URL, `index.json` |
| | the `plugins/<id>/` folders and `dist/<id>-<version>.vplugin` bundles |
| | `"format": "vetro-plugin-index"` and `"format": "vetro-plugin"`, and every field of `manifest.json` |
| | the routes on the TV (`/plugins/...`) and the tools (`vetro-plugin.cjs`) |

When a page of this repository says "plugin", it is talking about a technical name from the right-hand column.

## How it works

```
 this repository                  dashboard (your browser)                 the TV
 ───────────────                  ────────────────────────                 ──────
 catalog/index.json ─ reads ──▶ Vetro Shards → Load plugin catalog
 dist/x.vplugin ─ downloads ────▶ sends the bundle ─────────────────────▶ checks SHA-256 + catalog signature
                                                                          installs it, switched OFF
                                  you switch it on ─────────────────────▶ loads index.js, calls start()
                                  a tab appears (if it has a page) ◀───── serves /plugins/<id>/api/...
```

1. **A Shard is a folder of text files.** `manifest.json` says who it is, `index.js` is the code, `README.md` says
   what it does. No binaries, no `node_modules`, at most 20 files and 512 KB.
2. **It is packed into a `.vplugin` bundle.** A single JSON file with the manifest and the files inside.
   `scripts/build.cjs` makes it and writes its SHA-256 into `index.json`.
3. **The dashboard installs it on the TV.** The browser downloads the bundle and sends it to the TV, which checks the
   SHA-256 and catalog signature before installing anything. A Shard always lands **switched off**: its code is not even read until you
   switch it on.
4. **Once on, it is plain Node code in Vetro's process.** It gets four things (`ctx.id`, `ctx.dir`, `ctx.config`,
   `ctx.execute`) and can export `start`, `stop`, `status` and `route`. If it fails three times in a row, Vetro
   switches it off.

## What a Shard can do

- Show **one page** in the dashboard, as a tab that exists while the Shard is on.
- Serve its **own HTTP routes**, under `/plugins/<id>/api/...`.
- **Save its own settings** in one `config.json` that survives updates.
- Run **timers and sockets** while it is on, for example to poll something.
- Run **shell commands on the TV as root**, if it declares the `exec` permission.

## What a Shard cannot do

Through the API, a Shard cannot listen to the remote control, react to "TV turned on" or "app opened", add a launcher
tile, read or change Vetro's settings, use the MQTT / Home Assistant link, add a second page, or run while it is switched
off. It also cannot extend Vetro's own features (Remapper, Home Assistant, Quick settings): they are not Shards and the
host hands them nothing. The Launcher is the one feature that is a Shard (since 0.5.0), but it ships inside Vetro,
cannot be replaced or removed, and gets private services that no catalog Shard receives.

The full table, including what Vetro enforces and what it merely asks, is in
**[what a Shard can and cannot do](docs/what-a-plugin-can-do.md)**.

## Write a Shard

```
npm ci --ignore-scripts                  # install the pinned catalog tooling
node scripts/new.cjs my-shard "My Shard"     # copies template/ to plugins/my-shard/
# edit plugins/my-shard/
node scripts/build.cjs                       # checks it, packs it into dist/, updates index.json
```

Use Node 20 for catalog tooling; Shard code remains ES5 for older TVs. Test on a TV running Vetro 0.5.0 before submitting. Then open a pull
request with the source, `dist/` and `index.json`: CI fails if the Shard breaks a rule or if the generated files are
out of date.

| Read | When |
| --- | --- |
| [Writing a Shard](docs/writing-a-plugin.md) | step by step: template, manifest, code, build, test on a TV, publish |
| [What a Shard can and cannot do](docs/what-a-plugin-can-do.md) | the API, its limits, what Vetro enforces, what the catalog asks |
| [CONTRIBUTING.md](CONTRIBUTING.md) | what a pull request contains and what the maintainer checks |
| [SECURITY.md](SECURITY.md) | how to report a malicious or unsafe Shard |

The Shard API (called plugin API 1 in the code) is the same in Vetro 0.4.0 and 0.5.0, and is experimental. It may change.

## Repository layout

```
index.json                  what the dashboard reads (generated, do not edit)
dist/<id>-<version>.vplugin the bundle of each Shard (generated, do not edit)
plugins/<id>/               the source of each Shard: manifest.json, index.js, README.md
template/                   the starting point for a new Shard
scripts/new.cjs             creates plugins/<id>/ from template/
scripts/build.cjs           checks every Shard, packs dist/, writes index.json (--check is the CI test)
docs/                       the two guides above
```

## Trust

The SHA-256 in `index.json` catches a corrupted download. It is not proof of who wrote the code. A signature from the
catalog, when the catalog is signed, shows that a file is the one this catalog published, not that it is safe. Read the
source in `plugins/<id>/` before installing, and be wary of `exec`.

To report a Shard that is malicious or unsafe, see [SECURITY.md](SECURITY.md).

## Checks and signed publication

Run `npm ci --ignore-scripts`, `npm run build`, `npm test` and `npm run check`.
PRs require ES5-compatible source, up-to-date generated files, immutable published
versions and lifecycle smoke tests on Node 4.4.7, 12.4.0 and 20. A required aggregate
`check` covers all runtimes. Code-owner review is required for ordinary merges;
repository administrators retain their existing bypass. Smoke tests use fake TV
commands, do not establish firmware compatibility, and are not a security sandbox.

After a reviewed merge to `main`, the publisher runs those checks again and signs
only the matching bundle hashes. The private key is an environment secret available
only to the separate publication job on `main`; PR jobs cannot access it. Only
`index.json`, `dist/` and `catalog-public.pem` are pushed to the `catalog` branch.
The dashboard reads
`https://raw.githubusercontent.com/andrearicci93/vetro-plugins/catalog/index.json`.
Users install/enable/update Shards themselves; publication never pushes code to TVs.

The source index on `main` is a reproducible build input; contributors do not sign
it. Details, deployment setup and key rotation are in [publishing](docs/publishing.md).
