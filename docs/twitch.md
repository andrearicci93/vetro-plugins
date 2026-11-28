# Twitch Shard implementation

See the [Twitch Shard README](../plugins/twitch/README.md) for installation, options and usage.

## Code map

Start with [the Shard entry point](../plugins/twitch/index.js). It reads the enabled features, starts the session manager and attaches each enabled feature once the inspector is ready. Each feature implements `start`, `attach`, `connected`, `detach` and `stop`. Switching off the last feature runs feature cleanup before ending the session.

| Module under `plugins/twitch/` | Responsibility |
| --- | --- |
| `index.js` | Vetro lifecycle, saved settings, feature reconciliation and HTTP routes |
| `session-manager.js` | Detect Twitch, prepare the protected session and clean it up |
| `session-shell.js`, `session-shell/*.sh` | Assemble root commands for process identity, launch, firewall rules and recovery |
| `inspector-client.js` | Select the local Twitch page, exchange CDP messages and manage one document script per feature connection |
| `filter/index.js` | Manage network interception, auxiliary HTTPS requests and the response sent back to Chromium |
| `filter/playlist-filter.js` | Select a clean master at startup and aligned media replacements during playback |
| `emotes/index.js`, `emotes/chat-renderer.js` | Track the current channel and render emotes in chat |
| `public-data.js` | Fetch and cache public emote catalogues, channel IDs and avatars |
| `accounts/index.js` | Coordinate the chooser, native sign-in, account changes and recovery |
| `accounts/session.js` | Talk to the account page and verify Twitch identity and cookie changes |
| `accounts/store.js` | Encrypt and atomically store sessions and the recovery journal |
| `accounts/page.js` | Profile button, account chooser and sign-in controls |
| `page-actions.js` | Live player navigation and channel point claims |
| `twitch-page.js` | Shared page code for native session discovery, translations and notifications |
| `ui.html` | Dashboard settings and status |

## Session lifecycle

The Vetro launcher can hand Twitch launches to the Shard. The Shard starts or resumes a protected session, and Vetro can fall back to a normal launch. For launches outside Vetro, the session manager polls the registered Twitch process and prepares a session when it comes to the foreground. A failed preparation avoids repeatedly restarting the same normal Twitch process.

Tizen reports the dynamic inspector port after opening it. Before requesting a debug launch, the root script blocks new inbound TCP connections on non-loopback interfaces in IPv4 and, when supported, IPv6. After launch it verifies the process and port, installs port-specific rules and checks for an IPv4 listener. It refuses an IPv6 inspector listener. The temporary rules are removed before the ready state is published. The manager rechecks the port-specific rules while the session is active.

The preparation and cleanup scripts share a kernel lock through `flock`. It is released when its owning shell exits. A PID and kernel start time identify the Twitch process across PID reuse. One independent shell guard handles interrupted preparation. Another retires the port-specific rules once the listener is confirmed closed, even if Vetro exits. An unavailable socket table defers cleanup. Normal Twitch is relaunched on disable when the owned debug instance was in the foreground and its port has closed.

The shell programs are assembled from bundled sources and passed to `sh` through stdin. The polling command uses only the read helpers. Preparation, cleanup and the guards also use the mutation helpers. Root-owned session metadata is kept in `/run/vetro-twitch-session`.

CDP discovery accepts one hosted Twitch TV page and connects through the inspector's loopback address. The WebSocket client handles framing, ping/pong and command deadlines directly to support the TV's Node runtime. Ad filtering, 7TV, accounts and page actions each own a connection. The shared document-script registration keeps the identifier even if the feature stops during registration, so the feature can still remove the script before closing its connection. The coordinator cancels stale attachments when the session changes and retries failed features. Settings are persisted before runtime changes.

Vetro's plugin host controls safe mode. When the host suspends external Shards, the Twitch module is stopped and its routes return **Plugin not running**. Resuming Shards requires restarting Vetro before session preparation can resume.

## Ad filtering

The filter maps v1 and v2 Twitch live masters to their renditions. It ignores the HLS delivery directives when identifying a rendition and keeps the rest of its query string. At startup it spends up to 650 ms checking one video rendition for ad markers. If it detects a pre-roll, it tries anonymous `popout` and `embed` playback contexts within a total 4.5-second budget. A master can be replaced when the alternate preserves all rendition qualities, codecs and media groups, and its corresponding video playlist is clean. Chromium then starts on the alternate rendition URLs and adopts their media sequences.

