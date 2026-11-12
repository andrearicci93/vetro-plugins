# Twitch enhancements

Ad filtering, animated 7TV emotes, improved remote navigation, channel point bonuses and account switching for the official Samsung Twitch app.

## Install

The Shard needs Vetro plugin API 1, a working root backend and the Samsung Twitch app (`Jz7aUrV2Q4.Twitch`). The TV must support web-debug launch, `flock` and `iptables`. IPv6-capable TVs also need `ip6tables`. Ad filtering uses Chromium's network interception commands.

Install [twitch-1.0.0.vplugin](../../dist/twitch-1.0.0.vplugin) through Vetro Shards, then enable **Twitch enhancements**. An unsigned local bundle requires **Developer mode** in Vetro Shards during installation.

Open Twitch from the Vetro launcher or Samsung Home. On Vetro builds that support Shard launch interception, the Vetro tile can start a protected session directly. Opening from Samsung Home may restart Twitch once to prepare that session. If preparation fails, Twitch can open normally. Use **Retry preparation** in the dashboard to retry the enhancements.

## Options

| Option | Default | Behavior |
| --- | --- | --- |
| **Ad filtering** | On | Tries to avoid ads when a live stream opens. During playback, it compares clean feeds of the same quality and prefers a feed that aligns with the current stream. |
| **Use a backup when ad playlists cannot be aligned (experimental)** | Off | Tries the clean feed at a decoder boundary when strict alignment fails. Playback can skip ahead or stall during a switch. Requires ad filtering. |
| **7TV chat emotes** | On | Renders global and channel emotes, including animated emotes. Channel aliases take priority. |
| **Improved remote navigation in live streams** | On | Back hides visible controls before leaving the stream. OK reveals hidden controls before it can activate the focused button. |
| **Show an indicator when an ad is filtered** | Off | Shows **Ad filtered** in the top right after Chromium accepts a replacement playlist. Requires ad filtering. |
| **Automatically claim channel point bonuses** | Off | Claims available watch bonuses after a random 3–12-second delay, while Twitch is in the foreground and video is playing. |
| **Show a notification when a bonus is credited** | Off | Shows the confirmed points briefly in the top left. Requires automatic claims. |
| **Manage multiple Twitch accounts** | Off | Adds a profile button on Twitch Home and saves up to eight sessions on the TV. |
| **Choose an account when Twitch opens** | On | Opens the chooser once the session is ready and at least two accounts are saved. Requires account management. |

Vetro saves changes automatically. The initial ad check can add up to 650 ms when opening a live stream. If it detects an ad, the total search budget is 4.5 seconds. Twitch can still show ads when no compatible alternative is available or when the filter cannot recognize the ad format. The ad indicator confirms the replacement reached Chromium. The bonus indicator appears after Twitch confirms the credit.

The account screens and notifications on the TV follow Twitch’s language. English, French, Italian, Spanish, German and Portuguese are available, with English for unsupported languages. This applies only to the text added inside Twitch.

## Switch accounts on the TV

Enable **Manage multiple Twitch accounts**. The Shard saves the current signed-in account on first use. On Twitch Home, the profile button next to **Settings** shows the current username and public avatar, or **Guest**. From **Settings**, press **Right** and then **OK** to open the chooser. The avatar falls back to initials while the image is unavailable.

- **Add account** opens Twitch sign-in. Complete it on the official Twitch site. The Shard detects and saves the new account. The remote's **Back** key or the supported on-screen **Go Back** control cancels sign-in and restores the previous session.
- Select a saved profile to switch. Twitch reloads and the Shard verifies the active account. An expired or revoked session can be reconnected through normal Twitch sign-in.
- Select **Guest** to watch signed out. Saved sessions remain available in the chooser.
- Use **Manage accounts → Forget** or **Forget all saved accounts** in the dashboard to delete saved copies. Forgetting a profile leaves the active Twitch sign-in in place. Use **Save current account** to save it again.

Saved sessions and pending account changes are encrypted on the TV. The local key and vault are kept in a private directory beside the plugin so that accounts survive updates. This storage also survives uninstall. Use **Forget all saved accounts** before removing the Shard if you want to erase the saved sessions.

## Permissions and network access

The Shard uses `exec` to start and stop Twitch and configure its inspector's firewall rules. Before requesting a debug launch, it temporarily blocks new inbound TCP connections on non-loopback interfaces. Established connections continue. Once the inspector port is isolated, the Shard removes the temporary rules.

| Destination | Purpose |
| --- | --- |
| `127.0.0.2:<session port>` | Local connection to the Twitch TV page through Chromium's inspector |
| `id.twitch.tv` | Twitch token validation for account management |
| `gql.twitch.tv` | Anonymous playback, channel and avatar lookups. Authenticated bonus requests run in the Twitch page when enabled. |
| `usher.ttvnw.net` and other `*.ttvnw.net` media hosts | Alternate live playlists |
| `api.7tv.app` and `cdn.7tv.app` | 7TV catalogues and emote images |
| `static-cdn.jtvnw.net` | Public avatars for the profile button and chooser |

The Shard does not send chat text to 7TV. Image hosts receive the TV's normal image requests. The dashboard reports account names and status without exposing session cookies or tokens. See the [implementation guide](../../docs/twitch.md) for stored data, commands and lifecycle details.

## Commands it runs

- `app_launcher` inspects, starts and stops the Twitch app. `id` resolves the TV's app user, and `vconftool` identifies the foreground app.
- `iptables` and `ip6tables` manage the inspector's firewall rules. `netstat` checks whether the inspector port is listening.
- `awk`, `grep`, `sed`, `head` and `cat` read process identity from `/proc` and parse runtime state and launcher output.
- `flock` serializes session changes. `mkdir`, `touch`, `stat`, `chmod`, `mv` and `rm` maintain root-owned state.
- `base64` and `sh` pass the bundled programs through stdin. `nohup` runs the recovery guards independently of Vetro. `sleep`, `kill` and `wait` coordinate launch and cleanup.
- Shell builtins `test` (`[`), `read`, `echo` and `printf` handle state and output. `command`, `set`, `umask`, `exec` and `trap` check tools and manage the process, lock and cleanup. `break`, `return`, `exit` and `true` control the shell routines.

The bundle contains the JavaScript and shell sources. The standard catalog builder assembles them and `npm run check` verifies the generated bundle in CI.

## Disable and restore

Switch the Shard off, or turn off all of its features, to close the protected session. If Twitch is in the foreground, it may restart normally and reset the current stream or screen. The Shard keeps the port protected until it can confirm that the inspector has stopped listening.

If Vetro shows **Suspended**, resume third-party Shards and restart Vetro. Vetro's safe mode pauses external plugins after an interrupted startup. **Retry preparation** applies once the Twitch Shard is running.

## Verify

Run `npm test`, `npm run check` and `npm run test:runtime` from the repository root. On a target TV, verify startup and shutdown, remote focus, switching accounts and live playback across an ad break. Firewall isolation is a device and network check.

The alternate playback approach is based on the technique documented by [TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions). The implementation is materially AI-assisted. The Shard uses its bundled code at runtime.
