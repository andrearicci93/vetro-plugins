# Keyboard & Remote

Type text in any language from your browser into focused input fields on your Samsung Smart TV, view a live 1080p screen preview, and control your TV with full navigation, volume, channel, media playback, and interactive color keys.

<p align="center">
  <img src="../../docs/assets/keyboard-preview.png" alt="Keyboard & Remote Preview" width="700">
</p>

## What it does

Adds a unified **Keyboard** tab to the Vetro dashboard:
- **Text Input & Direct PC Keyboard Typing:**
  - **Instant Physical Keyboard Typing:** On PC, any letter (lowercase or uppercase with <kbd>Shift</kbd>), digit, space, symbol, or pasted text (<kbd>Ctrl+V</kbd>) typed on your keyboard is sent directly to the TV the moment you press the key—without having to focus the input box or press Enter/Send. Non-ASCII languages (such as Arabic) automatically accumulate characters into words and phrases via direct text buffering, and Backspace seamlessly deletes the last character.
  - **Direct Remote & Editing Shortcuts:** Press <kbd>Enter</kbd> to send typed text (in input box) or submit focused field / URL bar (outside input box), <kbd>Ctrl+Enter</kbd> to send an `OK` (`Return`) click, <kbd>Ctrl+S</kbd> to open Search, <kbd>Ctrl+A</kbd> to Select All, <kbd>Ctrl+Z</kbd> to Undo, <kbd>Backspace</kbd> to delete on TV, <kbd>Escape</kbd> to go Back, <kbd>Home</kbd> to open TV Home, and <kbd>Arrow keys</kbd> to navigate.
  - **Dynamic Device Pairing Name:** Automatically identifies pairing requests on your TV screen by device OS and per-install anonymous ID (e.g. `Vetro (Windows #7c1e)`, `Vetro (Android #a3f2)`) and isolates saved pairing tokens per device so phones and PCs stay paired independently.
  - **Mobile On-Screen Keyboard Support:** In fullscreen theater mode (`#screen`), mobile devices keep the input box docked at the bottom so you can tap to summon the mobile virtual keyboard, while PC hides it to maximize 100% vertical screen space (with a `⌨ Input` toolbar button to toggle on/off at will).
- **Interactive Live Screen Preview (Hardware + Wayland):** Expandable full-width TV display preview supporting **Hardware Direct ASIC Capture** (capturing broadcast TV, HDMI inputs, and hardware-decoded video alongside OSD UI on supported SoCs via `libsec-video-capture.so.0` + `libturbojpeg.so.0`) with **automatic Wayland GStreamer fallback** and a one-click **Auto / Wayland** toggle in the preview bar. Delivers smooth low-latency streaming over length-prefixed binary frames to `<canvas>` (`GET api/stream?format=bin`) with automatic legacy `<img>` MJPEG (`GET api/stream`) and polling fallback, selectable presets (`Fast`, `Balanced`, `HD`) and JPEG quality slider (`20–95`), 1080p composite single-shot captures (`GET api/screenshot`), and direct pointer & gesture control:
  - **Pointer Mode (`🖱 Pointer`):** Tap to click, double-tap to double-click, press & hold, press & drag (for sliders, scrollbars, and text selection), right-click, `Move only` hover mode, and scroll wheel support across the entire `1920×1080` screen (browser chrome, tabs, URL bar, web pages, and pointer-enabled apps).
  - **D-Pad Mode (`🕹 D-Pad`):** Swipe or tap directional zones directly on the preview to navigate and select items in D-Pad-only apps that ignore mouse input (such as YouTube or Netflix).
- **Navigation & D-Pad:** Full directional control (`Up`, `Down`, `Left`, `Right`, `OK`), `Home`, `Back`, `Menu`, `Info`, `Exit`.
- **Volume & Channels:** `Volume +`, `Volume −`, `Mute`, `Channel +`, `Channel −`, `Previous Channel`, `Channel List`, `Guide`.
- **Smooth Continuous Hold:** Press and hold arrow keys, volume, or channel buttons on your physical keyboard or screen to smoothly and continuously scroll without lag or stutter (native press/release with a 6 s auto-release safety timeout).
- **System & Display:** `Power`, `TV / Source`, `Quick Menu`, `Search`, `Subtitles`, `MultiView`, `Aspect Ratio`, `Ambient mode`.
- **Media Playback:** `Play`, `Pause`, `Play/Pause`, `Stop`, `Fast Forward`, `Rewind`, `Next`, `Previous`, `Record`.
- **Interactive Color Keys:** Samsung remote `Red (A)`, `Green (B)`, `Yellow (C)`, `Blue (D)` buttons.
- **Numeric Keypad:** Numbers `0`–`9` and `−` for direct channel entry.

