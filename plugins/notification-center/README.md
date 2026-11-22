# Notification Center

> **This Shard does nothing on its own: it needs the companion app on the TV.** The app (an unsigned `.wgt`, id `NotifCtr01.NotifCenter`, with a
> background service `NotifCtr01.Svc`) is not part of the catalog. Get it from https://github.com/mclaudiopt/tv-notification-center/releases, sign it
> with your own certificate and install it (see "Install the companion app" below). Without it, `notify` queues messages but nothing is shown.

Any device on your LAN (PC, phone, script) can `POST` a message to this Shard. By default the TV shows it as a **native Samsung banner**
(top-right, with the OK / "View history" buttons, kept in the TV's own notification history) **on top of whatever is running, without opening
any app**: the companion app's background service posts it. Optionally the message can also (or only) be shown as a **full-screen card**, which
does bring the companion app to the foreground for a few seconds. Everything runs on the TV, no PC is needed afterwards.

> **Status: early.** It works end to end on one TV (see "Tested on"). Read "Limitations" before installing.

The panel (tab **Notifications**) and the app screen are bilingual (English by default, Portuguese optional: use the EN/PT switch in the panel, or `POST .../api/lang` with `{"lang":"pt"}`) and use a One UI style look. The banner itself is always the TV's own native one.

The icon can be picked from the panel (button "Choose icon"): an emoji list with search in English and Portuguese, bundled with the Shard
(`emoji.json`, Unicode CLDR data from [emojibase-data](https://github.com/milesj/emojibase) 18.0.0, MIT; emoji up to Unicode 13, no network needed).

### Other apps: ntfy-compatible route

Apps and scripts that already publish to [ntfy](https://ntfy.sh) can point at `POST /plugins/notification-center/api/ntfy` instead: the message is the request body
(or JSON `{"message","title","priority","tags"}`), with the headers `Title`, `Priority` (5 = alert, 4 = warning) and `Tags` (`warning`, `rotating_light`, `white_check_mark`,
`tada`, `fire`, `soccer`, `bell`, `house`, `package`, `sunny`... become the icon and level):

```
curl -X POST http://<TV-IP>:8099/plugins/notification-center/api/ntfy -H "Title: Oven" -H "Priority: 4" -H "Tags: tada" -d "Dinner is ready"
```

## API for other apps and Shards

Everything above can be sent from any source (another Shard, a PC, Home Assistant, a script, any ntfy client). **[API.md](API.md)** documents every field, route, limit and
example, and `GET /plugins/notification-center/api/api` returns the same description as JSON. New features are always added to the code, that description and `API.md` together.

## Permissions

None. It does not use `exec`.

## Network

- **Incoming:** HTTP routes under `/plugins/notification-center/api/` (`notify`, `ntfy`, `notifications`, `img`, `recent`, `lang`, `emoji`, `ui`, `nt.js`),
  open to every device that can reach Vetro, like the rest of Vetro when pairing is off.
- **Outgoing:** one call, to Vetro itself on `127.0.0.1:8099` (`POST /apps/launch`, body `{"appId": "..."}`), to start the companion app or its service.
  The app screen is launched when a `full` or `both` notification is queued and the app is not already open (the app announces itself every 2 s while it is open and says goodbye when it leaves), never more than once every 2 seconds; a notification queued while it is open is simply picked up, and its stay is extended. It downloads no code. **The one exception is the optional `image` and `wallpaper` fields:** when a sender gives an image URL, the Shard fetches that URL once (HTTP or HTTPS GET, up to 3 redirects,
  8 s, at most 3 MB, only png/jpeg/gif/webp/bmp, kept in memory while the notification is queued) and serves it to the app from its own address, because the app may only load origins
  it declares. Whoever can send notifications can therefore make the TV fetch an image URL, including one on your LAN (that is how a doorbell snapshot works); with pairing on, they need a key.
- The companion app's service reads this Shard on the TV's own LAN address, port 8099 (`GET notifications`). Nothing leaves the TV.

## Data it keeps

The display language (`lang`, `en` or `pt`) and the last-20 list (`recent`) are kept in `ctx.config`. The id of the companion app is fixed in the code (`NotifCtr01.NotifCenter`), so no route can point the Shard at another app.
The queue (up to 5 active notifications) is kept in memory and cleared when the Shard stops. The list of the **last 20 sent** (title, message, level, mode, icon, image and wallpaper URLs, time) is kept in `ctx.config`, so "Recently sent" and Resend survive a restart or an update; nothing else about a message is stored.

## How it works

```
mode "banner" (default, native banner over the running app, no app switch):
any device --POST notify--> Shard (queue) --POST /apps/launch--> Vetro starts the app's background SERVICE (headless)
service --GET notifications--> Shard --> webapis.postPlainNotification(title, message, seconds) --> TV banner + notification history

modes "full" / "both" (full-screen card; the companion app comes to the foreground):
any device --POST notify--> Shard (queue) --POST /apps/launch--> Vetro launches the companion app
app --GET notifications--> Shard --> card on screen (+ new Notification(...) native banner for "both") --> exits after `duration`
```

The full-screen app is a **thin loader**: its logic is `nt.js`, served by this Shard, so you can change it from the Vetro panel without
reinstalling the app. The background service is self-contained (it downloads no code).

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

Fields: `message` (required, 200 characters), `title` (40), `level` (`info`, `ok`, `warn`, `alert`; colours the card on the app screen and the panel, default `info`), `duration` (1-60, default 8: seconds the notification stays on the TV screen before the app returns to the previous one; very short values may cut the native banner short), `icon` (an emoji, up to 8 characters: in front of the title on the native banner and in the card; default by level: ℹ️ ✅ ⚠️ 🔴), `image` (an http/https URL, up to 290 characters: a picture under the message on the full-screen card) and `wallpaper` (the same kind of URL, shown as a darkened full-screen background behind the card; use both together if you like; the native banner has neither), `mode` (`banner` default, `banner` = native Samsung banner only, `full` = full-screen card only), `seconds` (5-300, how long it waits in the queue), `open`
(`false` only queues it, without launching the app). The page of this Shard (tab **Notifications**) has a form for it.

## Install the companion app (required)

Download the unsigned `.wgt` from the releases of https://github.com/mclaudiopt/tv-notification-center, or build it from the four files below (also in `app/`) plus any 512x512 `icon.png`.
Sign it with your own certificate and install it with Apps2Samsung, TV-Store or Tizen Studio. The app id must stay `NotifCtr01.NotifCenter` and the service id `NotifCtr01.Svc`.

### Source (copy these four files)

`config.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="http://localhost/notifcenter" version="0.2.2" viewmodes="maximized">
  <tizen:application id="NotifCtr01.NotifCenter" package="NotifCtr01" required_version="6.0"/>
  <name>Notification Center</name>
  <icon src="icon.png"/>
  <content src="index.html"/>
  <access origin="http://127.0.0.1:8099" subdomains="false"/>
  <feature name="http://tizen.org/feature/screen.size.all"/>
  <tizen:privilege name="http://tizen.org/privilege/internet"/>
  <tizen:privilege name="http://tizen.org/privilege/notification"/>
  <tizen:profile name="tv-samsung"/>
  <tizen:service id="NotifCtr01.Svc" auto-restart="false" on-boot="false">
    <tizen:content src="service.js"/>
    <tizen:name>Notification Center service</tizen:name>
    <tizen:icon src="icon.png"/>
    <tizen:description>Shows the Samsung notification banner without opening an app</tizen:description>
  </tizen:service>
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

`service.js` (the background service)

```js
// Background service of the Notification Center companion app (Node.js in the TV's web service runtime).
// Vetro starts it (POST /apps/launch) each time a notification is queued in "banner" mode; it posts the native Samsung banner with
// webapis.postPlainNotification, without opening any app.
// It reads the queue from a file the Shard writes (no network, no Vetro key: it works with pairing on). If that file is missing it asks the
// Shard over the network, on the TV's own LAN address (loopback is not reachable from the service on every TV).
// The ids it has already shown are kept in a file of its own, so a restarted service never shows the same banner twice.
var QUEUE_FILE = '/tmp/notification-center-queue.json';
var SEEN_FILE = '/tmp/notification-center-seen.json';
var HOSTS = ['127.0.0.1'];
try {
  var ifs = require('os').networkInterfaces();
  Object.keys(ifs).forEach(function (k) { ifs[k].forEach(function (i) { if (i.family === 'IPv4' && !i.internal && HOSTS.indexOf(i.address) < 0) { HOSTS.push(i.address); } }); });
} catch (e) { /* keep loopback only */ }
var PATH = '/plugins/notification-center/api/notifications';
var EMOJI = { info: '\u2139\uFE0F', ok: '\u2705', warn: '\u26A0\uFE0F', alert: '\uD83D\uDD34' };
var seen = {};
try { seen = JSON.parse(require('fs').readFileSync(SEEN_FILE, 'utf8')) || {}; } catch (e) { seen = {}; }

function saveSeen() {
  try {
    var keys = Object.keys(seen);
    if (keys.length > 60) { keys.slice(0, keys.length - 60).forEach(function (k) { delete seen[k]; }); }
    require('fs').writeFileSync(SEEN_FILE, JSON.stringify(seen));
  } catch (e) { /* not writable: duplicates are possible only if the service restarts while a notification is still queued */ }
}
function show(n) {
  // The native banner takes plain text only, but it draws emoji: the icon (or the level's emoji) goes in front of the title.
  var head = n.icon || EMOJI[n.level] || '';
  var title = (head ? head + ' ' : '') + (n.title || 'Notification');
  try { webapis.postPlainNotification(title, n.message || '', parseInt(n.duration, 10) || 8); } catch (e) { /* API not available */ }
}
function handle(list) {
  var changed = false;
  list.forEach(function (n) {
    if (seen[n.id]) { return; }
    seen[n.id] = 1; changed = true;
    if (n.mode !== 'banner') { return; }                          // "full" and "both" are shown by the companion app screen
    if (n.expires && n.expires < Date.now()) { return; }          // too old to be worth showing
    show(n);
  });
  if (changed) { saveSeen(); }
}
function fromNetwork() {
  var i = 0;
  (function next() {
    if (i >= HOSTS.length) { return; }
    fetch('http://' + HOSTS[i++] + ':8099' + PATH + '?t=' + Date.now()).then(function (r) { if (!r.ok) { throw new Error('http ' + r.status); } return r.json(); }).then(function (d) {
      handle(d.notifications || []);
    }).catch(function () { next(); });
  })();
}
function check() {
  var d = null;
  try { d = JSON.parse(require('fs').readFileSync(QUEUE_FILE, 'utf8')); } catch (e) { d = null; }
  if (d && Array.isArray(d.notifications)) { handle(d.notifications); } else { fromNetwork(); }
}
module.exports.onStart = check;
module.exports.onRequest = check;
module.exports.onStop = function () {};
```

These files are also in the `app/` folder next to this README. A ready-made, **unsigned** `.wgt` (with an icon) is attached to
the releases of https://github.com/mclaudiopt/tv-notification-center (a catalog Shard can only hold text files, so the `.wgt` and its icon are not here).
Add any 512x512 `icon.png`, zip the files as `.wgt`, sign it and install it (Apps2Samsung, TV-Store, Tizen Studio).
`nt.js` also tries the address it was loaded from. If the app shows "nt.js failed" (loopback does not answer on some TVs), build the app with the TV's LAN address too:
add the TV's own LAN address to `BASES` in `js/app.js` and `nt.js`, and a matching `<access origin="...">` to `config.xml`.

## Limitations (all measured on a real TV)

- **Banner mode** uses Samsung's `webapis.postPlainNotification(title, message, seconds)`, which exists only inside a web *service* (a background
  `<tizen:service>` of the app, Node.js 18 in `wrt-service-launcher`). It takes plain text and a duration: **no icon, level or colour** on the native
  banner (the level only colours the panel and the full-screen card).
- **Full-screen card / both**: the web `Notification` API only works while the web app is on screen, so the companion app comes to the front, shows
  the card for `duration` seconds and exits; what was playing is interrupted briefly. `tizen.notification` does not exist in the app (UI) context.
- **Pairing on:** banner mode does not depend on a Vetro key: the Shard writes the queue to `/tmp/notification-center-queue.json` and the service reads it from the file (it falls back to the network only if the file is missing). The service keeps the ids it has shown in `/tmp/notification-center-seen.json`, so a restarted service never repeats a banner. The full-screen app (modes `full` and `both`) still reads the Shard over the network and needs Vetro pairing off, or a TV where loopback answers.
- The service reaches the Shard through the TV's own LAN address (loopback is not reachable from the service on the TV I tested, `EHOSTUNREACH`).
- Plain `notification_test`, `libnotification` sockets, D-Bus and writing the notification database were all dead ends (see the repository's `docs/NATIVE-NOTIFICATIONS.md`).
- The TV refuses to run **unsigned script files** ("the file is NOT signed"); inline commands through Vetro still work. This Shard needs neither.
- Whether the previous screen comes back cleanly after the app exits was tested only from the launcher, not yet over
  every kind of source (live TV, HDMI).
- With pairing off, any device that can reach Vetro's port can send notifications and make Vetro launch the companion app (at most once every 2 s); with pairing on, senders need a key (see above).

## Tested on

Samsung Q70C (TQ55Q70CATXXC), Tizen 9.0, Vetro 0.6.9, Shard 0.1.0 installed from the bundle as a file (Developer mode), with the companion
app `NotifCtr01.NotifCenter` 0.1.0 installed on the TV.

**Pairing off (Vetro's "Disable pairing mode" on): tested on the TV.** Notifications sent with `curl` from a PC on the LAN: native banner top-right
(`mode: banner`), full-screen card (`mode: full`) and both (`mode: both`); English and Portuguese (`lang`); the four levels (`info`, `ok`, `warn`,
`alert`) with their icons; `duration` (a 3 s card stayed 3 s); Resend from "Recently sent" in the panel; the app's loader falling back to the
address nt.js was loaded from. The TV returned to the previous app after each notification.

**Pairing on (Vetro 0.7.0 "Require pairing" on): banner mode tested on the TV.** After pairing a script with the 6-digit code, a notification sent with `Authorization: Bearer <key>` appeared as a native banner over the running app: the Shard wrote the queue to `/tmp/notification-center-queue.json` and the service read it from the file, with no network and no key. An unpaired request got `401`. **Not tested with pairing on:** the full-screen modes (`full`, `both`), because the app screen still reads the Shard over the network.

Not tested: live TV and HDMI sources as the "previous screen", other TV models, other Tizen versions.
