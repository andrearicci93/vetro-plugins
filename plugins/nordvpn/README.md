# NordVPN

NordVPN (NordLynx, i.e. WireGuard) on the TV itself, with no router setup or USB stick. A **VPN** tab to switch it
on and off, pick a country, set the kill switch and the NordVPN access token, and keep it connected after a restart
or a drop.

You need a NordVPN subscription and an access token: Nord Account → NordVPN → Set up NordVPN manually → Generate new
token. The token is kept on the TV only and never shown again.

## Permissions

`exec`: creating a network interface, routes and firewall rules needs root, and so does running the VPN program.

## The VPN program (`nordtv`)

Node cannot drive `/dev/net/tun` without native code, so the VPN itself is a separate program, `nordtv`, written
in Go on userspace [wireguard-go](https://git.zx2c4.com/wireguard-go). Its full source is in [`nordtv/`](nordtv),
identical to [piecifra/nordtv](https://github.com/piecifra/nordtv) at tag `v1.0.0`.

- **Where it comes from:** if `/opt/nordtv/nordtv` is missing, or was installed from another build, the Shard
  downloads `https://github.com/piecifra/nordtv/releases/download/v1.0.0/nordtv.gz` and installs it **only if its
  SHA-256 is `a7f033196957c03ae867ce5d4791b8590ac9cf024b15fcf4392abe9e30622af3`**, pinned in `index.js`. A
  file with any other hash is deleted and nothing is installed.
- **Reproducible build:** the same source gives the same bytes. From `nordtv/` (any Go 1.21+, which fetches
  Go 1.26.0 by itself):

  ```sh
  GOTOOLCHAIN=go1.26.0 CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 GOFLAGS=-mod=readonly \
    go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /tmp/nordtv-armv7 .
  gzip -9 -n -c /tmp/nordtv-armv7 | shasum -a 256      # a7f033196957c03ae867ce5d4791b8590ac9cf024b15fcf4392abe9e30622af3
  ```

- **How it runs:** the Shard keeps it in `/opt/nordtv` and copies it to `/dev/shm/nordtv` before each command,
  because the TV runs it from there.
- Any change to the binary gets a new release, a new hash and a new version of this Shard.

## Commands it runs

All through `ctx.execute`, as root.

| When | Command | Why |
| --- | --- | --- |
| before every command below | `chmod 700 /opt/nordtv`, `chmod 600 /opt/nordtv/*`, `chmod 700 /opt/nordtv/nordtv`; `md5sum` of `/opt/nordtv/nordtv` and `/dev/shm/nordtv`; when they differ `cp`, `chmod 700`, `mv` to `/dev/shm/nordtv`; `chmod 700 /dev/shm/nordtv` | keep the folder root-only and stage the program where it runs |
| 15 s after the Shard starts, and on **Download and install** | `mkdir -p /opt/nordtv`; if the binary or its pinned hash is missing: `curl -fsSL --max-time 90` the URL above, `sha256sum` check, `gunzip`, `chmod 700`, `mv`, write the hash to `/opt/nordtv/.source` | install the pinned binary (nothing is downloaded when it is already there) |
| page opens, **Refresh**, every 60 s | `nordtv state` (page: `nordtv status -json`) | read the state; `status` also asks NordVPN for the public IP |
| country list | `nordtv countries` | names for the country picker |
| a switch or the country changes | `nordtv set country CC` / `set killswitch on\|off` / `set autostart on\|off`, then `nordtv start` when the VPN is on | apply the setting; country and kill switch reconnect |
| **VPN on** / **VPN off** | `nordtv start` / `nordtv stop` | `stop` also saves "VPN off" |
| **Save and check token** | `base64 -d > /opt/nordtv/token.new`, `mv` to `/opt/nordtv/token`, `nordtv verify` | store the token (never in clear on a command line) and check it with NordVPN |
| every 60 s, only when "VPN on" and "Keep connected" are saved and the tunnel is down | `nordtv start` | reconnect after a restart or a drop; a failed start waits 2 minutes |
| the Shard is switched off | `nordtv down` | stop the VPN and remove everything it created, keeping "VPN on" saved so it comes back with the Shard |

Inside `nordtv`, the commands that change the system are only `ip addr/link/route/rule`, `iptables` and
`ip6tables` (next section).

## What it changes on the TV

While the VPN runs:

- a `nordtun` interface and policy routing like `wg-quick`: `ip rule` entries at priority 31000/31001, a default
  route in table 51820, fwmark 51820. The home network (LAN) stays reachable, Vetro included.
- **DNS is forced** to NordVPN's resolver (103.86.96.100): port 53 is redirected (`iptables -t nat`, chain `NORDTV_DNS`).
- **IPv6 egress is blocked** (`ip6tables`, chain `NORDTV`): the tunnel is IPv4 only.
- **Kill switch, on by default** (`iptables`, chain `NORDTV`): internet traffic outside the tunnel is rejected.
  **If the VPN drops, the TV has no internet until it reconnects**; the LAN keeps working. Switch it off in the tab.

`nordtv down` / `stop` (and switching the Shard off) remove all of it: on the tested TV, `ip rule`, table 51820, the
interfaces and the `iptables` / `ip6tables` rules were byte-for-byte identical to before the VPN started.

## Network

- `api.nordvpn.com`, with the token: the account's NordLynx key (`/v1/users/services/credentials`); without it:
  server recommendations and keys (`/v1/servers/recommendations`, `/v1/servers`), countries
  (`/v1/servers/countries`), the public IP for the status (`/v1/helpers/ips/insights`).
- The chosen NordVPN server, UDP 51820 (WireGuard).
- GitHub (`github.com` and the asset servers its release downloads redirect to): only to download the pinned
  binary when it is missing.

Nothing is sent anywhere else, and nothing about the TV, the user or the network is collected.

## Data it keeps

`/opt/nordtv`, root only (folder `0700`, files `0600`, binary `0700`): `config` (country, kill switch, "VPN on",
"Keep connected"), `token` (the NordVPN access token), `log`, `.source` (hash of the installed binary), `nordtv`.
`/dev/shm/nordtv` (the running copy). The Shard does not use `ctx.config`. Removing the Shard leaves `/opt/nordtv`;
`rm -rf /opt/nordtv` removes it and the token.

## Tested

Samsung QE43Q60BAUXXN (Q60B, 2022, firmware T-NKLBDEUC-1720.7), Tizen 6.5, kernel 5.4, ARMv7, Vetro 0.5.0, installed
from a file. **Other models are untested.**

- On/off, country, kill switch and token check from the tab; about 130 Mbit/s through the tunnel; NordVPN reports the
  IP as protected.
- Switching the Shard off took the VPN down and left routing and firewall identical to before; switching it on
  brought the VPN back by itself after about 16 s.
- Binary download from the release: installed only with the pinned hash; a file with another hash is refused
  (tested off the TV).
- Off the TV: the Shard inside Vetro 0.5.0's plugin host, and its own tests (fake TV, real shell for the download
  step).