The original and alternate renditions share a playback state. Once the filter has processed a media response, master refreshes retain their current URLs. A pending startup search also stops replacing the master if a media response arrives before it completes.

After playback starts, Twitch ad IDs, ad attributes and cue tags trigger the search for clean alternatives. The filter can substitute an entire compatible HLS window, using its original media numbering when the Twitch live sequence and segment times agree. When the windows have different lengths, it can instead preserve the tail already sent to the player and append clean segments in the new sequence slots. This requires matching rendition codecs and media groups, a program-time anchor and contiguous segment times. The filter can correct up to one second of clock skew after matching at least three live segments by Twitch live sequence, similar durations and consistent time offsets. Splicing is limited to complete, unencrypted playlists without partial segments, byte ranges or rendition reports.

During an ad break, the filter searches `popout` and `embed` in parallel and probes up to two matching rendition URLs per context. It skips the original URL and duplicate candidates. The ordering prefers strict alignment, a window that adds segments, matching media groups, a smaller program-time gap for experimental joins, and a newer playlist tail. The filter rechecks the chosen URL on subsequent refreshes and searches again if that feed becomes unusable. Searches with no usable candidate are throttled for 20 seconds.

The filter adds a discontinuity when changing sources and keeps previously sent segment URLs when appending native segments again. The experimental fallback can append segments from a clean feed of the same rendition when strict alignment fails. It keeps the media numbering and timestamps already presented to the player, then continues from the selected feed's sequence as its playlist advances. After the ad markers disappear, it appends native segments at another decoder boundary. Both feeds must use complete, unencrypted playlists.

The playlist processor resolves alternate media URLs and builds the replacement body. The interceptor preserves CORS headers, makes synthetic responses non-cacheable and resumes each request in Chromium. For media playlists, the processor records the window after the interceptor reports which response was delivered. The interceptor uses the original response when a usable replacement is unavailable or Chromium refuses the handoff.

The auxiliary HTTPS transport uses an allowlist, no app credentials and no redirects. It cancels requests on detach. Per-request deadlines and the total search budget bound the time Chromium waits. The **Ad filtered** notification follows a successful handoff to Chromium. Replacements less than 30 seconds apart share one notification group. It confirms handoff, while the player determines what it actually displays.

The `filter/status` counters report playlist handling within the current attachment.

| Counter | Meaning |
| --- | --- |
| `ads` / `unmappedAds` | Ad-marked media responses detected and the subset with no known live rendition |
| `prerollsDetected` / `prerollsReplaced` | Startup probes that detected ads / master replacements prepared |
| `prerollProbeFailures` | Startup probes that timed out or could not read their video playlist |
| `backupCandidates` | Distinct rendition URLs requested during mid-roll searches |
| `backupSearchFailures` | Mid-roll searches that found no replacement for the playlist that started the search |
| `timelineMismatches` | Alternate media windows rejected for incompatible timing |
| `timelineRejections` | Counts by first failed check, including unsupported playlist formats |
| `replacements` / `rebased` | Replacements prepared for Chromium and the subset that kept the original media numbering |
| `spliced` | Replacements prepared by appending clean segments to the previously delivered playlist tail |
| `fallbacks` | Ad responses that Chromium accepted with an experimental fallback playlist |
| `spliceRejections` | Rejections grouped by rendition, previous playlist availability, format, sequence, clock anchor, coverage or segment boundary |

These count playlist operations. A single ad break can span many playlist refreshes. The indicator counts successful handoffs separately.

## Chat and player controls

The 7TV renderer matches emote tokens in chat message bodies. It preserves React's original text nodes, native Twitch images, usernames and links. Global and current-channel catalogues are cached. Channel aliases take priority. A stale catalogue response is discarded after a channel change. A failed image falls back to the original token.

The navigation script uses Twitch's own player visibility state to hide and show the live controls. It handles Back or OK only when those keys should toggle visibility, and consumes the matching repeat and release events. Chat, menus and the account chooser retain their key handling. If the expected Twitch player component is unavailable, Twitch handles the keys normally.

Edit the `locales` object in [twitch-page.js](../plugins/twitch/twitch-page.js) to update account labels and notifications. Keep the `{value}` placeholders. The `native` section contains Twitch's own labels for language detection and the sign-in Back button. English is the fallback.

