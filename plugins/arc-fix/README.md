# ARC receiver fix

For HDMI 1.4 ARC receivers (such as the Yamaha RX-V375) that get stuck in "Decoder Off" when the TV switches the ARC
S/PDIF stream from PCM to Dolby Digital / DD+.

While the plugin is **switched on**, a small watcher on the TV listens for the audio-format change, then sends a CEC
RoutingChange away from ARC, waits a few seconds (default 4) and sets the TV as ActiveSource again. It skips the reset when the format did not
change: from one Dolby stream to the next in the same format (the next episode) the receiver keeps up by itself. The receiver
re-locks onto the bitstream; the running app is not interrupted. Switched off, the watcher is stopped.

Page: **Plugins → ARC fix**: manual reset, wait time (1–10 s), HDMI port (auto or 1–4), live receiver and stream info, log.

## Tested with

- Samsung QN55QNX1DAGXZD (Neo QLED), Tizen 9, firmware T-PTMDUABC-0090.2130.0, Vetro 0.5.0, with a Yamaha RX-V375 on
  the TV's ARC input.

That is the only setup it has been tried on. CEC defines the messages, not how a receiver reacts to them, so on
another receiver or TV:

- **If the receiver does not come back to ARC by itself**, switch its input back with its remote and switch the
  plugin off.
- **If "Stream" on the page stays at PCM** when a Dolby movie starts, this TV reports the audio format somewhere
  else and the watcher will never fire. It does nothing in that case.

Tried it on another receiver or TV? Please open an issue saying what you have and whether it worked, either way.

## Permissions

`exec`: reading the CEC and audio state and sending the CEC reset need root.

## Commands it runs

| Command | Why |
| --- | --- |
| `busctl --system call org.tizen.tv.hdmicec ... IsReceiverAvailable`, `GetDeviceType`, `GetDeviceName`, `GetDevicePortNum` | to find the receiver and its HDMI port for the page and the reset |
| `amixer cget numid=89`, `amixer cget numid=20` | to read the decoder codec and the S/PDIF format |
| `busctl --system monitor` | the watcher: waits for `SetAudioInformation` / `DigitalAudioFormatChanged` |
| `dbus-send ... org.tizen.tv.HdmiCec.SendRoutingChange`, then `SetActiveSource` | the reset itself, after a Dolby/DTS stream starts or when you press the button |
| `systemd-run --unit=vetro-arc-fix` (or `setsid nohup` if systemd-run fails) | to start the watcher when the plugin is switched on |
| `systemctl stop vetro-arc-fix.service`, `kill` / `pkill` on the PID in `vetro-arc-fix.pid` | to stop the watcher when the plugin is switched off |
| `/bin/sh`, `cat`, `tr`, `grep`, `tail`, `wc`, `mv`, `sed`, `awk`, `base64`, `date`, `sleep`, `rm` | to run the watcher, read its PID, wait between steps and keep its log short |

How the watcher starts: there is no script file. Tizen's UEP refuses to run unsigned script files, so the watcher
(`daemonFileContent()` in `arc-fix.js`, written out in full) is passed to the shell on stdin, base64-encoded, the
same way Vetro and this plugin run every command: `/bin/sh -c 'echo <base64> | base64 -d | /bin/sh -s vetro-arc-fix'`.
The `vetro-arc-fix` argument names the process, so the PID checks can recognise it.

How often: while the plugin is on, Vetro checks every 10 s that the watcher is still running and restarts it if not.
That check is one root command that reads the watcher's PID file and `/proc/<pid>/cmdline`. The CEC and `amixer`
reads run only when you open the plugin's page or press one of its buttons. The watcher itself acts only when the audio format changes.
Switched off, nothing runs.

## Network

None. Everything stays on the TV.

The page's routes (`status`, and `action` for the manual reset and the settings) go through Vetro like every other
route. With pairing off, any device on your network that can reach Vetro can press the reset or change the wait
time and port.

## Data it keeps

- `config.json`: the wait time and the HDMI port.
- While on: `vetro-arc-fix.pid` and `vetro-arc-fix.log` (last 40–60 lines) in the plugin's own folder.
  `vetro-arc-fix.log.tmp` exists for a moment each time the log is cut back to 40 lines. The PID file is removed
  when the plugin is switched off.
