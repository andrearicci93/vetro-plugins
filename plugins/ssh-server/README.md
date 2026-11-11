# SSH server

A real SSH-2 server you reach with your normal `ssh`, `scp` and `sftp` clients — implemented in pure JavaScript
([`ssh.js`](ssh.js), [`sftp.js`](sftp.js)) and run **inside Vetro's Node process**. It ships no binary, because a
Samsung TV refuses to execute unsigned native code (UEP); interpreted JS loaded by Vetro's already-signed Node is the
way to run a server here. **Needs Node 10+ on the TV** (Ed25519 / ECDH); the 2021+ Tizen TVs that run Vetro's agent
qualify. On older Node the Shard loads but reports "unsupported".

## What you get, and why

Vetro's service runs as **uid 5001** (`owner`) under the Smack label `User::Pkg::vetrotvapp`, which has **no execute
access to system binaries** (`/bin/bash`, `/usr/bin/script` are floor-labeled). So this process cannot spawn a shell or
a PTY — it can only run things as root through Vetro's **agent** (`ctx.execute`), which is one command at a time.

| Command | Runs as | Notes |
| --- | --- | --- |
| `ssh -p 2222 root@TV-IP` | **root** | interactive **line-shell**: each command you type runs via the agent, `cd` is remembered. **No PTY** — no `top`/`vi`/`less` (use `top -b -n1`), no shell state beyond `cwd` |
| `ssh -p 2222 root@TV-IP '<command>'` | **root** | the command runs through the agent and returns its output (one-shot, ~60 s cap) |
| `scp` / `sftp -P 2222` | **owner (uid 5001)** | file transfer, in-process; reaches owner-readable files |

The username is ignored — you authenticate with your key. The interactive shell and single commands run as **root**;
file transfer runs as the **owner**.

> **Why no interactive root shell with a real terminal?** A PTY needs to spawn a shell process, which the sandbox
> blocks, and the agent runs one command at a time (it can't stream a live terminal without holding Vetro's command
> queue open). So the interactive shell is line-based: you type a command, it runs, you get the output. For anything
> that needs a real terminal, there isn't a way on this platform today.

## Setup

1. Generate a key if you don't have one: `ssh-keygen -t ed25519`.
2. Open the Shard's page, paste your **public** key (`~/.ssh/id_ed25519.pub`) under *Authorized keys*, Save.
3. Switch the Shard **on**. Connect: `ssh -p 2222 root@TV-IP`.

Keys and the host key are stored in the Shard's own config, not in `~/.ssh` (root's home is read-only on the TV).

## Algorithms

One of each, all accepted by a stock OpenSSH client and available on Node 12:

- key exchange `ecdh-sha2-nistp256` · host key `ssh-ed25519` · cipher `aes256-ctr` · MAC `hmac-sha2-256`
- user authentication: `publickey`, **ed25519 keys only** (v1)

No post-quantum KEX, so recent OpenSSH prints a "not using a post-quantum key exchange" notice — expected. The server
**refuses the PTY request** on purpose, so your client prints "PTY allocation request failed" and drops to line mode —
that is the line-shell working as intended.

## Commands it runs

`exec` permission is used to run, through `ctx.execute` (as root via Vetro's agent), the commands you send over SSH —
**nothing runs unless you type it**. SFTP does **not** use the agent; it runs in Vetro's own process as uid 5001.

| Source | What runs | As |
| --- | --- | --- |
| interactive shell | each line you type, wrapped as `cd '<cwd>'; <your line>; printf <marker><pwd>` so the directory carries over, via `ctx.execute` | root (agent) |
| a command over SSH | the command you typed, verbatim, via `ctx.execute` | root (agent) |
| `scp`/`sftp` | Node `fs` operations (open/read/write/readdir/…) | uid 5001, in-process |

## Network

It opens no outbound connection and downloads nothing. The only listener is this SSH server, on the port you set
(default 2222), bound to **all interfaces** (`0.0.0.0`) — so it is reachable from anywhere that can route to the TV.
Vetro's traffic is plain HTTP — keep the TV on a trusted network and **never expose the SSH port to the Internet**.

## Data it keeps

In the Shard's config (`config.json`): the port, your authorized public keys, and the generated Ed25519 **host key**
(so your client doesn't warn about a changed key after a restart). Removing the Shard deletes all of it. *Regenerate
host key* on the page makes a new one (clients that connected before will warn once).

## Security note

This is a hand-written SSH server guarding a root command path on your TV. It has been exercised against OpenSSH
`ssh`/`scp`/`sftp` but has **not** had a third-party security review. Every async path is wrapped so a fault cannot
crash the Vetro service. Pre-auth abuse is bounded: a 30 s login grace period, at most 8 half-open (unauthenticated)
connections, and a few auth attempts per connection, so a host on the LAN can't tie up Vetro's memory with half-open
sessions. Switching the Shard off (or Vetro disabling it) tears down every live connection, including open SFTP
sessions. Run it on a trusted LAN, key auth only (there is no password auth), and read [`ssh.js`](ssh.js) before you
trust it. Not affiliated with OpenSSH or dropbear.

## Tested

_On the TV — Samsung The Frame **QN75LS03B** (2022, `22_PONTUSM_FTV`), Tizen 6.5.0, kernel 5.4.77 `armv7l`, Vetro 0.5.0_
(installed through Vetro's plugin host in Developer mode, trust `file`), with an OpenSSH 10.3 client over the LAN:

- `ssh root@tv '<cmd>'` runs as **root** (`id` → `uid=0(root)`); the command's **exit status is forwarded**
  (`exit 7` → 7, `exit 42` → 42, `true` → 0);
- the interactive **line-shell** works and remembers `cwd` (`pwd` → `/`, `cd /tmp`, `pwd` → `/tmp`), no PTY as designed;
- **`sftp` get + put of a 3 MB file is byte-identical** (same SHA-256) — this exercises the `CHANNEL_WINDOW_ADJUST`
  fix, since an upload past the initial ~2 MB window used to stall;
- the plugin stayed healthy throughout (host reports `errors: 0`, `lastError: null`); installing and exercising it did
  **not** crash the Vetro service.

The diagnosis above (Smack label `User::Pkg::vetrotvapp` has no execute access to system binaries) is from this TV.

_Off-device (OpenSSH 10.3 client, server on Node 22):_ key-exchange, ed25519 auth, the line-shell, `ssh root@tv 'cmd'`,
`sftp`/`scp` get+put of a 6 MB binary (byte-identical, upload past the old window stall), the pre-auth limits (login
grace, half-open cap, auth-attempt cap), a re-key request answered with a clean disconnect, and `stop()` tearing down a
live session — all with clean teardown.
