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
`PersistentKeepalive` and a host-name `Endpoint` are supported (next section for when its address changes).

## When the connection stops working

`nordtv` watches the WireGuard handshake, which a working tunnel renews every 2 minutes:

- **5 minutes without one:** it sets the server's endpoint again. A host-name `Endpoint` (a dynamic-DNS name) is
  looked up again first, and the tunnel follows a new address. That lookup goes past the dead tunnel: it asks the
  TV's own DNS servers (`/etc/resolv.conf`) from a socket outside the tunnel, and for the second or so it takes, the
  DNS redirect and the kill switch let through only that socket's query to port 53. (The tested TV's kernel has no
  `iptables` `mark` match, so the rules match the socket's port.) It is tried again every 5 minutes.
- **15 minutes without one:** it stops, removing its rules, so that the next start connects from scratch: every
  rule removed, the server looked up again, and for NordVPN a new server asked for. With **Keep connected** on,
  the Shard does that within a minute or two. With it off, the VPN stays off and the tab shows why. During that
  restart, as during any start, the kill switch is not in place yet.

**Your own server at home:** a config whose `Endpoint` is your public address or a dynamic-DNS name (for example
`me.synology.me`) only works from inside your home if the router loops that traffic back (hairpin NAT). Many routers
do not: then make a second profile with the server's LAN address as `Endpoint` for use at home.

## Migrating from nordvpn

This Shard replaces **NordVPN** (id `nordvpn` 1.0.0), which is no longer in the catalog.

- **The id changes** from `nordvpn` to `vpn`, so Vetro sees a new Shard and does not update the old one.
- **Switch NordVPN off, then remove it from the dashboard**, then install VPN. Do not run both: each would start the
  VPN.
- **Your settings are kept:** the token, country, kill switch, "VPN on" and "Keep connected" live in `/opt/nordtv`,
  not in the Shard, so VPN finds them and nothing has to be entered again. The first time, VPN replaces the old
  program (nordtv 1.0.0) with 1.1.2 (see below). If that download fails (for example the Wi-Fi is not up yet),
  VPN keeps using 1.0.0, shows **Update pending** in the tab, and tries again every 2 minutes until it works.
- **Going back:** switching NordVPN on again puts nordtv 1.0.0 back (it installs the program it pins), so the fixes
  and the WireGuard profiles of 1.1 are gone until VPN installs 1.1.2 again.
- **The old kill switch and DNS rules are removed:** switching NordVPN off runs `nordtv down`, which deletes them.
  If something was left anyway (for example the old program had crashed), VPN removes it within a minute or two of
  starting, and `nordtv up` removes it before connecting (next section). To check by hand from the Shell Shard,
  with the VPN off: `iptables -n -L NORDTV`, `iptables -t nat -n -L NORDTV_DNS` and `ip6tables -n -L NORDTV` say
  "No chain/target/match by that name", and `ip rule` has no line with `51820` (or `0xca6c`). `/opt/nordtv/nordtv
  down` removes anything that is left.

## If the VPN program crashes

The kill switch is a set of firewall rules, so it outlives `nordtv` if the program dies. The TV cannot be left
without internet for long:

- The **home network keeps working** in every case, so the dashboard can always reach Vetro and switch the VPN off.
- **VPN on and Keep connected:** the Shard notices within a minute or two (it checks every 60 s) and runs
  `nordtv start`. Since 1.1.1 `nordtv up`
  first removes every rule left behind, then connects, so the API call and the server's DNS lookup are not blocked
  by the old kill switch. If connecting fails, nothing of it stays (no kill switch, normal internet), and the Shard
  tries again every 2 minutes.
- **A start that does not connect is stopped, not left trying.** Since 1.1.2 `nordtv up` takes a lock
  (`/dev/shm/nordtv.d/lock`) before anything else. So `nordtv down`, **VPN off** and **Reset** stop it even while it
  is still waiting for the API or the server's address, and a second `up` refuses to start while one runs. One
  started by `nordtv start` also gives up by itself after 40 s, removing what it set up. It never connects later,
  kill switch included, after the VPN was switched off or the start reported a failure, even if `start` itself was
  killed.
- **Keep connected off, or the VPN switched off:** nothing reconnects, so the Shard removes the leftover rules
  itself (`nordtv down`) within a minute or two, and the TV is back on its normal connection.
- **VPN off** in the tab and **switching the Shard off** both run `nordtv stop` / `down`, which remove every rule
  even when the program is not running.
- The rules are kept in memory only, never saved: a full restart of the TV clears them too.

