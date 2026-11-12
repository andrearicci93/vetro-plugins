# Bedtime

Turn the TV off at set times or after a sleep timer, or open an app on a schedule. A **Bedtime** tab lists the
rules with their next run, sets a sleep timer (15, 30, 60 or 90 minutes) and shows the last actions.

- A rule is a time, one or more days of the week, and an action: **turn the TV off** or **open an app** (picked from
  the installed apps). Up to 20 rules.
- Times are the TV's local time. A rule runs once a day, within two minutes of its time; a time missed while the TV
  was off is skipped, never caught up later. When an app and power off are due in the same minute, the app opens first.
- The sleep timer is saved, so it survives a restart of Vetro.
- Rules run only while this Shard is switched on. Opening an app needs the TV on.
- **Test now** runs the chosen action at once. Turning the TV off needs a second click (the page cannot show dialogs).
- **Reset Bedtime** (second click to confirm) deletes every rule, cancels the sleep timer and clears the last
  actions.

## Permissions

`exec`: turning the TV off and opening an app go through the TV's own tools, as root.

## Commands it runs

| Command | When | Why |
| --- | --- | --- |
| `/usr/bin/input_keyevent XF86PowerOff` | a rule with "Turn the TV off" is due, the sleep timer ends, or **Test now** | the TV's discrete power-off key (never a toggle), the same command Vetro's own TV controls use |
| `app_launcher -s <appId>` | a rule with "Open an app" is due, or **Test now** | open the app; `<appId>` must be a Tizen app id (letters, digits, `.` `_` `-`) and is checked before use |
| `app_launcher -l` | the page asks for the app list (cached 5 minutes) | names and ids for the app picker |

Nothing runs at start or on its own except these, at the times you set.

## Network

None.

## Data it keeps

Its own `config.json` on the TV: the rules, the sleep timer's end time, the date each rule last ran (so it runs once
a day), and the last 20 actions with their result (time, what, done or the error). **Reset Bedtime** empties it;
removing the Shard deletes it.

## Tested

Samsung QE43Q60BAUXXN (Q60B, 2022, firmware T-NKLBDEUC-1720.7), Tizen 6.5, kernel 5.4, ARMv7, Vetro 0.5.0,
installed from a file. **Other models are untested.**

- Power off by a rule: the TV turned off at the rule's time (logged as done). Opening an app with **Test now**: the
  TV's Internet browser (`org.tizen.browser`) opened (logged as done). The app picker lists the TV's 411 apps; rules,
  the sleep timer and **Reset Bedtime** through the Shard's routes.
- Off the TV: rules and their validation, the local-time schedule (once a day, the two-minute window, no catch-up),
  the sleep timer across a reload, app before power off, failures logged, reset, and the app list parsed from that TV's real
  `app_launcher -l` output.
