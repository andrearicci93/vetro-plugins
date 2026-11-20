# TPK autorun fix

Samsung's **Autorun Last App** brings web apps (.wgt) and Samsung's own apps back when the TV wakes up, but not
.tpk apps you installed yourself. With this Shard on, the app you were using comes back too.

While the TV is on, it notes which of your own .tpk apps is on screen. When the TV goes to sleep with one on screen,
it opens that app again as soon as the TV wakes up. Everything else is left to Samsung.

## How it decides

- **Watched apps:** apps whose package is a `.tpk` and removable (installed by you), except `com.samsung.*` and
  `org.tizen.*`. Samsung's own apps and all web apps (.wgt) are left to Samsung. Each app is checked once, the first
  time it is on screen.
- **Armed at sleep:** the watched app that was on screen last, more recently than any other app. Samsung hides the
  app a moment before the TV reports sleep; samples with nothing on screen do not change the choice.
- **At wake:** it launches the app at once and stops when the app has been on screen for two samples. If Samsung covers
  it, it tries again, at most 3 launches within 20 s.
- **Never over something else:** if anything other than Samsung Home or the source viewer is on screen at wake (an app
  you opened, Ambient mode), it does not launch, and it stops retrying the moment you open another app.
- **After a full restart** (long press on power, power cut): if Vetro starts within 5 minutes of the TV booting and an
  app was armed, that counts as a wake-up.

## Permissions

`exec`: reading the TV's power state, which apps are on screen and the installed package files needs the root agent,
and so does opening an app.

## Commands it runs

| Command | When | Why |
| --- | --- | --- |
| `vconftool get memory/pm/state` | every second | 1 = TV on, 4 = asleep |
| `aul_test getallappstatus` | every second, only while the TV is on | which apps are visible (status 3) |
| `grep` on `/opt/share/packages/<package>.xml` | once per app seen on screen | is it a .tpk you installed |
| `/usr/bin/app_launcher -s <app>` | at wake, only for the armed app | open it again |

App and package names are checked against `[A-Za-z0-9_.-]` before they are put in a command.
While the TV sleeps only the first command runs. It does not change any setting.

## Network

None.

## Data it keeps

`ctx.config` (its own `config.json`): the armed app, the time of the last sleep and of the last launch.
The dashboard status shows the TV state, the app on screen, the armed app, the watched apps and the last 15 events
(with the apps seen in the last 3 samples before each sleep).

## Tested on

Samsung S95C (QE65S95CATXXH), Tizen 9.0: sleep and wake with Nuvio Legacy (.NET .tpk) on screen; it came back on
the first launch, within about a second of the TV waking. A web app (Stremio) on screen was left to Samsung.
Other models and Tizen versions are not tested: if `memory/pm/state` reads differently there, the Shard does nothing
and shows the error in its status. Not tested with HDMI-CEC wake (a console turning the TV on) or Ambient mode.

## Samsung's Autorun Last App setting

The Shard does not follow it: the setting is not stored where the Shard can read it (no settings key changes when it
is toggled). To stop the Shard, switch it off in Vetro Shards.
