# SSH server

A real SSH-2 server you reach with your normal `ssh`, `scp` and `sftp` clients — implemented in pure JavaScript
([`ssh.js`](ssh.js), [`sftp.js`](sftp.js)) and run **inside Vetro's Node process**. It ships no binary, because a
Samsung TV refuses to execute unsigned native code (UEP); interpreted JS loaded by Vetro's already-signed Node is the
way to run a server here. **Needs Node 10+ on the TV** (Ed25519 / ECDH); the 2021+ Tizen TVs that run Vetro's agent
qualify. On an older Node the Shard loads but reports "unsupported".

## What you get, and the one catch

Vetro's service runs as **uid 5001** (`owner`), not root — root is reached only as one-shot commands through Vetro's
agent. So:

| Command | Runs as | Notes |
| --- | --- | --- |
| `ssh -p 2222 owner@TV-IP` | **owner (uid 5001)** | interactive **PTY** shell via the signed `script` — `top`/`vi`/`less` work, `cd`/env persist |
| `ssh -p 2222 root@TV-IP '<command>'` | **root** | the command runs through Vetro's agent and returns its output (one-shot, ~60 s cap) |
| `scp` / `sftp -P 2222` | **owner (uid 5001)** | file transfer; reaches owner-readable files |

The username is ignored — you authenticate with your key. What decides root vs owner is whether you send a **command**
(root, via the agent) or open an **interactive session** (owner PTY). An interactive *root* shell isn't possible: you
can't stream a live PTY through the agent's one-shot command channel without freezing Vetro.

## Setup

1. Generate a key if you don't have one: `ssh-keygen -t ed25519`.
2. Open the Shard's page, paste your **public** key (`~/.ssh/id_ed25519.pub`) under *Authorized keys*, Save.
3. Switch the Shard **on**. Connect: `ssh -p 2222 owner@TV-IP`.

Keys and the host key are stored in the Shard's own config, not in `~/.ssh` (root's home is read-only on the TV).

## Algorithms

One of each, all accepted by a stock OpenSSH client and available on Node 12:

- key exchange `ecdh-sha2-nistp256` · host key `ssh-ed25519` · cipher `aes256-ctr` · MAC `hmac-sha2-256`
- user authentication: `publickey`, **ed25519 keys only** (v1)

No post-quantum KEX, so recent OpenSSH prints a "not using a post-quantum key exchange" notice — expected.

## Commands it runs

`exec` permission is used for one thing: a command you send over SSH (`ssh root@tv '<command>'`) is run as root through
`ctx.execute`, exactly as typed by you. **Nothing is run unless you send it.** The interactive shell and SFTP do **not**
use the agent — they run in Vetro's own process as uid 5001:

| Source | What runs | As |
| --- | --- | --- |
| interactive shell | `/usr/bin/script -qc 'exec bash -il' /dev/null` (falls back to `/bin/bash -il`) | uid 5001, in-process |
| a command over SSH | the command you typed, verbatim, via `ctx.execute` | root (agent) |
| `scp`/`sftp` | Node `fs` operations (open/read/write/readdir/…) | uid 5001, in-process |

## Network

It opens no outbound connection and downloads nothing. The only listener is this SSH server, on the port you set
(default 2222), bound to the LAN. Vetro's traffic is plain HTTP — keep the TV on a trusted network and **never expose
the SSH port to the Internet**.

## Data it keeps

In the Shard's config (`config.json`): the port, your authorized public keys, and the generated Ed25519 **host key**
(so your client doesn't warn about a changed key after a restart). Removing the Shard deletes all of it. *Regenerate
host key* on the page makes a new one (clients that connected before will warn once).

## Security note

This is a hand-written SSH server guarding a shell on your TV. It has been exercised against OpenSSH `ssh`/`scp`/`sftp`
off-device, but it has **not** had a third-party security review. Run it on a trusted LAN, use key auth only (the
default — there is no password auth), and read [`ssh.js`](ssh.js) before you trust it. Not affiliated with OpenSSH or
dropbear.

## Tested

_Off-device:_ OpenSSH 9.x client on macOS against the server on Node 22 — key-exchange, ed25519 publickey auth,
interactive shell channel, 6 MB output with window/backpressure, and `sftp`/`scp` get+put of a 1.2 MB binary
(byte-identical). _On-device:_ not yet — replace this with your TV model, Tizen/Node version, and what worked.
