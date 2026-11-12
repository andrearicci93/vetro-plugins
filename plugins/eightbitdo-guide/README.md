# 8BitDo Guide

Open Vetro's launcher by releasing Guide on an **8BitDo Ultimate 2 Wireless,
connected over Bluetooth**. Other buttons, scan codes and stick/trigger axes
are forwarded through a virtual copy of the gamepad.

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

This 1.1.1 contribution keeps that helper behavior, refuses unsupported 64-bit
runtime layouts before opening devices, makes its payload rebuildable, adds
wrapper error/lifecycle checks, and supplies catalog metadata.
Those packaging/wrapper changes are checked locally; they have not been installed
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
| `/usr/bin/dotnet … --self-test` | Check the helper's filter/framing before starting it |
| `/usr/bin/dotnet … --check-platform` | Refuse unsupported runtime layouts before creating a service |
| `systemctl is-active`, `reset-failed` | Inspect/reset this Shard's own transient unit |
| `systemd-run --unit=vetro-8bitdo-guide --collect … /usr/bin/dotnet …` | Start the helper with restart-on-failure supervision |
| `systemctl stop vetro-8bitdo-guide.service` | Stop the helper and release the controller |
| `cat /tmp/vetro-8bitdo-guide-status.json` | Read current helper status |

The helper uses libc input ioctls and file I/O. It does not start or kill Samsung
Home, run shell commands on button presses, or open a network listener.

## Network

None. No runtime downloads or outbound requests.

## Data it keeps

- In `ctx.dir`: the reconstructed `guide-bridge.dll` and its temporary `.new` file.
- In `/tmp`: `vetro-8bitdo-guide.lock` (process lock),
  `vetro-8bitdo-guide-status.json` and `.new` (device node, current state and
  counts), and `vetro-8bitdo-guide-selftest.log` (self-test result).
- A transient systemd unit; no persistent systemd service file is installed.

No configuration, account credentials, room/TV identifiers or key-history log
is stored. Status counters reset with the helper. Removing the disabled Shard
removes its directory; the small `/tmp` files disappear at reboot.

## Disable or recover

Use **Vetro Shards → 8BitDo Guide → Disable**, then Remove to uninstall.
Use the TV remote or dashboard browser if gamepad controls are unavailable.
The helper's `--preview-seconds 120` mode automatically releases the controller;
the on-TV preview was also bounded by a separate systemd time limit.

## Helper source and build

`GuideBridge.cs` is the readable helper source. The managed payload is stored
as gzip/base64 because the bundle format accepts text files. This is compiled
code, not plain JavaScript; it needs explicit maintainer review under the
catalog's text-only/no-binary policy. The private launcher integration above
also needs review before catalog publication.

The project at `helpers/eightbitdo-guide/GuideBridge.csproj` pins SDK 8.0.100 and
targets the TV's existing .NET 3.1 runtime. From the repository root:

```sh
node scripts/build-eightbitdo-guide-helper.cjs
node scripts/build-eightbitdo-guide-helper.cjs --check
npm run build
npm test
npm run check
npm run test:runtime
```

The helper build runs filter tests without TV access and produces a deterministic
DLL without debug paths. `--check` rebuilds and compares the packaged payload,
runtime configuration and dependency manifest with source. CI does the same.
Tests cover Guide/scan-code removal in a packet that also contains another
button and axis movement, repeats/releases and 32-bit event encoding.
