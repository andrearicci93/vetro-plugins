# TV Channels

Browse, switch, search, and manage satellite (DVB-S) and Samsung TV Plus (IPTV) channels with instant tuning, in-place renaming, slot-conserving move/sort, automatic gap closure, and backup export/import.

<p align="center">
  <img src="../../docs/assets/channels-preview.png" alt="TV Channels Preview" width="700">
</p>

## What it does

Adds a unified **Channels** tab to the Vetro dashboard:
- **Instant Direct Tuning:** Switches channels instantly (<100ms) via direct service ID (`tune_channel <srvId>`), with high-speed D-Bus key injection fallback. Never relies on slow single-digit entry delays.
- **In-Place Channel Renaming:** Click any channel name in Editor view to rename it directly. Automatically encodes UTF-16 hex and updates `SRV.srvName` and `modifiedByUser = 1`.
- **Channel Move & Reordering:** Move single or multiple channels to a new target slot. Implements a conservation displacement algorithm that preserves relative order without overwriting existing channels, complete with an interactive preview and validation dialog.
- **Automatic Gap Closure on Deletion (`1-X`):** Deleting channels (single or batch) automatically shifts subsequent channels to fill freed slots, guaranteeing a clean consecutive channel sequence from 1 to X without holes or missing numbers.
- **Instant Search, Filter & Multi-Mode Sorting:** Search across all channels by number, name, frequency, or transponder. Sort channels by number (#1-9 / #9-1) or alphabetically (A-Z / Z-A).
- **Source & Visibility Filters:** Quickly filter between All, 📡 Satellite, 📺 TV Plus, 🆓 FTA (Free to Air), and 🙈 Hidden channels.
- **Batch Selection & Sticky Toolbar:** Sticky controls panel keeps search and batch action buttons (`All`, `🙈 Hide`, `👁️ Unhide`, `🗑️ Delete`, `🔄 Move`) visible while scrolling. The combined `All` toggle features a dynamic selection counter badge and native indeterminate state.
- **Export & Import Backups:** Export official Samsung-compatible `Channel_list_<Model>.zip` archives directly to your PC, phone, or tablet (compatible with Samsung USB restore and PC editors like ChanSort). Import any channel backup ZIP directly through the browser without USB drives, bypassing country and model mismatch restrictions.
- **TV Remote Controls & Sticky Reload:** Convenient sticky header controls for Volume (`Vol+`, `Vol-` with click-and-hold continuous auto-repeat) and Channel switching (`CH+`, `CH-`), displaying full labels on wide screens and space-saving icons on mobile. In Editor Mode, a sticky `🔄 Reload TV` button dynamically appears beside the search box when scrolling down.
- **TV Mode Input Switcher:** One-click `📺 TV Mode` button to immediately switch the TV from any app or HDMI input to live broadcast TV.
- **Mobile & Dense Viewports:** Fully responsive design with auto-hiding stats badges on mobile screens, compact buttons, and touch-optimized infinite scrolling.

## Permissions

`exec` — to query and update channel records in `/mnt/systemrw/tvs-chms/data/`, tune channels via `/usr/bin/launch_app` and D-Bus, send remote key events via `/usr/bin/input_keyevent`, switch input source via `/usr/bin/launch_app`, and reload channel daemons via `systemctl restart tvs_deamon.service` (or `pkill -9 tvs-daemon`).

## Commands it runs

| Command | Why |
| --- | --- |
| `/usr/bin/launch_app org.tizen.tv-viewer tune_channel <srvId>` | Instant direct channel switching via native TV service ID without digit delay |
| `/usr/bin/launch_app org.tizen.tv-viewer change_source 0 sourceType 0 sourceName TV mbrIndex -2 __K_EX_LAUNCH_REQUESTOR user` | Switches the TV source directly to Live Broadcast TV (DVB-S/Tizen TV Viewer) from any app or HDMI input |
| `dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:<0\|1> string:<key>` | High-speed fallback key injection for tuning by channel number or returning to TV mode |
| `/usr/bin/input_keyevent <keysym>` | Dispatches remote key events (`XF86AudioRaiseVolume`, `XF86AudioLowerVolume`, `XF86AudioMute`, `XF86RaiseChannel`, `XF86LowerChannel`, `XF86Exit`) from a strict allow-list |
| `sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "ATTACH ...; SELECT ..."` | Queries satellite channel numbers, decoded UTF-16 names, frequencies, polarization, symbol rates, and satellites |
| `sqlite3 /mnt/systemrw/tvs-chms/data/ipsrv "SELECT ..."` | Queries Samsung TV Plus (IPTV) channels |
| `sqlite3 <dbPath> "PRAGMA ...; UPDATE SRV SET ...; PRAGMA wal_checkpoint(TRUNCATE);"` | Updates channel visibility flags (`hidden`, `hideGuide`, `numSel`), names, or positions |
| `sqlite3 <dbPath> < /tmp/ch_del_*.sql` | Executes atomic batch channel deletion and `1-X` sequential renumbering |
| `sqlite3 <dbPath> < /tmp/ch_mv_*.sql` | Executes atomic batch channel move and displacement |
| `sqlite3 <extracted_db> "PRAGMA integrity_check;"` | Validates SQLite integrity of uploaded backup database files before applying them |
| `sqlite3 <dbPath> "PRAGMA wal_checkpoint(TRUNCATE);"` | Checkpoints SQLite write-ahead log to disk |
| `sh -c "..."` | Executes scripted shell operations for export, verified import, and daemon reload |
| `cp /mnt/systemrw/tvs-chms/data/* /tmp/ch_bak_*` | Backs up existing TV channel databases before importing an uploaded backup |
| `cp /tmp/ch_imp_*/* /mnt/systemrw/tvs-chms/data/*` | Copies verified channel database files into place during backup import |
| `rm -f /mnt/systemrw/tvs-chms/data/*-wal /mnt/systemrw/tvs-chms/data/*-shm` | Cleans up stale write-ahead log and shared memory files before database replacement |
| `rm -f /tmp/... / rm -rf /tmp/...` | Removes temporary SQL scripts, zip archives, and extraction/backup folders |
| `mkdir -p /tmp/...` | Creates temporary directories for export staging and verified import |
| `cat << 'EOFXML' > /tmp/ch_export/metadata.xml` | Generates required Samsung TV storage metadata XML when exporting a backup archive |
| `grep -i "^Version=" /etc/prd_info.ini` | Queries TV firmware model version to construct standard Samsung backup filename |
| `cut -d "=" -f2`, `tr -d ";\r\n "` | Extracts clean firmware version string for backup file naming |
| `/usr/bin/zip -j /tmp/Channel_list_<Model>.zip ...` | Packages channel databases into an official Samsung TV USB and ChanSort compatible zip archive for export |
| `/usr/bin/unzip -t /tmp/...` | Validates zip archive format and integrity before extraction |
| `/usr/bin/unzip -o -q /tmp/... -d /tmp/...` | Extracts uploaded channel list zip archives for SQLite validation and import |
| `systemctl restart tvs_deamon.service` / `pkill -9 tvs-daemon` | Restarts the channel service daemon (`tvs_deamon.service`, configured with `Restart=on-failure`) when clicking **Reload TV** or importing a backup so it re-reads modified databases without remaining halted |
| `sleep 1` / `sleep 0.5` | Waits briefly for daemon reload or source switch initialization |

## Network

None. All queries and commands execute locally on the TV.

## Data it keeps

Temporary files in `/tmp` (`/tmp/Channel_list_*.zip`, `/tmp/ch_del_*.sql`, `/tmp/ch_mv_*.sql`, `/tmp/ch_imp_*`, `/tmp/ch_bak_*`) created during export, import, or batch operations and removed immediately upon completion.

> [!WARNING]
> Importing a channel list backup overwrites the TV's native channel databases in `/mnt/systemrw/tvs-chms/data/`. The plugin automatically validates SQLite database integrity and takes a temporary backup before applying changes.

## Tested Environment

- **Model:** Samsung Smart TV UA50AU7000 (Tizen 6.0)
- **Vetro Version:** Vetro 0.5.0 (Node v12.4.0)

*Note:* Tested specifically on Samsung Smart TV UA50AU7000 running Tizen 6.0 and Vetro 0.5.0; behavior on other TV models and firmware versions is untested.
