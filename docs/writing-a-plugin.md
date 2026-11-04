# Writing a plugin

A plugin is a folder of three files that you build into one bundle, try on your TV, and send here as a pull request.
This page goes through it in order.

Read [what a plugin can and cannot do](what-a-plugin-can-do.md) first. It is short, and it decides what you can build.
You need Node on your computer (any recent version) and a TV or dashboard running Vetro 0.4.0 to try it on.

- [1. Start from the template](#1-start-from-the-template)
- [2. Fill in the manifest](#2-fill-in-the-manifest)
- [3. Write `index.js`](#3-write-indexjs)
- [4. Write the README](#4-write-the-readme)
- [5. Build and check](#5-build-and-check)
- [6. Try it on a TV](#6-try-it-on-a-tv)
- [7. Publish](#7-publish)
- [Examples](#examples) · [Troubleshooting](#troubleshooting) · [Signing](#for-the-lists-maintainer-signing)

## 1. Start from the template

```
node scripts/new.cjs my-plugin "My plugin"
```

creates `plugins/my-plugin/` from [`template/`](../template):

| File | What it is |
| --- | --- |
| `manifest.json` | id, name, version, permissions, author, description, optional dashboard page |
| `index.js` | the code: `function (ctx)` returning `{ start, stop, status, route }`, in ES5 |
| `README.md` | what it does, which commands it runs, where it connects, what it stores |

The template already works: a page with a button and a counter that is kept in `ctx.config`. Install it as it is to see
a plugin run, then change it.

## 2. Fill in the manifest

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "0.1.0",
  "apiVersion": 1,
  "permissions": [],
  "author": "your-github-login",
  "description": "One line that says what it does and which hosts it talks to, if any.",
  "main": "index.js",
  "ui": { "label": "My plugin" }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Equals the folder name. 2-32 characters, `a-z 0-9 -`, starts with a letter. Not `install`, `resume` or `developer`. |
| `apiVersion` | yes | `1`. |
| `name` | yes | Up to 40 characters. Shown in the list. |
| `version` | yes | `1.2.3`. The dashboard offers an update when the list has a higher one. |
| `description` | yes | Up to 160 characters, one line. Say what it does **and which hosts it talks to**. |
| `author` | yes | Your GitHub login, up to 60 characters. It must be an account that can answer questions about the plugin. |
| `permissions` | no | `[]` or `["exec"]`. Ask for `exec` only if you call `ctx.execute`. |
| `main` | no | The entry file. Default `index.js`. |
| `ui` | no | `{ "label": "…" }`, 1-24 characters. Adds a tab to the dashboard while the plugin runs. The plugin must answer the `ui` route. |

**Choosing `permissions`.** There is only one, `exec`: shell commands on the TV, as root. Leave it out unless you need
it. If you have it, the README has to say which commands you run and why (section 4). Leaving it out does not make a
plugin safe, since nothing stops it from running commands another way. It tells the reader what you say you need, and
the maintainer reads the code to check that you did not lie.

## 3. Write `index.js`

```js
module.exports = function (ctx) {
    return {
        start:  function () {},               // switched on: open timers and sockets
        stop:   function () {},               // switched off: close them
        status: function () { return {}; },   // shown by the dashboard as the plugin's detail
        route:  function (req, res, sub) {    // /plugins/<id>/api/<sub>
            return false;                     // false = not mine
        }
    };
};
```

All four are optional. `ctx` gives you `ctx.id`, `ctx.dir`, `ctx.config` and `ctx.execute`, and nothing else. The
[reference](what-a-plugin-can-do.md#6-what-the-api-gives-a-plugin) lists what each one does.

### The life of a plugin

1. The user switches it on. Vetro reads your file and calls your function with `ctx`, then calls `start()`.
2. The dashboard calls `status()` now and then, and requests go to `route()`.
3. The user switches it off, or removes it, or Vetro switches it off after three errors in a row. Vetro calls `stop()`.
4. If `start()` throws, Vetro still calls `stop()` so you can release what you had already taken.

### The page

Set `ui` in the manifest and answer `GET api/ui` with an HTML document. The dashboard puts it in a frame:

- it runs scripts but has **no cookies and no `localStorage`**: keep state in `ctx.config`, through a route;
- use **relative URLs** (`fetch("count")`, not `fetch("/plugins/my-plugin/api/count")`): the session token is part of the
  page's URL and only a relative URL carries it;
- send POST bodies as `Content-Type: text/plain` if you want to work on older Vetro builds as well;
- add `<meta name="color-scheme" content="light dark">` so the page follows dark mode.

### Rules of thumb

- **ES5.** `var` and `function`. No arrow functions, `let`/`const`, `async`/`await`, classes or template literals: older
  TVs run Node 4.4, and CI will not tell you (it runs Node 20).
- **Clean up in `stop()`.** A timer you forget keeps running after the user switches the plugin off.
- **Catch your own errors.** The host catches what is thrown *inside* `start`, `status` and `route`. It does not catch
  what is thrown later, in a timer, a socket or a promise: that can stop all of Vetro.
- **Keep data in `ctx.config`.** An update replaces everything else in the plugin's folder.
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

This checks every plugin (the limits of the TV's installer, the README, the banned calls), then writes
`dist/<id>-<version>.vplugin` and `index.json`. When something is wrong it names the plugin and the rule, and stops.
`--check` does the same without writing; CI runs it.

The bundle is the same one `node scripts/vetro-plugin.cjs pack plugins/<id>` in the Vetro repository produces, so the
SHA-256 matches. `node scripts/vetro-plugin.cjs check plugins/<id>` there also loads your entry file and calls it once,
which `build.cjs` does not.

## 6. Try it on a TV

1. Open the dashboard, then **Plugins → Add a plugin → from a file**, and pick `dist/<id>-<version>.vplugin`. If the
   build asks for a signed plugin list, turn on **Developer mode** first.
2. It is installed **switched off**. Switch it on. Its tab appears while it runs.
3. Change the code, run `build.cjs` again, install again: the plugin is replaced in place and comes back switched off.
4. If it fails, the dashboard shows *Failed* and the last error. Three errors in a row switch it off.

If the TV does not come back after a restart, Vetro starts the next boot in safe mode: plugins are paused, and you can
switch off or remove yours.

## 7. Publish

1. Check that `author` is your GitHub login and the README is filled in.
2. Run `node scripts/build.cjs`.
3. Open a pull request with `plugins/<id>/`, `dist/` and `index.json`. The description template asks for permissions
   and hosts: answer it.
4. CI checks the plugin, that `dist/` and `index.json` are up to date, and that no published bundle changed without a new
   version. A maintainer then reads the code (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

**Changing a published plugin:** bump `version`, rebuild. The old bundle disappears from `dist/` and users see
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

Always pass a timeout, and list the command in the README. [`plugins/tv-uptime`](../plugins/tv-uptime) is a full plugin
built on this.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| `Plugin checks failed` | Read the line: it names the plugin and the rule. |
| *Invalid* in the dashboard | The bundle failed a check on the TV. The reason is shown. |
| `SHA-256 does not match` | The file changed after the list was written, or GitHub's CDN has not caught up (wait a few minutes). |
| *Failed* | `start()` threw, or three errors came in a row. The message is the last one. |
| Plugins *Suspended* | Safe mode: the last boot did not stay up for 60 seconds. Switch off or remove the culprit, then Resume. |
| Works in CI, breaks on the TV | Probably syntax newer than ES5. |
| The page loads but its requests fail | An absolute URL in `fetch`: use a relative one. |
| `has no exec permission` | You call `ctx.execute` and the manifest does not list `exec`. |

## For the list's maintainer: signing

Vetro 0.4.0 can require the list to be signed. The key is set in `app/service/plugin-key.js`; while it is `null`, the TV
only checks the SHA-256. The signing key is **not** the one that signs Vetro updates and never goes in this repository.

```
node <vetro>/app/scripts/vetro-plugin.cjs sign index.json <plugin-list-private.pem> dist
git add index.json && git commit
```

Run it after merging and before publishing, because it signs the id, version and SHA-256 of each entry. `build.cjs`
keeps a `signature` while those three are unchanged, so the next pull request does not remove it and CI does not call
the file out of date. A contributor cannot sign: their pull request has unsigned entries until the maintainer signs
them.
