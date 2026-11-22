# EFL leak fix

A Vetro Shard that stops a memory leak in Samsung's firmware which makes the TV's UI freeze after a few hours:
the menu, volume overlay and remote stop answering while the picture and sound keep playing, until the TV is
restarted with a long press on the power button.

## Why

On some firmware `msf-server` (Samsung's Multiscreen / SmartThings remote server) runs `/usr/bin/pw-show-lastset 1`
**every second**, even with no phone connected. That helper only saves the Elementary "show the last character of a
password" setting, so each run rewrites `~/share/.elementary/config/tv/base.cfg` with the same content. Every EFL app
watches that file: on each write tv-viewer, menu, YouTube, ScreenMirroring, registertv, qdinfo-daemon and others
reload their config and fonts and leak heap. On a Q70A that was about 2.4 MB per minute per app, roughly 26 MB per
minute in total; once RAM and swap run out the UI freezes.

How to see whether your TV has it (Shell Shard or SSH):

```sh
stat -c %y /opt/usr/home/owner/share/.elementary/config/tv/base.cfg   # run twice a few seconds apart: changes every second
ps -eo pid,ppid,args | grep pw-show-lastset                             # spawned again and again by msf-server
```

The Shard binds `/bin/true` over `/usr/bin/pw-show-lastset` in the init mount namespace. msf-server keeps running
(phone remote, Smart View and SmartThings still work); the helper simply does nothing. The only thing lost is that
a phone can no longer change the "show last password character" setting. Nothing on the TV's storage is changed:
a bind mount disappears at reboot, which is why the Shard applies it again after every boot.

## Permissions

`exec`: the bind mount is a root command, run through the TV's root agent.

## Commands it runs

| Command | Why |
| --- | --- |
| `[ -e /usr/bin/pw-show-lastset ] && ! grep -q " /usr/bin/pw-show-lastset " /proc/1/mountinfo && nsenter -t 1 -m mount --bind /bin/true /usr/bin/pw-show-lastset`, then the check below | applies the fix in the init mount namespace (where msf-server runs), only if the helper exists and is not bound yet |
| `if [ ! -e /usr/bin/pw-show-lastset ]; then echo absent; elif grep -q " /usr/bin/pw-show-lastset " /proc/1/mountinfo; then echo bound; else echo free; fi` | reads back whether the fix is in place |
| `nsenter -t 1 -m umount /usr/bin/pw-show-lastset` (up to 5 times while it is still bound), then the check | removes the fix when the Shard is switched off |

When: 2 s after the Shard starts, then every 15 s until the root agent answers (it is not up for the first minute or
two after a boot; at most 80 tries, then every 10 minutes), then every 10 minutes to put the bind back if something
removed it. **Check now** on the page runs the apply command once. Switching the Shard off runs the remove command.
On firmware without the helper it reports `not needed` and only looks again every 10 minutes.

## Network

None. The page talks only to its own routes (`state`, `check`).

## Data it keeps

None. It does not use `ctx.config`.

## Tested on

Samsung QE65Q70A (2021), Tizen 6.0, firmware T-NKM2DEUC, Vetro 0.7.0:

- before: `base.cfg` was rewritten every second and `MemAvailable` dropped by about 70 MB every 3 minutes
  (1066 MB to 770 MB in 15 minutes after a boot); the UI froze after a few hours.
- with the bind in place: `base.cfg` no longer changes, the heap of tv-viewer, menu, YouTube, registertv and
  qdinfo-daemon stays flat, and `MemAvailable` stays level (1133 MB to 1137 MB over 40 s, 6 minutes after a boot).
- after a reboot the Shard applied the bind on its own once the root agent answered.

## Install

From the Shard catalog in **Vetro Shards**, or from a file: download the `.vplugin`, then
**Vetro Shards → Install from a file or develop a Shard** (needs Developer mode). It installs switched off; switch it on.
