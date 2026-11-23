# Home Assistant

A Vetro Shard that adds a **Home Assistant card to the Control center** (Down on the launcher's apps row): up to seven
entities you chose, each with its state ("Living room · on"). OK on a row switches it. A page in the Vetro dashboard
sets it up. It is also the example Shard for the Control center card API.

This is not Vetro's own Home Assistant connection (MQTT, in the dashboard). That one publishes the TV to Home Assistant;
this Shard goes the other way and lets the TV's remote control things in your home.

## What it needs

- **Vetro 0.7.0 or later** for the card. On older versions the Shard loads and its page works, but there is no card.
- The Control center on: **Vetro UI → Launcher → Control center**, switch **Home Assistant** on (it is off until you do; at most three cards in all).
- A Home Assistant the TV can reach, and a **long-lived access token**: in Home Assistant, your profile → Security → Long-lived access tokens.
  Use the server's IP address (`http://192.168.1.20:8123`): a name ending in `.local` often does not resolve on the TV.
  `https://` works only if the TV trusts the certificate.

## Setting it up

1. Switch the Shard on in **Vetro Shards**, then open its **Home Assistant** page.
2. Enter the address and the token, **Save and test**. The page reads your entities from Home Assistant.
3. **Add** up to seven entities, name them, put them in order, **Save the card**.

## What the card does

| Entity | The row shows | OK |
| --- | --- | --- |
| `light`, `switch`, `fan`, `input_boolean` | its state: `on`, `off`, `unavailable` | turns it off if the row says `on`, on otherwise |
| `scene`, `script` | `Scene`, `Script` | runs it |
| `button`, `input_button` | `Button` | presses it |

- OK uses the state the row showed (`turn_on` or `turn_off`, never Home Assistant's `toggle`), so a press after a stale read cannot flip the entity back. The row changes at once to what Home Assistant answers.
- The card is read each time the Control center opens: one call per entity that has a state, never the whole list. If Home Assistant does not answer, the card says why (**HA did not answer**, **Token refused**, **HA address not found**) and the next opening tries again.
- **Left out on purpose:** locks, covers (garage doors), alarm panels and anything else that opens or disarms something. A remote-control key press should not do that. A script or scene you add runs with the token's full rights, so choose them with that in mind.

## Permissions

None. It runs no command on the TV.

## Network

Only the Home Assistant address you set, over HTTP or HTTPS, with your token in the `Authorization` header:

| Request | When |
| --- | --- |
| `GET /api/states/<entity_id>` | the Control center opens (one per chosen entity that has a state), and the first press on a row not shown yet |
| `POST /api/services/<domain>/<service>` with `{"entity_id": …}` | OK on a row: `turn_on`, `turn_off` or `press` |
| `GET /api/states` | only when you open the page or press **Save and test**, to list the entities you can add |

Nothing else, and no other host. The address cannot carry a user name or password.

## Data it keeps

`config.json` in the Shard's folder on the TV (Vetro's `ctx.config`, kept across updates): the address, the **token in clear text**, and the
entities with the names you gave them. The page never gets the token back, the Shard's status does not show it, and **a new address forgets the
old token** so it cannot be sent somewhere else by changing the address. Anyone who can read the TV's files, or who is a paired device of Vetro, can reach it:
use a token made for this, and delete it in Home Assistant if you remove the Shard. Removing the Shard in Vetro deletes the file.

## Tested

Against a fake Home Assistant: `tests/home-assistant.test.cjs` (slow answers, `401`, broken JSON, more than seven entities, odd ids, an unknown row, the setup
routes) and, by hand, `tests/manual/home-assistant-in-vetro-host.cjs <vetro repo>`, which installs the bundle in Vetro's own plugin host (`plugin-host.js`, commit `f1b48f6`) and
checks what the card shows after the host's limits, timeouts and cleaning. The network code also ran on Node 4.4.7, 12 and 22. The author also tried the card on a real TV
with a real Home Assistant, through the whole chain (the launcher, the Vetro service, this Shard).
