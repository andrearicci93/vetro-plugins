# Hardware Screen Capture — Developer Handover & TV Porting Guide

This document explains how `keyboard` (v1.2.0+) captures hardware-composited video + OSD frames on Samsung Tizen Smart TVs, how the binary stream transport works end to end, and how contributors can diagnose and adapt capture backends for untested TV models, SoCs, and architectures.

---

## 1. Architecture Overview

Samsung Smart TVs render graphics onto two separate planes:
1. **Wayland / Enlightenment OSD Plane (`waylandsrc`):** UI menus, browser windows, Smart Hub, YouTube/app chrome, and captions. Video viewports are punched out as transparent (`alpha = 0`) holes.
2. **SoC Hardware Video / Display Overlay Plane (`libsec-video-capture.so.0`):** Broadcast DVB/Cable/Satellite TV, HDMI inputs, and hardware-decoded video streams bypassed around Wayland.

When `captureMode` is **`auto`** (the default):
- **Live Streaming (`GET api/stream` / `GET api/stream?format=bin`):**
  - The Node Shard (`plugins/keyboard/index.js`) extracts the tiny managed helper (`hardware-streamer.dll`, ~15 KB gzipped base64) into `ctx.dir/runtime/` (`0700` dir, `0600` files) and runs an isolated short-lived `--probe` child process.
  - If `--probe` succeeds, `index.js` starts `hardware-streamer.dll --serve` bound strictly to `127.0.0.1:<ephemeral>` (no extra LAN port).
  - Node sends pull-paced `CAP <w> <h> <q>\n` commands only when at least one viewer is ready to receive a frame (zero-backlog backpressure, 45 ms minimum interval thermal ceiling).
  - The helper captures YUV via `ICaptureBackend`, converts Samsung's BT.709 studio/limited range (`Y ∈ [16..235]`, `C ∈ [16..240]`) to BT.601 full-range JFIF YCbCr (`[0..255]`) via fused Q8 LUTs (`ConvertBt709LimitedToBt601Full`) so blacks and colors match Wayland output, encodes JPEG in native RAM using `libturbojpeg.so.0` (`tjCompressFromYUVPlanes`), and returns `[4B len][2B width][2B height][JPEG]`.
  - Node broadcasts every frame simultaneously to both `?format=bin` `<canvas>` viewers and legacy `<img>` MJPEG viewers.
- **HD Composite Screenshots (`GET api/screenshot`):**
  - Captures Wayland BGRA via `/usr/bin/gst-launch-1.0 ... ! fdsink fd=1` directly into stdout (zero `/tmp` raw files) and captures the HW YUV frame concurrently.
  - Transparent / translucent Wayland pixels (`alpha < 255`) are alpha-composited over bilinearly upscaled HW video; opaque UI pixels remain sharp native 1080p.
- **Automatic & One-Click Wayland Fallback:**
  - If `/usr/bin/dotnet` is missing (Tizen 5 / 5.5), native libraries are missing, `--probe` fails or segfaults in its isolated child process, or 3 consecutive frames fail mid-stream, Node automatically degrades to Wayland `gst-launch-1.0` without crashing Vetro or dropping viewers.
  - Users can also switch between **Auto** and **Wayland** with one click in the UI if an untested TV outputs wrong colors/aspect ratio.

---

## 2. Wire Protocols

### A. Browser Binary Stream (`GET api/stream?format=bin`)
- HTTP Response: `200 OK`, `Content-Type: application/octet-stream`, `Cache-Control: no-cache, no-store, must-revalidate`, `Connection: close`.
- Repeated packed frames (big-endian integers):
  ```
  +-------------------+------------------+------------------+-----------------------+
  | 4B UInt32BE len   | 2B UInt16BE w    | 2B UInt16BE h    | len bytes JPEG (FF D8)|
  +-------------------+------------------+------------------+-----------------------+
  ```
- Browser decodes via `fetch()` + `res.body.getReader()` + `createImageBitmap()` → `<canvas>` (dropping stale frames while a decode is in flight and calling `bitmap.close()` immediately to prevent GPU memory leaks). Older browsers fall back automatically to `<img src="stream">` MJPEG.

### B. Helper Loopback Protocol (`127.0.0.1:<ephemeral>`)
1. Helper connects to Node's ephemeral TCP server and writes one ASCII handshake line:
   `READY <token> <backend> <abi>\n` using the per-launch `VETRO_STREAM_TOKEN` environment variable (or `READY <backend> <abi>\n` when invoked manually without `VETRO_STREAM_TOKEN`). Unauthenticated or duplicate connections are rejected by Node.
2. Node sends single-line commands:
   - `CAP <width> <height> <quality>\n` → Helper replies `[4B len][2B w][2B h][JPEG]` (or 8 zero bytes `0x00*8` on transient failure).
   - `HD <quality>\n` → Helper captures 1080p Wayland-over-HW composite JPEG and replies `[4B len][2B w][2B h][JPEG]` (or `0x00*8` on failure).
   - `QUIT\n` → Helper disposes native handles and exits `0`.

---

## 3. Compatibility Matrix

