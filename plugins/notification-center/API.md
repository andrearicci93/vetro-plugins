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
| `icon` | string, max 8 | by level | One emoji in front of the title (e.g. a goal: the ball). |
| `image` | http/https URL, max 290 | none | A picture under the message on the **full-screen card**. |
| `wallpaper` | http/https URL, max 290 | none | A darkened full-screen background behind the card. Can be combined with `image`. |
| `seconds` | integer 5-300 | `30` | How long it may wait in the queue (always at least `duration` + 20). |
| `open` | boolean | `true` | `false` only queues it, without launching the app or its service. |

Answer: `{"ok":true,"id":"1-abc","open":"requested"}`. Errors: `400 {"error":"message is required"}` or `"invalid JSON"`.

Notes:
- `image` and `wallpaper` are fetched **by the Shard** (the app may only load origins it declares) and served back to the app. Up to 3 redirects, 8 s, 3 MB, png/jpeg/gif/webp/bmp only.
  The URL may be on your LAN (a camera snapshot). A picture that cannot be fetched shows "FAILED to load" with its address on the card.
- The native banner (`mode: banner`) takes plain text and a duration only: no image, no colour. Use `full` or `both` for pictures.
- The queue holds up to 5 active notifications; the app is launched at most once every 10 s (the banner service has no such limit).

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
| `GET status` | `{version, app, appVersion, service, pairing:"on"\|"off"\|"unknown"}`: is the companion app and its banner service installed, is Vetro pairing on. |
| `GET lang` / `POST lang` | Display language `{lang:"en"|"pt"}`, shared by the panel and the TV screen. |
| `GET emoji` | The bundled emoji list (Unicode CLDR, MIT) used by the panel's icon picker. |

## Security notes

- With pairing off, anyone who can reach the TV's port 8099 can send notifications and make the Shard fetch an image URL. Turn pairing on for shared networks.
- The Shard only fetches `http`/`https` URLs, never `file:` or other schemes, and serves only image types.
- The active queue (5) is kept in memory only. The list of the last 20 sent (`GET recent`) is kept in `ctx.config` on the TV so it survives restarts and updates; it holds the fields you sent, including any image or wallpaper URL. The display language is also kept there.
