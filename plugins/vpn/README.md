# VPN

A WireGuard VPN on the TV itself, with no router setup or USB stick. A **VPN** tab switches it on and off, sets the
kill switch and keeps it connected after a restart or a drop, with two providers:

- **NordVPN:** pick a country, or let NordVPN recommend the fastest server. You need a NordVPN subscription and an
  access token: Nord Account → NordVPN → Set up NordVPN manually → Generate new token.
- **WireGuard (your own config):** profiles made from WireGuard config files (`.conf`), from a provider's website
  (Mullvad, Proton VPN, Surfshark, IVPN, AirVPN, Windscribe…) or from your own server (wg-easy, a router, a NAS).
  Paste the file or load it, give it a name, pick it. Up to 20 profiles, one server each.

The token and the profiles, keys included, are kept on the TV only and never shown again. **Reset VPN** (second
click to confirm) turns the VPN off and deletes the token, every profile, the settings and the log, as after a fresh
install; the VPN program stays.

## Full tunnel or split

A profile's `AllowedIPs` decides what goes through the VPN:

- `0.0.0.0/0` (or `0.0.0.0/1, 128.0.0.0/1`, or no `AllowedIPs` line): **everything**. DNS is forced to the
  profile's `DNS` server, or to Quad9 (9.9.9.9) through the tunnel if it has none, and the kill switch applies.
- Anything narrower, for example `10.8.0.0/24` (split): **only those addresses** go through the VPN, the rest uses
  your normal connection. DNS is redirected only when the profile names a server, and the kill switch is not used
  (it would cut the internet the profile leaves outside on purpose).

Either way the home network (LAN) stays reachable, Vetro included: its own route always wins over the tunnel.

Limits: IPv4 only (IPv6 addresses, DNS servers and `AllowedIPs` in a config are skipped, and IPv6 is blocked while
the VPN is on; a server reachable only over IPv6 is refused), and one `[Peer]` per config. `PresharedKey`, `MTU`,
`PersistentKeepalive` and a host-name `Endpoint` are supported; the host name is looked up again when the
connection drops.

**Your own server at home:** a config whose `Endpoint` is your public address or a dynamic-DNS name (for example
`me.synology.me`) only works from inside your home if the router loops that traffic back (hairpin NAT). Many routers
do not: then make a second profile with the server's LAN address as `Endpoint` for use at home.

## Moving from the NordVPN Shard

This Shard replaces **NordVPN** (id `nordvpn`). Switch NordVPN off and remove it, then install VPN: your token,
country and switches are kept, because they live in `/opt/nordtv`, not in the Shard. Do not run both: each would
start the VPN.

## Permissions

`exec`: creating a network interface, routes and firewall rules needs root, and so does running the VPN program.

## The VPN program (`nordtv`)

