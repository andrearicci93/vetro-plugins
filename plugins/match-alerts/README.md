# NEWS

The official name of this Vetro Shard is **NEWS**. It sends **sport, weather, news and civil-protection** alerts through
[Notification Center](https://github.com/mclaudiopt/tv-notification-center). Everything runs on the TV; no PC is needed at
runtime. The Shard keeps the id `match-alerts` so an existing installation keeps its configuration.

### Which Notification Center version is needed

- The public catalog currently publishes Notification Center **0.3.1**; PR #34 proposes **0.6.1** (not merged). With those
  versions the basic `banner` path works: `title`, `message`, `level`, `duration`, `source` and `group:false`. The Shard's
  `refreshSounds()` calls `GET /api/api`, which 0.3.1 does not have, so sounds are simply omitted; sound, volume and the
  `theme`/`action` fields are ignored. `overlay` mode does not exist before **0.8.0** and falls back to `banner`.
- `overlay`, adaptive sounds and per-section volume need Notification Center **0.8.0+**; the TVs in use here have
  **0.16.0** (.7) and **0.17.1** (.3), installed from file. No catalog version offers `overlay` yet; PR #34 (0.6.1) does not.
- `priority:"high"` for civil-protection warnings needs **0.13.0+**; on older versions the warning is still shown, just
  without the quiet-hours bypass.

The panel has five tabs, in the same order as the module switches: **SETUP** (formerly General), **Sport**, **Weather**, **News** and **Technical** (Técnico).

- **Weather** uses two columns, like the Notification Center Shard: meteorology (places, Open-Meteo, proactive warnings) and **Proteção Civil** (IPMA/ANEPC/RSS). The `civ.enabled` switch shows or hides the civil-protection column.
- **Sport** has two sub-tabs: **Football** (clubs, alerts, goal simulation) and **Other sports** (picks for NBA/MLB/NHL/NFL/F1). The same `modules.sport` switch shows or hides the whole Sport tab.
- The Modules switches in SETUP control tab visibility: **Sport**, **Weather** and **News**; SETUP and Technical are always visible. Previous/Next skip hidden tabs, and hiding a tab keeps all its saved parameters.
- Each tab is split into collapsible sections. The tab bar stays at the top while scrolling, and the header has **Test all** (sport, weather, news, civil protection, 1 s apart) and **Save all**. The **Technical** tab holds Diagnostics: watched lines, log, provider health and **Clear log**, plus a `curl` example and the route list.

## SETUP (General)

| Module | Source | What it sends |
|---|---|---|
| **Sport** | ESPN public scoreboard (no key) or API-Football (your key) | Goals, opponent goals, cards, substitutions, disallowed goal, kick-off, half-time, full time; for other sports also score changes. |
| **Weather** | [Open-Meteo](https://open-meteo.com) (no key) | Temperature, condition, daily min/max and rain chance for the place chosen in the panel, every 5-240 minutes (60 by default). |
| **News** | Public RSS and Google News (no key) | New headlines from the sources you pick, every 5-240 minutes (30 by default). |

Weather and news respect a **quiet hours 23h-07h** switch (on by default): the data is still fetched, but no banner is sent.
"Check now", the test buttons and the periodic sport feed are not affected. Seen headlines, match baselines and
deduped events are saved in `ctx.config.history`, so a restart does not repeat old news or lose a goal that happened
while the Shard was down.

### Weather provider and schedule

- **Provider**: **Open-Meteo** (worldwide, no key) or **IPMA** (Portuguese official forecast, no key; the place is matched
  by name or nearest district and weather types are translated to Portuguese). Both work with the custom places.
- **When to notify**: **Always** (default), **Morning until 10h** (only up to 10:00, showing *today*'s forecast) or
  **Night after 18h** (only after 18:00, showing *tomorrow*'s forecast). Outside the chosen window the forecast is still
  fetched and shown in the panel, but no banner is sent. Manual **Test** always shows the banner.
- **Advance warnings**: with Open-Meteo, enable **Advance warnings** and choose the look-ahead (30/60/120/180 min,
  default 120 min — enough time to act without flooding the TV). One discreet banner per phenomenon per hour when the
  hourly forecast crosses the configured thresholds. All four thresholds (rain %, wind km/h, heat °C and storm code),
  the look-ahead, the on/off switches, quiet hours, sound, style and volume are editable in the panel. Warnings are silent
  by default, respect quiet hours and are sent only once per hour — the ids are saved
  in `ctx.config.weatherNotified` so a restart cannot repeat them. IPMA's public feed has no hourly data, so this
  feature only runs with Open-Meteo.

### Custom place (any town)

Under **Weather**, type a name (for example *Caldas da Rainha*) and press **Find**. Open-Meteo's geocoder
returns matching places with their coordinates; pick one and press **Add selected**. It is saved on the TV, appears in
the Place list and is used by the weather banner immediately. Up to 10 custom places; each has a small `x` to remove it.
Removing the selected place falls back to Lisboa. No coordinates need to be typed by hand.

### Notification style and sound (per tab)

| `mode` | On the TV |
|---|---|
| **Banner** | Native Samsung banner over whatever is running, no app switch. |
| **Full screen** | Full-screen card; the companion app comes to the front. |
| **Bottom toast** (shown as "Overlay bar" in older screens) | Bar near the bottom, drawn over the running picture by Notification Center 0.8.0+. `level` colours the stripe, `sound` plays immediately, opacity is a Notification Center setting. The panel label is "Bottom toast"; the API value stays `mode: "overlay"`. |

Each section has its own **Sound** switch (football and other sports on by default, weather and news off) and its own
**Volume** (10-100, default 100), sent to Notification Center as `volume`.
Sport notifications use the `reward` sound by default (all events and other sports); the module's Sound switch still
mutes them. Goal banners always name the scorer when the source provides
one — the name appears in both the title and the message, with the minute. ESPN scorers are read from the scoreboard
details or the event summary (including `participants` with an explicit `scorer` role); API-Football events carry the
player directly. A goal detected only by a score change reuses the scorer from the summary if it is already known.

A global rate limit applies to **all** modules: at most **4 banners per minute**, at least 1 s apart. Excess banners wait
in a small queue (max 12) and are delivered when a slot frees. The queue is bounded: once full, the oldest (stale) banner
is dropped and logged, so a burst cannot grow memory without limit. Civil-protection warnings with `priority: "high"`
bypass the limit. `/api/state` and `/api/last` report `notify.queued` and `notify.sentMinute`, and a failed POST to the
Notification Center (transport error or HTTP 4xx/5xx) is written to the log. The drain timer is cancelled correctly and
no banner is delivered after the Shard stops. This protects the Notification Center's 5-slot queue from a burst of
goals, cards, news and weather at the same time.

Every notification is sent with `source: "tv-alerts"`; sport alerts also use `group: false`, so two similar banners in
the same minute are both shown (they are already deduped by event key). Sport alerts also send `image` with the club's
ESPN crest (PNG), which Notification Center uses as the icon of the bottom toast; the emoji `icon` remains the fallback
when there is no crest (e.g. API-Football teams or F1).

## Football

Follow **up to 3 clubs at once**, each with its own competitions. Adding or removing a club, sport pick or news source
saves immediately — no need to press Guardar. Add a club by picking its league and team; the panel
pre-ticks that country's league and cup plus the European competitions, and you can tick or untick any of them:

- Portugal: Liga Portugal, Taça de Portugal
- England: Premier League, Championship, FA Cup, League Cup
- Spain: La Liga, LaLiga 2, Copa del Rey
- Italy: Serie A, Serie B, Coppa Italia
- Germany: Bundesliga, 2. Bundesliga, DFB Pokal
- France: Ligue 1, Ligue 2, Coupe de France
- Netherlands: Eredivisie
- Europe: Champions League, Europa League, Conference League

Each competition is fetched once per cycle and shared by every club that follows it, so two Portuguese clubs mean one
request, not two. A competition with no matches is skipped for 5 minutes, one with matches for 2 minutes, and one with
a live match (or a kick-off within 30 min) is polled every 20 s. The scoreboard only ever shows a match of one of your clubs.

**Next match**: **SETUP → Right now** also lists the next fixture of each club ("Sporting CP: Sporting CP × FC Porto ·
Sat 29 Nov, 20:30"). It is found by scanning the competition scoreboards day by day (ESPN accepts one date per request),
shared between clubs and cached for an hour. In **Football → Style** you can turn on **Warn before kick-off** and pick
0/15/30/60 minutes (30 by default): one overlay banner per fixture is sent inside that window. Nothing is shown while
the match is live. The banner title is exactly **PRE-MATCH** (the teams and local kick-off time are in the message). The
**Test: kick-off warning** button shows the same banner on demand without using up the real alert. Already-warned
fixture ids are saved in `ctx.config.nextNotified` (max 20), so a TV restart inside the window does not repeat the banner.

**Per-club alerts**: each club can override the global alert switches — goal for my club, opponent goal, cards,
substitutions, disallowed goal, kick-off, half-time, full time. The club card shows `inherited (global)` until you tick
one of them; **Use global** removes the overrides. Other sports keep their own global switches.

**Test with a club**: the test buttons at the bottom of Football act for the club picked in **Test with**. The banner
takes that club's name, crest and style, so a club with custom alerts or a different competition setup can be checked
without changing the others. Tests ignore the alert switches on purpose (a switch that is off still sends its test),
and they never edit the followed clubs or consume the real kick-off warning.

**Club news**: tick it on a club (Football tab only) to get headlines about that club (Google News, in the panel language) in the News module. The old duplicate **Club news** card in the News tab was removed, so the same club is never configured or announced twice.

## Goal simulation (inside Football)

A **Goal simulation** section inside the Football tab has one button per club with its ESPN crest (40×40), name and score
line. Pressing a button sends a
real notification through the same `banner()` path used by real goals, with `level` (stripe colour), `mode: "overlay"`,
`theme: "sport"`, `image` (PNG crest), `duration: 8`, `group: false` and **no sound**. The result is shown in the panel.
The default list is Sporting (2250, `ok`), Benfica (1929, `alert`), Porto (437, `info`) and Feyenoord (142, `alert`) —
useful for testing Porto–Feyenoord. The list is editable in the panel (add by name/ESPN id/message/colour, change the
colour, remove a club) and is stored in `config.sim.clubs`, separate from the clubs the Shard actually follows.

## Proteção Civil (column in the Weather tab)

A separate module polls three official/complementary sources every 10 min and sends only what is relevant to the chosen district:

| Source | What it gives | How it is shown |
|---|---|---|
| **IPMA** — `https://api.ipma.pt/open-data/forecast/warnings/warnings_www.json` | Warning type, district (`idAreaAviso`), level and validity | Red → `alert` + overlay; orange → `warn` + overlay; yellow → discreet banner (off by default). Only the selected district (Leiria by default) and still-valid warnings are used. |
| **ANEPC** — `https://prociv.gov.pt/pt/avisos-a-populacao/` | Official "Avisos à população" with date and link | Priority notice with a link to the official statement. |
| **Notícias ao Minuto** — `https://www.noticiasaominuto.com/rss/ultima-hora` | Breaking news | Only when the title contains one of the configured keywords (emergência, estado de alerta, evacuação, corte, sismo, incêndio, inundação, acidente grave, INEM, GNR, PSP, fecho). Off by default. |

The tab lists the active warnings with source, level, validity and official link, and has controls for district, levels,
sources, keywords, interval, duration, sound and style. The first poll is a baseline; each alert is announced once
(stable id = source + area + type + start). **Test** always shows a banner: it reuses the highest-priority allowed active
warning even if it was already announced, or a clearly labelled sample when there is none (and works with the module
switched off). Everything is sent through Notification Center — the Shard never draws on the TV itself.

An emergency warning from ANEPC always takes precedence over a generic news story; a coastal yellow warning is shown
as such, not as a general urban emergency. No routine police/fire news is shown without a matching keyword.

## Other sports

Add up to **10 picks**: NBA, MLB, NHL, NFL and Formula 1 (the whole race, with the winner at the end). Several picks of
the same sport are allowed: team picks are identified by sport + team id, race picks by sport + ESPN event id (older
configs fall back to the name), and each keeps its own watch and baseline. In Formula 1 the second selector lists the
**whole season** from `/api/races` (ESPN `?dates=YYYY`, 25 races in 2026, cached 6 h and sorted by date), so two Grands
Prix can be followed at once and each announces its own winner. If the season list cannot be loaded, **Add** is disabled
rather than storing a pick without an event id, and an old pick whose race no longer exists is left empty instead of
following (and announcing) the first race on the board. The sport
list starts at **Nenhum / None** (Add stays disabled until a sport is chosen, and also when the cap is reached). Alerts:
start, half/period, end and (optional, off by default) score changes.

## News

Pick **several sources**; each keeps its own history, so a new headline in any of them is announced once:

**Google News (PT)** — `https://news.google.com/rss?hl=pt-PT&gl=PT&ceid=PT:pt-150` — is the default and only source on a fresh install.
RTP, Público, Observador, Record and Maisfutebol (PT); BBC, CNN, Sky News, New York Times, Wall Street Journal and ESPN
(EN); Reuters and AP through Google News (they no longer publish a public RSS feed).
Per-source **headlines per check** is 1-3. The first read of a source is only a baseline.

## Providers

| Provider | Key | Notes |
|---|---|---|
| **ESPN** (public scoreboard) | none | Default. Unofficial, can change without notice. Polls every 20 s while a match is live, otherwise every 2-3 minutes; the summary (scorer, cards, substitutions) is fetched at most once a minute and kept until after the final whistle, so the last goal is not repeated. |
| **API-Football** | your own key, free plan 100 requests/day | Experimental, football only, and **out of scope by decision**: ESPN is the provider to use. The code and the **Check key** button remain, but no key was ever tested. One `/fixtures?live=all` covers every club; when nothing is live it asks each club for its next fixture at most once every two hours. |

No API-Football key is shipped in this repository. The key is stored in `ctx.config` on the TV only and is never returned to the panel.

## Network and permissions

- Permissions: none (no `exec`).
- Outgoing HTTPS: `site.api.espn.com` and `a.espncdn.com` (club/race crests sent as `image` to Notification Center),
  `v3.football.api-sports.io` (only with a key), `api.open-meteo.com`, `geocoding-api.open-meteo.com` (custom places),
  `news.google.com`, the selected RSS hosts (CNN is plain HTTP), and for civil protection `api.ipma.pt`, `prociv.gov.pt`
  and `www.noticiasaominuto.com`. The set is fixed by the code and the config only accepts known feed ids.
- Local: `POST http://127.0.0.1:8099/plugins/notification-center/api/notify`.
- Stored in `ctx.config`: modules, clubs with their competitions, other sports, news sources, options and, if set, the
  API-Football key. Match baselines, seen events and news baselines are persisted in `ctx.config.history` so a restart
  does not repeat alerts; the log and the live status lines are memory only.

## Build, install, test

The Shard is plain ES5 for the TV's Node 4.4. All shipped sources are ASCII (unicode is written as `\u` escapes or HTML
entities). `index.js` keeps the HTTP client, banners, config, watches, polling, scheduler and routes; `providers/espn.js`,
`providers/af.js` and `news.js` hold the providers and the news logic and receive their dependencies by injection. The
bundle has 8 files, well below the 20 files / 512 KB limit.

The mocked tests live in `tests/` (they require `../index.js`, so they need no TV or network). Run them all with:

```bat
node tests\run.js
npm test
npm run lint:es5
```

The runner requires each script to exit 0 **and** print `ALL GOOD`, so a test with no assertions cannot pass silently.
`npm run lint:es5` rejects ES6+ syntax in the four shipped Node files. `.github/workflows/test.yml` runs both checks on
every push and pull request (Node 20, no TV needed).

Use the script — it runs the Notification Center drift check **first**, builds a clean staging folder, runs
`vetro check` and `vetro pack`, prints the sha256, and optionally installs and verifies on the TV:

```bat
pwsh -File build.ps1
pwsh -File build.ps1 -Install
pwsh -File build.ps1 -Install -TvIp 192.168.1.7
```

The Vetro packer is vendored in `tools/vetro/` (MIT, see `tools/vetro/LICENSE`), so no clone in `%TEMP%` is needed.
The script also refuses to pack when the docs do not mention the manifest version, and prunes old bundles after a
successful pack (keeps the current one and its predecessor). Staging is `build/stage`; both `build/` and `dist/` are
gitignored. Pack from a folder that does **not** contain
`dist/`: the packer bundles every subfolder, so `dist/` inside the project ends up inside the `.vplugin` (that is how a
88 KB shard became 261 KB). The script copies `index.js`, `ui.html`, `manifest.json`, `README.md`, `LICENSE`, `news.js`
and the `providers/` folder (`espn.js`, `af.js`) — the modules are loaded with local `require()` and will fail on the TV
if missing. Installing manually is `POST http://<TV-IP>:8099/plugins/install` (bundle as body, header
`X-Vetro-Sha256: <sha256>`), then `POST /plugins/match-alerts/enable`; updating = disable, install, enable.

Panel buttons show a spinner then a green/red flash. Routes: `/api/state` (full state, panel only), `/api/last`
(read-only public view: `version`, `at`, `status`, `watches`, `next`, `civ`, `last`, `notify`, `health`, `log`; no config or keys),
`/api/teams` (POST with `sport`/`league`), `/api/races` (whole F1 season for the picker, with a `season` flag and a
current-scoreboard fallback),
`/api/geocode` (POST with `name`), `/api/config`, `/api/test`, `/api/poll`, `/api/clearlog` (POST, empties the log)
and `/api/keycheck`. Note: Vetro's own auth gate still refuses cross-origin browser requests to plugin routes, so
`/api/last` is readable by scripts on the TV / local LAN (no `Origin` header) but not by a browser mini-site on another
host. When pairing is off it therefore shows the followed clubs, the weather line and the last results to anything on
the LAN — by design, since it carries no config or keys. Disable the Shard or keep pairing on if that is not wanted.

## Tested / not tested

- Tested on a Samsung Q70C (Tizen 9, Vetro 0.7.0): install/update, preserved configuration, sport/weather/news timers,
  weather and news banners, and **real ESPN goal and red-card banners with scorer and minute**.
- 0.4.3 verified with mocked provider answers: two clubs with different competitions, other-sport score change, opponent
  goal, three news sources at once (RTP, CNN and club news), `source`/`group`/`sound`/`mode` in the notify body, the
  config route (clubs and sources) and the migration of the old single-team config.
- 0.4.5 verified with mocked provider answers: geocoding by name, saving a custom place, the place appearing in the
  panel list and the weather banner using its coordinates, bad coordinates rejected, and removing the selected place
  falling back to Lisboa.
- 0.4.6 verified with a focused mocked test (`test_robust.js`): a failing competition no longer hides the other
  clubs, two clubs in the same match make one summary request, the scoreboard cache follows a 20 s / 2 min / 5 min
  schedule, and a news poll never sends more than 4 banners (at least 1 s apart), with leftovers kept for the next poll.
- 0.4.9 verified with `test_next.js`: the next fixture appears in `/api/state`, the day scan stops at the first match
  and reuses its cache, the pre-kick-off banner is sent only once, and disabling the warning stops it.
- 0.5.16 verified with mocked tests: Google News (PT) as the only default source, the 3-club cap, and the sound
  fallback when the Notification Center does not offer `golo` (it was added, withdrawn and re-added in 0.10.0).
- 0.4.x verified on the TV: tabs filled again (the panel asked for `…/api/api/state`, which 404s; the API base is now
  taken from `location.pathname` without the trailing `/ui`), football/news/weather tests all sent banners, adding a
  club through the panel and saving it worked, and the news **Test** button now shows the newest headline even when no
  new one arrived since the last poll.
- Not tested on the TV: **API-Football with a real key** — out of scope by decision (no key was available, ESPN is the provider).
- 0.5.30 verified with mocked tests: two basketball picks of the same sport produce two independent watches, repeated
  picks are deduped, `/api/last` carries no config or key, and the module split preserves the existing flows. Verified on
  the TV: version 0.5.30, all six tabs render with zero console errors.
- 0.5.31 verified with mocked tests (`tests/run.js`, 17 scripts): two F1 picks selected by ESPN event id follow two
  different races and announce two different winners; `/api/races` lists both races; `test_flow.js` now asserts the
  sport/weather/news flow instead of only printing it.
- 0.5.32: hygiene only — shipped sources are pure ASCII, `dist/`/`build/` are gitignored, and `build.ps1` runs the NC
  check before pack/install (verified with `pwsh -File build.ps1 -Install`).
- 0.5.33 verified with mocked tests (`tests/run.js`, 19 scripts): `/api/races` lists the whole F1 season sorted by date
  and falls back to the current scoreboard; the banner queue is bounded and drops are logged; failed notify POSTs are
  logged. The race picker disables **Add** when no race list is available. CI runs the same tests on every push.
- 0.5.34 verified with mocked tests (`tests/run.js`, 20 scripts): provider health is recorded for success/failure and
  exposed in `state`/`last`, `POST /api/clearlog` empties the log, all panel `data-t` keys are translated (`mode` was
  missing), and queue drops are logged as `notify/queue`. The duplicate club-news card was removed from the News tab;
  club news is configured only in Football.
- 0.5.35: new **Technical** tab holds Diagnostics (moved out of General), and the civil-protection **Test** button
  always announces a banner even when warnings are already seen, none are active, or the module is switched off.
- 0.5.36: the General tab is now **SETUP**, and its four module switches show/hide the matching tabs (Sport covers
  Football + Other sports, Civil protection uses `civ.enabled`); SETUP and Technical stay visible and parameters are
  preserved when a tab is hidden.
- 0.5.37: full code audit fixed orphan banner timers, post-stop notifications, unlogged NC HTTP errors, civil-warning
  escalation lost to dedupe, manual tests racing with polls, stale F1 picks following the wrong race, legacy baselines
  stalling sport polling, malformed query escapes, explicit empty sim lists being restored, silent config type coercion,
  and next-hint/weather-warning retention. 21 mocked tests, including new audit regressions.
- 0.5.38: design/a11y pass — light and dark themes (`color-scheme`), shared tokens, centered `max-width:1040px`,
  `role`/`aria-live`/`aria-selected` and `hidden` panes, focus ring, two-click Clear log, friendly offline error, and
  `curl`/route examples in the Technical tab. Added a **Control center card** with four "Check now" actions plus the
  next fixture, `civ`/`health` in `status()`, and an ES5 syntax gate in CI.
- 0.5.39: half-time detection fix — ESPN's `First Half` / `Second Half` are playing time, not the
  interval; only `Halftime` / `Half Time` / `HT` / `Intervalo` with state `in` announce "Intervalo".
  A kick-off no longer sends both "Começou o jogo" and "Intervalo". 22 mocked tests.
- 0.5.40: penalty alerts — ESPN's `Penalty - Saved` / `Penalty - Missed` (scoringPlay=false) now
  announce "Penalty falhado" with the taker's name; `Penalty Awarded` announces "Penalty marcado";
  a scored penalty remains a goal. Two new switches in the Football tab, default on. 23 tests.
- 0.5.41: official name **NEWS** (id `match-alerts` unchanged). Panel merged into five tabs with Sport sub-tabs and a two-column Weather tab; `check-nc.ps1` keeps a snapshot per TV; `build.ps1 -Install` accepts several IPs. README documents compatibility with the catalog's Notification Center 0.3.1 and the newer 0.8.0+ features.
- 0.5.42: all 41 checkboxes replaced by Vetro-style on/off switches (`role="switch"`, pill and sliding knob, On/Off label synced on change and after each render).
- 0.5.43: the four module switches in **SETUP → Modules** are laid out horizontally in columns instead of a vertical list.
- 0.5.44: tab order matches the module order — SETUP, **Sport**, **Weather**, **News**, Technical (civil protection stays a column inside Weather).
- **`mode: "overlay"` confirmed working** with Notification Center 0.8.0.
