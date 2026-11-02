# TV uptime

Shows how long the TV has been on, on a page in the Vetro dashboard.

## Permissions

`exec`: it has to read a file only the TV's root agent can be asked for.

## Commands it runs

| Command | Why |
| --- | --- |
| `cat /proc/uptime` | the number of seconds since boot, shown as days, hours and minutes |

It runs only when the page asks for the value (when it opens and on **Refresh**), with a 5 second timeout.

## Network

None.

## Data it keeps

None. It does not use `ctx.config`.
