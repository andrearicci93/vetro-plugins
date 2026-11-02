# Country switch

Changes the service country that Samsung TV Plus and the App Store read, from a page in the Vetro dashboard. No VPN, no factory reset.

**Experimental: not yet tested on a TV.** It is based on reading the Q80A firmware (T-NKM2DEUC). Samsung's servers may still apply their own checks (for example the connection's IP address or the country of the Samsung account), so the lineup or catalogue may not change even when the TV accepts the new value.

## What it changes

Only `db/comss/countrycode`, the value `libproductinfo` returns as the service country. It does **not** touch `db/system/country` (tuner, channels, rating lock) or the Samsung account.
In the firmware, the `comss` daemon watches that value: when it changes it drops the stored access token and, if `db/comss/reset_status` is 0, asks Samsung's provisioning server for the service URLs of the new country.
TV Plus keeps the country in memory: close and reopen it after a change.

The first time you apply a country, the plugin saves the original one in its own config. **Restore original** writes it back.

## Permissions

`exec`: the value can only be read and written by the TV's root agent.

## Commands it runs

| Command | Why |
| --- | --- |
| `vconftool get <key>` for `db/comss/countrycode`, `db/comss/reset_status`, `db/comss/mobilecountrycode`, `db/system/country`, `db/system/pnp_country`, `db/sso/sa_user_country_code`, `db/comss/gpmurl/apps`, `rtc/db/comss/gpmurl/apps` | show the current state on the page (read only) |
| `vconftool set -f -t string db/comss/countrycode <XX>` | apply a country from the page's list, or restore the saved original |

Reads happen when the page opens, on **Refresh**, and after a change. A change is only sent after you tick the box and press **Apply** or **Restore original**. The country code is checked against a fixed list (or, for the restore, against two capital letters) before it reaches a command.

## Network

None. It talks only to the TV agent. (The TV's own `comss` daemon contacts Samsung when the value changes; that is Samsung's code, not the plugin's.)

## Data it keeps

`ctx.config` holds one value: `original`, the country the TV had before the first change.
