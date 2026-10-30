# Vetro plugins

Plugin list for [Vetro](https://github.com/andrearicci93/vetro). The Vetro dashboard reads
[`index.json`](index.json) from this repository (Plugins → Show available plugins), downloads the
bundle in the browser and sends it to the TV, which checks the SHA-256 listed here before installing.
Plugins land switched off.

| Plugin | What it does | Permissions | Author |
| --- | --- | --- | --- |
| `tv-uptime` | How long the TV has been on | `exec` | andrearicci93 |

## Add a plugin

1. Write it (`node scripts/vetro-plugin.cjs new my-plugin` in the Vetro repo; see `app/docs/plugins.md`
   there) and put the folder in `plugins/<id>/`.
2. Run `node scripts/build.cjs`. It writes `dist/<id>-<version>.vplugin` and updates `index.json`.
3. Open a pull request with the source, `dist/` and `index.json`. CI fails if they are out of date.

See [CONTRIBUTING.md](CONTRIBUTING.md) for what is checked before a plugin is merged.

## Trust

A plugin is code running on the TV with the same access as Vetro. Entries are read by a maintainer
before they are merged, but that is a spot check, not an audit, and gives no guarantee. The SHA-256 in
`index.json` catches a corrupted download; it is not a signature and does not prove who wrote the code.
Read the source in `plugins/<id>/` before installing, and be wary of `exec`.

To report a plugin that is malicious or unsafe, see [SECURITY.md](SECURITY.md).
