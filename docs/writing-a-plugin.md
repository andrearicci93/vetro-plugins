# Writing a Shard

A Shard is a folder of three files that you build into one bundle, try on your TV, and send here as a pull request.
This page goes through it in order.

"Shard" is the name Vetro 0.5.0 gives to a plugin. The files, the commands and the bundle format keep the old name
(`plugins/`, `.vplugin`, `vetro-plugin.cjs`, `permissions`), so a Shard written today also runs on Vetro 0.4.0.

Read [what a Shard can and cannot do](what-a-plugin-can-do.md) first. It is short, and it decides what you can build.
You need Node on your computer (any recent version) and a TV or dashboard running Vetro 0.4.0 or 0.5.0 to try it on.

- [1. Start from the template](#1-start-from-the-template)
- [2. Fill in the manifest](#2-fill-in-the-manifest)
- [3. Write `index.js`](#3-write-indexjs)
- [4. Write the README](#4-write-the-readme)
- [5. Build and check](#5-build-and-check)
- [6. Try it on a TV](#6-try-it-on-a-tv)
- [7. Publish](#7-publish)
- [Examples](#examples) · [Troubleshooting](#troubleshooting) · [Signing](#for-the-catalogs-maintainer-signing)

## 1. Start from the template

```
node scripts/new.cjs my-shard "My Shard"
```

creates `plugins/my-shard/` from [`template/`](../template):

| File | What it is |
| --- | --- |
| `manifest.json` | id, name, version, permissions, author, description, optional dashboard page |
| `index.js` | the code: `function (ctx)` returning `{ start, stop, status, route }`, in ES5 |
| `README.md` | what it does, which commands it runs, where it connects, what it stores |

The template already works: a page with a button and a counter that is kept in `ctx.config`. Install it as it is to see
a Shard run, then change it.

## 2. Fill in the manifest

```json
{
  "id": "my-shard",
  "name": "My Shard",
  "version": "0.1.0",
  "apiVersion": 1,
  "permissions": [],
  "author": "your-github-login",
  "description": "One line that says what it does and which hosts it talks to, if any.",
  "main": "index.js",
  "ui": { "label": "My Shard" }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Equals the folder name. 2-32 characters, `a-z 0-9 -`, starts with a letter. Not `install`, `resume`, `developer` or `launcher` (a Shard that ships inside Vetro). |
| `apiVersion` | yes | `1`. |
| `name` | yes | Up to 40 characters. Shown in the catalog. |
| `version` | yes | `1.2.3`. The dashboard offers an update when the catalog has a higher one. |
| `description` | yes | Up to 160 characters, one line. Say what it does **and which hosts it talks to**. |
| `author` | yes | Your GitHub login, up to 60 characters. It must be an account that can answer questions about the Shard. |
| `permissions` | no | `[]` or `["exec"]`. Ask for `exec` only if you call `ctx.execute`. |
| `main` | no | The entry file. Default `index.js`. |
| `ui` | no | `{ "label": "…" }`, 1-24 characters. Adds a tab to the dashboard while the Shard runs. The Shard must answer the `ui` route. |
| `intercepts` | no | `[{ "appId": "…", "label": "…" }]`, 1-3 apps. Says that the Vetro launcher's tile for each app starts your `launch(appId)` while the Shard runs. The Shard must have a `launch` method. See [Taking over an app's tile](#taking-over-an-apps-launcher-tile). |

**Choosing `permissions`.** There is only one, `exec`: shell commands on the TV, as root. Leave it out unless you need
it. If you have it, the README has to say which commands you run and why (section 4). Leaving it out does not make a
Shard safe, since nothing stops it from running commands another way. It tells the reader what you say you need, and
the maintainer reads the code to check that you did not lie.

## 3. Write `index.js`

```js
module.exports = function (ctx) {
    return {
        start:  function () {},               // switched on: open timers and sockets
        stop:   function () {},               // switched off: close them
        status: function () { return {}; },   // shown by the dashboard as the Shard's detail
        route:  function (req, res, sub) {    // /plugins/<id>/api/<sub>
            return false;                     // false = not mine
        },
        launch: function (appId) {            // only with "intercepts": start that app your way
            return Promise.resolve(true);
        }
    };
};
```

All five are optional (`launch` only matters with `intercepts`). `ctx` gives you `ctx.id`, `ctx.dir`, `ctx.config` and `ctx.execute`, and nothing else. The
[reference](what-a-plugin-can-do.md#6-what-the-api-gives-a-shard) lists what each one does.

### The life of a Shard

1. The user switches it on. Vetro reads your file and calls your function with `ctx`, then calls `start()`.
2. The dashboard calls `status()` now and then, and requests go to `route()`.
3. The user switches it off, or removes it, or Vetro switches it off after three errors in a row. Vetro calls `stop()`.
4. If `start()` throws, Vetro still calls `stop()` so you can release what you had already taken.

### Taking over an app's launcher tile

Some apps have to be started in a particular way: through a proxy, with a flag, with a patch applied first. A Shard can
say that it does this for an app, and the Vetro launcher then starts the Shard instead of the app when that app's tile is
pressed. The Ad-free YouTube Shard does this for YouTube; a Twitch Shard could do the same for the Twitch app.

```json
"intercepts": [{ "appId": "com.samsung.tv.cobalt-yt", "label": "YouTube" }]
```

- `appId` is the Tizen id, as in `app_launcher -s <id>` (letters, digits, `.` `_` `-`). `label` is the name people read, 1-24 characters of plain text.
  Up to three apps, no app twice. `build.cjs` checks the same rules as Vetro does, and fails if the entry file has no `launch`.
- **Vetro tells the user.** The Shard's card in the dashboard shows **Intercepts the YouTube app**, and the install question lists the apps.
  The catalog entry (`index.json`) carries the same list, and Vetro refuses a download whose manifest lists other apps than the catalog says.
  Put it in your README too: say what changes for the tile.
- It is **not a permission**: `permissions` stays `[]` or `["exec"]`. Older Vetro versions ignore the key and the Shard still loads.
- `launch(appId)` returns a Promise. Resolve `true` when the app is starting; resolve `false` to decline. It may take a while the first time (up to 2 minutes).
- **The fallback is Vetro's.** If the Shard is off, has no answer, declines, throws, rejects or is too slow, Vetro starts the app the normal way, so the tile
  never goes dead. Do not start the app yourself *and* resolve `false`: it would start twice.
- Only while the Shard is on: switching it off or removing it gives the tile back.

### The page

Set `ui` in the manifest and answer `GET api/ui` with an HTML document. The dashboard puts it in a frame:

- it runs scripts but has **no cookies and no `localStorage`**: keep state in `ctx.config`, through a route;
- use **relative URLs** (`fetch("count")`, not `fetch("/plugins/my-shard/api/count")`): the session token is part of the
  page's URL and only a relative URL carries it;
- send POST bodies as `Content-Type: text/plain` if you want to work on older Vetro builds as well;
- add `<meta name="color-scheme" content="light dark">` so the page follows dark mode.

### Rules of thumb

- **ES5.** `var` and `function`. No arrow functions, `let`/`const`, `async`/`await`, classes or template literals: older
  TVs run Node 4.4, and CI will not tell you (it runs Node 20).
- **Clean up in `stop()`.** A timer you forget keeps running after the user switches the Shard off.
- **Catch your own errors.** The host catches what is thrown *inside* `start`, `status` and `route`. It does not catch
  what is thrown later, in a timer, a socket or a promise: that can stop all of Vetro.
- **Keep data in `ctx.config`.** An update replaces everything else in the Shard's folder.
- **Say what you connect to.** Name every host in `description` and in the README.
- **Readable source.** No minified code, no `eval`, no code downloaded at run time. `build.cjs` rejects `eval` and
  `new Function`.

## 4. Write the README

The template has the headings; fill them in. A reader should know, without opening `index.js`:

| Section | What goes in it |
| --- | --- |
| *(intro)* | What it does, in one or two sentences. |
| **Permissions** | `None`, or `exec` and why. |
| **Commands it runs** | Only with `exec`: a table of every command and the reason. `build.cjs` fails without this section. |
| **Network** | `None`, or each host and what you send it. |
| **Data it keeps** | What is in `config.json`, or `None`. |

The [`tv-uptime` README](../plugins/tv-uptime/README.md) is a complete example.

## 5. Build and check

```
node scripts/build.cjs
```

This checks every Shard (the limits of the TV's installer, the README, the banned calls), then writes
`dist/<id>-<version>.vplugin` and `index.json`. When something is wrong it names the Shard and the rule, and stops.
`--check` does the same without writing; CI runs it.

The bundle is the same one `node scripts/vetro-plugin.cjs pack plugins/<id>` in the Vetro repository produces, so the
SHA-256 matches. `node scripts/vetro-plugin.cjs check plugins/<id>` there also loads your entry file and calls it once,
which `build.cjs` does not.

## 6. Try it on a TV

1. Open the dashboard, then **Vetro Shards** (called **Plugins** in 0.4.0), and open **Install from a file or develop a
   Shard**. Turn on **Developer mode**, choose `dist/<id>-<version>.vplugin` and confirm. Developer mode is off by
   default and is needed for any Shard the catalog has not signed, which includes yours. (In 0.4.0 it is needed only when
   the build has the catalog's key.)
2. It is installed **switched off**. Switch it on. Its tab appears while it runs.
3. Change the code, run `build.cjs` again, install again: the Shard is replaced in place and comes back switched off.
4. If it fails, the dashboard shows *Failed* and the last error. Three errors in a row switch it off.

If the TV does not come back after a restart, Vetro starts the next boot in safe mode: Shards are paused, and you can
switch off or remove yours.

## 7. Publish

1. Check that `author` is your GitHub login and the README is filled in.
2. Run `node scripts/build.cjs`.
3. Open a pull request with `plugins/<id>/`, `dist/` and `index.json`. The description template asks for permissions
   and hosts: answer it.
4. CI checks the Shard, that `dist/` and `index.json` are up to date, and that no published bundle changed without a new
   version. A maintainer then reads the code (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

**Changing a published Shard:** bump `version`, rebuild. The old bundle disappears from `dist/` and users see
*Update*. Do not edit a published bundle in place: CI refuses it.

## Examples

### A timer that polls a host

```js
var https = require('https');

module.exports = function (ctx) {
    var timer = null, last = { ok: null, at: null };

    function check() {
        try {
            var req = https.get('https://example.com/', function (res) {
                last = { ok: res.statusCode < 400, at: Date.now() };
                res.resume();
            });
            req.on('error', function () { last = { ok: false, at: Date.now() }; });   // not caught by the host
            req.setTimeout(5000, function () { req.abort(); });
        } catch (e) { last = { ok: false, at: Date.now() }; }
    }

    return {
        start:  function () { check(); timer = setInterval(check, 60000); },
        stop:   function () { if (timer) clearInterval(timer); timer = null; },
        status: function () { return last; }
    };
};
```

Note the `error` handler and the `try`/`catch`: errors from the request happen outside `start`, so Vetro would not
catch them. The description and README must name `example.com`.

### A command, with `exec`

```js
ctx.execute('cat /proc/uptime', 5000).then(function (r) {
    var seconds = parseFloat(r.stdout.split(' ')[0]);
    // …
}, function (err) {
    // rejects without the exec permission, or when the command fails
});
```

Always pass a timeout, and list the command in the README. [`plugins/tv-uptime`](../plugins/tv-uptime) is a full Shard
built on this.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| `Plugin checks failed` | Read the line: it names the Shard and the rule. |
| *Invalid* in the dashboard | The bundle failed a check on the TV. The reason is shown. |
| `SHA-256 does not match` | The file changed after the catalog was written, or GitHub's CDN has not caught up (wait a few minutes). |
| *Failed* | `start()` threw, or three errors came in a row. The message is the last one. |
| Shards *Suspended* | Safe mode: the last boot did not stay up for 60 seconds. Switch off or remove the culprit, then Resume. |
| Works in CI, breaks on the TV | Probably syntax newer than ES5. |
| The page loads but its requests fail | An absolute URL in `fetch`: use a relative one. |
| `has no exec permission` | You call `ctx.execute` and the manifest does not list `exec`. |

## For the catalog's maintainer: signing

Vetro 0.4.0 and 0.5.0 can require the catalog to be signed. The key is set in `app/service/plugin-key.js`; while it is `null`, the TV
only checks the SHA-256. The signing key is **not** the one that signs Vetro updates and never goes in this repository.

```
node <vetro>/app/scripts/vetro-plugin.cjs sign index.json <catalog-private.pem> dist
git add index.json && git commit
```

Run it after merging and before publishing, because it signs the id, version and SHA-256 of each entry. `build.cjs`
keeps a `signature` while those three are unchanged, so the next pull request does not remove it and CI does not call
the file out of date. A contributor cannot sign: their pull request has unsigned entries until the maintainer signs
them.
