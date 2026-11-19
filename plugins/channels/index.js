'use strict';

// Vetro Shard: TV Channels
//
// Fast satellite & IP channel browser, frequency search, and instant channel switcher.
// Reads directly from Tizen's channel management database:
//   - DVB-S Satellite: /mnt/systemrw/tvs-chms/data/dvbs & sat
//   - IPTV (Samsung TV Plus): /mnt/systemrw/tvs-chms/data/ipsrv
// Tunes channels instantly via /usr/bin/launch_app org.tizen.tv-viewer tune_channel <srvId>
// with high-speed D-Bus key injection fallback.

var fs = require('fs');
var path = require('path');

function decodeUtf16(raw) {
    if (!raw) return '';
    var chars = [];
    for (var i = 0; i < raw.length; i++) {
        var c = raw.charCodeAt(i);
        var chCode = ((c & 0xFF) << 8) | (c >> 8);
        if (chCode !== 0) {
            chars.push(String.fromCharCode(chCode));
        }
    }
    return chars.join('').trim();
}

function encodeUtf16Hex(str) {
    if (!str) return '';
    var hex = '';
    for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        var high = (code >> 8) & 0xFF;
        var low = code & 0xFF;
        var hStr = high.toString(16);
        if (hStr.length < 2) hStr = '0' + hStr;
        var lStr = low.toString(16);
        if (lStr.length < 2) lStr = '0' + lStr;
        hex += hStr + lStr;
    }
    return hex;
}

function readJson(req, maxBytes, callback) {
    var limit = maxBytes || 8192;
    var body = '';
    var done = false;

    function finish(err, res) {
        if (done) return;
        done = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        callback(err, res);
    }

    function onData(chunk) {
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > limit) {
            finish(new Error('payload too large (max ' + limit + ' bytes)'), null);
        }
    }

    function onEnd() {
        if (!body) {
            finish(null, {});
            return;
        }
        try {
            var data = JSON.parse(body);
            if (!data || typeof data !== 'object') {
                finish(new Error('invalid JSON payload'), null);
                return;
            }
            finish(null, data);
        } catch (e) {
            finish(new Error('invalid JSON format: ' + e.message), null);
        }
    }

    function onError(e) {
        finish(e || new Error('request error'), null);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
}

function computeChannelMoves(allChannels, selectedNums, target) {
    var selectedSet = {};
    for (var i = 0; i < selectedNums.length; i++) {
        selectedSet[selectedNums[i]] = true;
    }

    var selected = [];
    var unselected = [];
    for (var j = 0; j < allChannels.length; j++) {
        var ch = allChannels[j];
        if (selectedSet[ch.major]) {
            selected.push(ch);
        } else {
            unselected.push(ch);
        }
    }

    selected.sort(function (a, b) { return a.major - b.major; });
    unselected.sort(function (a, b) { return a.major - b.major; });
    var k = selected.length;

    if (k === 0) return { error: 'No channels selected' };
    if (isNaN(target) || target < 1 || target > 9999) return { error: 'Target channel number must be between 1 and 9999' };
    if (target + k - 1 > 9999) return { error: 'Target range would exceed maximum channel number 9999' };

    var currentSelectedNums = [];
    var targetSlots = [];
    for (var m = 0; m < k; m++) {
        currentSelectedNums.push(selected[m].major);
        targetSlots.push(target + m);
    }

    var isAlready = true;
    for (var n = 0; n < k; n++) {
        if (currentSelectedNums[n] !== targetSlots[n]) {
            isAlready = false;
            break;
        }
    }
    if (isAlready) {
        return { error: 'Selected channel(s) already occupy #' + target + (k > 1 ? (' - #' + (target + k - 1)) : '') };
    }

    var allSorted = allChannels.slice().sort(function (a, b) { return a.major - b.major; });
    var maxOrig = allSorted.length > 0 ? allSorted[allSorted.length - 1].major : 0;

    // If moving beyond the max existing channel number into open space:
    if (target > maxOrig) {
        var simpleChanges = [];
        for (var p = 0; p < k; p++) {
            simpleChanges.push({
                srvId: selected[p].srvId,
                oldMajor: selected[p].major,
                newMajor: target + p
            });
        }
        return { changes: simpleChanges };
    }

    var minInvolved = Math.min(currentSelectedNums[0], target);
    var maxInvolved = Math.max(currentSelectedNums[currentSelectedNums.length - 1], target + k - 1);

    var involved = [];
    var involvedUnselected = [];
    var occupiedSlotsMap = {};

    for (var q = 0; q < allSorted.length; q++) {
        var cItem = allSorted[q];
        if (cItem.major >= minInvolved && cItem.major <= maxInvolved) {
            involved.push(cItem);
            occupiedSlotsMap[cItem.major] = true;
            if (!selectedSet[cItem.major]) {
                involvedUnselected.push(cItem);
            }
        }
    }

    for (var tIdx = 0; tIdx < targetSlots.length; tIdx++) {
        occupiedSlotsMap[targetSlots[tIdx]] = true;
    }

    var occupiedSlots = [];
    for (var slotStr in occupiedSlotsMap) {
        if (occupiedSlotsMap.hasOwnProperty(slotStr)) {
            occupiedSlots.push(parseInt(slotStr, 10));
        }
    }
    occupiedSlots.sort(function (a, b) { return a - b; });

    var targetSlotsSet = {};
    for (var ts = 0; ts < targetSlots.length; ts++) {
        targetSlotsSet[targetSlots[ts]] = true;
    }

    var unselectedSlots = [];
    for (var os = 0; os < occupiedSlots.length; os++) {
        if (!targetSlotsSet[occupiedSlots[os]]) {
            unselectedSlots.push(occupiedSlots[os]);
        }
    }

    var newAssignments = {};
    for (var sIdx = 0; sIdx < selected.length; sIdx++) {
        newAssignments[selected[sIdx].srvId] = targetSlots[sIdx];
    }
    for (var uIdx = 0; uIdx < involvedUnselected.length; uIdx++) {
        if (uIdx < unselectedSlots.length) {
            newAssignments[involvedUnselected[uIdx].srvId] = unselectedSlots[uIdx];
        }
    }

    var changes = [];
    for (var aIdx = 0; aIdx < allSorted.length; aIdx++) {
        var curCh = allSorted[aIdx];
        if (newAssignments.hasOwnProperty(curCh.srvId) && newAssignments[curCh.srvId] !== curCh.major) {
            changes.push({
                srvId: curCh.srvId,
                oldMajor: curCh.major,
                newMajor: newAssignments[curCh.srvId]
            });
        }
    }

    return { changes: changes };
}

