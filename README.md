# Vetro plugins

The plugin list for [Vetro](https://github.com/andrearicci93/vetro), the dashboard that runs on a Samsung TV.

A plugin adds a small feature to Vetro: a page in the dashboard, a few HTTP routes, a timer that checks something.
This repository holds the list the dashboard shows under **Plugins → Show available plugins**, the source of every
plugin on it, and the tools to write a new one.

| Plugin | What it does | Permissions | Author |
| --- | --- | --- | --- |
| [`tv-uptime`](plugins/tv-uptime) | How long the TV has been on | `exec` | andrearicci93 |

> **A plugin is code that runs inside Vetro on the TV, with the same access as Vetro, including running commands as
> root.** The `permissions` field is a label the author writes; Vetro does not enforce it. Every plugin here is read by
> a maintainer before it is merged, but that is a spot check, not an audit. Read
> [what a plugin can and cannot do](docs/what-a-plugin-can-do.md) before you install or write one.

## How it works

```
 this repository                  dashboard (your browser)                 the TV
 ───────────────                  ────────────────────────                 ──────
 index.json  ──── reads list ───▶ Plugins → Show available plugins
 dist/x.vplugin ─ downloads ────▶ sends the bundle ─────────────────────▶ checks the SHA-256 from index.json
                                                                          installs it, switched OFF
                                  you switch it on ─────────────────────▶ loads index.js, calls start()
                                  a tab appears (if it has a page) ◀───── serves /plugins/<id>/api/...
```

1. **A plugin is a folder of text files.** `manifest.json` says who it is, `index.js` is the code, `README.md` says
   what it does. No binaries, no `node_modules`, at most 20 files and 512 KB.
2. **It is packed into a `.vplugin` bundle.** A single JSON file with the manifest and the files inside.
   `scripts/build.cjs` makes it and writes its SHA-256 into `index.json`.
3. **The dashboard installs it on the TV.** The browser downloads the bundle and sends it to the TV, which checks the
   SHA-256 before installing anything. A plugin always lands **switched off**: its code is not even read until you
   switch it on.
4. **Once on, it is plain Node code in Vetro's process.** It gets four things (`ctx.id`, `ctx.dir`, `ctx.config`,
   `ctx.execute`) and can export `start`, `stop`, `status` and `route`. If it fails three times in a row, Vetro
   switches it off.

## What a plugin can do

- Show **one page** in the dashboard, as a tab that exists while the plugin is on.
- Serve its **own HTTP routes**, under `/plugins/<id>/api/...`.
- **Save its own settings** in one `config.json` that survives updates.
- Run **timers and sockets** while it is on, for example to poll something.
- Run **shell commands on the TV as root**, if it declares the `exec` permission.

## What a plugin cannot do

Through the API, a plugin cannot listen to the remote control, react to "TV turned on" or "app opened", add a launcher
tile, read or change Vetro's settings, use the MQTT / Home Assistant link, add a second page, or run while it is switched
off. It also cannot extend Vetro's own features (Remapper, Launcher, Home Assistant, Quick settings): they are not
plugins and the host hands them nothing.

The full table, including what Vetro enforces and what it merely asks, is in
**[what a plugin can and cannot do](docs/what-a-plugin-can-do.md)**.

## Write a plugin

```
node scripts/new.cjs my-plugin "My plugin"   # copies template/ to plugins/my-plugin/
# edit plugins/my-plugin/
node scripts/build.cjs                       # checks it, packs it into dist/, updates index.json
```

You need Node (any recent version) and a TV or dashboard running Vetro 0.4.0 to try it on. Then open a pull
request with the source, `dist/` and `index.json`: CI fails if the plugin breaks a rule or if the generated files are
out of date.

| Read | When |
| --- | --- |
| [Writing a plugin](docs/writing-a-plugin.md) | step by step: template, manifest, code, build, test on a TV, publish |
| [What a plugin can and cannot do](docs/what-a-plugin-can-do.md) | the API, its limits, what Vetro enforces, what the list asks |
| [CONTRIBUTING.md](CONTRIBUTING.md) | what a pull request contains and what the maintainer checks |
| [SECURITY.md](SECURITY.md) | how to report a malicious or unsafe plugin |

The plugin API is part of Vetro 0.4.0 and is experimental (API 1). It may change.

## Repository layout

```
index.json                  what the dashboard reads (generated, do not edit)
dist/<id>-<version>.vplugin the bundle of each plugin (generated, do not edit)
plugins/<id>/               the source of each plugin: manifest.json, index.js, README.md
template/                   the starting point for a new plugin
scripts/new.cjs             creates plugins/<id>/ from template/
scripts/build.cjs           checks every plugin, packs dist/, writes index.json (--check is the CI test)
docs/                       the two guides above
```

## Trust

The SHA-256 in `index.json` catches a corrupted download. It is not proof of who wrote the code. A signature from the
list, when the list is signed, shows that a file is the one this list published, not that it is safe. Read the source in
`plugins/<id>/` before installing, and be wary of `exec`.

To report a plugin that is malicious or unsafe, see [SECURITY.md](SECURITY.md).