## Channel point bonuses

The bonus script runs only when enabled. It uses the active Twitch session inside the page to check and claim bonuses on a visible, playing live stream. A detected bonus is scheduled after a uniformly random delay of 3–12 seconds. The coordinator checks the deadline on its two-second polling cycle, so execution can take up to two additional seconds. It reads the offer again before claiming; an unavailable or different bonus is not claimed. Changing the account or stream, pausing playback, leaving Twitch or disabling automatic claims cancels the scheduled attempt. The account and channel are checked again before each claim. The token stays in the page and is sent only to Twitch.

Vetro saves hashes of the last 128 claims accepted by Twitch to avoid duplicates across reloads. After a failed request it waits two minutes and checks whether Twitch still offers the same bonus before trying again. The dashboard shows when the Twitch session or channel points are unavailable, when a bonus is scheduled, and when the claim or confirmation fails. The dashboard and optional notification report confirmed credits after Twitch accepts the claim, removes the offer and reports an increased balance. The remote navigation and bonus scripts share one CDP connection. Only the selected scripts are registered for new documents.

## Accounts

The account manager saves up to eight profiles. The vault accepts only the supported Twitch authentication cookies for the root path. It encrypts profiles and pending changes with AES-256-GCM in the private `.twitch-accounts` directory beside the plugin. Atomic writes and a process lock protect the saved data. The encryption key is local to the TV. The vault survives plugin updates and uninstall.

Adding or switching saves the current cookies to a recovery journal before modifying the browser session. The manager uses normal Twitch sign-in for adding, validates saved accounts at `id.twitch.tv/oauth2/validate`, and verifies the native Twitch authentication state after switching or selecting Guest. Cancellation and recovery restore the previous cookies and reload Twitch. A failed restoration leaves the journal available for the next attachment.

Switching refreshes an existing saved profile. Unsaved and forgotten active sessions remain available through the recovery journal during an account change and are added to the profile list only through an explicit save. The automatic first-use capture retries after validation failures with a five-second delay.

The account script and CDP calls are scoped to the exact HTTPS Twitch TV origin seen at attachment. The page receives display metadata and sends fixed account actions. On Home, the profile button next to **Settings** shows the active username and avatar, or **Guest**. It loads only the current avatar while the chooser is closed. During an owned sign-in, the remote Back key and the supported native Back control cancel the operation. The app can still render while the protected session is being prepared.

## Dashboard API

Routes are relative to `/plugins/twitch/api/` and use Vetro's authentication.

| Method | Path | Result |
| --- | --- | --- |
| GET | `ui` | Dashboard HTML |
| GET | `status` | Settings, session and feature status |
| GET / POST | `settings` | Read settings or persist a partial update of known boolean options |
| GET | `filter/status` | Network, replacement and indicator counters |
| GET | `emotes/status` | Catalogue counts and renderer status |
| GET | `accounts` | Saved profile metadata and operation status |
| POST | `accounts` | Fixed account actions with a saved numeric ID when required |
| POST | `retry` | Clear preparation and attachment backoff |

The accounts route accepts `capture`, `add`, `switch`, `cancel`, `manage`, `choose`, `dismiss`, `forget` and `forget-all`. The in-app chooser also offers Guest. The HTTP API does not return account cookies or tokens, and it does not accept arbitrary CDP commands.

## Runtime bounds

| Resource | Bound |
| --- | --- |
| Concurrent playlist processing | 8 requests |
| Initial ad probe | 650 ms |
| Auxiliary response and deadline | 512 KiB and 1.8 seconds |
| Alternate playlist search and retry | 4.5-second total search budget and 20-second retry cooldown for media replacements |
| Emote catalogue response and deadline | 3 MiB and 6 seconds |
| CDP message and command deadline | 2 MiB and 5 seconds |
| Encrypted account vault | 8 profiles and 256 KiB |
| Settings and account action request bodies | 512 and 256 bytes |

Automated tests cover playback fallbacks, page behavior, account recovery and simulated firewall transitions. Verify the native Twitch UI, ad-break continuity and firewall behavior on the target TV. The TV app's routes, React state and Twitch queries are private implementation details that can change.

References include [Samsung Web Inspector](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/web-inspector.html), [Twitch token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/), [TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions) and the [7TV catalogue API](https://api.7tv.app/v3/emote-sets/global).
