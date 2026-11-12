# 8BitDo Guide

Open Vetro's launcher by releasing Guide on an **8BitDo Ultimate 2 Wireless,
connected over Bluetooth**. Other buttons, scan codes and stick/trigger axes
are forwarded through a virtual copy of the gamepad.

**Private Vetro dependency:** this Shard reads `/home/owner/tvlauncher.pid`
and writes `/home/owner/tvlauncher.fifo`. These are not public Shard API hooks;
a Vetro update can break the integration.

## Compatibility

| Device or feature | Status |
| --- | --- |
| 8BitDo Ultimate 2 Wireless, Bluetooth, `2dc8:6012` | Selected explicitly; tested on the TV below |
| Other 8BitDo models, USB or wireless-dongle modes | Not supported by this device selector; untested |
| Microsoft Xbox controllers | Not selected and not tested |
| Force feedback or event types beyond keys, absolute axes and scan codes | Rejected before taking control of the physical device |

The selector checks the exact name, Bluetooth bus, vendor and product IDs.
This is not a generic Xbox-controller remapper. Supporting another device needs
its own capability and application tests, including its haptics and controller
enumeration; changing the name/IDs alone does not establish compatibility.

### Requirements

- A rooted TV running Vetro 0.5.0 with the Vetro launcher enabled.
- The TV's existing .NET 3.1 runtime at `/usr/bin/dotnet`; none is installed by this Shard.
- 32-bit little-endian Linux input-event records, evdev, `/dev/uinput`, and
  systemd with `systemd-run --collect`.

Older TVs, other runtime versions, and 64-bit input-event layouts have not been
validated. ES5 compatibility of the wrapper does not establish TV compatibility.

### Actual TV tests

The helper in 1.1.0 was tested on a **Samsung UN43BU8000GXUG**, Tizen **6.5**,
firmware **T-KSU2EBUABC-1720.7**, Vetro **0.5.0**:

- The owner confirmed Guide opens Vetro and it stays open from YouTube.
- The owner confirmed Moonlight's controller buttons/sticks and Guide work.
- The bounded preview was stopped and the normal supervised helper was enabled;
  the TV reported exactly one proxy, with the preview stopped.

This 1.1.2 contribution keeps that helper behavior, refuses unsupported 64-bit
runtime layouts before opening devices, makes its payload rebuildable, adds
wrapper error/lifecycle checks, and moves runtime files into the Shard's private
folder. Those changes are checked locally; they have not been installed
on the test TV. A reboot of the final proxy helper, standby/wake, and a physical
Bluetooth disconnect/reconnect have not been manually confirmed.

## How it works

Samsung's original Guide action competes with a second Home/show action. Merely
observing Guide and then opening Vetro did not work reliably on the test TV.

The helper clones the selected gamepad's identity, key/scan-code capabilities,
axis limits, fuzz, flat, resolution and current state through uinput. It then
takes an exclusive evdev grab and forwards input frames, withholding Guide and
its adjacent scan code. Guide release sends `hide`/`show` through Vetro's local
launcher FIFO. `SYN_DROPPED` triggers a full key/axis state resynchronization.

The TV/Moonlight may enumerate the clone as another controller. Test actual
gameplay before leaving it enabled. The controller is released and the clone
destroyed when the helper stops, the controller disconnects, or the launcher
turns off; the kernel also closes both descriptors if the process is killed.

**Private integration:** `/home/owner/tvlauncher.pid` and `tvlauncher.fifo` are
Vetro launcher implementation details, not Shard API hooks. A Vetro update can
break this integration. This Shard does not modify Vetro or Samsung firmware.

## Permissions

`exec`: runs the supervised helper as root to read/grab evdev, create a uinput
device, and write to the launcher's FIFO. These are privileged operations.

### Commands it runs

