# What a Vetro Shard can and cannot do

Written against Vetro **0.4.0** and **0.5.0**, plugin API **1** (experimental), which did not change between the two.
Since 0.5.0 the dashboard calls the plugin system **Vetro Shards** and one plugin a **Shard**; 0.4.0 calls the same page
*Plugins*. Only that name changed: the code, the `permissions` field, the `.vplugin` bundles and the routes still say
"plugin". Everything here comes from the host's code
(`app/service/plugin-host.js`) and from measurements on a Q80A, not from intentions. When something is a rule of this
catalog and not something Vetro enforces, the text says so.

- **Writing a Shard?** Read this page, then [Writing a Shard](writing-a-plugin.md).
- **Installing one?** Read sections 1, 3 and 8.

## 1. The short version

A Shard is JavaScript that Vetro **loads into its own process on the TV**. It is not sandboxed.

That has one consequence that matters more than the rest:

> A Shard can do whatever Vetro itself can do, **including running commands as root**, whether or not its manifest
> says so. `permissions` is a label the author writes; Vetro does not enforce it against a Shard that wants more.

What Vetro does guarantee is **fault isolation**: a Shard that keeps failing gets switched off, and a Shard that stops
the TV from booting cannot do it twice. It does not guarantee that a Shard is *well behaved*.

So the question for a user is not "which permissions does it ask for" but "do I trust whoever wrote it". For an author it
is "what does the API give me, and what will the catalog accept".

## 2. At a glance

|  | What |
| --- | --- |
| **Supported** | one page in the dashboard · its own HTTP routes · its own saved settings · timers and sockets while it runs · shell commands as root, with `exec` |
| **Not offered by the API** | remote-control events · "TV turned on" or "app opened" callbacks · launcher tiles · anything drawn on the TV screen · Vetro's settings · the MQTT / Home Assistant link · a second page · running while switched off |
| **Possible but forbidden by this catalog** | `eval`, `new Function`, minified code, code downloaded at run time, network calls the description does not mention, collecting data about the user, the TV or the network, `exec` without saying which commands |

The three rows are three different things:

- *Supported* is the API. It works and it is what you build on.
- *Not offered* means the host has no hook for it. It is not forbidden, there is simply nothing to call.
- *Possible but forbidden* is code that Vetro would run happily. Only the review stops it (section 4).

## 3. What Vetro enforces

Checked by the host. A Shard cannot opt out of any of these.

| Rule | Detail |
| --- | --- |
| **Off until switched on** | Installing or updating leaves a Shard off. Its code is **not even read** until you switch it on, so installing, listing, safe mode and booting with it off never run anything of it. The choice survives restarts. |
| **Only paired devices manage Shards** | Installing, switching on and removing need a device paired with the TV. |
| **Only its own routes** | A Shard gets `/plugins/<id>/api/...` and nothing else. It cannot take a Vetro route or another Shard's. |
| **Failing Shards are switched off** | Calls into `start`, `status` and `route` are guarded. After **3 errors in a row** the Shard is stopped and shown as *Failed* with the last message. If `start()` throws, `stop()` is called so it can release what it took. |
| **Safe mode** | If a boot does not stay up for 60 seconds, the next one starts with every Shard paused. They are still listed, so you can switch off or remove the culprit, then resume. |
| **Text only, small** | A bundle is at most **20 files and 512 KB** in total, text only: no binaries, no native code, no `node_modules`. File names use `a-z A-Z 0-9 . _ -` and `/`. |
| **Manifest limits** | `id` 2-32 chars (`a-z 0-9 -`, starts with a letter, not `install`, `resume` or `developer`; nor the id of a built-in Shard such as `launcher`) · `name` ≤ 40 · `version` ≤ 24 · `description` ≤ 160 · `author` ≤ 60 · `ui.label` 1-24 · `intercepts` 1-3 apps, each `appId` a Tizen id (`a-z A-Z 0-9 . _ -`) and `label` 1-24 plain characters · `apiVersion` must be `1` · `permissions` may only contain `exec`. |
| **Unsigned installs need Developer mode** | A Shard the catalog has not signed, including one installed from a file, installs only with **Developer mode** on. It is off by default and asks for confirmation. In 0.5.0 this holds for every build; in 0.4.0 only for builds that have the catalog's key. |
| **Built-in Shards are protected** | A Shard that ships inside Vetro (since 0.5.0: `launcher`) cannot be replaced by a bundle or removed, and keeps running in safe mode. Only built-in Shards receive `ctx.vetro`, Vetro's own services; a catalog Shard never does. |
| **Taking over a launcher tile** | A manifest `intercepts` list makes the Vetro launcher call the Shard's `launch(appId)` for those apps' tiles while the Shard is on. It is not a permission, the dashboard shows **Intercepts the &lt;app&gt; app** on the Shard's card and in the install question, and Vetro starts the app itself if the Shard is off, declines, fails or takes more than 2 minutes. The launcher never reads anything from the Shard: it only learns which tiles are taken over. Two Shards claiming the same app: neither takes it, and the dashboard shows the conflict. |
| **Own saved data** | `ctx.config` reads and writes one file, `config.json`, in the Shard's own folder. Nothing else survives an update; Remove deletes it. |
| **`ctx.execute` needs `exec`** | Without the permission, `ctx.execute` rejects. This is the only thing the permission gates (see section 4). |
| **Pages are sandboxed** | Everything under `/api/` is served with `Content-Security-Policy: sandbox allow-scripts`. The page runs in a frame with scripts but without cookies, storage or the dashboard's origin. It gets a **session token in its URL** that opens that Shard's routes only, expires after 8 hours and ends when the Shard is switched off. |