## Text Input & App Compatibility

Samsung Smart TVs handle text entry in two different ways depending on the app:
- **Native OS Input Fields (Direct Typing Supported):** Apps that use standard input fields invoke the TV's native system keyboard (such as the Samsung Internet Browser address bar, system settings, Wi-Fi password dialogs, account login screens, and web apps with native `<input>` elements). In these fields, text typed from the browser is injected directly into the active field in any language.
- **Custom In-App Keyboards (Use D-Pad Navigation):** Many TV streaming apps (such as YouTube, Netflix, or Prime Video) build their own custom on-screen letter grid instead of using the OS virtual keyboard. Because spatial focus in these apps is placed on individual letter tiles rather than a text cursor, direct text injection is not routed to their search bar. Use the remote **D-Pad** (`Up`, `Down`, `Left`, `Right`, `OK`) to navigate and select letters on their custom grid.

## Permissions

`exec` — to run `/usr/bin/input_keyevent` for remote control keys and local text input, `dbus-send` (`org.enlightenment.wm.info` for fast mouse actions and fallback screenshots), `/usr/bin/dotnet` with the bundled `hardware-streamer.dll` payload for hardware direct ASIC capture, `systemd-run` / `systemctl` / `setsid` / `nohup` for managing the capture service unit, `gst-launch-1.0` for Wayland live streaming and 1080p UI capture, and `kill`/`rm` cleanup.

## Commands it runs

| Command | Why |
| --- | --- |
| `/usr/bin/input_keyevent <keysym> [down\|up]` | Injects remote-control key taps and native press/release holds (with a 6 s auto-release safety cap) |
| `sh -c "/usr/bin/input_keyevent Control_L\|Shift_L down; /usr/bin/input_keyevent <keysym>; /usr/bin/input_keyevent Control_L\|Shift_L up"` | Sends modified key combinations (`Ctrl+A`, `Ctrl+Z`, shifted/uppercase keys) |
| `sh -c '/usr/bin/input_keyevent ...; sleep 0.04; ...'` | Chains mapped ASCII key events (wrapping uppercase and shifted symbols in `Shift_L down/up`) with `sleep 0.04` between characters for local text typing |
| `dbus-send --system ... /org/enlightenment/wm org.enlightenment.wm.info.{init_device,mousegen,deinit_device}` | Provides native TV scroll wheel events and fast fallback cursor movement, clicks (`usleep 60000` for double-clicks via `sh -c`), and drag/hold (with 8 s idle auto-deinit and 6 s inactivity / 30 s max auto-release timeout) when WebSocket is unavailable |
| `DOTNET_ROLL_FORWARD=Major /usr/bin/dotnet '<dir>/runtime/hardware-streamer.dll' --probe --abi <abi>` | Runs an isolated short-lived hardware capture probe (`ilp32` on 32-bit; `lp64-int`/`lp64-sizet` on 64-bit TVs are **untested on real TV hardware**) to verify `libsec-video-capture.so.0` and `libturbojpeg.so.0` cleanly before enabling HW mode |
| `echo <b64> \| base64 -d \| sh` launching `command -v systemd-run` + `systemd-run --unit=vetro-keyboard-capture --collect ... -p Environment=VETRO_STREAM_TOKEN=<hex> /usr/bin/dotnet '<dir>/runtime/hardware-streamer.dll' --serve --port <ephemeral> --abi <abi> --timeout 60` (with `setsid nohup ... & echo $! > '<dir>/runtime/hw.pid'` fallback and `rm -f` on stale PID) | Starts the pull-paced hardware capture helper over `127.0.0.1:<ephemeral>` (`--serve`) with an automatic 60 s idle timeout and per-launch handshake token; resets failed unit state via `systemctl reset-failed` |
| `DOTNET_ROLL_FORWARD=Major /usr/bin/dotnet '<dir>/runtime/hardware-streamer.dll' --oneshot-hd --abi <abi> --quality 92 --out '<dir>/runtime/shot_<id>.jpg'` (inside which helper spawns `/usr/bin/gst-launch-1.0 -q waylandsrc num-buffers=1 ! video/x-raw,format=BGRA,width=1920,height=1080 ! fdsink fd=1`) | Captures a single-shot 1080p Wayland UI frame over stdout (zero `/tmp` raw file) and alpha-composites it over hardware video into a single crisp JPEG |
| `echo <b64> \| base64 -d \| sh` running `systemctl stop --no-block vetro-keyboard-capture.service` and fallback `cat` / `tr '\0' ' '` / `grep -q 'hardware-streamer\.dll'` / `kill` / `sleep 0.15` / `kill -9` / `rm -f` on `<dir>/runtime/hw.pid` | Stops the hardware capture service or verified PID cleanly when viewers disconnect, switching to Wayland, or when the Shard stops |
| `command -v gst-launch-1.0`, `WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run gst-launch-1.0 -q waylandsrc ! video/x-raw,width=1920,height=1080 ! videoscale method=0 n-threads=2 ! video/x-raw,width=<W>,height=<H> ! videoconvert n-threads=2 ! jpegenc quality=<20..95> idct-method=1 ! tcpclientsink host=127.0.0.1 port=<ephemeral> sync=false ... & echo $! > /tmp/vetro-keyboard-stream.pid` | Wayland fallback live MJPEG streamer over loopback (`640×360`, `960×540`, or `1280×720` at JPEG quality `20–95`) when `captureMode` is `'wayland'` or HW capture is unavailable |
| `if [ -f /tmp/vetro-keyboard-stream.pid ]; then pid=$(cat /tmp/vetro-keyboard-stream.pid ...); ... tr '\0' ' ' < /proc/"$pid"/cmdline \| grep -q 'tcpclientsink.*127\.0\.0\.1' && kill "$pid"; sleep 0.15; kill -9 "$pid"; ... rm -f /tmp/vetro-keyboard-stream.pid; fi` | Cleans up only the tracked Wayland GStreamer PID cleanly once no viewers remain or when the Shard stops |
| `WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run gst-launch-1.0 -q waylandsrc num-buffers=1 ... filesink location='/tmp/shot_<id>.jpg'` | Wayland fallback single-shot `1920×1080` JPEG screenshot into a unique temp file deleted immediately after reading |
| `dbus-send --system --print-reply --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.info.dump_screen string:'/tmp/shot_<id>.png'` | Final fallback 1080p PNG frame buffer snapshot from Enlightenment WM if Wayland GStreamer capture is unavailable |
| `rm -f '/tmp/shot_<id>.jpg'` / `rm -f '/tmp/shot_<id>.png'` | Fallback cleanup when deleting a temporary Wayland/D-Bus screenshot file |

