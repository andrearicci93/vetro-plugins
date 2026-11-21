# Notification Center

> **This Shard does nothing on its own: it needs the companion web app on the TV.** The app (an unsigned `.wgt`, id `NotifCtr01.NotifCenter`)
> is not part of the catalog. Get it from https://github.com/mclaudiopt/tv-notification-center/releases, sign it with your own certificate and
> install it (see "Install the companion app" below). Without it, `notify` queues messages but nothing is shown.

Any device on your LAN (PC, phone, script) can `POST` a message to this Shard. It queues the message, asks Vetro to
launch the companion app, and the app shows it as a **native Samsung TV banner** (top-right, with the OK /
"View history" buttons, kept in the TV's own notification history). Everything runs on the TV, no PC is needed afterwards.

> **Status: early.** It works end to end on one TV (see "Tested on"), but it is **not** a banner on top of the running
> app: the companion app has to come to the foreground for a few seconds. Read "Limitations" before installing.

The panel (tab **Notifications**) and the app screen are bilingual (English by default, Portuguese optional: use the EN/PT switch in the panel, or `POST .../api/lang` with `{"lang":"pt"}`) and use a One UI style look. The banner itself is always the TV's own native one.

## Permissions

None. It does not use `exec`.

## Network

- **Incoming:** HTTP routes under `/plugins/notification-center/api/` (`notify`, `notifications`, `recent`, `ui`, `nt.js`),
  open to every device that can reach Vetro, like the rest of Vetro when pairing is off.
- **Outgoing:** one call, to Vetro itself on `127.0.0.1:8099` (`POST /apps/launch`, body `{"appId": "..."}`), to start the companion app. At most once every 10 seconds.
  It talks to no other host and downloads no code.

## Data it keeps

Only the display language (`lang`, `en` or `pt`) is kept in `ctx.config`. The id of the companion app is fixed in the code (`NotifCtr01.NotifCenter`), so no route can point the Shard at another app.
The queue (up to 5 active notifications) and the list of the last 20 sent are kept in memory only and are cleared when the Shard stops.

## How it works

```
any device --POST notify--> Shard (queue) --POST /apps/launch--> Vetro launches the companion app
companion app --GET notifications--> Shard      (XHR, or <script> if the TV blocks cross-origin XHR)
companion app --new Notification(title, {body})--> TV banner + TV notification history
companion app stays open ~8 s (it must be on screen for the banner to show), then exits
```

The companion app is a **thin loader**: its logic is `nt.js`, served by this Shard, so you can change the logic from the
Vetro panel without reinstalling the app on the TV.

## Install

1. Vetro with root connected. If Vetro keeps restarting, set the TV's **Host PC IP to `127.0.0.1`** (Developer Mode); otherwise
   it can end up in safe mode ("Resume plugins", then restart Vetro).
2. Install this Shard from the catalog and switch it on.
3. Build and install the companion app (below) with your own certificate. It needs the privileges `notification` and `internet`.
4. Send a notification:

```
curl -X POST http://<TV-IP>:8099/plugins/notification-center/api/notify \
  -H "Content-Type: application/json" \
  -d '{"title":"Oven","message":"Dinner is ready","seconds":30}'
```

**With pairing on (Vetro's default)** a request from another device goes through Vetro's sign-in like every other route, so a script on the LAN needs
`Authorization: Bearer <key>`. Pair the script once (the TV shows a 6-digit code), as described in Vetro's `SIGN-IN.md`:

```
curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"scripts"}' http://<TV-IP>:8099/auth/pair
curl -s -X POST -H 'Content-Type: application/json' -d '{"id":"<id>","code":"<code>"}' http://<TV-IP>:8099/auth/confirm   # returns the token
curl -X POST http://<TV-IP>:8099/plugins/notification-center/api/notify -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"message":"Dinner is ready"}'
```

The companion app on the TV itself (127.0.0.1) needs no key. With pairing off (Vetro's "Disable pairing mode") any device on the LAN can send notifications.

Fields: `message` (required, 200 characters), `title` (40), `level` (`info`, `ok`, `warn`, `alert`; colours the card on the app screen and the panel, default `info`), `duration` (2-60, default 8: seconds the notification stays on the TV screen before the app returns to the previous one; at least 5 when a native banner is shown), `mode` (`both` default, `banner` = native Samsung banner only, `full` = full-screen card only), `seconds` (5-300, how long it waits in the queue), `open`
(`false` only queues it, without launching the app). The page of this Shard (tab **Notifications**) has a form for it.

## Install the companion app (required)

Download the unsigned `.wgt` from the releases of https://github.com/mclaudiopt/tv-notification-center, or build it from the three files below (also in `app/`).
Sign it with your own certificate and install it with Apps2Samsung, TV-Store or Tizen Studio. The app id must stay `NotifCtr01.NotifCenter`.

### Source (copy these three files)

`config.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="http://localhost/notifcenter" version="0.1.0" viewmodes="maximized">
  <tizen:application id="NotifCtr01.NotifCenter" package="NotifCtr01" required_version="6.0"/>
  <name>Notification Center</name>
  <icon src="icon.png"/>
  <content src="index.html"/>
  <access origin="http://127.0.0.1:8099" subdomains="false"/>
  <feature name="http://tizen.org/feature/screen.size.all"/>
  <tizen:privilege name="http://tizen.org/privilege/internet"/>
  <tizen:privilege name="http://tizen.org/privilege/notification"/>
  <tizen:profile name="tv-samsung"/>
</widget>
```

`index.html`

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Notification Center</title></head>
<body style="background:#0f1218;color:#e8ecf2;font:28px sans-serif;margin:40px">
<div id="log"></div>
<script src="js/app.js"></script>
</body></html>
```

`js/app.js` (the loader)

```js
(function () {
  "use strict";
  var BASES = ["http://127.0.0.1:8099"];
  var PATH = "/plugins/notification-center/api/nt.js";
  var logEl = document.getElementById("log"), i = 0;
  function say(t) { var d = document.createElement("div"); d.textContent = t; logEl.appendChild(d); }
  (function next() {
    if (i >= BASES.length) { say("Could not load nt.js from the Shard. Is it running?"); return; }
    var s = document.createElement("script");
    s.src = BASES[i++] + PATH + "?t=" + new Date().getTime();
    s.onerror = function () { say("nt.js failed: " + s.src.split("?")[0]); next(); };
    (document.head || document.documentElement).appendChild(s);
  })();
})();
```

These three files are also in the `app/` folder next to this README. A ready-made, **unsigned** `.wgt` (with an icon) is attached to
the releases of https://github.com/mclaudiopt/tv-notification-center (a catalog Shard can only hold text files, so the `.wgt` and its icon are not here).
Add any 512x512 `icon.png`, zip the files as `.wgt`, sign it and install it (Apps2Samsung, TV-Store, Tizen Studio).
`nt.js` also tries the address it was loaded from. If the app shows "nt.js failed" (loopback does not answer on some TVs), build the app with the TV's LAN address too:
add the TV's own LAN address to `BASES` in `js/app.js` and `nt.js`, and a matching `<access origin="...">` to `config.xml`.

## Limitations (all measured on a real TV)

- **The app must be in the foreground to post.** The web `Notification` API only works while the web app is on screen
  (a background web app is suspended and its timers stop). So the companion app comes to the front, posts, stays ~8 s
  (leaving earlier hides the banner), and exits. You will see it for a moment, and what was playing is interrupted briefly.
- `tizen.notification` / `StatusNotification` **do not exist** on the TV profile; only the web `Notification` API works.
- **No banner over the running app without launching an app.** I checked that it is not possible from a Shard or a shell:
  the TV's `libnotification` uses its own sockets (nothing about notifications on the system D-Bus), there is no
  `notification_test`, and writing to `/opt/dbspace/.notification.db` does not notify the UI. The realistic way is a small
  background **`service-application`** (native or .NET) with the `notification` privilege calling `NotificationManager.Post`.
  Nobody has built it here (no Tizen Studio / .NET SDK); **help wanted**.
- The TV refuses to run **unsigned script files** ("the file is NOT signed"); inline commands through Vetro still work. This Shard needs neither.
- Whether the previous screen comes back cleanly after the app exits was tested only from the launcher, not yet over
  every kind of source (live TV, HDMI).
- With pairing off, any device that can reach Vetro's port can send notifications and make Vetro launch the companion app (at most once every 10 s); with pairing on, senders need a key (see above).

## Tested on

Samsung Q70C (TQ55Q70CATXXC), Tizen 9.0, Vetro 0.5.0. The flow (queue, launch, banner top-right, entry in the notification
history, app exits) was tested with an earlier version of this Shard that lived inside another one; this standalone
version keeps the same logic and was checked on the TV for its HTTP routes and page.