## 4. Possible, but not allowed

**A Shard with `"permissions": []` can still run commands as root.** It is Node code inside Vetro's process. It can
`require('child_process')`, read and write files, open sockets, call Vetro's own HTTP routes and talk to the root
helper. This was measured on the Q80A: a test Shard with no permissions ran `child_process` and read the service
files, and a request to Vetro from the TV itself can run `/exec` as root with no key.

What follows:

- Do not rely on `permissions` to keep a Shard out of the TV. It does not.
- This catalog forbids the things in the table above, and the review is how it tries to stop them. A Shard that does any of
  them is removed (see [SECURITY.md](../SECURITY.md)). Vetro does not block it.
- A signature from the catalog (when the catalog is signed) shows that a file is the one the catalog published. It does not
  show that the code is safe.

A real boundary needs the Shard to run in a separate unprivileged process with no network. That works on the Q80A and
is written up in Vetro's `PLUGIN-ISOLATION.md`; it is **not in 0.4.0 or 0.5.0**.

## 5. What this catalog asks

Not enforced by Vetro. `node scripts/build.cjs` checks what a machine can check (marked ⚙). A person reads the rest,
once, before the merge. That is a spot check, not an audit.

- ⚙ `README.md`, `description`, `author` (a real GitHub account) and a `1.2.3` version are present.
- ⚙ No `eval()` and no `new Function`.
- ⚙ A Shard that asks for `exec` has a "Commands it runs" section in its README that lists every command and why.
- No minified or obfuscated source, no downloaded code.
- It talks only to what the description says. No calls to hosts the description does not mention.
- No collection of data about the user, the TV or the network.
- `permissions` is as small as possible. A Shard that does not need `exec` must not ask for it.
- It cleans up in `stop()` (timers, sockets) and keeps its data in `ctx.config`.
- A changed Shard gets a new `version`.

## 6. What the API gives a Shard

```js
module.exports = function (ctx) {
    return { start, stop, status, route };   // all four optional
};
```

**What you receive: `ctx`**

| Member | What it is |
| --- | --- |
| `ctx.id` | The Shard's id. |
| `ctx.dir` | The Shard's folder on the TV. An update replaces everything in it except `config.json`. |
| `ctx.config.get()` | Reads your `config.json`. Synchronous. Returns `{}` when there is none. |
| `ctx.config.set(obj)` | Writes it (file mode `600`). Synchronous. |
| `ctx.execute(cmd, timeoutMs)` | Runs a shell command on the TV **as root**, through the TV agent. Returns a Promise of the result (`r.stdout`, as `tv-uptime` reads it). Needs `exec`. |