## Network

| Host | Port | Protocol | Why |
| --- | --- | --- | --- |
| TV IP | `8002` | WSS (TLS, encrypted) | Samsung Remote WebSocket API (2019+ TVs) — injects full Unicode text in any language directly from the browser, and provides native hardware key press/release. Plaintext port 8001 is intentionally not used to prevent sending keystrokes or tokens unencrypted over the LAN. |
| `127.0.0.1` | Ephemeral (OS-assigned) | TCP | Internal localhost loopback listener bound to `127.0.0.1:0` only while live stream viewers are connected (`hardware-streamer.dll` and fallback `tcpclientsink` connect locally, avoiding fixed-port conflicts; all client streaming stays on Vetro's HTTP API route). |

## Data it keeps

`config.json` (file mode `600`) stores a random 128-bit per-install `salt`, a per-device `tokens` map (capped at 16 devices) keyed by a truncated `HMAC-SHA256` of the caller's device identity (resolved for the single matching IP from read-only `/proc/net/arp`, falling back to IP if routed across subnets, matching how Samsung TVs bind port `8002` tokens by client MAC), optional `streamPreset` (`"fast"`, `"balanced"`, `"hd"`) / `streamQuality` (`20–95`), and `captureMode` (`"auto"` or `"wayland"`) preview preferences. No raw MAC addresses or client IPs are stored on disk or transmitted. `status()` and `GET api/status` only expose `paired: true/false` so raw tokens never appear in the Vetro Shard detail view; `GET api/status` also returns non-sensitive `capture` backend diagnostics (`mode`, `activeBackend`, `hwAvailable`, `hwBackend`, `hwArch`, `hwAbi`, `hwReason`). Because Vetro renders Shard pages inside a sandboxed iframe without `localStorage`, the Shard page reads its own saved token on load via `GET api/token` (`Cache-Control: no-store`) so each device can reconnect to port `8002` without re-prompting "Allow" or overwriting other devices.

Extracted helper files (`hardware-streamer.dll`, `.runtimeconfig.json`, `.deps.json`, optional `hw.pid`, and transient composite JPEGs) are stored only inside Vetro's own `<dir>/runtime/` (`0700` directory, `0600` files) with per-launch SHA-256 re-verification, symlink refusal, and exclusive (`O_EXCL` / `CreateNew`) atomic writes.

## Security & Privacy Notice

- **Pairing Token (`GET api/token`):** Both `GET api/token` and `POST api/savetoken` are scoped strictly server-side to the calling device's own HMAC slot (no client-chosen ID parameter is accepted), so an unpaired LAN device receives `token: null` rather than another device's grant. While Vetro pairing is **off**, anyone on the LAN who could call this route from an already-paired device could read only that device's saved token; with Vetro pairing **on**, only paired Vetro sessions can call Shard routes at all. Note that turning Vetro pairing on later or removing this Shard only protects or deletes `config.json`—it does **not** revoke grants already stored on the TV, so any previously copied token continues to work on port `8002` until you revoke the device in the TV's settings (**Settings → General → External Device Manager → Device Connection Manager → Device List**, or **Settings → Connection → External Device Manager → Device Connection Manager → Device List** on newer Tizen versions).
- **Frame Buffer Capture (`GET api/screenshot` & `GET api/stream`):** Captures and returns the TV's `1920×1080` single-shot or `640×360` / `960×540` / `1280×720` (`720×576` scaled in `Auto` HW mode) live stream over binary frames (`?format=bin`) or MJPEG, including both the Wayland graphics plane and (in `Auto` mode) the hardware video/broadcast/HDMI plane. While Vetro pairing is **off**, anyone who can reach Vetro's HTTP port can call these routes; with Vetro pairing **on**, only paired devices with an active Shard session can call them. The captured image/stream includes running applications, browser contents, live video playback, and any visible on-screen text or typed passwords. Temporary single-shot files (`<dir>/runtime/shot_<id>.jpg`, or fallback `/tmp/shot_<id>.jpg` / `/tmp/shot_<id>.png`) are written with per-request unique names and removed immediately after reading; live streaming stays in memory and stops automatically when viewers disconnect.
- **Local Typing Execution (`POST api/type`):** Typing via the local TV shell command is capped at 200 characters and supports partial US ASCII (letters, numbers, standard symbols). Any unsupported characters are omitted with a warning. Full Unicode text (Arabic, Hebrew, Cyrillic, CJK, emoji, etc.) is handled via the encrypted WebSocket connection on port 8002.

## Screen Preview & Display Layers

The Screen Preview feature supports two capture layers:
- **Auto Mode (Hardware Direct ASIC Capture + Wayland Composite):**
  - **Live stream:** Uses Samsung's `libsec-video-capture.so.0` (`api_capture_screen`) + `libturbojpeg.so.0` via a pull-paced `.NET` helper (`hardware-streamer.dll`, source in [`CaptureBackends.cs`](./CaptureBackends.cs) & [`HardwareStreamer.cs`](./HardwareStreamer.cs)), converting BT.709 studio/limited-range YUV to BT.601 full-range JFIF for accurate blacks and colors (~14–21 FPS on UA50AU7000, ~16–21% CPU above idle while streaming; the helper stops automatically when no viewer is connected, keeping keyboard/remote-only use near idle).
  - **Single-shot 1080p capture:** Captures crisp `1920×1080` Wayland graphics over `fdsink` stdout (zero `/tmp` files) and alpha-composites UI/captions onto the hardware video frame.
  - **Automatic Fallback:** If `/usr/bin/dotnet` is missing (Tizen 5/5.5), native libraries/ABI differ, or a runtime error occurs, Vetro automatically falls back to Wayland GStreamer. (32-bit ARMv7 `ilp32` is verified on UA50AU7000; 64-bit `lp64-int` / `lp64-sizet` paths are currently **untested** on real TV hardware.)
- **Wayland Mode (Manual 1-Click Override):** Forces software Wayland compositor capture (`gst-launch-1.0 waylandsrc`). Useful on untested TVs if hardware capture produces swapped colors or wrong aspect ratios.

For architecture details, wire protocol specs, and porting capture backends to other TV models/SoCs, see [`helpers/keyboard/HANDOVER.md`](../../helpers/keyboard/HANDOVER.md).

## Keyboard shortcuts (when focused on page)

| Key | Action |
| --- | --- |
| Printable characters (letters, numbers, symbols, spaces) | Instant direct typing to TV |
| `Enter` (in input box) | Send typed text to TV and commit |
| `Enter` (outside input box) | Submit focused field / URL bar (Android keyboard Enter) |
| `Ctrl+Enter` | Send OK / confirm to TV |
| `Ctrl+S` | Open TV Search |
| `Ctrl+A` | Select all text in focused TV input field |
| `Ctrl+V` (or paste) | Paste text directly to TV |
| `Ctrl+Z` | Undo in focused TV input field |
| `Backspace` (in empty box) | Send Backspace to TV |
| `Escape` | Send Back to TV |
| `Home` | Open TV Home / Smart Hub |
| Arrow keys (held or pressed) | Move TV cursor / D-Pad |

## Tested Environment

- **Model:** Samsung Smart TV UA50AU7000 (Tizen 6.0)
- **Vetro Version:** Vetro 0.7.0 (Node v12.4.0)