function deleteAndCompactDb(ctx, dbPath, delSet) {
    return new Promise(function (resolve, reject) {
        ctx.execute('sqlite3 ' + dbPath + ' "SELECT srvId, major FROM SRV WHERE elim = 0 ORDER BY major ASC;"', 10000)
            .then(function (qRes) {
                if (qRes.exit_code !== 0) {
                    return reject(new Error('Failed to query channels from ' + dbPath + ': ' + (qRes.stderr || 'exit code ' + qRes.exit_code)));
                }

                var lines = (qRes.stdout || '').split('\n');
                var dbChannels = [];
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (!line) continue;
                    var parts = line.split('|');
                    if (parts.length >= 2) {
                        var m = parseInt(parts[1], 10);
                        if (!isNaN(m) && m > 0) {
                            dbChannels.push({
                                srvId: parts[0],
                                major: m
                            });
                        }
                    }
                }

                if (dbChannels.length === 0) {
                    return resolve({ deleted: 0, shifted: 0, remaining: 0 });
                }

                var toDelete = [];
                var toKeep = [];
                for (var j = 0; j < dbChannels.length; j++) {
                    var ch = dbChannels[j];
                    if (delSet[ch.major] || delSet[ch.srvId]) {
                        toDelete.push(ch);
                    } else {
                        toKeep.push(ch);
                    }
                }

                if (toDelete.length === 0) {
                    return resolve({ deleted: 0, shifted: 0, remaining: dbChannels.length });
                }

                var changes = [];
                for (var k = 0; k < toKeep.length; k++) {
                    var newMajor = k + 1;
                    if (toKeep[k].major !== newMajor) {
                        changes.push({
                            srvId: toKeep[k].srvId,
                            oldMajor: toKeep[k].major,
                            newMajor: newMajor
                        });
                    }
                }

                var delSrvIds = [];
                for (var d = 0; d < toDelete.length; d++) {
                    delSrvIds.push(toDelete[d].srvId);
                }

                var sqlParts = [
                    '.bail on',
                    '.timeout 5000',
                    'PRAGMA busy_timeout = 5000;',
                    'BEGIN TRANSACTION;'
                ];
                sqlParts.push('UPDATE SRV SET elim = 1, hidden = 1, hideGuide = 1, numSel = 0, major = 0 WHERE srvId IN (' + delSrvIds.join(',') + ');');

                if (changes.length > 0) {
                    var caseClauses = [];
                    var changeSrvIds = [];
                    for (var c = 0; c < changes.length; c++) {
                        caseClauses.push('WHEN ' + changes[c].srvId + ' THEN ' + changes[c].newMajor);
                        changeSrvIds.push(changes[c].srvId);
                    }
                    sqlParts.push('UPDATE SRV SET major = CASE srvId ' + caseClauses.join(' ') + ' END, modifiedByUser = 1 WHERE srvId IN (' + changeSrvIds.join(',') + ');');
                }

                sqlParts.push('COMMIT;');
                sqlParts.push('PRAGMA wal_checkpoint(TRUNCATE);');

                var fullSql = sqlParts.join('\n');
                var tmpFile = '/tmp/ch_del_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6) + '.sql';

                try {
                    fs.writeFileSync(tmpFile, fullSql, 'utf8');
                } catch (fsErr) {
                    return reject(new Error('Failed to write temp SQL file: ' + fsErr.message));
                }

                var cmd = 'sqlite3 ' + dbPath + ' < ' + tmpFile + '; rm -f ' + tmpFile + ';';
                ctx.execute(cmd, 15000)
                    .then(function (res) {
                        if (res.exit_code !== 0) {
                            return reject(new Error('Failed to execute delete & compact on ' + dbPath + ': ' + (res.stderr || 'exit code ' + res.exit_code)));
                        }
                        resolve({
                            deleted: toDelete.length,
                            shifted: changes.length,
                            remaining: toKeep.length
                        });
                    }, function (execErr) {
                        try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
                        reject(execErr);
                    });
            }, reject);
    });
}

function loadPage(ctx) {
    var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
    for (var i = 0; i < places.length; i++) {
        try { return fs.readFileSync(places[i], 'utf8'); } catch (e) { /* next */ }
    }
    return '<!doctype html><meta charset="utf-8"><p>Page file missing: reinstall this Shard.</p>';
}

