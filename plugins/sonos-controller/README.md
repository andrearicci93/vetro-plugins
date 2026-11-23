# Sonos controller

Your TV remote's volume and mute keys control a Sonos room instead of the TV. Vetro catches the keys and
publishes an MQTT message for each press; this Shard receives those messages itself (no separate broker,
no Home Assistant) and sends the change straight to the Sonos speaker on your network. A **Sonos** tab
shows the volume, lets you pick the room, the step per press and a maximum volume, and lists the exact
values to enter in Vetro.

## How it works

```
remote key ─▶ Vetro: Remote interception + rule "Publish MQTT message"
          ─▶ this Shard: MQTT receiver on 127.0.0.1:1883
          ─▶ Sonos speaker: HTTP on port 1400 (the local UPnP interface the Sonos app also uses)
```

| Topic (default prefix `vetro/sonos`) | What it does |
| --- | --- |
| `vetro/sonos/volume-up` | volume up by the step (default 2), not past the maximum; unmutes |
| `vetro/sonos/volume-down` | volume down by the step; unmutes |
| `vetro/sonos/mute-toggle` | mute, or unmute if muted |
| `vetro/sonos/mute`, `vetro/sonos/unmute` | explicit mute and unmute |

The payload does not matter. Quick presses that arrive while a change is still being sent are added
together into one change. "This room only" changes the chosen room (a home theatre with surrounds and Sub
counts as one room); "the whole group" changes every room grouped with it, keeping their balance.

## Setup

1. Install and switch on this Shard, open its **Sonos** tab and choose the room: **Search the network**,
   or type the IP address of any Sonos speaker and **Look up**.
2. In Vetro's **MQTT** page, set broker `127.0.0.1`, port `1883`, no user name, TLS off, keep the topic
   prefix `vetro`, enable and save. The tab shows **Vetro connected** within half a minute.
3. In Vetro's **Remote** page, choose the remote, **Start listening**, and press Volume up, Volume down
   and Mute to see their key codes, then **Stop listening**. (On a 2022 The Frame with the infrared remote,
   device "wt61p807 rc device": 68, 67 and 66.)
4. Add three rules in the MQTT page. For each, change **Trigger type** from the default "MQTT message" to
   **Physical key**, enter the code, leave the payload blank, and choose **Publish MQTT message** to
   `vetro/sonos/volume-up`, `vetro/sonos/volume-down` and `vetro/sonos/mute-toggle`.
5. In the Remote page, choose your remote in the device menu (not "Detect automatically": that one only
   listens, and Vetro refuses to intercept with it). Then turn on **Remote interception** and press
   **Check Vetro setup** in the Sonos tab. Vetro 0.5.0 intercepts one remote device at a time; keys from
   another remote (for example a Bluetooth one) still go to the TV.

### When the keys do nothing

Vetro runs a rule for a remote key only while **Remote interception** is running, and only for keys it
intercepts. While **Start listening** is active, no rule runs: listening pauses interception until it is
stopped (or after five minutes without the Remote page open). A rule whose trigger type was left on
"MQTT message" waits for a message instead of a key, and never fires.

**Check Vetro setup** finds these: it reads Vetro's MQTT settings, rules and interception state and lists
what is wrong, with the last keys Vetro saw and whether they were intercepted. The Volume card shows how
many key presses arrived from Vetro, and the activity log names any message on a topic that is not a
command (a mistyped rule topic).

Vetro's MQTT link now points at this Shard, so it cannot also talk to another broker. If a key press
reaches Vetro while this Shard is off, Vetro gives the keys back to the TV for a minute and then tries again.

## Permissions

None. It runs no commands.

## Network

- **Listens** on `127.0.0.1` (TCP, port 1883 by default) for Vetro's MQTT connection. Only programs on
  the TV can reach it. An optional user name and password can be required.
- **Connects** to the Sonos speakers on your local network, HTTP port 1400: reads and sets volume and
  mute, and reads which rooms exist and how they are grouped. Nothing else is sent to them.
- **Search the network** sends an SSDP search (UDP multicast to `239.255.255.250:1900`); only when you
  press the button, or when the chosen speaker stops answering and no other speaker knows where it went.
- **Check Vetro setup** reads Vetro's own settings from Vetro's service on the TV (`127.0.0.1`, port 8099
  or the port Vetro was built with): `GET /mqtt` (without the password), `GET /remap` and `GET /input`.
  Read-only, and only when you press the button. See below: this is not part of the Shard API.
- No internet, no Sonos account, no cloud. Nothing is sent anywhere else.

## Goes around the Shard API (Check Vetro setup only)

The Shard API gives a Shard no access to Vetro's MQTT settings, rules or remote interception, so **Check
Vetro setup** goes around it:

- it calls Vetro's own HTTP routes `GET /mqtt`, `GET /remap` and `GET /input` from the TV itself, which
  Vetro answers without pairing;
- to find Vetro's port it reads `build-info.js` next to Vetro's main script (else `VETRO_PORT`, else 8099).

This is **not supported** by Vetro and **can break with any Vetro update**. It only reads, never changes a
setting, and runs only when you press the button. Opening `/input` also counts as "the Remote page is
open" for Vetro, which is why it never runs on a timer. If a Vetro update breaks it, the Check reports that
it could not read Vetro's settings; the volume keys themselves do not depend on it.

## Data it keeps

Its own `config.json`: the chosen room (name, Sonos id, address), room or group, step, maximum volume,
whether volume keys unmute, the receiver's port and topic prefix, and the optional user name and password
(stored in plain text on the TV; the page never shows the password again).

## Tested

On a computer, with Vetro's own MQTT client and bridge (from Vetro 0.5.0) connected to the receiver and a
simulated Sonos player that checks each request against the action and argument names in a real player's
service descriptions. The Sonos commands were also sent to a real Playbar (grouped with another room) and
read back: room and group volume, mute and unmute all worked, and room mode left the other room untouched.

On a 2022 The Frame (Vetro 0.5.0, Node 12.16) with Remote interception on the infrared remote ("wt61p807 rc
device", codes 68, 67 and 66), reported by the owner: volume up, volume down and mute from the remote
control a Sonos Playbar. Not tested: network search (SSDP) on the TV, and remotes other than the infrared one.
