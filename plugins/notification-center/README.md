# Notification Center

> **This Shard needs a companion app on the TV.** The app (an unsigned `.wgt`, id `NotifCtr01.NotifCenter`, with a background service
> `NotifCtr01.Svc`) cannot be part of the catalog. Get it from https://github.com/mclaudiopt/tv-notification-center/releases, sign it with your own
> certificate and install it (see "Install"). Without it, `notify` queues messages but nothing is shown.

Any device on your LAN (PC, phone, script, another Shard, any ntfy client) can `POST` a message to this Shard. By default the TV shows it as a
**native Samsung banner on top of whatever is running, without opening any app** (the companion app's background service posts it, and it also lands
in the TV's own notification history). Optionally the message is shown as a **full-screen card**, which brings the companion app to the foreground for
a few seconds. Everything runs on the TV.

**API for other apps and Shards:** [API.md](API.md) documents every field, route, limit and example, and `GET /plugins/notification-center/api/api`
returns the same description as JSON. Apps that already publish to [ntfy](https://ntfy.sh) can point at `POST .../api/ntfy` instead (headers `Title`,
`Priority`, `Tags`).

**Sources and rules** (tab in the panel, and the routes `profiles`, `settings`, `hooks` in [API.md](API.md)): each sender can have its own defaults, on/off switch,
rate limit and key (`X-NC-Key`); quiet hours hold back everything below a chosen level; identical repeats are counted instead of shown again; and **webhooks**
(`POST hook/<name>`) turn any JSON, such as a GitHub or Home Assistant payload, into a notification with `{{path}}` templates.

The panel (tab **Notifications**) is bilingual (English by default, Portuguese optional) and has a form, a request generator, an API explorer, an icon
picker (emoji list bundled in `emoji.json`: Unicode CLDR data from [emojibase-data](https://github.com/milesj/emojibase), MIT, no network) and an
installation status card.

## Permissions

None. It does not use `exec`.

## Network

- **Incoming:** HTTP routes under `/plugins/notification-center/api/` (`notify`, `ntfy`, `notifications`, `img`, `recent`, `lang`, `emoji`, `status`,
  `api`, `ui`, `nt.js`), open to every device that can reach Vetro (with pairing on, senders need a key).
- **Outgoing, Vetro:** `POST 127.0.0.1:8099/apps/launch` with `{"appId": "..."}` to start the companion app or its service. The app id is fixed in the
  code, so no route can point the Shard at another app. Launches of the app screen are limited to one every 2 seconds; the banner service is launched for every notification in banner mode (limit a noisy sender with its per-minute rate in "Sources").
- **Outgoing, images:** no code is downloaded. The one exception is the optional `image` and `wallpaper` fields: the Shard fetches that URL once (GET, up
  to 3 redirects, at most 2 downloads at once, 10 s in total each, at most 3 MB, only png/jpeg/gif/webp/bmp, kept in memory while queued) and serves it to the app from its own address, because the
  app may only load origins it declares. Whoever can send notifications can therefore make the TV fetch an image URL, including one on your LAN (that is
  how a doorbell snapshot works).
- The companion app's service reads the queue from a file the Shard writes (`/tmp/notification-center-queue.json`), and falls back to the TV's own LAN
  address, port 8099. Nothing leaves the TV.

## Data it keeps

The display language and the list of the last 20 notifications sent (title, message, level, mode, icon, image and wallpaper URLs, time) are kept in
`ctx.config`, so "Recently sent" and Resend survive a restart. The queue (up to 5 active notifications) lives in memory and is cleared when the Shard stops.
The queue file and the file of already shown ids (`/tmp/notification-center-seen.json`) are temporary files in `/tmp`.

## Install

1. Vetro with root connected. If Vetro keeps restarting, set the TV's **Host PC IP to `127.0.0.1`** (Developer Mode), or it can end up in safe mode.
2. Install this Shard from the catalog and switch it on.
3. Install the companion app: download the unsigned `.wgt` from the releases linked above (or build it from the text files in [`app/`](app/) plus any
   512x512 `icon.png`), sign it with your own certificate and install it with Apps2Samsung, TV-Store or Tizen Studio. It needs the privileges
   `notification` and `internet`. The app id must stay `NotifCtr01.NotifCenter` and the service id `NotifCtr01.Svc`.
4. Send a notification:

```
curl -X POST http://<TV-IP>:8099/plugins/notification-center/api/notify \
  -H "Content-Type: application/json" \
  -d '{"title":"Oven","message":"Dinner is ready","level":"ok"}'
```

With **pairing on** (Vetro's default) a request from another device needs `Authorization: Bearer <key>`: pair the script once (the TV shows a 6-digit
code) as described in Vetro's `SIGN-IN.md`. The companion app on the TV itself needs no key.

If the app shows "nt.js failed" (loopback does not answer on some TVs), build it with the TV's LAN address too: add it to `BASES` in `app/js/app.js`
and `nt.js`, and a matching `<access origin="...">` to `config.xml`.

## How it works

```
mode "banner" (default, native banner over the running app, no app switch):
any device --POST notify--> Shard (queue + queue file) --POST /apps/launch--> Vetro starts the app's background SERVICE
service --reads queue--> webapis.postPlainNotification(title, message, seconds) --> TV banner + notification history

modes "full" / "both" (full-screen card; the companion app comes to the foreground):
any device --POST notify--> Shard (queue) --POST /apps/launch--> Vetro launches the companion app
app --GET notifications--> Shard --> card on screen (+ native banner for "both") --> exits after `duration`
```

The full-screen app is a thin loader: its logic is `nt.js`, served by this Shard, so it can change without reinstalling the app. The background service is
self-contained.

## Compatibility

- **Vetro / Node:** the Shard is plain ES5 and uses only Node 4.4 APIs (request timeouts are set with `setTimeout`, because the `timeout` option only exists
  from Node 6.8). It was checked with an ES5-only parser, and the runtime lifecycle test (`npm run test:runtime`) plus a request/queue/icon test pass on a **real
  Node 4.9.1** (the last 4.x release). The Node 4.4.7 binary itself crashes at start on the Windows 11 machine used for the work, so 4.4.7 exactly has not been run.
- **Samsung TVs:** the app declares `required_version="6.0"`, so it needs **Tizen 6.0 or newer (2021 models and later)**. Everything was tested on one TV
  only: **Samsung Q70C, Tizen 9.0, Vetro 0.7.0**. Older TVs and Smart Monitors have not been tried.

## Limitations (all measured on a real TV)

- The native banner (`webapis.postPlainNotification`, which exists only inside a web *service*) takes plain text and a duration: **no icon, level or colour**.
  The Shard puts an emoji in front of the title instead (by level, or the icon you choose).
- Full-screen card / both: the companion app comes to the front, shows the card for `duration` seconds and exits, so what was playing is interrupted briefly.
  These modes still read the Shard over the network, so they need Vetro pairing off (or a TV where loopback answers). Banner mode works with pairing on.
- The service cannot reach Vetro over loopback on the TV tested (`EHOSTUNREACH`), which is why the queue is handed over as a file.
- The TV refuses to run unsigned script files; this Shard needs none.
- Native notification routes other than the web service (`notification_test`, `libnotification` sockets, D-Bus, writing the notification database) were dead
  ends; see the repository's `docs/NATIVE-NOTIFICATIONS.md`.
- Whether the previous screen returns cleanly was tested only from the launcher, not over every source (live TV, HDMI).
- With pairing off, any device that can reach Vetro's port can send notifications and make Vetro launch the companion app.

## Tested on

Samsung Q70C (TQ55Q70CATXXC), Tizen 9.0, Vetro 0.7.0, Shard 0.2.0 installed from the bundle as a file (Developer mode), companion app 0.2.2.

- **Pairing off:** notifications sent with `curl` from a PC: native banner (`banner`), full-screen card (`full`) and both; English and Portuguese; the four
  levels with their icons; `duration`; Resend from "Recently sent"; the TV returned to the previous app each time.
- **Pairing on (Vetro 0.7.0 "Require pairing"):** banner mode tested (a notification sent with a Bearer key appeared as a native banner over the running
  app; an unpaired request got `401`). Full-screen modes not tested with pairing on.
- **Not tested:** live TV and HDMI as the "previous screen", other TV models, other Tizen versions.

Changes are listed in [CHANGELOG.md](CHANGELOG.md).