**What you can export**

| Function | When it runs |
| --- | --- |
| `start()` | The Shard is switched on. Open timers and sockets here. |
| `stop()` | It is switched off, or `start()` threw. Close everything you opened. |
| `status()` | The dashboard asks for the Shard's detail. Returns an object. Called often: keep it cheap. |
| `route(req, res, sub)` | A request to `/plugins/<id>/api/<sub>`. Return `true` when you answered, `false` when it is not yours. |

**A page.** With `"ui": { "label": "…" }` in the manifest, `GET api/ui` must return HTML. The dashboard shows it as a
tab while the Shard is on.

## 7. What the API does not give a Shard

`ctx` has exactly four members: `id`, `dir`, `config`, `execute`. The host has no other hook, so there is **no**:

- remote-control or key events, and no "when the TV turns on" or "when an app opens" callback;
- way to add a launcher tile, a sidebar item, a notification or anything on the TV screen;
- access to Vetro's settings, its paired devices, or the MQTT / Home Assistant connection through the API;
- scheduler: if you need to poll, start your own timer in `start()` and clear it in `stop()`;
- HTTP client: use Node's own `http` / `https`, and declare the hosts in `description` and README;
- more than one dashboard page per Shard, or a page outside the dashboard.

**Vetro's own features (Remapper, Home Assistant, Quick settings) cannot be replaced or extended by a Shard through the
API.** They are not Shards and the host passes them nothing: no hook to add a remapper trigger or action, change a rule,
or add a launcher entry. A Shard that wants to touch them has to go around the API, for example by
calling Vetro's own HTTP routes (`/remap`, `/dock`) from the TV. That is the "possible but forbidden" case of
section 4: it is not supported, it can break on any Vetro update, and a Shard that does it must say so in its README.

**The Launcher is a Shard, but not one you can build on.** Since 0.5.0 it ships inside Vetro as a built-in Shard. It is
not in the catalog, cannot be removed, and uses services (`ctx.vetro`) that the host lends to built-in Shards only. A
catalog Shard cannot take the id `launcher`, and `build.cjs` refuses it. Other features may become built-in Shards in
later Vetro versions; the same rule will apply to their ids.

Anything beyond this is possible only through shell commands (`exec`) or Node's own modules, which is exactly what
section 4 is about. Say so in the README if your Shard does it.

## 8. Gotchas

- **Write ES5.** The host is written for Node 4.4, which older TVs run (the Q80A has Node 12). Do not rely on arrow
  functions, `let`/`const`, `async`/`await`, classes or template literals. `build.cjs` does not check syntax and CI
  runs on Node 20, so modern syntax passes CI and can break on an old TV.
- **Errors in your own callbacks are not caught.** The host guards the calls *into* your Shard. An exception thrown
  later from a timer, a socket or a promise you started is not counted, and Vetro installs no global handler for it:
  it can stop the whole service. Wrap those callbacks in `try`/`catch` and handle promise rejections.
- **The page has no storage.** No cookies, no `localStorage`. Keep state in `ctx.config` through a route.
- **Relative URLs only** in the page (`fetch("count")`). The session token is part of the page URL, so a relative
  URL carries it and an absolute one loses it.
- **POST bodies.** JSON `POST` works on 0.4.0 and 0.5.0. To support older builds too, send `Content-Type: text/plain`, as the
  template does.
- **Updates need no restart.** A running Shard is switched off, replaced and switched on again, with its
  `config.json` kept. If the new version asks for different permissions it stays off until the user reviews it. A failed
  `start()` after an update does not restore the previous version: the Shard shows *Failed* and the old bundle has to
  be installed again.

## 9. Before you install one

1. Open its folder in this repository and read `index.js`. It is short on purpose.
2. Read its README: what it runs, where it connects, what it stores.
3. Be wary of `exec`. It is the one permission that is declared, but section 4 explains why its absence proves nothing.
4. It lands switched off. Switch it on when you are ready; switch it off and Remove if you are not.
5. If a TV does not come back after installing something, Vetro starts the next boot in safe mode by itself.