## Permissions

`exec`: creating a network interface, routes and firewall rules needs root, and so does running the VPN program.

## The VPN program (`nordtv`)

Node cannot drive `/dev/net/tun` without native code, so the VPN itself is a separate program, `nordtv`, written
in Go on userspace [wireguard-go](https://git.zx2c4.com/wireguard-go). Its full source is in [`nordtv/`](nordtv)
(also at [piecifra/nordtv](https://github.com/piecifra/nordtv)).

- **Why it is not in the bundle:** the TV accepts bundles of text only, at most 512 KiB; the program is 3 MB
  compressed. It is kept in this catalog instead, as [`helpers/nordtv-1.1.2.gz`](../../helpers), next to its source.
- **Checked by CI:** on every pull request and push, the catalog's CI runs `go test` in `nordtv/`, builds it with
  the command below (Go 1.26.0, set up with `actions/setup-go`), and fails unless the result is byte for byte the
  binary inside `helpers/nordtv-1.1.2.gz` and that file's SHA-256 is the one pinned in `index.js` and written here.
- **Where the TV gets it:** if `/opt/nordtv/nordtv` is missing, or was installed from another build (for example
  1.0.0 by the NordVPN Shard), the Shard downloads
  `https://raw.githubusercontent.com/andrearicci93/vetro-plugins/main/helpers/nordtv-1.1.2.gz` and installs it
  **only if its SHA-256 is `b56117fb6d34fbb09f9d5acfaab76a256f67de9386f94c6c7fc8e0a32ecc57e4`**, pinned in
  `index.js`. A file with any other hash is deleted and nothing is installed.
- **Rebuild it yourself:** Go 1.26.0 (any Go 1.21 or later fetches it by itself through `GOTOOLCHAIN`), from
  `nordtv/`:

  ```sh
  GOTOOLCHAIN=go1.26.0 CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 GOFLAGS=-mod=readonly \
    go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /tmp/nordtv-armv7 .
  shasum -a 256 /tmp/nordtv-armv7                       # df043b5876bd1b078dff04de65fb1fe80606e7c9381555e04ab3b198bc73d255
  gzip -9 -n -c /tmp/nordtv-armv7 | shasum -a 256       # b56117fb6d34fbb09f9d5acfaab76a256f67de9386f94c6c7fc8e0a32ecc57e4
  ```

  The first hash is the program itself. The second depends on the gzip in use as well (it was made with the one
  in macOS); CI compares the program and checks the `.gz` against the pinned hash.
- **How it runs:** the Shard keeps it in `/opt/nordtv` and copies it to `/dev/shm/nordtv.d/nordtv` before each
  command, because the TV runs it from there. `/dev/shm` is writable by everyone, so `/dev/shm/nordtv.d` is used
  only as a real folder owned by root with mode `0700`: anything else found there (a file, a link, a folder of
  another user) is removed and the folder made again. The copy is made inside it, and the lock and pid files of
  `nordtv` live there too (up to 1.1.1: a fixed `/dev/shm/nordtv.new` and `/tmp/nordtv.pid`).
- Any change to the binary gets a new file in `helpers/`, a new hash and a new version of this Shard.

## Commands it runs

All through `ctx.execute`, as root.

| When | Command | Why |
| --- | --- | --- |
| before every command below | `umask 077`; `chmod 700 /opt/nordtv`, `chmod 600` on each plain file in it except the binary (and one being unpacked), `chmod 700` on `/opt/nordtv/nordtv` and `/opt/nordtv/profiles`; `stat -c %u /dev/shm/nordtv.d`, and unless it is a folder owned by root: `rm -rf`, `mkdir -m 700`; `md5sum` of `/opt/nordtv/nordtv` and `/dev/shm/nordtv.d/nordtv`; when they differ `cp`, `chmod 700`, `mv` inside `/dev/shm/nordtv.d` | keep the folders root-only and stage the program where it runs |
| 15 s after the Shard starts, then every 2 minutes while it has not worked, and on **Download and install**; one at a time, never during another change | `mkdir -p /opt/nordtv`; if the binary or its pinned hash is missing: `find` removes leftovers of an interrupted install older than 5 minutes; `mktemp` twice in `/opt/nordtv`, `curl -fsSL --max-time 90` the URL above into the first, `sha256sum` check of that file, `gunzip` of that same file into the second, `chmod 700`, `mv` to `/opt/nordtv/nordtv`, write the hash to `/opt/nordtv/.source` | install the pinned binary (nothing is downloaded when it is already there) |
| page opens, **Refresh**, every 60 s | `cat /opt/nordtv/.source`, `nordtv state` (page: `nordtv status -json`) | read the state and the profiles (never their keys), and whether the pinned binary is the one installed; `status` also asks NordVPN for the public IP |
| country list (NordVPN only) | `nordtv countries` | names for the country picker |
| a setting changes | `nordtv set provider nordvpn\|wireguard` / `set profile NAME` / `set country CC` / `set killswitch on\|off` / `set autostart on\|off`, then `nordtv start` when the VPN is on | apply the setting; provider, profile, country and kill switch reconnect |
| **VPN on** / **VPN off** | `nordtv start` / `nordtv stop` | `stop` also saves "VPN off" |
| **Save and check token** | `base64 -d > /opt/nordtv/token.new`, `mv` to `/opt/nordtv/token`, `nordtv verify` | store the token (never in clear on a command line) and check it with NordVPN |
| **Save profile** | `base64 -d \| nordtv profile add NAME` | `nordtv` checks the config and saves it as `/opt/nordtv/profiles/NAME.conf` (never in clear on a command line) |
| **Remove** (a profile) | `nordtv profile remove NAME` | delete it; the profile in use while connected cannot be removed |
| **Reset VPN** | `nordtv stop`, then `rm -f /opt/nordtv/token /opt/nordtv/token.new /opt/nordtv/config /opt/nordtv/log` and `rm -rf /opt/nordtv/profiles` | back to a fresh install; the binary and `.source` stay, so nothing is downloaded again |
| every 60 s, only when "VPN on" and "Keep connected" are saved, the provider has what it needs (a token, or a valid chosen profile) and the tunnel is down and not connecting | `nordtv start` | reconnect after a restart or a drop; a failed start waits 2 minutes |
| every 60 s, when it will not reconnect (VPN off, Keep connected off, or nothing to connect with) and the tunnel is down and not connecting | `iptables -n -L NORDTV`, `iptables -t nat -n -L NORDTV_DNS`, `ip6tables -n -L NORDTV`, `ip rule`; only if one of them shows nordtv's rules and no `nordtv up` is starting (`/proc/*/cmdline`): `nordtv down` | remove what a crashed `nordtv` left, so its kill switch cannot keep the TV offline |
| the Shard is switched off | `nordtv down` | stop the VPN and remove everything it created, keeping "VPN on" saved so it comes back with the Shard |

`NAME` is checked before use: letters, digits, `-` and `_`, up to 32. Inside `nordtv`, the commands that change the
system are only `ip addr/link/route/rule`, `iptables` and `ip6tables` (next section). Nothing else on the TV is
changed: no system DNS setting or file, only the redirect rules below.

## What it changes on the TV

All of it is done as root by `nordtv`, and all of it is in memory. While the VPN runs:

- a `nordtun` interface and policy routing like `wg-quick`: `ip rule` entries at priority 31000/31001, fwmark
  51820, and in table 51820 a default route (full tunnel) or the profile's `AllowedIPs` (split). The home network
  stays reachable, Vetro included.
- **DNS is forced** (`iptables -t nat`, chain `NORDTV_DNS`, port 53): to NordVPN's resolver (103.86.96.100), to the
  profile's `DNS`, or to Quad9 for a full-tunnel profile without one. A split profile without `DNS` leaves DNS alone.
  The WireGuard server's own address and port are let through first, so a server listening on port 53 still works.
- **IPv6 egress is blocked** (`ip6tables`, chain `NORDTV`): the tunnel is IPv4 only, so this stops IPv6 from
  going around it.
- **Kill switch, on by default** (`iptables`, chain `NORDTV`; not with a split profile): internet traffic outside
  the tunnel is rejected, so nothing leaks if the tunnel drops. **While the VPN is down but still on, the TV has no
  internet until it reconnects**; the LAN keeps working. Switch it off in the tab; a crash is covered above.

`nordtv down` / `stop` (and switching the Shard off) remove all of it: on the tested TV, `ip rule`, table 51820, the
interfaces and the `iptables` / `ip6tables` rules were byte-for-byte identical to before the VPN started.

## Network

- **NordVPN:** `api.nordvpn.com`, with the token: the account's NordLynx key (`/v1/users/services/credentials`);
  without it: server recommendations and keys (`/v1/servers/recommendations`, `/v1/servers`), countries
  (`/v1/servers/countries`). The chosen NordVPN server, UDP 51820 (WireGuard).
- **WireGuard:** only the profile's `Endpoint` (UDP), and the DNS lookup of its name when it is one.
- **Both:** `api.nordvpn.com/v1/helpers/ips/insights`, without the token, for the public IP shown in the tab (the
  only NordVPN address a WireGuard profile contacts); `raw.githubusercontent.com` (this catalog), only to download
  the pinned binary when it is missing.

Nothing is sent anywhere else, and nothing about the TV, the user or the network is collected.

## Data it keeps

`/opt/nordtv`, root only (folders `0700`, files `0600`, binary `0700`): `config` (provider, profile, country, kill
switch, "VPN on", "Keep connected"), `token` (the NordVPN access token), `profiles/NAME.conf` (the WireGuard
configs, keys included), `log`, `.source` (hash of the installed `.gz`), `nordtv`. `/dev/shm/nordtv.d`, root only,
in memory: `nordtv` (the running copy), `lock`, `pid`, `server`, `mode`. The Shard does not use `ctx.config`. Removing the Shard leaves `/opt/nordtv`: use **Reset VPN** first to
delete the token and the profiles, or `rm -rf /opt/nordtv` to remove everything.

## Tested

Only on one TV: Samsung QE43Q60BAUXXN (Q60B, 2022, firmware T-NKLBDEUC-1720.7), **Tizen 6.5**, kernel 5.4, ARMv7,
Vetro 0.5.0, the Shard installed from a file. **Other models and Tizen versions are untested.**

**NordVPN**, on that TV:

- on/off, country, kill switch and token check from the tab; about 130 Mbit/s through the tunnel (nordtv 1.0.0);
  NordVPN reports the IP as protected. With 1.1.0: connected, kill switch and DNS redirect in place, IP protected.

**WireGuard**, on the same TV, against a wg-easy 15.3 server on the LAN, with a `PresharedKey`, through the Shard's
routes:

- full tunnel with the kill switch: internet through the server, DNS to the profile's server, LAN reachable;
- a split profile (`AllowedIPs = 10.8.0.0/24`): only that range in the tunnel, no kill switch, no DNS redirect;
- switching profile, and switching back to NordVPN, while connected: reconnected each time;
- the same server through a dynamic-DNS name did not answer from inside the LAN (the router does no hairpin NAT),
  which is why the note above exists.

**A crash of `nordtv`** (killed with `kill -9`), on the same TV, NordVPN with the kill switch, nordtv 1.1.1:

- Keep connected on: the TV was offline (LAN reachable), and the Shard reconnected 32 s later with the kill switch
  back, IP protected.
- Keep connected off: the Shard removed the leftover rules about 85 s later (its check waited behind other commands
  on the TV), and the TV was back on its normal connection: no `NORDTV` chains, no `ip rule` entries, no `nordtun`.

**nordtv 1.1.2**, on the same TV (Vetro in safe mode, the binary run by hand and through the Shard's own shell
scripts):

- NordVPN with the kill switch, and the `nas-lan` WireGuard profile: connected; after `nordtv down` the routes,
  rules, interfaces and `iptables` / `ip6tables` rules were identical to before (compared by checksum);
- with the tunnel cut (its UDP dropped): a plain lookup of a dynamic-DNS name failed after 10 s, and
  `nordtv lookup NAME:51820` found it in 0.2 s, leaving no rule behind;
- `nordtv start` with a server name that never resolves: the `up` gave up after 40 s by itself and removed what it
  had set; with `start` killed after 5 s, the same; `nordtv down` while it was connecting stopped it at once; a
  second `up` while one ran was refused;
- an `up` of 1.1.1 still running (no lock, pid in `/tmp`): shown as running, a new `up` refused, stopped by the new
  `down`; a planted `/tmp/nordtv.pid` naming another process was ignored;
- the install script: a wrong hash refused and nothing left; two installs at once both ended with the pinned
  binary and no temporary file left; a link or a folder of another user planted at `/dev/shm/nordtv.d` replaced
  by root's `0700` folder.

**Both:**

- after every stop, `ip rule`, the routes, the interfaces and the `iptables` / `ip6tables` rules were identical to
  before; switching the Shard off took the VPN down;
- configs refused by `nordtv`: no IPv4 address or IPv4 `AllowedIPs`, an IPv6 endpoint, two peers, bad keys, a bad
  MTU, a missing endpoint or port (Go tests); bad profile names (on the TV and in the tests);
- off the TV: the binary download (installed only with the pinned hash, any other file refused), the leftover
  cleanup after a crash (stubbed `iptables` / `ip` in a real shell), the reset, and the Shard inside Vetro 0.5.0's
  plugin host.