Node cannot drive `/dev/net/tun` without native code, so the VPN itself is a separate program, `nordtv`, written
in Go on userspace [wireguard-go](https://git.zx2c4.com/wireguard-go). Its full source is in [`nordtv/`](nordtv),
identical to [piecifra/nordtv](https://github.com/piecifra/nordtv) at tag `v1.1.0`.

- **Where it comes from:** if `/opt/nordtv/nordtv` is missing, or was installed from another build (for example
  v1.0.0 by the NordVPN Shard), the Shard downloads
  `https://github.com/piecifra/nordtv/releases/download/v1.1.0/nordtv.gz` and installs it **only if its SHA-256 is
  `5e1156501e49bcb6077c056cea404b1c6bc7aeba6a923db0be4291c718189866`**, pinned in `index.js`. A file with any other
  hash is deleted and nothing is installed.
- **Reproducible build:** the same source gives the same bytes. From `nordtv/` (any Go 1.21+, which fetches
  Go 1.26.0 by itself):

  ```sh
  GOTOOLCHAIN=go1.26.0 CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 GOFLAGS=-mod=readonly \
    go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /tmp/nordtv-armv7 .
  gzip -9 -n -c /tmp/nordtv-armv7 | shasum -a 256      # 5e1156501e49bcb6077c056cea404b1c6bc7aeba6a923db0be4291c718189866
  ```

- **How it runs:** the Shard keeps it in `/opt/nordtv` and copies it to `/dev/shm/nordtv` before each command,
  because the TV runs it from there.
- Any change to the binary gets a new release, a new hash and a new version of this Shard.

## Commands it runs

All through `ctx.execute`, as root.

| When | Command | Why |
| --- | --- | --- |
| before every command below | `chmod 700 /opt/nordtv`, `chmod 600` on each plain file in it, `chmod 700` on `/opt/nordtv/nordtv` and `/opt/nordtv/profiles`; `md5sum` of `/opt/nordtv/nordtv` and `/dev/shm/nordtv`; when they differ `cp`, `chmod 700`, `mv` to `/dev/shm/nordtv`; `chmod 700 /dev/shm/nordtv` | keep the folder root-only and stage the program where it runs |
| 15 s after the Shard starts, and on **Download and install** | `mkdir -p /opt/nordtv`; if the binary or its pinned hash is missing: `curl -fsSL --max-time 90` the URL above, `sha256sum` check, `gunzip`, `chmod 700`, `mv`, write the hash to `/opt/nordtv/.source` | install the pinned binary (nothing is downloaded when it is already there) |
| page opens, **Refresh**, every 60 s | `nordtv state` (page: `nordtv status -json`) | read the state and the profiles (never their keys); `status` also asks NordVPN for the public IP |
| country list (NordVPN only) | `nordtv countries` | names for the country picker |
| a setting changes | `nordtv set provider nordvpn\|wireguard` / `set profile NAME` / `set country CC` / `set killswitch on\|off` / `set autostart on\|off`, then `nordtv start` when the VPN is on | apply the setting; provider, profile, country and kill switch reconnect |
| **VPN on** / **VPN off** | `nordtv start` / `nordtv stop` | `stop` also saves "VPN off" |
| **Save and check token** | `base64 -d > /opt/nordtv/token.new`, `mv` to `/opt/nordtv/token`, `nordtv verify` | store the token (never in clear on a command line) and check it with NordVPN |
| **Save profile** | `base64 -d \| nordtv profile add NAME` | `nordtv` checks the config and saves it as `/opt/nordtv/profiles/NAME.conf` (never in clear on a command line) |
| **Remove** (a profile) | `nordtv profile remove NAME` | delete it; the profile in use while connected cannot be removed |
| **Reset VPN** | `nordtv stop`, then `rm -f /opt/nordtv/token /opt/nordtv/token.new /opt/nordtv/config /opt/nordtv/log` and `rm -rf /opt/nordtv/profiles` | back to a fresh install; the binary and `.source` stay, so nothing is downloaded again |
| every 60 s, only when "VPN on" and "Keep connected" are saved, the provider has what it needs (a token, or a valid chosen profile) and the tunnel is down | `nordtv start` | reconnect after a restart or a drop; a failed start waits 2 minutes |
| the Shard is switched off | `nordtv down` | stop the VPN and remove everything it created, keeping "VPN on" saved so it comes back with the Shard |

`NAME` is checked before use: letters, digits, `-` and `_`, up to 32. Inside `nordtv`, the commands that change the
system are only `ip addr/link/route/rule`, `iptables` and `ip6tables` (next section).

## What it changes on the TV

While the VPN runs:

- a `nordtun` interface and policy routing like `wg-quick`: `ip rule` entries at priority 31000/31001, fwmark
  51820, and in table 51820 a default route (full tunnel) or the profile's `AllowedIPs` (split). The home network
  stays reachable, Vetro included.
- **DNS is forced** (`iptables -t nat`, chain `NORDTV_DNS`, port 53): to NordVPN's resolver (103.86.96.100), to the
  profile's `DNS`, or to Quad9 for a full-tunnel profile without one. A split profile without `DNS` leaves DNS alone.
- **IPv6 egress is blocked** (`ip6tables`, chain `NORDTV`): the tunnel is IPv4 only.
- **Kill switch, on by default** (`iptables`, chain `NORDTV`; not with a split profile): internet traffic outside
  the tunnel is rejected. **If the VPN drops, the TV has no internet until it reconnects**; the LAN keeps working.
  Switch it off in the tab.

`nordtv down` / `stop` (and switching the Shard off) remove all of it: on the tested TV, `ip rule`, table 51820, the
interfaces and the `iptables` / `ip6tables` rules were byte-for-byte identical to before the VPN started.

## Network

- **NordVPN:** `api.nordvpn.com`, with the token: the account's NordLynx key (`/v1/users/services/credentials`);
  without it: server recommendations and keys (`/v1/servers/recommendations`, `/v1/servers`), countries
  (`/v1/servers/countries`). The chosen NordVPN server, UDP 51820 (WireGuard).
- **WireGuard:** only the profile's `Endpoint` (UDP), and the DNS lookup of its name when it is one.
- **Both:** `api.nordvpn.com/v1/helpers/ips/insights`, without the token, for the public IP shown in the tab (the
  only NordVPN address a WireGuard profile contacts); GitHub (`github.com` and the asset servers its release
  downloads redirect to), only to download the pinned binary when it is missing.

Nothing is sent anywhere else, and nothing about the TV, the user or the network is collected.

## Data it keeps

`/opt/nordtv`, root only (folders `0700`, files `0600`, binary `0700`): `config` (provider, profile, country, kill
switch, "VPN on", "Keep connected"), `token` (the NordVPN access token), `profiles/NAME.conf` (the WireGuard
configs, keys included), `log`, `.source` (hash of the installed binary), `nordtv`. `/dev/shm/nordtv` (the running
copy). The Shard does not use `ctx.config`. Removing the Shard leaves `/opt/nordtv`: use **Reset VPN** first to
delete the token and the profiles, or `rm -rf /opt/nordtv` to remove everything.

## Tested

Samsung QE43Q60BAUXXN (Q60B, 2022, firmware T-NKLBDEUC-1720.7), Tizen 6.5, kernel 5.4, ARMv7, Vetro 0.5.0, installed
from a file. **Other models are untested.**

- NordVPN: on/off, country, kill switch and token check from the tab; about 130 Mbit/s through the tunnel (v1.0.0);
  NordVPN reports the IP as protected. With v1.1.0: connected, kill switch and DNS in place, IP protected.
- WireGuard, against a wg-easy 15.3 server on the LAN, with a `PresharedKey`, through the Shard's routes: full tunnel
  with the kill switch (internet through the server, DNS to the profile's server, LAN reachable); a split profile
  (`AllowedIPs = 10.8.0.0/24`: only that range in the tunnel, no kill switch, no DNS redirect); switching profile and
  switching back to NordVPN while connected reconnected each time. The same server through a dynamic-DNS name did not
  answer from inside the LAN (the router does no hairpin NAT), which is why the note above exists.
- After every stop, routing and firewall were identical to before; switching the Shard off took the VPN down.
- Configs refused by `nordtv`: no IPv4 address or IPv4 `AllowedIPs`, an IPv6 endpoint, two peers, bad keys, a bad
  MTU, a missing endpoint or port (Go tests); bad profile names (on the TV and in the tests).
- Binary download from the release: installed only with the pinned hash; a file with another hash is refused
  (tested off the TV).
- Off the TV: the Shard inside Vetro 0.5.0's plugin host, and its own tests (fake TV, real shell for the download
  step).