| Command | Purpose |
| --- | --- |
| `echo … \| base64 -d \| sh` | Pass a fixed script to Vetro's root agent |
| `base64 -d`, `gzip -d`, `chmod 600`, `mv` | Materialize the bundled managed DLL in the Shard's directory; no executable is downloaded |
| `/usr/bin/dotnet … --self-test` | Check filter/framing before starting it; no fixed log file is written |
| `/usr/bin/dotnet … --check-platform` | Refuse unsupported runtime layouts before creating a service |
| `systemctl is-active`, `reset-failed` | Inspect/reset this Shard's own transient unit |
| `systemd-run --unit=vetro-8bitdo-guide --collect … /usr/bin/dotnet …` | Start the helper with restart-on-failure supervision |
| `systemctl stop vetro-8bitdo-guide.service` | Stop the helper and release the controller |
| `/usr/bin/dotnet … --status --state-dir <ctx.dir>/runtime` | Read helper status with symlink-safe file access |

The helper uses libc input ioctls and file I/O. It does not start or kill Samsung
Home, run shell commands on button presses, or open a network listener.

## Network

None. No runtime downloads or outbound requests.

## Data it keeps

- In `ctx.dir`: the reconstructed `guide-bridge.dll` and its temporary `.new` file.
- In `ctx.dir/runtime`: `guide.lock` (process lock), `status.json` (device node,
  current state and counts), and short-lived random `.status-*` files used for
  atomic writes. Vetro creates this folder as its own user; the helper restricts
  it to mode `0700` without changing ownership, preserving update/removal access.
  State and lock files are mode `0600`.
- No runtime state, lock or self-test log is written to a fixed path in `/tmp`.
- A transient systemd unit; no persistent systemd service file is installed.

No configuration, account credentials, room/TV identifiers or key-history log
is stored. Status counters reset with the helper. Removing the disabled Shard
removes its directory, including runtime state.

The helper pins the runtime directory using `O_DIRECTORY | O_NOFOLLOW`, accesses
files relative to that descriptor with `openat`, refuses symlinked locks/status
reads, and creates status updates with `O_EXCL | O_NOFOLLOW` before `renameat`.
Atomic replacement replaces a malicious status symlink itself, not its target.
Filesystem regression tests cover directory, status and lock symlink attacks.

## Disable or recover

Use **Vetro Shards → 8BitDo Guide → Disable**, then Remove to uninstall.
Use the TV remote or dashboard browser if gamepad controls are unavailable.
The helper's `--state-dir <ctx.dir>/runtime --preview-seconds 120` mode
automatically releases the controller; the on-TV preview was also bounded by a
separate systemd time limit.

## Helper source and build

`GuideBridge.cs` and `StateFiles.cs` are the complete readable helper source.
The managed payload is stored as gzip/base64 because the bundle format accepts
text files. This is compiled code, not plain JavaScript. The required CI
source-rebuild check proves that its committed DLL matches the readable source.

The project at `helpers/eightbitdo-guide/GuideBridge.csproj` pins **.NET SDK 8.0.100**
in `global.json` with roll-forward disabled and checks the selected SDK version.
It targets the TV's existing .NET 3.1 runtime. From the repository root:

```sh
node scripts/build-eightbitdo-guide-helper.cjs
npm run build
node scripts/build-eightbitdo-guide-helper.cjs --check
npm test
npm run check
npm run test:runtime
```

The helper build runs filter tests without TV access and produces a deterministic
DLL without debug paths. The required `guide-helper` CI job uses SDK 8.0.100.
`--check` rebuilds and prints/compares the **SHA-256 of the rebuilt DLL** and the
**SHA-256 of the DLL decoded from the committed plugin payload**, failing on a
mismatch. It also compares the DLL decoded directly from the committed
`.vplugin` bundle, and checks the runtime
configuration and dependency manifest. CI does the same.
Tests cover Guide/scan-code removal in a packet that also contains another
button and axis movement, repeats/releases and 32-bit event encoding. Linux CI
also runs `--self-test-files` to check symlink refusal and atomic state writes
without accessing any input devices.