| TV / Platform | CPU / ABI | `.NET` Runtime | Status | Expected Behavior |
| --- | --- | --- | --- | --- |
| Samsung **UA50AU7000** (Novatek Kant-SU2, Tizen 6.0) | ARMv7 32-bit (`ilp32`) | .NET Core 3.1 | **Verified** | HW `secvideo` + `libturbojpeg` works (`720x576` YUV420 NV12 with BT.709-to-BT.601 LUTs stretched to 16:9, ~14–21 FPS, ~16–21% CPU above idle while streaming; helper exits when idle) + 1080p composite HD screenshots |
| Samsung Tizen **5 / 5.5** | ARMv7 32-bit | None (`/usr/bin/dotnet` absent) | Expected | Fast-fails `--probe` (`dotnet_missing`), automatically uses Wayland GStreamer |
| Samsung Tizen **6.5 / 7 / 8 / 9+** (32-bit or `aarch64`) | `arm` (`ilp32`) / `arm64` (`lp64-int`, `lp64-sizet`) | .NET 6 / 8+ (`RollForward=Major`) | Needs TV test | Isolated `--probe` tests candidate ABIs safely; succeeds if ABI matches or falls back to Wayland cleanly |

---

## 4. Bringing Up a New / Untested TV Model

All diagnostics can be run directly over SSH/shell using the materialized helper in Vetro's plugin directory (typically `/opt/usr/home/owner/share/vetro/plugins/keyboard/runtime/hardware-streamer.dll` or similar `$VETRO_DATA/plugins/keyboard/runtime/`):

### Step 1: Check OS, Architecture, `.NET`, and Libraries
```sh
uname -a
/usr/bin/dotnet --info
DOTNET_ROLL_FORWARD=Major /usr/bin/dotnet <path>/hardware-streamer.dll --check-platform
```
Example output:
```json
{"ok":true,"arch":"Arm","ptrSize":4,"endian":"little","runtime":"3.1.x","secLib":true,"secPath":"libsec-video-capture.so.0","secSym":true,"secSymName":"api_capture_screen","tjLib":true,"tjPath":"libturbojpeg.so.0","tjSym":true}
```
- If `secLib: false`, search the TV for alternative capture libraries:
  ```sh
  find /usr/lib /usr/lib64 -maxdepth 2 -name '*capture*' -o -name '*turbojpeg*' 2>/dev/null
  ```
- Inspect exported symbols on your TV's library:
  ```sh
  nm -D /usr/lib/libsec-video-capture.so.0 | grep capture
  ```

### Step 2: Run Isolated `--probe`
```sh
DOTNET_ROLL_FORWARD=Major /usr/bin/dotnet <path>/hardware-streamer.dll --probe --abi auto
```
On 64-bit (`aarch64`) TVs, test both 64-bit candidate layouts manually:
```sh
DOTNET_ROLL_FORWARD=Major /usr/bin/dotnet <path>/hardware-streamer.dll --probe --abi lp64-int
DOTNET_ROLL_FORWARD=Major /usr/bin/dotnet <path>/hardware-streamer.dll --probe --abi lp64-sizet
```

### Step 3: Check Color Swap (NV12 vs NV21) or Disassembly on New SoCs
- **Red/blue swapped faces (cyan skin tones):** Your TV outputs `NV21` (`VUVU`) instead of `NV12` (`UVUV`). Test with:
  ```sh
  DOTNET_ROLL_FORWARD=Major /usr/bin/dotnet <path>/hardware-streamer.dll --probe --chroma nv21
  ```
- **64-bit struct offset verification:** If both `lp64-int` and `lp64-sizet` fail `--probe`, inspect `api_capture_screen` disassembly (`objdump -d /usr/lib64/libsec-video-capture.so.0` or Ghidra) to confirm the exact field sizes/offsets of `capBufPtr` (`yLen`, `cLen`, `actW`, `actH`, `yPtr`, `cPtr`), add a new `StructAbi` entry in `plugins/keyboard/CaptureBackends.cs`, and register its unit check in `--self-test`.

---

## 5. Adding a New Capture Backend (`ICaptureBackend`)

Platform-specific native capture is isolated in [`plugins/keyboard/CaptureBackends.cs`](../../plugins/keyboard/CaptureBackends.cs):
1. Implement `ICaptureBackend`:
   - `Name` (short backend slug, e.g. `"exynos-drm"`)
   - `AbiName` (layout identifier)
   - `TryCapture(int reqW, int reqH, ref CapturedYuvFrame frame, out string error)` — populate `Width`, `Height`, `YStride`, `YPlane`, `YLength`, `CPlane`, `CLength`, `Subsampling`, and `ChromaOrder`.
2. Wire your probe/constructor into `CaptureBackendRegistry.TryCreateDefault(...)`.
3. Streaming, TurboJPEG compression, 1080p Wayland compositing, pull pacing, and browser `<canvas>` rendering all work automatically without changes to `HardwareStreamer.cs`, `index.js`, or `ui.html`.

---

## 6. Rebuilding Deterministically & Verifying CI Checks

Upstream CI requires the bundled `hardware-streamer.dll.gz.b64` inside `plugins/keyboard/` and `dist/keyboard-<version>.vplugin` to match the committed C# source **byte-for-byte**.

1. Install the exact pinned `.NET SDK` specified in [`global.json`](./global.json) (`8.0.417`).
2. Rebuild the embedded helper artifacts & run `--self-test` / `--check-platform`:
   ```sh
   node scripts/build-keyboard-helper.cjs
   ```
3. Rebuild the `.vplugin` bundle & `index.json`:
   ```sh
   npm run build
   ```
4. Verify everything passes all repo & CI checks:
   ```sh
   node scripts/build-keyboard-helper.cjs --check
   npm test
   npm run check
   npm run test:runtime
   ```
