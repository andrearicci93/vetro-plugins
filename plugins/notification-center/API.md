# Notification Center API

Everything the Notification Center can show on the TV can be sent as an HTTP request, from **any source**: another Shard on the same TV, a PC, a phone, a script,
Home Assistant, a NAS, a doorbell, or any app that can publish to [ntfy](https://ntfy.sh). The panel is only one more client of this API.

The same description is available from the Shard itself: `GET /plugins/notification-center/api/api` returns the fields, enums, limits and routes as JSON, built from the code that
validates the requests. Use it to discover what a given TV supports.

> **Rule for contributors.** A new field, mode or route is added in four places together: the code (`index.js`, plus `nt.js` / `svc` if it changes what is shown), the
> self-description (`describe()` in `index.js`), this file, and the panel (`ui.html`). Fields are only ever added, never renamed or removed, so existing senders keep working.

## Where to send

| From | Address |
|---|---|
| Another Shard on the same TV | `http://127.0.0.1:8099/plugins/notification-center/api/<route>` (no key needed) |
| Any device on the LAN | `http://<TV-IP>:8099/plugins/notification-center/api/<route>` |

With Vetro pairing **off** no key is needed. With pairing **on**, devices other than the TV itself send `Authorization: Bearer <key>` (pair once with `POST /auth/pair`, then
`POST /auth/confirm` with the 6-digit code shown on the TV, as in Vetro's `SIGN-IN.md`).

## Send a notification: `POST notify`

JSON body. Only `message` is required.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `message` | string, max 200 | required | The text. |
| `title` | string, max 40 | empty | Bold line above the message. |
| `level` | `info` `ok` `warn` `alert` | `info` | Colours the card and the panel; the native banner gets the level's emoji. |
| `mode` | `banner` `full` `both` | `banner` | `banner`: the native Samsung banner over whatever is running, no app switch. `full`: a full-screen card (the companion app comes to the front). `both`: card and banner. |
| `duration` | integer 1-60 | `8` | Seconds on screen. |
| `icon` | string, max 16 | by level | One emoji (or emoji sequence) in front of the title, e.g. the ball for a goal. Cut at whole emoji only. |
| `image` | http/https URL, max 290 | none | A picture under the message on the **full-screen card**. |
| `wallpaper` | http/https URL, max 290 | none | A darkened full-screen background behind the card. Can be combined with `image`. |
| `seconds` | integer 5-300 | `30` | How long it may wait in the queue (always at least `duration` + 20). |
| `open` | boolean | `true` | `false` only queues it, without launching the app or its service. |
| `source` | string, max 32 (`a-z 0-9 . _ -`) | none | Who is sending (or the header `X-NC-Source`). If a source with that name exists, its defaults, key, on/off switch and rate limit apply, see "Sources". |

Answer: `{"ok":true,"id":"1-abc","open":"requested"}`. Errors: `400 {"error":"message is required"}` or `"invalid JSON"`; `403` (`invalid key for this source`, `source is disabled`, `unknown source`); `429` (`rate limit for this source`).
Two other answers are still `200`: during quiet hours `{"ok":true,"id":"...","suppressed":"quiet hours"}` (recorded in `GET recent`, not shown), and a repeat inside the grouping window `{"ok":true,"id":"...","merged":true,"count":2}`.

Notes:
- `image` and `wallpaper` are fetched **by the Shard** (the app may only load origins it declares) and served back to the app. Up to 3 redirects, 8 s, 3 MB, png/jpeg/gif/webp/bmp only.
  The URL may be on your LAN (a camera snapshot). A picture that cannot be fetched shows "FAILED to load" with its address on the card.
- The native banner (`mode: banner`) takes plain text and a duration only: no image, no colour. Use `full` or `both` for pictures.
- The queue holds up to 5 active notifications; the full-screen app is launched when it is not already open (it announces itself while open and when it leaves), at most once every 2 s, and a notification queued while it is open extends its stay; the banner service has no such limit.

```
curl -X POST http://<TV-IP>:8099/plugins/notification-center/api/notify \
  -H "Content-Type: application/json" \
  -d '{"title":"Doorbell","message":"Someone is at the door","mode":"full","level":"alert","duration":20,
       "image":"http://camera.local/snapshot.jpg","wallpaper":"https://example.com/night.jpg"}'
```

### From another Shard (ES5, no dependencies)

```js
var http = require('http');
function notify(fields) {                       // fields: the table above
    var body = JSON.stringify(fields);
    var rq = http.request({ host: '127.0.0.1', port: 8099, method: 'POST', path: '/plugins/notification-center/api/notify',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, function (r) { r.resume(); });
    rq.on('error', function () { /* Notification Center not installed or Vetro busy */ });
    rq.end(body);
}
notify({ title: 'Goal', message: 'Team 1-0 Rival (23\')', level: 'ok', duration: 30 });
```

The Match alerts and Cast Shards use exactly this call.

### Other languages

```powershell
Invoke-RestMethod -Method Post -Uri "http://<TV-IP>:8099/plugins/notification-center/api/notify" -ContentType "application/json" `
  -Body (@{ title = "Backup"; message = "Finished"; level = "ok" } | ConvertTo-Json)
```
```python
import json, urllib.request
req = urllib.request.Request("http://<TV-IP>:8099/plugins/notification-center/api/notify",
    json.dumps({"title": "Oven", "message": "Dinner is ready", "mode": "both"}).encode(), {"Content-Type": "application/json"})
print(urllib.request.urlopen(req).read())
```
Home Assistant (`configuration.yaml`):
```yaml
rest_command:
  tv_notify:
    url: "http://<TV-IP>:8099/plugins/notification-center/api/notify"
    method: post
    content_type: "application/json"
    payload: '{"title":"{{ title }}","message":"{{ message }}","level":"{{ level | default(''info'') }}"}'
```

## ntfy-compatible: `POST ntfy`

For apps that already publish to ntfy. The body is the message; headers `Title`, `Priority` (`5` = alert, `4` = warning) and `Tags` (`warning`, `rotating_light`,
`white_check_mark`, `tada`, `fire`, `soccer`, `bell`, `house`, `package`, `sunny`, `skull` set the icon and level). Or JSON `{"message","title","priority","tags"}`.

```
curl -X POST http://<TV-IP>:8099/plugins/notification-center/api/ntfy -H "Title: Oven" -H "Priority: 4" -H "Tags: tada" -d "Dinner is ready"
```

## Read and discover

| Route | Returns |
|---|---|
| `GET api` | This API as JSON: fields, enums, limits, routes, version. |
| `GET notifications` | `{lang, notifications:[{id,title,message,level,mode,duration,icon,image,wallpaper,seconds}]}` (the active queue; `?js=1` for the script form used by the app). |
| `GET recent` | `{recent:[{id,title,message,level,mode,duration,icon,image,wallpaper,at}]}` (the last 20 sent). |
| `GET img?id=<id>[&kind=wallpaper][&info=1]` | The picture of a queued notification; `info=1` returns `{ok,type,bytes}` or `{ok:false,error}` (use it to check a URL). |
| `GET img?url=<encoded URL>[&info=1]` | Fetch and serve any http(s) image by URL (the panel's live preview uses it); `info=1` returns `{ok,type,bytes}`. Kept 2 minutes, 8 at a time. |
| `GET status` | `{version, app, appVersion, service, handoff, pairing:"on"\|"off"\|"unknown"}`: is the companion app and its banner service installed, is Vetro pairing on, did the Shard write the queue file the banner service reads (`handoff`). |
| `GET lang` / `POST lang` | Display language `{lang:"en"|"pt"}`, shared by the panel and the TV screen. |
| `GET emoji` | The bundled emoji list (Unicode CLDR, MIT) used by the panel's icon picker. |

## Sources, quiet hours, grouping and webhooks

**Sources** give each sender its own defaults and rules. A source is a short name (`doorbell`, `home-assistant`, `match-alerts`); senders put it in `source` (or the header `X-NC-Source`).

| Route | What it does |
|---|---|
| `GET profiles` | `{profiles:{<source>:{enabled,icon,level,mode,duration,rate,hasKey}}, max:20}`. The key is never returned. |
| `POST profiles` | Create, change or delete one: `{source, icon?, level?, mode?, duration?, rate?, enabled?, key?, genKey?, delete?}`. `icon`, `level`, `mode` and `duration` fill in what the sender leaves out (the sender's own value always wins). `rate` is the most notifications per minute (`0` = no limit). `key` (8-64 characters; `""` clears it) makes the source require the header `X-NC-Key`; `genKey: true` creates a random key and returns it **once**. |

**Settings:**

| Route | What it does |
|---|---|
| `GET settings` | `{settings:{quiet:{enabled,from,to,allow},groupSeconds,strict}}` |
| `POST settings` | Send only what changes. `quiet`: between `from` and `to` (`"22:00"` to `"07:00"`, TV local time, may cross midnight) nothing is shown below the level `allow` (`alert` lets only alerts through, `warn` lets warnings and alerts, `none` silences everything); suppressed ones are still listed in `GET recent`. `groupSeconds` (0-3600, default 60, `0` = off): a notification identical to one from the last `groupSeconds` (same source, title, message and level) is counted (`count` in `GET recent`) instead of shown again. `strict: true` rejects notifications whose `source` has no profile. |

**Webhooks** turn any JSON a service already sends (GitHub, Home Assistant, Grafana, a router) into a notification, without changing the sender:

| Route | What it does |
|---|---|
| `GET hooks` | `{hooks:{<name>:{title,message,level,icon,mode,duration,source}}, max:10, base}` |
| `POST hooks` | Create, change or delete one: `{name, message, title?, level?, icon?, mode?, duration?, source?, delete?}`. `name`: `a-z 0-9 -`, up to 24. The text fields are templates: `{{a.b.0.c}}` is replaced by that value of the posted JSON (a missing value gives an empty string; nothing is ever evaluated). `message` is required. |
| `POST hook/<name>` | Send any JSON (up to 64 KB) to that hook. A body that is not JSON is available as `{{text}}`. The notification is sent as source `source`, or the hook's name if `source` is empty, so a source's key protects its hook. |

Example, GitHub pushes: `POST hooks` with `{"name":"github","title":"{{repository.name}}","message":"{{pusher.name}} pushed {{head_commit.message}}","icon":"📦"}`, then give GitHub the URL `http://<TV-IP>:8099/plugins/notification-center/api/hook/github`.

## Security notes

- A source key is stored in `ctx.config` on the TV and checked by the Shard; it is not a replacement for Vetro pairing (it travels in clear text on the LAN, like the rest of the traffic) but it lets you accept one sender and refuse the others when pairing is off. `GET profiles` never returns it.
- Anyone who can reach the Shard can change sources, settings and hooks, as they can change the language. Hooks and sources can only shape the text, icon, level, mode and duration of a notification: nothing can point the Shard at another app or run a command.

- With pairing off, anyone who can reach the TV's port 8099 can send notifications and make the Shard fetch an image URL. Turn pairing on for shared networks.
- The Shard only fetches `http`/`https` URLs, never `file:` or other schemes, and serves only image types.
- The active queue (5) is kept in memory only. The list of the last 20 sent (`GET recent`) is kept in `ctx.config` on the TV so it survives restarts and updates; it holds the fields you sent, including any image or wallpaper URL. The display language is also kept there.
