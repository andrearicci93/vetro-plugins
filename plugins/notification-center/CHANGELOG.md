# Changelog

## 0.2.0
- **Banner over the running app, no app switch** (default mode `banner`): the companion app's background service posts the native Samsung banner. Works with Vetro pairing on (the queue is handed over in a file).
- Modes `banner`, `full` (full-screen card) and `both`; `duration` 1-60 s with a countdown; levels `info`, `ok`, `warn`, `alert`.
- Emoji icons: by level or picked in the panel from a bundled Unicode list; the icon is cut at whole emoji only.
- `image` and `wallpaper` on the full-screen card (fetched and served by the Shard).
- ntfy-compatible route (`POST ntfy`) and a documented API: `API.md`, `GET api` (self-description), `GET status`.
- Panel: three columns with a live preview, request generator, API explorer, installation status, English and Portuguese, recently sent list kept across restarts with Resend.
- The full-screen app is relaunched as soon as it has left; a notification queued while it is open extends its stay; a restarted banner service never repeats a banner.
- Node 4 compatibility: explicit request timeouts.

## 0.1.0
- First version: queue notifications over HTTP and show them as the native banner through a companion app that comes to the foreground.