var ALLOWED_KEYS = {
    vol_up: 'XF86AudioRaiseVolume',
    'vol+': 'XF86AudioRaiseVolume',
    VolumeUp: 'XF86AudioRaiseVolume',
    XF86AudioRaiseVolume: 'XF86AudioRaiseVolume',
    vol_down: 'XF86AudioLowerVolume',
    'vol-': 'XF86AudioLowerVolume',
    VolumeDown: 'XF86AudioLowerVolume',
    XF86AudioLowerVolume: 'XF86AudioLowerVolume',
    mute: 'XF86AudioMute',
    XF86AudioMute: 'XF86AudioMute',
    ch_up: 'XF86RaiseChannel',
    'ch+': 'XF86RaiseChannel',
    ChannelUp: 'XF86RaiseChannel',
    XF86RaiseChannel: 'XF86RaiseChannel',
    ch_down: 'XF86LowerChannel',
    'ch-': 'XF86LowerChannel',
    ChannelDown: 'XF86LowerChannel',
    XF86LowerChannel: 'XF86LowerChannel',
    exit: 'XF86Exit',
    XF86Exit: 'XF86Exit',
    Return: 'Return',
    Up: 'Up',
    Down: 'Down',
    Left: 'Left',
    Right: 'Right'
};

module.exports = function (ctx) {
    var page = null;
    var cachedChannels = null;
    var lastFetchTime = 0;
    var dbBusy = false;

    function withDbLock(res, actionFn) {
        if (dbBusy) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Another database modification is in progress. Please wait.' }));
            return;
        }
        dbBusy = true;
        var released = false;
        function release() {
            if (!released) {
                released = true;
                dbBusy = false;
            }
        }
        try {
            actionFn(release);
        } catch (err) {
            release();
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
    }

    function queryDatabase() {
        var sql = "ATTACH '/mnt/systemrw/tvs-chms/data/sat' AS sat_db; " +
            "SELECT S.major, S.srvName, IFNULL(T.tpFreq/1000, 0), IFNULL(T.tpPol, -1), IFNULL(T.tpSr, 0), IFNULL(SAT.satName, ''), S.scrambled, S.hidden, S.srvId " +
            "FROM SRV S " +
            "LEFT JOIN CHNL C ON S.chId = C.chId " +
            "LEFT JOIN sat_db.SAT_TP T ON C.chNum = T.tpId " +
            "LEFT JOIN sat_db.SAT SAT ON T.satId = SAT.satId " +
            "WHERE S.elim = 0 " +
            "ORDER BY S.major ASC;";

        var cmd = 'sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "' + sql + '"';

        return ctx.execute(cmd, 10000).then(function (res) {
            var channels = [];
            if (res.exit_code === 0 && res.stdout) {
                var lines = res.stdout.split('\n');
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    if (!line) continue;
                    var parts = line.split('|');
                    if (parts.length < 8) continue;
                    var major = parseInt(parts[0], 10);
                    if (isNaN(major)) continue;
                    var name = decodeUtf16(parts[1]);
                    var freq = parseInt(parts[2], 10) || 0;
                    var polRaw = parts[3];
                    var pol = polRaw === '0' ? 'H' : (polRaw === '1' ? 'V' : '');
                    var sr = parseInt(parts[4], 10) || 0;
                    var sat = decodeUtf16(parts[5]);
                    var scrambled = parts[6] === '1';
                    var hidden = parts[7] === '1';
                    var srvId = parts[8] ? String(parts[8]).trim() : '';

                    channels.push({
                        num: major,
                        name: name,
                        freq: freq,
                        pol: pol,
                        sr: sr,
                        sat: sat || 'Satellite',
                        type: 'dvbs',
                        scrambled: scrambled,
                        hidden: hidden,
                        srvId: srvId
                    });
                }
            }

            // Also query IPTV (Samsung TV Plus) from ipsrv
            var sqlIp = "SELECT major, srvName, hidden, srvId FROM SRV WHERE elim = 0 ORDER BY major ASC;";
            var cmdIp = 'sqlite3 /mnt/systemrw/tvs-chms/data/ipsrv "' + sqlIp + '"';

            return ctx.execute(cmdIp, 5000).then(function (resIp) {
                if (resIp.exit_code === 0 && resIp.stdout) {
                    var linesIp = resIp.stdout.split('\n');
                    for (var j = 0; j < linesIp.length; j++) {
                        var l = linesIp[j];
                        if (!l) continue;
                        var p = l.split('|');
                        if (p.length < 3) continue;
                        var m = parseInt(p[0], 10);
                        if (isNaN(m)) continue;
                        var ipSrvId = p[3] ? String(p[3]).trim() : '';
                        channels.push({
                            num: m,
                            name: decodeUtf16(p[1]),
                            freq: 0,
                            pol: '',
                            sr: 0,
                            sat: 'Samsung TV Plus',
                            type: 'iptv',
                            scrambled: false,
                            hidden: p[2] === '1',
                            srvId: ipSrvId
                        });
                    }
                }

                cachedChannels = channels;
                lastFetchTime = Date.now();
                return channels;
            }).catch(function () {
                cachedChannels = channels;
                lastFetchTime = Date.now();
                return channels;
            });
        });
    }

    return {
        start: function () {
            page = loadPage(ctx);
        },

        stop: function () {
            page = null;
            cachedChannels = null;
            lastFetchTime = 0;
            dbBusy = false;
        },

        status: function () {
            return {
                ok: true,
                count: cachedChannels ? cachedChannels.length : 0
            };
        },

        route: function (req, res, sub) {
            var action = (sub || '').split('?')[0];

            // Global CORS OPTIONS preflight handler for sandboxed iframe UI
            if (req.method === 'OPTIONS') {
                res.writeHead(204, {
                    'access-control-allow-origin': '*',
                    'access-control-allow-methods': 'GET, POST, OPTIONS',
                    'access-control-allow-headers': '*',
                    'access-control-max-age': '86400'
                });
                res.end();
                return true;
            }

            // GET api/ui
            if (action === 'ui' && req.method === 'GET') {
                if (!page) page = loadPage(ctx);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(page || '');
                return true;
            }

            // GET api/list
            if (action === 'list' && req.method === 'GET') {
                var forceRefresh = req.url && req.url.indexOf('refresh=1') >= 0;
                if (!forceRefresh && cachedChannels && (Date.now() - lastFetchTime < 3000)) {
                    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ ok: true, channels: cachedChannels }));
                    return true;
                }

                queryDatabase()
                    .then(function (channels) {
                        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                        res.end(JSON.stringify({ ok: true, channels: channels }));
                    }, function (err) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                    });
                return true;
            }

            // POST api/tune — switch TV to selected channel number or direct srvId
            if ((sub === 'tune' || action === 'tune') && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }

                    var channel = parseInt(parsed.channel, 10);
                    var srvId = parsed.srvId ? String(parsed.srvId).trim() : null;
                    var forceTv = !!parsed.forceTv;

                    // If srvId wasn't provided in the request body, look it up in cachedChannels
                    if (!srvId && cachedChannels && channel) {
                        for (var c = 0; c < cachedChannels.length; c++) {
                            if (cachedChannels[c].num === channel && cachedChannels[c].srvId) {
                                srvId = cachedChannels[c].srvId;
                                break;
                            }
                        }
                    }

                    // METHOD 1: Instant Direct Tune via srvId (0ms delay, no digit entry)
                    if (srvId && /^-?[0-9]+$/.test(srvId)) {
                        var launchCmd = '/usr/bin/launch_app org.tizen.tv-viewer tune_channel ' + srvId;
                        ctx.execute(launchCmd, 4000).then(function (r) {
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: r.exit_code === 0, channel: channel, srvId: srvId, method: 'direct' }));
                        }, function (e) {
                            res.writeHead(500, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: e.message }));
                        });
                        return;
                    }

                    // METHOD 2 (Fallback): High-Speed Async D-Bus Key Injection
                    if (!channel || isNaN(channel) || channel <= 0) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'invalid channel number or srvId' }));
                        return;
                    }

                    var digits = String(channel).split('');
                    var keyCmds = [];

                    if (forceTv) {
                        keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:1 string:XF86TV');
                        keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:0 string:XF86TV');
                        keyCmds.push('sleep 0.5');
                    }

                    for (var d = 0; d < digits.length; d++) {
                        keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:1 string:"' + digits[d] + '"');
                        keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:0 string:"' + digits[d] + '"');
                        if (d < digits.length - 1) {
                            keyCmds.push('sleep 0.05');
                        }
                    }
                    keyCmds.push('sleep 0.05');
                    keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:1 string:Return');
                    keyCmds.push('dbus-send --system --type=method_call --dest=org.enlightenment.wm /org/enlightenment/wm org.enlightenment.wm.Test.EventKey uint32:0 string:Return');

                    var fullCmd = keyCmds.join('; ');

                    ctx.execute(fullCmd, 6000).then(function (r) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: r.exit_code === 0, channel: channel, method: 'keys', stderr: r.stderr }));
                    }, function (e) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                });
                return true;
            }

            // POST api/tvsource — switch input directly to Broadcast TV
            if ((sub === 'tvsource' || action === 'tvsource') && req.method === 'POST') {
                var switchCmd = 'sh -c "/usr/bin/input_keyevent XF86Exit; /usr/bin/launch_app org.tizen.tv-viewer change_source 0 sourceType 0 sourceName TV mbrIndex -2 __K_EX_LAUNCH_REQUESTOR user"';
                ctx.execute(switchCmd, 6000).then(function (r) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: r.exit_code === 0 }));
                }, function (e) {
                    res.writeHead(500, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                });
                return true;
            }

            // POST api/reload — reload channel manager daemon
            if ((sub === 'reload' || action === 'reload') && req.method === 'POST') {
                withDbLock(res, function (release) {
                    var reloadCmd = 'sh -c "(systemctl restart tvs_deamon.service || pkill -9 tvs-daemon || true) && sleep 1 && (/usr/bin/launch_app org.tizen.tv-viewer change_source 0 sourceType 0 sourceName TV mbrIndex -2 __K_EX_LAUNCH_REQUESTOR user >/dev/null 2>&1 || true)"';
                    ctx.execute(reloadCmd, 8000).then(function (r) {
                        release();
                        cachedChannels = null;
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: r.exit_code === 0 }));
                    }, function (e) {
                        release();
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                });
                return true;
            }

            // POST api/key — send key event (e.g. Vol+, Vol-, CH+, CH-)
            if ((sub === 'key' || action === 'key') && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }
                    var k = parsed.key;
                    var keySym = ALLOWED_KEYS[k];

                    if (!keySym) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'Invalid key' }));
                        return;
                    }

                    ctx.execute('/usr/bin/input_keyevent ' + keySym, 3000).then(function (r) {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: r.exit_code === 0, key: keySym }));
                    }, function (e) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    });
                });
                return true;
            }

            // POST api/edit — manage channel flags (hide, unhide, delete, move, rename)
            if ((sub === 'edit' || action === 'edit') && req.method === 'POST') {
                readJson(req, 65536, function (err, parsed) {
                    if (err) {
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                        return;
                    }

                    withDbLock(res, function (release) {
                        var editAction = parsed.action;
                        var dvbsChannels = [];
                        var ipsrvChannels = [];

                        if (Array.isArray(parsed.dvbs) || Array.isArray(parsed.ipsrv)) {
                            if (Array.isArray(parsed.dvbs)) {
                                for (var d = 0; d < parsed.dvbs.length; d++) {
                                    var dn = parseInt(parsed.dvbs[d], 10);
                                    if (dn > 0 && !isNaN(dn)) dvbsChannels.push(dn);
                                }
                            }
                            if (Array.isArray(parsed.ipsrv)) {
                                for (var ip = 0; ip < parsed.ipsrv.length; ip++) {
                                    var ipn = parseInt(parsed.ipsrv[ip], 10);
                                    if (ipn > 0 && !isNaN(ipn)) ipsrvChannels.push(ipn);
                                }
                            }
                        } else {
                            var legacyList = [];
                            if (Array.isArray(parsed.channels)) {
                                for (var ci = 0; ci < parsed.channels.length; ci++) {
                                    var cNum = parseInt(parsed.channels[ci], 10);
                                    if (cNum > 0 && !isNaN(cNum)) legacyList.push(cNum);
                                }
                            } else if (parsed.channel) {
                                var sNum = parseInt(parsed.channel, 10);
                                if (sNum > 0 && !isNaN(sNum)) legacyList.push(sNum);
                            }
                            if (parsed.type === 'ipsrv') {
                                ipsrvChannels = legacyList;
                            } else {
                                dvbsChannels = legacyList;
                            }
                        }

                        var totalChannels = dvbsChannels.length + ipsrvChannels.length;
                        if (!editAction || (editAction !== 'move' && totalChannels === 0)) {
                            release();
                            res.writeHead(400, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: 'missing action or channels' }));
                            return;
                        }

                        // ACTION 1: DELETE with 1-X gap closure
                        if (editAction === 'delete') {
                            var delTasks = [];

                            if (dvbsChannels.length > 0) {
                                var dvbsDelSet = {};
                                for (var di = 0; di < dvbsChannels.length; di++) {
                                    dvbsDelSet[dvbsChannels[di]] = true;
                                }
                                if (parsed.srvId && parsed.type !== 'ipsrv') {
                                    dvbsDelSet[String(parsed.srvId).trim()] = true;
                                }
                                delTasks.push(function () {
                                    return deleteAndCompactDb(ctx, '/mnt/systemrw/tvs-chms/data/dvbs', dvbsDelSet);
                                });
                            }

                            if (ipsrvChannels.length > 0) {
                                var ipsrvDelSet = {};
                                for (var ipi = 0; ipi < ipsrvChannels.length; ipi++) {
                                    ipsrvDelSet[ipsrvChannels[ipi]] = true;
                                }
                                if (parsed.srvId && parsed.type === 'ipsrv') {
                                    ipsrvDelSet[String(parsed.srvId).trim()] = true;
                                }
                                delTasks.push(function () {
                                    return deleteAndCompactDb(ctx, '/mnt/systemrw/tvs-chms/data/ipsrv', ipsrvDelSet);
                                });
                            }

                            var totalDeleted = 0;
                            var totalShifted = 0;
                            var runDelIndex = function (idx) {
                                if (idx >= delTasks.length) {
                                    release();
                                    cachedChannels = null;
                                    res.writeHead(200, { 'content-type': 'application/json' });
                                    res.end(JSON.stringify({
                                        ok: true,
                                        action: 'delete',
                                        deleted: totalDeleted,
                                        shifted: totalShifted
                                    }));
                                    return;
                                }
                                delTasks[idx]().then(function (result) {
                                    totalDeleted += (result.deleted || 0);
                                    totalShifted += (result.shifted || 0);
                                    runDelIndex(idx + 1);
                                }, function (delErr) {
                                    release();
                                    res.writeHead(500, { 'content-type': 'application/json' });
                                    res.end(JSON.stringify({ ok: false, error: delErr.message }));
                                });
                            };

                            runDelIndex(0);
                            return;
                        }

                        // ACTION 2: MOVE channel(s) with conservation displacement
                        if (editAction === 'move') {
                            var targetType = parsed.type === 'ipsrv' ? 'ipsrv' : 'dvbs';
                            var dbPath = targetType === 'ipsrv' ? '/mnt/systemrw/tvs-chms/data/ipsrv' : '/mnt/systemrw/tvs-chms/data/dvbs';
                            var channels = targetType === 'ipsrv' ? ipsrvChannels : dvbsChannels;
                            var target = parseInt(parsed.target, 10);
                            if (isNaN(target) || target < 1 || target > 9999) {
                                release();
                                res.writeHead(400, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'target channel must be between 1 and 9999' }));
                                return;
                            }

                            ctx.execute('sqlite3 ' + dbPath + ' "SELECT srvId, major FROM SRV WHERE elim = 0 ORDER BY major ASC;"', 10000)
                                .then(function (qRes) {
                                    if (qRes.exit_code !== 0) {
                                        release();
                                        res.writeHead(500, { 'content-type': 'application/json' });
                                        res.end(JSON.stringify({ ok: false, error: 'database query failed: ' + (qRes.stderr || 'code ' + qRes.exit_code) }));
                                        return;
                                    }

                                    var lines = (qRes.stdout || '').split('\n');
                                    var dbChannels = [];
                                    for (var i = 0; i < lines.length; i++) {
                                        var line = lines[i].trim();
                                        if (!line) continue;
                                        var parts = line.split('|');
                                        if (parts.length >= 2) {
                                            var m = parseInt(parts[1], 10);
                                            if (!isNaN(m) && m > 0) {
                                                dbChannels.push({
                                                    srvId: parts[0],
                                                    major: m
                                                });
                                            }
                                        }
                                    }

                                    var plan = computeChannelMoves(dbChannels, channels, target);
                                    if (plan.error) {
                                        release();
                                        res.writeHead(400, { 'content-type': 'application/json' });
                                        res.end(JSON.stringify({ ok: false, error: plan.error }));
                                        return;
                                    }

                                    var changes = plan.changes || [];
                                    if (changes.length === 0) {
                                        release();
                                        res.writeHead(200, { 'content-type': 'application/json' });
                                        res.end(JSON.stringify({ ok: true, action: 'move', changed: 0, message: 'Channels are already at the target location' }));
                                        return;
                                    }

                                    var caseParts = [];
                                    var srvIdList = [];
                                    for (var c = 0; c < changes.length; c++) {
                                        caseParts.push('WHEN ' + changes[c].srvId + ' THEN ' + changes[c].newMajor);
                                        srvIdList.push(changes[c].srvId);
                                    }

                                    var moveSql = '.bail on\n' +
                                        '.timeout 5000\n' +
                                        'PRAGMA busy_timeout = 5000;\n' +
                                        'BEGIN TRANSACTION;\n' +
                                        'UPDATE SRV SET major = CASE srvId ' + caseParts.join(' ') + ' END, modifiedByUser = 1 WHERE srvId IN (' + srvIdList.join(',') + ');\n' +
                                        'COMMIT;\n' +
                                        'PRAGMA wal_checkpoint(TRUNCATE);';

                                    var tmpMove = '/tmp/ch_mv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6) + '.sql';
                                    try {
                                        fs.writeFileSync(tmpMove, moveSql, 'utf8');
                                    } catch (fsErr) {
                                        release();
                                        res.writeHead(500, { 'content-type': 'application/json' });
                                        res.end(JSON.stringify({ ok: false, error: 'Failed to write SQL: ' + fsErr.message }));
                                        return;
                                    }

                                    var cmd = 'sqlite3 ' + dbPath + ' < ' + tmpMove + '; rm -f ' + tmpMove + ';';
                                    ctx.execute(cmd, 15000).then(function (upRes) {
                                        release();
                                        cachedChannels = null;
                                        res.writeHead(200, { 'content-type': 'application/json' });
                                        res.end(JSON.stringify({
                                            ok: upRes.exit_code === 0,
                                            action: 'move',
                                            target: target,
                                            moved: channels.length,
                                            changed: changes.length,
                                            changes: changes,
                                            stderr: upRes.stderr
                                        }));
                                    }, function (upErr) {
                                        try { fs.unlinkSync(tmpMove); } catch (e) {}
                                        release();
                                        res.writeHead(500, { 'content-type': 'application/json' });
                                        res.end(JSON.stringify({ ok: false, error: upErr.message }));
                                    });
                                }, function (qErr) {
                                    release();
                                    res.writeHead(500, { 'content-type': 'application/json' });
                                    res.end(JSON.stringify({ ok: false, error: qErr.message }));
                                });
                            return;
                        }

                        // ACTION 3: HIDE, UNHIDE
                        if (editAction === 'hide' || editAction === 'unhide') {
                            var hideVal = editAction === 'hide' ? 1 : 0;
                            var numSelVal = editAction === 'hide' ? 0 : 1;
                            var updateTasks = [];

                            if (dvbsChannels.length > 0) {
                                var sqlDvbs = 'UPDATE SRV SET hidden = ' + hideVal + ', hideGuide = ' + hideVal + ', numSel = ' + numSelVal + ' WHERE major IN (' + dvbsChannels.join(',') + ');';
                                var cmdDvbs = 'sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE; ' + sqlDvbs + ' COMMIT; PRAGMA wal_checkpoint(TRUNCATE);"';
                                updateTasks.push(function () { return ctx.execute(cmdDvbs, 10000); });
                            }

                            if (ipsrvChannels.length > 0) {
                                var sqlIp = 'UPDATE SRV SET hidden = ' + hideVal + ', hideGuide = ' + hideVal + ', numSel = ' + numSelVal + ' WHERE major IN (' + ipsrvChannels.join(',') + ');';
                                var cmdIp = 'sqlite3 /mnt/systemrw/tvs-chms/data/ipsrv "PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE; ' + sqlIp + ' COMMIT; PRAGMA wal_checkpoint(TRUNCATE);"';
                                updateTasks.push(function () { return ctx.execute(cmdIp, 10000); });
                            }

                            var runUpdateIndex = function (uIdx) {
                                if (uIdx >= updateTasks.length) {
                                    release();
                                    cachedChannels = null;
                                    res.writeHead(200, { 'content-type': 'application/json' });
                                    res.end(JSON.stringify({
                                        ok: true,
                                        action: editAction,
                                        count: totalChannels
                                    }));
                                    return;
                                }
                                updateTasks[uIdx]().then(function (r) {
                                    if (r.exit_code !== 0) {
                                        release();
                                        res.writeHead(500, { 'content-type': 'application/json' });
                                        res.end(JSON.stringify({ ok: false, error: r.stderr || 'sqlite error code ' + r.exit_code }));
                                        return;
                                    }
                                    runUpdateIndex(uIdx + 1);
                                }, function (uErr) {
                                    release();
                                    res.writeHead(500, { 'content-type': 'application/json' });
                                    res.end(JSON.stringify({ ok: false, error: uErr.message }));
                                });
                            };

                            runUpdateIndex(0);
                            return;
                        }

                        // ACTION 4: RENAME
                        if (editAction === 'rename') {
                            var newName = (parsed.name || '').trim();
                            if (!newName) {
                                release();
                                res.writeHead(400, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'missing channel name' }));
                                return;
                            }
                            var hexName = encodeUtf16Hex(newName);
                            var srvIdStr = parsed.srvId != null ? String(parsed.srvId).trim() : '';
                            var renameDbPath = (parsed.type === 'ipsrv' || ipsrvChannels.length > 0) ?
                                '/mnt/systemrw/tvs-chms/data/ipsrv' :
                                '/mnt/systemrw/tvs-chms/data/dvbs';
                            var renameChs = (parsed.type === 'ipsrv' || ipsrvChannels.length > 0) ? ipsrvChannels : dvbsChannels;

                            var renameSql = '';
                            if (srvIdStr && /^-?[0-9]+$/.test(srvIdStr)) {
                                renameSql = "UPDATE SRV SET srvName = CAST(X'" + hexName + "' AS TEXT), modifiedByUser = 1 WHERE srvId = " + srvIdStr + ";";
                            } else if (renameChs.length > 0) {
                                renameSql = "UPDATE SRV SET srvName = CAST(X'" + hexName + "' AS TEXT), modifiedByUser = 1 WHERE major = " + renameChs[0] + " AND elim = 0;";
                            } else {
                                release();
                                res.writeHead(400, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'missing channel major or srvId' }));
                                return;
                            }

                            var renameCmd = 'sqlite3 ' + renameDbPath + ' "PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE; ' + renameSql + ' COMMIT; PRAGMA wal_checkpoint(TRUNCATE);"';
                            ctx.execute(renameCmd, 10000).then(function (r) {
                                release();
                                cachedChannels = null;
                                res.writeHead(200, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({
                                    ok: r.exit_code === 0,
                                    action: 'rename',
                                    count: 1,
                                    stderr: r.stderr
                                }));
                            }, function (e) {
                                release();
                                res.writeHead(500, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: e.message }));
                            });
                            return;
                        }

                        release();
                        res.writeHead(400, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: 'unsupported action' }));
                    });
                });
                return true;
            }

            // GET api/export — export official Samsung Channel_list_<Version>.zip
            if ((sub === 'export' || action === 'export') && req.method === 'GET') {
                var exportCmd = 'PRD="/etc/prd_info.ini"; ' +
                    'VER=""; ' +
                    'if [ -f "$PRD" ]; then VER=$(grep -i "^Version=" "$PRD" | head -n 1 | cut -d "=" -f2 | tr -d ";\\r\\n "); fi; ' +
                    'if [ -z "$VER" ]; then VER="backup"; fi; ' +
                    'ZIPNAME="Channel_list_${VER}.zip"; ' +
                    'ZIPPATH="/tmp/${ZIPNAME}"; ' +
                    'rm -f /tmp/Channel_list_*.zip; ' +
                    'mkdir -p /tmp/ch_export; ' +
                    'cd /mnt/systemrw/tvs-chms/data/ || exit 1; ' +
                    'if [ -f dvbs ]; then sqlite3 dvbs "PRAGMA wal_checkpoint(TRUNCATE);"; fi; ' +
                    'if [ -f ipsrv ]; then sqlite3 ipsrv "PRAGMA wal_checkpoint(TRUNCATE);"; fi; ' +
                    'FILES=""; ' +
                    'for f in dvbs sat ipsrv dvbt dvbc metadata.xml; do ' +
                    '  if [ -f "$f" ]; then FILES="$FILES $f"; fi; ' +
                    'done; ' +
                    'if [ ! -f "metadata.xml" ]; then ' +
                    '  cat << \'EOFXML\' > /tmp/ch_export/metadata.xml\n' +
                    '<?xml version="1.0" encoding="UTF-8"?>\n' +
                    '<TVS_XML_STORAGE>\n' +
                    '\t<ANALOG_COUNTRY>48</ANALOG_COUNTRY>\n' +
                    '\t<DIGITAL_COUNTRY>5198920</DIGITAL_COUNTRY>\n' +
                    '\t<SEI_VERSION>101</SEI_VERSION>\n' +
                    '</TVS_XML_STORAGE>\n' +
                    'EOFXML\n' +
                    '  FILES="$FILES /tmp/ch_export/metadata.xml"; ' +
                    'fi; ' +
                    '/usr/bin/zip -j "$ZIPPATH" $FILES >/dev/null 2>&1; ' +
                    'echo "$ZIPNAME"';

                ctx.execute(exportCmd, 12000).then(function (r) {
                    var lines = (r.stdout || '').trim().split('\n');
                    var zipName = lines[lines.length - 1].trim();
                    if (!zipName || zipName.indexOf('Channel_list_') !== 0) {
                        zipName = 'Channel_list_backup.zip';
                    }
                    var fullZipPath = '/tmp/' + zipName;
                    try {
                        var stat = fs.statSync(fullZipPath);
                        res.writeHead(200, {
                            'content-type': 'application/zip',
                            'content-disposition': 'attachment; filename="' + zipName + '"',
                            'access-control-expose-headers': 'content-disposition',
                            'access-control-allow-origin': '*',
                            'content-length': stat.size,
                            'cache-control': 'no-store'
                        });
                        var readStream = fs.createReadStream(fullZipPath);
                        readStream.pipe(res);
                        readStream.on('close', function () {
                            try { fs.unlinkSync(fullZipPath); } catch (e) {}
                            try { ctx.execute('rm -rf /tmp/ch_export', 2000); } catch (e) {}
                        });
                    } catch (fsErr) {
                        res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                        res.end(JSON.stringify({ ok: false, error: 'Backup archive could not be generated: ' + fsErr.message }));
                    }
                }, function (e) {
                    res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                });
                return true;
            }

            // POST api/import — import Samsung Channel_list_*.zip archive
            if ((sub === 'import' || action === 'import') && req.method === 'POST') {
                withDbLock(res, function (release) {
                    var importId = Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
                    var uploadZip = '/tmp/ch_up_' + importId + '.zip';
                    var tmpDir = '/tmp/ch_imp_' + importId;
                    var bakDir = '/tmp/ch_bak_' + importId;

                    var MAX_IMPORT_BYTES = 15 * 1024 * 1024; // 15 MB cap
                    var receivedBytes = 0;
                    var outStream = fs.createWriteStream(uploadZip);
                    var exceeded = false;

                    req.on('data', function (chunk) {
                        receivedBytes += chunk.length;
                        if (receivedBytes > MAX_IMPORT_BYTES) {
                            exceeded = true;
                            req.destroy();
                            outStream.destroy();
                            try { fs.unlinkSync(uploadZip); } catch (e) {}
                        }
                    });

                    req.pipe(outStream);

                    outStream.on('finish', function () {
                        if (exceeded) {
                            release();
                            res.writeHead(413, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: 'Archive exceeds 15 MB limit.' }));
                            return;
                        }

                        var importCmd = 'sh -c \'' +
                            'if ! /usr/bin/unzip -t "' + uploadZip + '" >/dev/null 2>&1; then ' +
                            '  rm -f "' + uploadZip + '"; echo "INVALID_ZIP"; exit 1; ' +
                            'fi; ' +
                            'rm -rf "' + tmpDir + '" && mkdir -p "' + tmpDir + '"; ' +
                            '/usr/bin/unzip -o -q "' + uploadZip + '" -d "' + tmpDir + '/"; ' +
                            'FOUND=0; ' +
                            'for f in dvbs sat ipsrv dvbt dvbc; do ' +
                            '  if [ -f "' + tmpDir + '/$f" ]; then FOUND=1; break; fi; ' +
                            'done; ' +
                            'if [ $FOUND -eq 0 ]; then ' +
                            '  rm -rf "' + tmpDir + '" "' + uploadZip + '"; echo "NO_CHANNELS_FOUND"; exit 2; ' +
                            'fi; ' +
                            'for f in dvbs sat ipsrv dvbt dvbc; do ' +
                            '  if [ -f "' + tmpDir + '/$f" ]; then ' +
                            '    CHK=$(sqlite3 "' + tmpDir + '/$f" "PRAGMA integrity_check;" 2>/dev/null || echo "corrupt"); ' +
                            '    if [ "$CHK" != "ok" ]; then ' +
                            '      rm -rf "' + tmpDir + '" "' + uploadZip + '"; echo "CORRUPT_DB_$f"; exit 3; ' +
                            '    fi; ' +
                            '  fi; ' +
                            'done; ' +
                            'rm -rf "' + bakDir + '" && mkdir -p "' + bakDir + '"; ' +
                            'cp /mnt/systemrw/tvs-chms/data/* "' + bakDir + '/" 2>/dev/null || true; ' +
                            'rm -f /mnt/systemrw/tvs-chms/data/*-wal /mnt/systemrw/tvs-chms/data/*-shm; ' +
                            'for f in dvbs sat ipsrv dvbt dvbc metadata.xml; do ' +
                            '  if [ -f "' + tmpDir + '/$f" ]; then ' +
                            '    cp "' + tmpDir + '/$f" "/mnt/systemrw/tvs-chms/data/$f"; ' +
                            '  fi; ' +
                            'done; ' +
                            '[ -f /mnt/systemrw/tvs-chms/data/dvbs ] && sqlite3 /mnt/systemrw/tvs-chms/data/dvbs "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true; ' +
                            '[ -f /mnt/systemrw/tvs-chms/data/ipsrv ] && sqlite3 /mnt/systemrw/tvs-chms/data/ipsrv "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true; ' +
                            '(systemctl restart tvs_deamon.service || pkill -9 tvs-daemon || true); sleep 1; ' +
                            '(/usr/bin/launch_app org.tizen.tv-viewer change_source 0 sourceType 0 sourceName TV mbrIndex -2 __K_EX_LAUNCH_REQUESTOR user >/dev/null 2>&1 || true); ' +
                            'rm -rf "' + tmpDir + '" "' + bakDir + '" "' + uploadZip + '"; ' +
                            'echo "SUCCESS"\';';

                        ctx.execute(importCmd, 20000).then(function (r) {
                            release();
                            cachedChannels = null;
                            var out = (r.stdout || '').trim();
                            if (out.indexOf('INVALID_ZIP') >= 0) {
                                res.writeHead(400, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'The uploaded file is not a valid zip archive.' }));
                                return;
                            }
                            if (out.indexOf('NO_CHANNELS_FOUND') >= 0) {
                                res.writeHead(400, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'No channel databases (dvbs, ipsrv, dvbt) found inside archive.' }));
                                return;
                            }
                            if (out.indexOf('CORRUPT_DB_') >= 0) {
                                res.writeHead(400, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'Database integrity check failed: corrupt SQLite database in zip.' }));
                                return;
                            }
                            if (r.exit_code !== 0) {
                                // Restore backup on error
                                ctx.execute('sh -c "if [ -d \\"' + bakDir + '\\" ]; then cp \\"' + bakDir + '\\"/* /mnt/systemrw/tvs-chms/data/ 2>/dev/null || true; fi; rm -rf \\"' + tmpDir + '\\" \\"' + bakDir + '\\" \\"' + uploadZip + '\\";"', 10000);
                                res.writeHead(500, { 'content-type': 'application/json' });
                                res.end(JSON.stringify({ ok: false, error: 'Import failed: ' + (r.stderr || 'exit code ' + r.exit_code) }));
                                return;
                            }
                            res.writeHead(200, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: true, message: 'Channels imported successfully and TV tuner reloaded!' }));
                        }, function (e) {
                            ctx.execute('sh -c "if [ -d \\"' + bakDir + '\\" ]; then cp \\"' + bakDir + '\\"/* /mnt/systemrw/tvs-chms/data/ 2>/dev/null || true; fi; rm -rf \\"' + tmpDir + '\\" \\"' + bakDir + '\\" \\"' + uploadZip + '\\";"', 10000);
                            release();
                            res.writeHead(500, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: e.message }));
                        });
                    });

                    outStream.on('error', function (err) {
                        try { fs.unlinkSync(uploadZip); } catch (e) {}
                        release();
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                    });
                });
                return true;
            }

            return false;
        }
    };
};
