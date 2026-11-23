# TV reboot

A Vetro Shard with one button, on a page in the Vetro dashboard, that restarts the TV.
Press **Reboot TV**, then **Press again to reboot** within 5 seconds. Vetro and its Shards come back on their own after the boot.

## Why

Restarting the TV from the remote can be finicky and annoying, at least on a Samsung The Frame (2022). With this
Shard anyone who can open the Vetro dashboard can restart the TV with one button, from a phone or a computer.

## Permissions

`exec`: restarting the TV and reading the app registry are root commands, run through the TV's root agent.

## Commands it runs

| Command | Why |
| --- | --- |
| `sqlite3 -readonly /opt/dbspace/.pkgmgr_parser.db "SELECT app_disable FROM package_app_info WHERE app_id='com.samsung.tv.csfs';"` | Is Samsung Home disabled for everyone? If it is, or the answer is not `false`, it does not reboot (see Guards) |
| `sqlite3 -readonly /opt/dbspace/user/5001/.pkgmgr_parser.db "SELECT is_disabled FROM package_app_info_for_uid WHERE app_id='com.samsung.tv.csfs';"` | Is Samsung Home disabled for the TV's user? If so, it does not reboot |
| `sync; systemctl reboot \|\| reboot \|\| reboot -f` | writes pending data to storage, then restarts the TV, with two fallbacks |

The check runs once per confirmed press, with a 10 second timeout. The reboot runs 1.5 seconds after the check
passes (so the page gets its answer first), with a 30 second timeout, and repeats the check first. Nothing runs when
the Shard is switched on or when Vetro starts. If the TV does not go down, the page shows the command's output.

## Guards

- **Samsung Home disabled:** it refuses. With Samsung Home (`com.samsung.tv.csfs`) disabled, the boot script keeps
  retrying it and the TV may never finish starting. If the state cannot be read, it refuses too.
- **Vetro started less than 90 seconds ago:** it refuses. A restart inside Vetro's first 60 seconds puts the next
  start in safe mode, with every Shard paused.
- A second press while a reboot is pending is ignored.

## Network

None.

## Data it keeps

None. It does not use `ctx.config`.

## Tested on

Samsung LS03B The Frame (2022), Tizen 6.5, firmware T-PTMDEUC-1720.7: the TV restarted and Vetro came back.

## Install

From the Shard catalog in **Vetro Shards**, or from a file: download the `.vplugin`, then
**Vetro Shards → Install from a file or develop a Shard** (needs Developer mode). It installs switched off; switch it on.
