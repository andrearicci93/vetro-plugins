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
var crypto = require('crypto');

var DEFAULT_DATA_DIR = '/mnt/systemrw/tvs-chms/data';
var DEFAULT_TMP_DIR = '/tmp';
var ALLOWED_DBS = ['dvbs', 'sat', 'ipsrv', 'dvbt', 'dvbc'];
var SRVID_RE = /^-?[0-9]+$/;
var MAX_CHANNEL_NAME_LEN = 60;
var CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
var MAX_IMPORT_BYTES = 15 * 1024 * 1024;
var MAX_UNZIP_BYTES = 32 * 1024 * 1024;
var MAX_UNZIP_ENTRIES = 50;
var DEFAULT_STAGED_IMPORT_TTL_MS = 5 * 60 * 1000;

// Note: Samsung Tizen firmware intentionally spells this systemd unit "tvs_deamon.service"
// (verified on UA50AU7000 Tizen 6.0; "tvs_daemon.service" does not exist). Check both safely.
var TVS_UNIT_RESOLVE =
    'UNIT=""; ' +
    'if systemctl cat tvs_deamon.service >/dev/null 2>&1; then UNIT="tvs_deamon.service"; ' +
    'elif systemctl cat tvs_daemon.service >/dev/null 2>&1; then UNIT="tvs_daemon.service"; fi; ';

var VETRO_TUNER_UNIT = 'vetro-tuner.service';
var VETRO_TUNER_PID = '/home/owner/vetro-tuner.pid';
var VETRO_TUNER_PIPE = '/tmp/vetro-tuner.ctl';
var VETRO_TUNER_SHOWN = '/tmp/vetro-tuner.ctl.shown';

// Exact same non-blocking FIFO liveness check used by Vetro's key-routing.js (exec 3<> never blocks).
var VETRO_TUNER_ALIVE_SH =
    'p=$(cat ' + shQuote(VETRO_TUNER_PID) + ' 2>/dev/null); ' +
    '[ -n "$p" ] && [ -d "/proc/$p" ] && [ -p ' + shQuote(VETRO_TUNER_PIPE) + ' ]';

var VETRO_TUNER_SHOWN_SH =
    VETRO_TUNER_ALIVE_SH + ' && [ -e ' + shQuote(VETRO_TUNER_SHOWN) + ' ]';

// Trigger Activate() -> ResyncNow() in Vetro TV Tuner after a direct launch_app srvId tune while shown,
// so Vetro's banner and CH+/- cursor sync to the exact newly tuned srvId even before a reload.
var VETRO_TUNER_RESYNC_SH =
    'if ' + VETRO_TUNER_SHOWN_SH + '; then ' +
    'sleep 0.5; ' +
    '( exec 3<>' + shQuote(VETRO_TUNER_PIPE) + ' && printf \'hide\\nshow\\n\' >&3 ) 2>/dev/null || true; ' +
    'fi';

// Restart Vetro TV Tuner after tvs-daemon restarts so it drops its cached channel list and reconnects.
// Uses --no-block for Tizen 9 systemd/SMACK D-Bus compatibility; falls back to pipe 'quit' if started outside systemd.
// Completely a no-op when Vetro TV Tuner is not installed or not running.
var VETRO_TUNER_RESTART_SH =
    '{ if [ "$(systemctl is-active ' + VETRO_TUNER_UNIT + ' 2>/dev/null)" = "active" ]; then ' +
    'systemctl restart --no-block ' + VETRO_TUNER_UNIT + ' </dev/null >/dev/null 2>&1 || true; ' +
    'else tp=$(cat ' + shQuote(VETRO_TUNER_PID) + ' 2>/dev/null); ' +
    'if [ -n "$tp" ] && [ -d "/proc/$tp" ] && tr \'\\0\' \' \' < "/proc/$tp/cmdline" 2>/dev/null | grep -q \'vetro-tuner.dll\' && [ -p ' + shQuote(VETRO_TUNER_PIPE) + ' ]; then ' +
    '( exec 3<>' + shQuote(VETRO_TUNER_PIPE) + ' && echo \'quit\' >&3 ) 2>/dev/null || true; ' +
    'fi; fi; }';

function createDict() {
    return Object.create(null);
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function shQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Node 4.4 inherits Buffer.from from Uint8Array (does not accept strings); Node 5.10+ has real Buffer.from.
function toUtf8Bytes(s) {
    return (Buffer.from && Buffer.from !== Uint8Array.from) ? Buffer.from(s, 'utf8') : new Buffer(s, 'utf8');
}

// Run shell scripts via base64 pipe so Vetro's root agent never mangles nested quotes or backslashes.
function wrapSh(script) {
    return 'echo ' + toUtf8Bytes(script).toString('base64') + ' | base64 -d | sh';
}

function sqlPath(p) {
    return String(p).replace(/\\/g, '/').replace(/'/g, "''");
}

function getQueryParam(urlStr, key) {
    if (!urlStr || typeof urlStr !== 'string') return '';
    var qIdx = urlStr.indexOf('?');
    if (qIdx < 0) return '';
    var parts = urlStr.slice(qIdx + 1).split('&');
    var target = key + '=';
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].indexOf(target) === 0) {
            var rawVal = parts[i].slice(target.length).replace(/\+/g, ' ');
            try { return decodeURIComponent(rawVal); } catch (e) { return rawVal; }
        }
    }
    return '';
}

function sendJson(res, statusCode, obj, extraHeaders) {
    var headers = {
        'content-type': 'application/json',
        'cache-control': 'no-store'
    };
    if (extraHeaders) {
        var ks = Object.keys(extraHeaders);
        for (var i = 0; i < ks.length; i++) {
            headers[ks[i]] = extraHeaders[ks[i]];
        }
    }
    res.writeHead(statusCode || 200, headers);
    res.end(JSON.stringify(obj));
}

function getServiceCategory(srvType) {
    var t = parseInt(srvType, 10);
    if (isNaN(t)) return 'tv';
    if (t === -1) return 'iptv';
    if (t === 1 || t === 17 || t === 22 || t === 25 || t === 31 || t === 32) return 'tv';
    if (t === 2 || t === 7 || t === 10) return 'radio';
    return 'data';
}

function rmrfSync(targetPath) {
    if (!targetPath) return;
    try {
        if (!fs.existsSync(targetPath)) return;
        var st = fs.lstatSync(targetPath);
        if (st.isDirectory() && !st.isSymbolicLink()) {
            var entries = fs.readdirSync(targetPath);
            for (var i = 0; i < entries.length; i++) {
                rmrfSync(path.join(targetPath, entries[i]));
            }
            fs.rmdirSync(targetPath);
        } else {
            fs.unlinkSync(targetPath);
        }
    } catch (e) { /* ignore cleanup error */ }
}

function parseMetadataXml(xmlText) {
    if (!xmlText || typeof xmlText !== 'string') return null;
    var aMatch = /<ANALOG_COUNTRY>\s*([^<\s]+)\s*<\/ANALOG_COUNTRY>/i.exec(xmlText);
    var dMatch = /<DIGITAL_COUNTRY>\s*([^<\s]+)\s*<\/DIGITAL_COUNTRY>/i.exec(xmlText);
    var sMatch = /<SEI_VERSION>\s*([^<\s]+)\s*<\/SEI_VERSION>/i.exec(xmlText);
    if (!aMatch && !dMatch && !sMatch) return null;
    return {
        analogCountry: aMatch ? aMatch[1].trim() : '',
        digitalCountry: dMatch ? dMatch[1].trim() : '',
        seiVersion: sMatch ? sMatch[1].trim() : ''
    };
}

function parsePrdModel(prdText) {
    if (!prdText || typeof prdText !== 'string') return '';
    var lines = prdText.split(/\r?\n/);
    var model = '';
    var version = '';
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (/^Model=/i.test(line)) {
            model = line.replace(/^Model=/i, '').replace(/;/g, '').trim();
        } else if (/^Version=/i.test(line)) {
            version = line.replace(/^Version=/i, '').replace(/;/g, '').trim();
        }
    }
    if (model) return model;
    if (version) {
        return version.replace(/-[0-9]+(?:\.[0-9]+)*$/, '');
    }
    return '';
}

function extractZipModelPrefix(fileName) {
    if (!fileName || typeof fileName !== 'string') return '';
    var base = fileName.replace(/^.*[\/\\]/, '').replace(/\.zip$/i, '').trim();
    if (!/^Channel_list_/i.test(base)) return '';
    var rest = base.replace(/^Channel_list_/i, '').trim();
    if (!rest || /^(backup|export|channels)$/i.test(rest)) return '';
    var platMatch = /^([A-Za-z]-[A-Za-z0-9]{3,})(?:-[0-9].*)?$/i.exec(rest);
    if (platMatch) return platMatch[1];
    return rest.replace(/-[0-9]+(?:\.[0-9]+)*$/, '');
}

function sanitizeFileName(rawName) {
    if (!rawName || typeof rawName !== 'string') return 'Channel_list.zip';
    var base = rawName.replace(/^.*[\/\\]/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!base) return 'Channel_list.zip';
    if (base.length > 120) base = base.substr(0, 120);
    return base;
}

// Parse `/usr/bin/unzip -l` output to enforce uncompressed size/count limits
// and block path traversal before extracting only allowlisted files.
function parseUnzipList(stdout) {
    if (!stdout || typeof stdout !== 'string') {
        return { error: 'Could not inspect archive contents.' };
    }
    var lines = stdout.split(/\r?\n/);
    var entryCount = 0;
    var totalBytes = 0;
    var allowSet = createDict();
    var dbFiles = [];
    var extractFiles = [];
    var entryRe = /^\s*(\d+)\s+\d{2,4}[-\/]\d{2}[-\/]\d{2,4}\s+\d{2}:\d{2}\s+(.+)$/;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var m = entryRe.exec(line);
        if (!m) continue;
        var sz = parseInt(m[1], 10);
        var name = String(m[2]).replace(/\r$/, '');
        if (name.charAt(name.length - 1) === '/') {
            continue;
        }
        entryCount++;
        if (entryCount > MAX_UNZIP_ENTRIES) {
            return { error: 'Archive contains too many entries (max ' + MAX_UNZIP_ENTRIES + ').' };
        }
        if (isNaN(sz) || sz < 0) {
            return { error: 'Invalid entry size in archive.' };
        }
        totalBytes += sz;
        if (totalBytes > MAX_UNZIP_BYTES) {
            return { error: 'Decompressed archive exceeds 32 MB safety limit.' };
        }
        if (name.charAt(0) === '/' || name.indexOf('..') >= 0 || name.indexOf('\\') >= 0) {
            return { error: 'Unsafe file path inside archive: ' + name };
        }
        if (ALLOWED_DBS.indexOf(name) >= 0) {
            if (!hasOwn(allowSet, name)) {
                allowSet[name] = true;
                dbFiles.push(name);
                extractFiles.push(name);
            }
        } else if (name === 'metadata.xml') {
            if (!hasOwn(allowSet, name)) {
                allowSet[name] = true;
                extractFiles.push(name);
            }
        }
    }

    if (entryCount === 0) {
        return { error: 'Could not inspect archive file listing.' };
    }
    if (dbFiles.length === 0) {
        return { error: 'No channel databases (dvbs, ipsrv, dvbt, dvbc, sat) found inside archive.' };
    }

    return {
        dbFiles: dbFiles,
        extractFiles: extractFiles,
        totalBytes: totalBytes,
        entryCount: entryCount
    };
}

function parseSchemaOutput(stdout) {
    var out = {
        integrity: '',
        userVersion: 0,
        tableNames: [],
        tables: createDict(),
        badTables: []
    };
    if (!stdout) return out;
    var lines = String(stdout).split('\n');
    var curTable = null;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r/g, '').trim();
        if (!line) continue;
        if (line.indexOf('__INTEGRITY__=') === 0) {
            out.integrity = line.substr('__INTEGRITY__='.length).trim();
            curTable = null;
        } else if (line.indexOf('__VERSION__=') === 0) {
            out.userVersion = parseInt(line.substr('__VERSION__='.length).trim(), 10) || 0;
            curTable = null;
        } else if (line.indexOf('__BAD_TABLE__=') === 0) {
            out.badTables.push(line.substr('__BAD_TABLE__='.length).trim());
            curTable = null;
        } else if (line.indexOf('__TABLE__=') === 0) {
            curTable = line.substr('__TABLE__='.length).trim();
            if (curTable) {
                out.tableNames.push(curTable);
                if (!out.tables[curTable]) out.tables[curTable] = [];
            }
        } else if (curTable) {
            var parts = line.split('|');
            if (parts.length >= 3) {
                var colName = parts[1].trim();
                var colType = parts[2].trim().toLowerCase();
                out.tables[curTable].push(colName + ':' + colType);
            }
        }
    }
    return out;
}

function inspectDbSchema(ctx, dbPath) {
    var qDb = shQuote(dbPath);
    var cmd = wrapSh(
        'DB=' + qDb + '; ' +
        'if [ ! -f "$DB" ]; then echo "__MISSING__=1"; exit 2; fi; ' +
        'RO=""; sqlite3 -readonly "$DB" "SELECT 1;" </dev/null >/dev/null 2>&1 && RO="-readonly"; ' +
        'INT=$(sqlite3 $RO "$DB" "PRAGMA integrity_check;" </dev/null 2>/dev/null | tr "\\n" " "); ' +
        'VER=$(sqlite3 $RO "$DB" "PRAGMA user_version;" </dev/null 2>/dev/null || echo "0"); ' +
        'echo "__INTEGRITY__=$INT"; ' +
        'echo "__VERSION__=$VER"; ' +
        'set -f; ' +
        'sqlite3 $RO "$DB" "SELECT name FROM sqlite_master WHERE type=\'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name;" </dev/null 2>/dev/null | ' +
        'while IFS= read -r t; do ' +
        '  [ -z "$t" ] && continue; ' +
        '  case "$t" in ' +
        '    *[!A-Za-z0-9_]*) echo "__BAD_TABLE__=$t" ;; ' +
        '    *) echo "__TABLE__=$t"; sqlite3 $RO "$DB" "PRAGMA table_info($t);" </dev/null 2>/dev/null ;; ' +
        '  esac; ' +
        'done'
    );
    return ctx.execute(cmd, 8000).then(function (r) {
        if (r.exit_code !== 0 || (r.stdout || '').indexOf('__MISSING__=1') >= 0) {
            return null;
        }
        return parseSchemaOutput(r.stdout);
    });
}

function hasCol(cols, colName) {
    var target = colName + ':';
    for (var i = 0; i < cols.length; i++) {
        if (cols[i].indexOf(target) === 0) return true;
    }
    return false;
}

function validateDbSchema(dbName, importedSchema, liveSchema) {
    if (!importedSchema) {
        return dbName + ': failed to inspect SQLite database';
    }
    if (importedSchema.integrity !== 'ok') {
        return dbName + ': integrity_check failed (' + (importedSchema.integrity || 'unknown') + ')';
    }
    if (importedSchema.badTables.length > 0) {
        return dbName + ': unsafe or unexpected table name (' + importedSchema.badTables.join(', ') + ')';
    }
    if (importedSchema.tableNames.length === 0) {
        return dbName + ': SQLite database contains no tables';
    }

    if (liveSchema) {
        var impTablesStr = importedSchema.tableNames.join(',');
        var liveTablesStr = liveSchema.tableNames.join(',');
        if (impTablesStr !== liveTablesStr) {
            return dbName + ': table list mismatch (archive has [' + impTablesStr + '], TV expects [' + liveTablesStr + '])';
        }
        for (var i = 0; i < liveSchema.tableNames.length; i++) {
            var tbl = liveSchema.tableNames[i];
            var impCols = importedSchema.tables[tbl] || [];
            var liveCols = liveSchema.tables[tbl] || [];
            if (impCols.join(',') !== liveCols.join(',')) {
                return dbName + ': schema mismatch in table "' + tbl + '"';
            }
        }
        if (liveSchema.userVersion > 0 && importedSchema.userVersion !== liveSchema.userVersion) {
            return dbName + ': database user_version mismatch (archive ' + importedSchema.userVersion + ' vs TV ' + liveSchema.userVersion + ')';
        }
        return null;
    }

    if (dbName === 'sat') {
        if (!importedSchema.tables.SAT || !importedSchema.tables.SAT_TP) {
            return dbName + ': missing required SAT/SAT_TP tables';
        }
        var satCols = importedSchema.tables.SAT;
        var tpCols = importedSchema.tables.SAT_TP;
        if (!hasCol(satCols, 'satId') || !hasCol(satCols, 'satName') ||
            !hasCol(tpCols, 'tpId') || !hasCol(tpCols, 'satId') || !hasCol(tpCols, 'tpFreq')) {
            return dbName + ': missing required SAT or SAT_TP columns';
        }
        return null;
    }

    if (!importedSchema.tables.SRV || !importedSchema.tables.CHNL) {
        return dbName + ': missing required SRV or CHNL tables';
    }
    var reqSrv = ['srvId', 'chId', 'major', 'srvName', 'srvType', 'elim', 'hidden', 'hideGuide', 'numSel', 'modifiedByUser'];
    var srvCols = importedSchema.tables.SRV;
    for (var r = 0; r < reqSrv.length; r++) {
        if (!hasCol(srvCols, reqSrv[r])) {
            return dbName + ': SRV table missing required column "' + reqSrv[r] + '"';
        }
    }
    var chnlCols = importedSchema.tables.CHNL;
    if (!hasCol(chnlCols, 'chId') || !hasCol(chnlCols, 'chNum')) {
        return dbName + ': CHNL table missing required columns';
    }
    return null;
}

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

function parseSrvIdList(arr) {
    var out = [];
    var seen = createDict();
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
        var raw = arr[i] != null ? String(arr[i]).trim() : '';
        if (raw && SRVID_RE.test(raw) && !hasOwn(seen, raw)) {
            seen[raw] = true;
            out.push(raw);
        }
    }
    return out;
}

// Reorder channels strictly by srvId while conserving slot count and optionally scoping
// displacement to a single DVB service category (TV vs Radio vs Data).
function computeChannelMoves(allChannels, selectedSrvIds, target, scopeByCategory) {
    var selectedSet = createDict();
    var validIds = parseSrvIdList(selectedSrvIds);
    for (var i = 0; i < validIds.length; i++) {
        selectedSet[validIds[i]] = true;
    }

    var matchedSelected = [];
    for (var j = 0; j < allChannels.length; j++) {
        var ch = allChannels[j];
        if (selectedSet[ch.srvId]) {
            matchedSelected.push(ch);
        }
    }

    var k = matchedSelected.length;
    if (k === 0) return { error: 'No matching channels selected' };
    if (isNaN(target) || target < 1 || target > 9999) {
        return { error: 'Target channel number must be between 1 and 9999' };
    }
    if (target + k - 1 > 9999) {
        return { error: 'Target range would exceed maximum channel number 9999' };
    }

    var targetCat = null;
    if (scopeByCategory) {
        targetCat = getServiceCategory(matchedSelected[0].srvType);
        for (var ci = 1; ci < matchedSelected.length; ci++) {
            if (getServiceCategory(matchedSelected[ci].srvType) !== targetCat) {
                return { error: 'Selected channels mix different service types (TV, Radio, or Data). Select one category to move.' };
            }
        }
    }

    var poolChannels = [];
    for (var pi = 0; pi < allChannels.length; pi++) {
        var item = allChannels[pi];
        if (!scopeByCategory || getServiceCategory(item.srvType) === targetCat) {
            poolChannels.push(item);
        }
    }

    var selected = [];
    var unselected = [];
    for (var si = 0; si < poolChannels.length; si++) {
        var pc = poolChannels[si];
        if (selectedSet[pc.srvId]) {
            selected.push(pc);
        } else {
            unselected.push(pc);
        }
    }

    function sortByMajorThenSrv(a, b) {
        if (a.major !== b.major) return a.major - b.major;
        return a.srvId < b.srvId ? -1 : (a.srvId > b.srvId ? 1 : 0);
    }

    selected.sort(sortByMajorThenSrv);
    unselected.sort(sortByMajorThenSrv);

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
        return {
            error: 'Selected channel(s) already occupy #' + target + (k > 1 ? (' - #' + (target + k - 1)) : '')
        };
    }

    var allSorted = poolChannels.slice().sort(sortByMajorThenSrv);
    var maxOrig = allSorted.length > 0 ? allSorted[allSorted.length - 1].major : 0;

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

    var involvedUnselected = [];
    var occupiedSlotsMap = createDict();

    for (var q = 0; q < allSorted.length; q++) {
        var cItem = allSorted[q];
        if (cItem.major >= minInvolved && cItem.major <= maxInvolved) {
            occupiedSlotsMap[cItem.major] = true;
            if (!selectedSet[cItem.srvId]) {
                involvedUnselected.push(cItem);
            }
        }
    }

    for (var tIdx = 0; tIdx < targetSlots.length; tIdx++) {
        occupiedSlotsMap[targetSlots[tIdx]] = true;
    }

    var occupiedSlots = Object.keys(occupiedSlotsMap).map(function (s) {
        return parseInt(s, 10);
    });
    occupiedSlots.sort(function (a, b) { return a - b; });

    var targetSlotsSet = createDict();
    for (var ts = 0; ts < targetSlots.length; ts++) {
        targetSlotsSet[targetSlots[ts]] = true;
    }

    var unselectedSlots = [];
    for (var os = 0; os < occupiedSlots.length; os++) {
        if (!targetSlotsSet[occupiedSlots[os]]) {
            unselectedSlots.push(occupiedSlots[os]);
        }
    }

    var newAssignments = createDict();
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
        if (hasOwn(newAssignments, curCh.srvId) && newAssignments[curCh.srvId] !== curCh.major) {
            changes.push({
                srvId: curCh.srvId,
                oldMajor: curCh.major,
                newMajor: newAssignments[curCh.srvId]
            });
        }
    }

    return { changes: changes };
}

// Build pure deletion + optional category-scoped gap closure plan.
// Matches rows strictly by srvId (never major) and preserves hidden channel numbers.
function planDeleteAndCompact(dbChannels, delSrvIdSet, options) {
    var allowCompact = !!(options && options.allowCompact);
    var compact = !!(options && options.compact);

    var toDelete = [];
    var toKeep = [];
    for (var j = 0; j < dbChannels.length; j++) {
        var ch = dbChannels[j];
        if (hasOwn(delSrvIdSet, ch.srvId)) {
            toDelete.push(ch);
        } else {
            toKeep.push(ch);
        }
    }

    if (toDelete.length === 0) {
        return { toDelete: [], changes: [], remaining: dbChannels.length };
    }

    var changes = [];
    if (allowCompact && compact) {
        var affectedCats = createDict();
        for (var di = 0; di < toDelete.length; di++) {
            affectedCats[getServiceCategory(toDelete[di].srvType)] = true;
        }

        var catNames = Object.keys(affectedCats);
        for (var ci = 0; ci < catNames.length; ci++) {
            var cat = catNames[ci];
            var minBefore = null;
            for (var bi = 0; bi < dbChannels.length; bi++) {
                var row = dbChannels[bi];
                if (getServiceCategory(row.srvType) === cat && !row.hidden) {
                    if (minBefore === null || row.major < minBefore) {
                        minBefore = row.major;
                    }
                }
            }

            var visibleKeep = [];
            var reservedHidden = createDict();
            for (var ki = 0; ki < toKeep.length; ki++) {
                var kRow = toKeep[ki];
                if (getServiceCategory(kRow.srvType) !== cat) continue;
                if (kRow.hidden) {
                    reservedHidden[kRow.major] = true;
                } else {
                    visibleKeep.push(kRow);
                }
            }

            // Main DVB TV list compacts from 1; Radio/Data keep their pool start (or 1 if starting at 1).
            var nextMajor = (cat === 'tv' || minBefore === null || minBefore < 1) ? 1 : minBefore;
            for (var vi = 0; vi < visibleKeep.length; vi++) {
                while (reservedHidden[nextMajor]) {
                    nextMajor++;
                }
                if (visibleKeep[vi].major !== nextMajor) {
                    changes.push({
                        srvId: visibleKeep[vi].srvId,
                        oldMajor: visibleKeep[vi].major,
                        newMajor: nextMajor
                    });
                }
                nextMajor++;
            }
        }
    }

    return {
        toDelete: toDelete,
        changes: changes,
        remaining: toKeep.length
    };
}

function queryChannelsForEdit(ctx, dbPath, defaultSrvType) {
    var sql = 'PRAGMA busy_timeout = 5000; SELECT srvId, major, IFNULL(srvType, ' + defaultSrvType + '), IFNULL(hidden, 0) FROM SRV WHERE elim = 0 ORDER BY major ASC, srvId ASC;';
    var cmd = wrapSh('sqlite3 -bail ' + shQuote(dbPath) + ' ' + shQuote(sql) + ' </dev/null');
    return ctx.execute(cmd, 10000).then(function (qRes) {
        if (qRes.exit_code !== 0) {
            return Promise.reject(new Error('Failed to query channels from ' + dbPath + ': ' + (qRes.stderr || 'exit code ' + qRes.exit_code)));
        }
        var lines = (qRes.stdout || '').split('\n');
        var rows = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            var parts = line.split('|');
            if (parts.length < 2) continue;
            var srvIdStr = String(parts[0]).trim();
            var m = parseInt(parts[1], 10);
            var srvType = parts.length >= 3 ? parseInt(parts[2], 10) : defaultSrvType;
            var isHidden = parts.length >= 4 ? (String(parts[3]).trim() === '1') : false;
            if (SRVID_RE.test(srvIdStr) && !isNaN(m) && m > 0) {
                rows.push({
                    srvId: srvIdStr,
                    major: m,
                    srvType: isNaN(srvType) ? defaultSrvType : srvType,
                    hidden: isHidden
                });
            }
        }
        return rows;
    });
}

function randomHex(byteLen) {
    return crypto.randomBytes(byteLen || 8).toString('hex');
}

function buildSavePermsSh() {
    var lines = [];
    for (var i = 0; i < ALLOWED_DBS.length; i++) {
        var f = ALLOWED_DBS[i];
        lines.push(
            'M_' + f + '=$(stat -c \'%a\' "$DATA_DIR/' + f + '" 2>/dev/null || echo 0644); ' +
            'case "$M_' + f + '" in [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;; *) M_' + f + '=0644 ;; esac; ' +
            'O_' + f + '=$(stat -c \'%u:%g\' "$DATA_DIR/' + f + '" 2>/dev/null || echo 0:0); ' +
            'case "$O_' + f + '" in *[!0-9:]*|""|:*|*:|*:*:*) O_' + f + '=0:0 ;; esac;'
        );
    }
    var getPermCases = [];
    for (var j = 0; j < ALLOWED_DBS.length; j++) {
        var db = ALLOWED_DBS[j];
        getPermCases.push(db + ') P_M="$M_' + db + '"; P_O="$O_' + db + '" ;;');
    }
    lines.push('get_perm() { case "$1" in ' + getPermCases.join(' ') + ' *) P_M=0644; P_O=0:0 ;; esac; };');
    return lines.join(' ') + ' ';
}

function buildMetaHeredocSh(metaObj, destExpr, failAction) {
    var jsonBody = JSON.stringify(metaObj, null, 2);
    var delim = '__VETRO_META_' + randomHex(8) + '__';
    while (jsonBody.indexOf(delim) >= 0) {
        delim = '__VETRO_META_' + randomHex(8) + '__';
    }
    return "cat <<'" + delim + "' > " + destExpr + ' || { ' + failAction + '; }\n' + jsonBody + '\n' + delim + '\n';
}

function hashStagedFiles(tmpDir, dbFiles) {
    var hashes = createDict();
    for (var i = 0; i < dbFiles.length; i++) {
        var f = dbFiles[i];
        var p = path.join(tmpDir, f);
        try {
            var st = fs.lstatSync(p);
            if (!st.isFile() || st.isSymbolicLink()) return null;
            hashes[f] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        } catch (e) {
            return null;
        }
    }
    return hashes;
}

function buildStageAndVerifySh(expectedHashes, dbFiles) {
    if (!dbFiles || dbFiles.length === 0) return '';
    var parts = [];
    for (var i = 0; i < dbFiles.length; i++) {
        var f = dbFiles[i];
        var qf = shQuote(f);
        var h = expectedHashes && expectedHashes[f];
        parts.push(
            'if [ -L "$TMP_DIR/"' + qf + ' ] || [ ! -f "$TMP_DIR/"' + qf + ' ]; then echo "STAGED_HASH_MISMATCH"; exit 16; fi; ' +
            'cp "$TMP_DIR/"' + qf + ' "$SAFE_DIR/"' + qf + ' && chmod 0600 "$SAFE_DIR/"' + qf + ' || { echo "STAGED_HASH_MISMATCH"; exit 16; }; '
        );
        if (h && /^[0-9a-f]{64}$/.test(h)) {
            parts.push(
                'if command -v sha256sum >/dev/null 2>&1; then ' +
                'GOT_H=$(sha256sum "$SAFE_DIR/"' + qf + ' 2>/dev/null | cut -d" " -f1); ' +
                'if [ "$GOT_H" != ' + shQuote(h) + ' ]; then echo "STAGED_HASH_MISMATCH"; exit 16; fi; ' +
                'fi; '
            );
        }
    }
    return parts.join('');
}

function runSqlFile(ctx, dbPath, sqlParts, timeoutMs) {
    var sqlBody = sqlParts.join('\n');
    var delim = '__VETRO_SQL_' + randomHex(8) + '__';
    while (sqlBody.indexOf(delim) >= 0) {
        delim = '__VETRO_SQL_' + randomHex(8) + '__';
    }
    var script = 'sqlite3 -bail ' + shQuote(dbPath) + " <<'" + delim + "'\n" + sqlBody + '\n' + delim + '\n';
    var cmd = wrapSh(script);
    return ctx.execute(cmd, timeoutMs || 15000).then(function (res) {
        if (res.exit_code !== 0) {
            return Promise.reject(new Error('SQLite command failed on ' + dbPath + ': ' + (res.stderr || 'exit code ' + res.exit_code)));
        }
        return res;
    });
}

function loadPage(ctx) {
    var places = [path.join(__dirname, 'ui.html'), path.join(ctx.dir || '', 'ui.html')];
    for (var i = 0; i < places.length; i++) {
        try { return fs.readFileSync(places[i], 'utf8'); } catch (e) { /* next */ }
    }
    return '<!doctype html><meta charset="utf-8"><p>Page file missing: reinstall this Shard.</p>';
}

var ALLOWED_KEYS = createDict();
ALLOWED_KEYS.vol_up = 'XF86AudioRaiseVolume';
ALLOWED_KEYS['vol+'] = 'XF86AudioRaiseVolume';
ALLOWED_KEYS.VolumeUp = 'XF86AudioRaiseVolume';
ALLOWED_KEYS.XF86AudioRaiseVolume = 'XF86AudioRaiseVolume';
ALLOWED_KEYS.vol_down = 'XF86AudioLowerVolume';
ALLOWED_KEYS['vol-'] = 'XF86AudioLowerVolume';
ALLOWED_KEYS.VolumeDown = 'XF86AudioLowerVolume';
ALLOWED_KEYS.XF86AudioLowerVolume = 'XF86AudioLowerVolume';
ALLOWED_KEYS.mute = 'XF86AudioMute';
ALLOWED_KEYS.XF86AudioMute = 'XF86AudioMute';
ALLOWED_KEYS.ch_up = 'XF86RaiseChannel';
ALLOWED_KEYS['ch+'] = 'XF86RaiseChannel';
ALLOWED_KEYS.ChannelUp = 'XF86RaiseChannel';
ALLOWED_KEYS.XF86RaiseChannel = 'XF86RaiseChannel';
ALLOWED_KEYS.ch_down = 'XF86LowerChannel';
ALLOWED_KEYS['ch-'] = 'XF86LowerChannel';
ALLOWED_KEYS.ChannelDown = 'XF86LowerChannel';
ALLOWED_KEYS.XF86LowerChannel = 'XF86LowerChannel';
ALLOWED_KEYS.exit = 'XF86Exit';
ALLOWED_KEYS.XF86Exit = 'XF86Exit';

var TUNER_PIPE_KEYS = createDict();
TUNER_PIPE_KEYS.XF86RaiseChannel = 'key 88';
TUNER_PIPE_KEYS.XF86LowerChannel = 'key 87';
TUNER_PIPE_KEYS.XF86Exit = 'key 174';

function buildKeyCommand(keySym) {
    if (hasOwn(TUNER_PIPE_KEYS, keySym)) {
        var pipeWord = TUNER_PIPE_KEYS[keySym];
        return wrapSh(
            'if ' + VETRO_TUNER_SHOWN_SH + '; then ' +
            '( exec 3<>' + shQuote(VETRO_TUNER_PIPE) + ' && echo ' + shQuote(pipeWord) + ' >&3 ); ' +
            'else /usr/bin/input_keyevent ' + keySym + ' </dev/null; fi'
        );
    }
    return '/usr/bin/input_keyevent ' + keySym;
}

function channelsPlugin(ctx) {
    var page = null;
    var cachedChannels = null;
    var lastFetchTime = 0;
    var dbBusy = false;
    var pendingReload = false;
    var pendingImport = null;
    var pendingImportTimer = null;
    var stagedImportTtlMs = (ctx && typeof ctx._stagedImportTtlMs === 'number' && ctx._stagedImportTtlMs > 0) ? ctx._stagedImportTtlMs : DEFAULT_STAGED_IMPORT_TTL_MS;
    var dataDir = (ctx && ctx._dataDir) ? String(ctx._dataDir) : DEFAULT_DATA_DIR;
    var tmpRoot = (ctx && ctx._tmpDir) ? String(ctx._tmpDir) : DEFAULT_TMP_DIR;
    var lockFile = path.join(tmpRoot, 'vetro_channels_db.lock');
    var backupDir = ctx && ctx.dir ? path.join(ctx.dir, 'backup') : null;
    var preImportDir = backupDir ? path.join(backupDir, 'pre-import') : null;
    var preEditDir = backupDir ? path.join(backupDir, 'pre-edit') : null;

    function clearPendingImport() {
        if (pendingImportTimer) {
            clearTimeout(pendingImportTimer);
            pendingImportTimer = null;
        }
        if (pendingImport && pendingImport.tmpDir) {
            rmrfSync(pendingImport.tmpDir);
        }
        pendingImport = null;
    }

    function getDirOwnerUg() {
        if (!ctx || !ctx.dir) return '';
        try {
            var st = fs.statSync(ctx.dir);
            if (st && typeof st.uid === 'number' && typeof st.gid === 'number') {
                return String(st.uid) + ':' + String(st.gid);
            }
        } catch (e) { /* ignore on platforms without posix uid/gid */ }
        return '';
    }

    function readSlotStatus(slotDir, slotName) {
        var result = {
            available: false,
            slot: slotName,
            createdAt: null,
            sourceName: null,
            reason: null,
            files: [],
            model: null
        };
        if (!slotDir) return result;
        try {
            if (!fs.existsSync(slotDir)) return result;
            var found = [];
            for (var i = 0; i < ALLOWED_DBS.length; i++) {
                var f = ALLOWED_DBS[i];
                var p = path.join(slotDir, f);
                try {
                    if (fs.existsSync(p)) {
                        var st = fs.lstatSync(p);
                        if (st.isFile() && !st.isSymbolicLink()) {
                            found.push(f);
                        }
                    }
                } catch (e) { /* ignore stat error */ }
            }
            if (found.length === 0) return result;
            result.available = true;
            result.files = found;
            var metaPath = path.join(slotDir, 'backup-meta.json');
            if (fs.existsSync(metaPath)) {
                try {
                    var meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    if (meta && typeof meta === 'object') {
                        result.createdAt = meta.createdAt || null;
                        result.sourceName = meta.sourceName || null;
                        result.reason = meta.reason || null;
                        result.model = meta.model || null;
                    }
                } catch (e) { /* ignore invalid meta */ }
            }
        } catch (e) { /* ignore */ }
        return result;
    }

    function readBackupStatus() {
        var preImport = readSlotStatus(preImportDir, 'pre-import');
        if (!preImport.available && backupDir) {
            var legacy = readSlotStatus(backupDir, 'pre-import');
            if (legacy.available) {
                legacy.legacy = true;
                preImport = legacy;
            }
        }
        var preEdit = readSlotStatus(preEditDir, 'pre-edit');

        var latest = null;
        if (preEdit.available && preImport.available) {
            var tEdit = preEdit.createdAt ? Date.parse(preEdit.createdAt) : 0;
            var tImport = preImport.createdAt ? Date.parse(preImport.createdAt) : 0;
            latest = (!isNaN(tEdit) && !isNaN(tImport) && tEdit >= tImport) ? preEdit : preImport;
        } else {
            latest = preEdit.available ? preEdit : (preImport.available ? preImport : null);
        }

        return {
            ok: true,
            available: !!(preImport.available || preEdit.available),
            preImport: preImport,
            preEdit: preEdit,
            latestSlot: latest ? latest.slot : null,
            createdAt: latest ? latest.createdAt : null,
            sourceName: latest ? latest.sourceName : null,
            files: latest ? latest.files : [],
            model: latest ? latest.model : null
        };
    }

    // Create an online SQLite .backup snapshot of target DB(s) before delete or move.
    // Leaves pre-import backup untouched in its separate slot.
    function savePreEditBackup(targetDbNames, reason) {
        if (!preEditDir || !targetDbNames || targetDbNames.length === 0) {
            return Promise.resolve(false);
        }
        var dbList = [];
        var seen = createDict();
        for (var i = 0; i < targetDbNames.length; i++) {
            var db = targetDbNames[i];
            if (ALLOWED_DBS.indexOf(db) >= 0 && !hasOwn(seen, db)) {
                seen[db] = true;
                dbList.push(db);
            }
        }
        if (dbList.length === 0) return Promise.resolve(false);

        var ownerUg = getDirOwnerUg();
        var fileArgs = '';
        var bakSteps = '';
        for (var j = 0; j < dbList.length; j++) {
            var bf = dbList[j];
            var qf = shQuote(bf);
            fileArgs += (j > 0 ? ' ' : '') + qf;
            var bkSql = ".backup '" + sqlPath(path.join(preEditDir + '.new', bf)) + "'";
            bakSteps += 'if [ -f "$DATA_DIR/"' + qf + ' ]; then ' +
                'sqlite3 -bail "$DATA_DIR/"' + qf + ' ' + shQuote(bkSql) + ' </dev/null >/dev/null 2>&1 || { rm -rf "$NEW_DIR"; echo ' + shQuote('BACKUP_SQLITE_FAILED_' + bf) + '; exit 13; }; ' +
                'fi; ';
        }
        var metaWriteSh = buildMetaHeredocSh({
            createdAt: new Date().toISOString(),
            slot: 'pre-edit',
            reason: String(reason || 'edit'),
            files: dbList.slice()
        }, '"$NEW_DIR/backup-meta.json"', 'rm -rf "$NEW_DIR"; echo "BACKUP_META_FAILED"; exit 13');

        var script =
            'DATA_DIR=' + shQuote(dataDir) + '; ' +
            'BACKUP_BASE=' + shQuote(backupDir) + '; ' +
            'SLOT_DIR=' + shQuote(preEditDir) + '; ' +
            'NEW_DIR="${SLOT_DIR}.new"; ' +
            'OLD_DIR="${SLOT_DIR}.old"; ' +
            'ANY_SRC=0; ' +
            'for f in ' + fileArgs + '; do ' +
            '  if [ -f "$DATA_DIR/$f" ]; then ANY_SRC=1; break; fi; ' +
            'done; ' +
            'if [ "$ANY_SRC" -eq 0 ]; then echo "BACKUP_SKIP"; exit 0; fi; ' +
            'mkdir -p "$BACKUP_BASE" || { echo "BACKUP_MKDIR_FAILED"; exit 13; }; ' +
            'rm -rf "$NEW_DIR" "$OLD_DIR"; ' +
            'mkdir -p "$NEW_DIR" || { echo "BACKUP_MKDIR_FAILED"; exit 13; }; ' +
            bakSteps +
            metaWriteSh +
            (ownerUg ? ('chown -R ' + shQuote(ownerUg) + ' "$NEW_DIR" 2>/dev/null || true; ') : '') +
            'chmod -R u+rwX,go+rX "$NEW_DIR" 2>/dev/null || true; ' +
            'if [ -d "$SLOT_DIR" ]; then mv "$SLOT_DIR" "$OLD_DIR" || { rm -rf "$NEW_DIR"; echo "BACKUP_ROTATE_FAILED"; exit 13; }; fi; ' +
            'mv "$NEW_DIR" "$SLOT_DIR" || { [ -d "$OLD_DIR" ] && mv "$OLD_DIR" "$SLOT_DIR" 2>/dev/null || true; rm -rf "$NEW_DIR"; echo "BACKUP_SWAP_FAILED"; exit 13; }; ' +
            'rm -rf "$OLD_DIR"; ' +
            'echo "BACKUP_OK"';

        return ctx.execute(wrapSh(script), 15000).then(function (r) {
            if (r.exit_code !== 0) {
                return Promise.reject(new Error('Pre-edit backup failed (' + ((r.stdout || '').trim() || r.stderr || 'exit code ' + r.exit_code) + '); edit aborted to protect existing data.'));
            }
            return true;
        });
    }

    // Phase 1 of import: read-only validation while tvs_deamon.service keeps running.
    // Validates zip integrity & uncompressed bounds (unzip -t / -l), extracts only allowlisted
    // non-symlink entries, checks SQLite integrity & live TV schema match, and detects region/model mismatch.
    function runPhase1Validation(uploadZip, tmpDir, sourceName) {
        var listCmd = wrapSh(
            'UP=' + shQuote(uploadZip) + '; ' +
            'if ! /usr/bin/unzip -t "$UP" </dev/null >/dev/null 2>&1; then rm -f "$UP"; echo "INVALID_ZIP"; exit 1; fi; ' +
            'echo "__LIST_START__"; ' +
            '/usr/bin/unzip -l "$UP" </dev/null; ' +
            'RC=$?; ' +
            'echo "__LIST_END__"; ' +
            'exit $RC'
        );

        return ctx.execute(listCmd, 12000).then(function (lr) {
            var listOut = String(lr.stdout || '');
            if (listOut.indexOf('INVALID_ZIP') >= 0 || lr.exit_code !== 0) {
                try { if (fs.existsSync(uploadZip)) fs.unlinkSync(uploadZip); } catch (e) { }
                return { errorCode: 400, error: 'The uploaded file is not a valid zip archive.' };
            }

            var sList = listOut.indexOf('__LIST_START__');
            var eList = listOut.indexOf('__LIST_END__', sList >= 0 ? sList + 14 : 0);
            var listBody = (sList >= 0 && eList > sList) ? listOut.slice(sList + 14, eList) : listOut;
            var parsedList = parseUnzipList(listBody);
            if (parsedList.error) {
                try { if (fs.existsSync(uploadZip)) fs.unlinkSync(uploadZip); } catch (e) { }
                return { errorCode: 400, error: parsedList.error };
            }

            var extractArgs = '';
            for (var ei = 0; ei < parsedList.extractFiles.length; ei++) {
                extractArgs += (ei > 0 ? ' ' : '') + shQuote(parsedList.extractFiles[ei]);
            }
            var ownerUg = getDirOwnerUg();
            var extractCmd = wrapSh(
                'UP=' + shQuote(uploadZip) + '; ' +
                'TMP=' + shQuote(tmpDir) + '; ' +
                'rm -rf "$TMP" && mkdir -p "$TMP" || { rm -f "$UP"; echo "EXTRACT_MKDIR_FAILED"; exit 1; }; ' +
                '/usr/bin/unzip -o -q "$UP" ' + extractArgs + ' -d "$TMP/" </dev/null >/dev/null 2>&1; RC=$?; rm -f "$UP"; ' +
                'if [ $RC -ne 0 ]; then rm -rf "$TMP"; echo "INVALID_ZIP"; exit 1; fi; ' +
                'TOTAL_SZ=0; DBS=""; ' +
                'for f in ' + extractArgs + '; do ' +
                '  if [ -L "$TMP/$f" ]; then rm -rf "$TMP"; echo "SYMLINK_REJECTED"; exit 4; fi; ' +
                '  if [ -f "$TMP/$f" ]; then ' +
                '    FSZ=$(wc -c < "$TMP/$f" 2>/dev/null || echo 0); ' +
                '    TOTAL_SZ=$((TOTAL_SZ + FSZ)); ' +
                '    case "$f" in metadata.xml) ;; *) DBS="$DBS $f" ;; esac; ' +
                '  fi; ' +
                'done; ' +
                'if [ "$TOTAL_SZ" -gt ' + MAX_UNZIP_BYTES + ' ]; then rm -rf "$TMP"; echo "UNZIP_TOO_LARGE"; exit 5; fi; ' +
                'if [ -z "$DBS" ]; then rm -rf "$TMP"; echo "NO_CHANNELS_FOUND"; exit 2; fi; ' +
                (ownerUg ? ('chown -R ' + shQuote(ownerUg) + ' "$TMP" 2>/dev/null || true; ') : '') +
                'chmod -R u+rwX "$TMP" 2>/dev/null || true; ' +
                'echo "__DBS__=$DBS"; ' +
                'if [ -f "$TMP/metadata.xml" ] && [ ! -L "$TMP/metadata.xml" ]; then echo "__IMP_META_START__"; cat "$TMP/metadata.xml"; echo ""; echo "__IMP_META_END__"; fi; ' +
                'if [ -f ' + shQuote(path.join(dataDir, 'metadata.xml')) + ' ]; then echo "__TV_META_START__"; cat ' + shQuote(path.join(dataDir, 'metadata.xml')) + '; echo ""; echo "__TV_META_END__"; fi; ' +
                'if [ -f "/etc/prd_info.ini" ]; then echo "__PRD_START__"; cat /etc/prd_info.ini; echo ""; echo "__PRD_END__"; fi'
            );

            return ctx.execute(extractCmd, 15000).then(function (r) {
                var out = String(r.stdout || '');
                if (out.indexOf('INVALID_ZIP') >= 0) {
                    rmrfSync(tmpDir);
                    return { errorCode: 400, error: 'The uploaded file is not a valid zip archive.' };
                }
                if (out.indexOf('SYMLINK_REJECTED') >= 0) {
                    rmrfSync(tmpDir);
                    return { errorCode: 400, error: 'Archive contains disallowed symbolic links.' };
                }
                if (out.indexOf('UNZIP_TOO_LARGE') >= 0) {
                    rmrfSync(tmpDir);
                    return { errorCode: 400, error: 'Extracted archive exceeds 32 MB safety limit.' };
                }
                if (out.indexOf('NO_CHANNELS_FOUND') >= 0) {
                    rmrfSync(tmpDir);
                    return { errorCode: 400, error: 'No channel databases (dvbs, ipsrv, dvbt, dvbc, sat) found inside archive.' };
                }
                if (r.exit_code !== 0) {
                    rmrfSync(tmpDir);
                    return { errorCode: 500, error: 'Failed to unpack archive: ' + (r.stderr || 'exit code ' + r.exit_code) };
                }

                var dbsMatch = /__DBS__=([^\r\n]+)/.exec(out);
                var rawList = dbsMatch ? dbsMatch[1].trim().split(/\s+/) : [];
                var dbFiles = [];
                for (var i = 0; i < rawList.length; i++) {
                    if (ALLOWED_DBS.indexOf(rawList[i]) >= 0) {
                        dbFiles.push(rawList[i]);
                    }
                }
                if (dbFiles.length === 0) {
                    rmrfSync(tmpDir);
                    return { errorCode: 400, error: 'No valid channel databases found inside archive.' };
                }

                function sliceBetween(startTag, endTag) {
                    var sIdx = out.indexOf(startTag);
                    if (sIdx < 0) return '';
                    sIdx += startTag.length;
                    var eIdx = out.indexOf(endTag, sIdx);
                    if (eIdx < 0) return '';
                    return out.slice(sIdx, eIdx).trim();
                }

                var impMeta = parseMetadataXml(sliceBetween('__IMP_META_START__', '__IMP_META_END__'));
                var tvMeta = parseMetadataXml(sliceBetween('__TV_META_START__', '__TV_META_END__'));
                var tvModel = parsePrdModel(sliceBetween('__PRD_START__', '__PRD_END__'));

                var dbIdx = 0;
                function validateNextDb() {
                    if (dbIdx >= dbFiles.length) {
                        var warnings = [];
                        if (impMeta && tvMeta) {
                            var diffs = [];
                            if (tvMeta.digitalCountry && impMeta.digitalCountry && tvMeta.digitalCountry !== impMeta.digitalCountry) {
                                diffs.push('Digital country ' + impMeta.digitalCountry + ' vs TV ' + tvMeta.digitalCountry);
                            }
                            if (tvMeta.analogCountry && impMeta.analogCountry && tvMeta.analogCountry !== impMeta.analogCountry) {
                                diffs.push('Analog country ' + impMeta.analogCountry + ' vs TV ' + tvMeta.analogCountry);
                            }
                            if (tvMeta.seiVersion && impMeta.seiVersion && tvMeta.seiVersion !== impMeta.seiVersion) {
                                diffs.push('SEI version ' + impMeta.seiVersion + ' vs TV ' + tvMeta.seiVersion);
                            }
                            if (diffs.length > 0) {
                                warnings.push('Region/country metadata differs (' + diffs.join('; ') + '). The TV\'s existing metadata.xml will NOT be overwritten.');
                            }
                        }
                        var zipModel = extractZipModelPrefix(sourceName);
                        if (zipModel && tvModel && zipModel.toUpperCase() !== tvModel.toUpperCase()) {
                            warnings.push('Archive filename suggests model "' + zipModel + '", which differs from this TV ("' + tvModel + '").');
                        }
                        var hashes = hashStagedFiles(tmpDir, dbFiles);
                        if (!hashes) {
                            rmrfSync(tmpDir);
                            return Promise.resolve({ errorCode: 500, error: 'Failed to verify staged database files.' });
                        }
                        return Promise.resolve({
                            dbFiles: dbFiles,
                            warnings: warnings,
                            tvModel: tvModel,
                            hashes: hashes
                        });
                    }

                    var f = dbFiles[dbIdx++];
                    var impPath = path.join(tmpDir, f);
                    var livePath = path.join(dataDir, f);
                    return inspectDbSchema(ctx, impPath).then(function (impSchema) {
                        return inspectDbSchema(ctx, livePath).then(function (liveSchema) {
                            var effectiveLive = (liveSchema && liveSchema.integrity === 'ok' && liveSchema.tableNames.length > 0) ? liveSchema : null;
                            var errMsg = validateDbSchema(f, impSchema, effectiveLive);
                            if (errMsg) {
                                rmrfSync(tmpDir);
                                return { errorCode: 400, error: 'Database schema validation failed: ' + errMsg };
                            }
                            return validateNextDb();
                        });
                    });
                }

                return validateNextDb();
            });
        }).then(null, function (err) {
            try { if (fs.existsSync(uploadZip)) fs.unlinkSync(uploadZip); } catch (e) { }
            rmrfSync(tmpDir);
            return { errorCode: 500, error: err.message };
        });
    }

    // Phase 2 of import: atomic swap under flock + stopped tvs_deamon.service.
    // EXIT trap cleans staged files and guarantees daemon restart even on error.
    function runPhase2Swap(tmpDir, dbFiles, sourceName, tvModel, expectedHashes) {
        if (!preImportDir) {
            rmrfSync(tmpDir);
            return Promise.resolve({ errorCode: 500, error: 'Plugin directory unavailable for persistent backup.' });
        }

        if (expectedHashes) {
            var currentHashes = hashStagedFiles(tmpDir, dbFiles);
            if (!currentHashes) {
                rmrfSync(tmpDir);
                return Promise.resolve({ errorCode: 409, error: 'Staged import files are missing or invalid. Please upload the archive again.' });
            }
            for (var hi = 0; hi < dbFiles.length; hi++) {
                var hf = dbFiles[hi];
                if (expectedHashes[hf] && currentHashes[hf] !== expectedHashes[hf]) {
                    rmrfSync(tmpDir);
                    return Promise.resolve({ errorCode: 409, error: 'Staged import files changed before apply. Please upload the archive again.' });
                }
            }
        }

        var id = randomHex(8);
        var safeDir = path.join(tmpRoot, 'ch_stage_' + id);
        var liveFiles = [];
        for (var li = 0; li < ALLOWED_DBS.length; li++) {
            var ldb = ALLOWED_DBS[li];
            try {
                if (fs.existsSync(path.join(dataDir, ldb))) {
                    liveFiles.push(ldb);
                }
            } catch (e) { /* ignore stat error */ }
        }
        var metaWriteSh = buildMetaHeredocSh({
            createdAt: new Date().toISOString(),
            slot: 'pre-import',
            reason: 'import',
            sourceName: sanitizeFileName(sourceName),
            files: liveFiles,
            importedFiles: dbFiles.slice(),
            model: tvModel || ''
        }, '"$BACKUP_NEW/backup-meta.json"', 'rm -rf "$BACKUP_NEW"; echo "BACKUP_META_FAILED"; exit 13');

        var ownerUg = getDirOwnerUg();
        var fileArgs = '';
        for (var i = 0; i < dbFiles.length; i++) {
            fileArgs += (i > 0 ? ' ' : '') + shQuote(dbFiles[i]);
        }
        var stageAndVerifySh = buildStageAndVerifySh(expectedHashes, dbFiles);

        var script =
            'exec 9>' + shQuote(lockFile) + '; ' +
            '/usr/bin/flock -n 9 || { echo "LOCKED"; exit 10; }; ' +
            'DATA_DIR=' + shQuote(dataDir) + '; ' +
            'TMP_DIR=' + shQuote(tmpDir) + '; ' +
            'SAFE_DIR=' + shQuote(safeDir) + '; ' +
            'cleanup_early() { rm -rf "$SAFE_DIR" "$TMP_DIR" 2>/dev/null || true; }; ' +
            'trap cleanup_early EXIT; ' +
            'mkdir -m 0700 "$SAFE_DIR" || { echo "STAGE_MKDIR_FAILED"; exit 16; }; ' +
            stageAndVerifySh +
            TVS_UNIT_RESOLVE +
            'if [ -z "$UNIT" ]; then echo "NO_TVS_UNIT"; exit 11; fi; ' +
            buildSavePermsSh() +
            'systemctl stop "$UNIT" </dev/null >/dev/null 2>&1 || { echo "STOP_FAILED"; exit 12; }; ' +
            'BACKUP_BASE=' + shQuote(backupDir) + '; ' +
            'BACKUP_DIR=' + shQuote(preImportDir) + '; ' +
            'BACKUP_NEW="${BACKUP_DIR}.new"; ' +
            'BACKUP_OLD="${BACKUP_DIR}.old"; ' +
            'RESTARTED=0; ' +
            'cleanup_on_exit() { ' +
            '  rm -rf "$SAFE_DIR" "$TMP_DIR" 2>/dev/null || true; ' +
            '  if [ "$RESTARTED" -eq 0 ]; then systemctl start "$UNIT" </dev/null >/dev/null 2>&1 || true; RESTARTED=1; sleep 1; ' + VETRO_TUNER_RESTART_SH + '; fi; ' +
            '}; ' +
            'trap cleanup_on_exit EXIT; ' +
            'for f in dvbs sat ipsrv dvbt dvbc; do ' +
            '  if [ -f "$DATA_DIR/$f" ]; then sqlite3 "$DATA_DIR/$f" "PRAGMA wal_checkpoint(TRUNCATE);" </dev/null >/dev/null 2>&1 || true; fi; ' +
            'done; ' +
            'mkdir -p "$BACKUP_BASE" || { echo "BACKUP_MKDIR_FAILED"; exit 13; }; ' +
            'rm -rf "$BACKUP_NEW" "$BACKUP_OLD"; ' +
            'mkdir -p "$BACKUP_NEW" || { echo "BACKUP_MKDIR_FAILED"; exit 13; }; ' +
            'for f in dvbs sat ipsrv dvbt dvbc; do ' +
            '  if [ -f "$DATA_DIR/$f" ]; then ' +
            '    cp -p "$DATA_DIR/$f" "$BACKUP_NEW/$f" || { rm -rf "$BACKUP_NEW"; echo "BACKUP_COPY_FAILED"; exit 13; }; ' +
            '  fi; ' +
            'done; ' +
            metaWriteSh +
            (ownerUg ? ('chown -R ' + shQuote(ownerUg) + ' "$BACKUP_NEW" 2>/dev/null || true; ') : '') +
            'chmod -R u+rwX,go+rX "$BACKUP_NEW" 2>/dev/null || true; ' +
            'if [ -d "$BACKUP_DIR" ]; then mv "$BACKUP_DIR" "$BACKUP_OLD" || { rm -rf "$BACKUP_NEW"; echo "BACKUP_ROTATE_FAILED"; exit 13; }; fi; ' +
            'mv "$BACKUP_NEW" "$BACKUP_DIR" || { [ -d "$BACKUP_OLD" ] && mv "$BACKUP_OLD" "$BACKUP_DIR" 2>/dev/null || true; rm -rf "$BACKUP_NEW"; echo "BACKUP_SWAP_FAILED"; exit 13; }; ' +
            'rm -rf "$BACKUP_OLD"; ' +
            'rm -f "$DATA_DIR"/*-wal "$DATA_DIR"/*-shm; ' +
            'COPY_ERR=0; ' +
            'for f in ' + fileArgs + '; do ' +
            '  get_perm "$f"; ' +
            '  cp "$SAFE_DIR/$f" "$DATA_DIR/$f" && chmod "$P_M" "$DATA_DIR/$f" && chown "$P_O" "$DATA_DIR/$f" || { COPY_ERR=1; break; }; ' +
            'done; ' +
            'if [ "$COPY_ERR" -ne 0 ]; then ' +
            '  rm -f "$DATA_DIR"/*-wal "$DATA_DIR"/*-shm; ' +
            '  for f in dvbs sat ipsrv dvbt dvbc; do ' +
            '    if [ -f "$BACKUP_DIR/$f" ]; then get_perm "$f"; cp "$BACKUP_DIR/$f" "$DATA_DIR/$f" && chmod "$P_M" "$DATA_DIR/$f" && chown "$P_O" "$DATA_DIR/$f" || true; fi; ' +
            '  done; ' +
            '  for f in ' + fileArgs + '; do ' +
            '    if [ ! -f "$BACKUP_DIR/$f" ]; then rm -f "$DATA_DIR/$f"; fi; ' +
            '  done; ' +
            '  echo "COPY_ROLLED_BACK"; exit 14; ' +
            'fi; ' +
            'for f in ' + fileArgs + '; do ' +
            '  [ -f "$DATA_DIR/$f" ] && sqlite3 "$DATA_DIR/$f" "PRAGMA wal_checkpoint(TRUNCATE);" </dev/null >/dev/null 2>&1 || true; ' +
            'done; ' +
            'systemctl start "$UNIT" </dev/null >/dev/null 2>&1 || { echo "START_FAILED"; exit 15; }; ' +
            'RESTARTED=1; ' +
            'sleep 1; ' +
            VETRO_TUNER_RESTART_SH + '; ' +
            'echo "SUCCESS"';

        return ctx.execute(wrapSh(script), 30000).then(function (r) {
            rmrfSync(tmpDir);
            var out = String(r.stdout || '').trim();
            if (out.indexOf('SUCCESS') >= 0 && r.exit_code === 0) {
                cachedChannels = null;
                pendingReload = false;
                return {
                    ok: true,
                    message: 'Channels imported and TV channel manager reloaded! Previous list saved for rollback.'
                };
            }
            if (out.indexOf('LOCKED') >= 0) {
                return { errorCode: 409, error: 'Database lock held by another operation. Please retry in a few seconds.' };
            }
            if (out.indexOf('STAGED_HASH_MISMATCH') >= 0) {
                return { errorCode: 409, error: 'Staged import files failed integrity check before apply. Please upload the archive again.' };
            }
            if (out.indexOf('NO_TVS_UNIT') >= 0 || out.indexOf('STOP_FAILED') >= 0) {
                return { errorCode: 500, error: 'Could not stop tvs_deamon.service safely before import; live TV databases were left untouched.' };
            }
            if (out.indexOf('BACKUP_') >= 0) {
                return { errorCode: 500, error: 'Failed to create persistent pre-import backup (' + out + '); live TV databases were left untouched.' };
            }
            if (out.indexOf('COPY_ROLLED_BACK') >= 0) {
                return { errorCode: 500, error: 'Failed while copying database files; previous channel list was rolled back inside the stopped-daemon transaction.' };
            }
            return { errorCode: 500, error: 'Import swap failed (' + (out || r.stderr || 'exit code ' + r.exit_code) + ').' };
        }, function (err) {
            // Do NOT delete tmpDir/metaTmp or spawn a competing restore script after timeout;
            // the running shell script's EXIT trap owns cleanup and backup/pre-import stays intact.
            return {
                errorCode: 500,
                error: 'Import command timed out or failed (' + err.message + '). Refresh the list or use "Restore Previous" if needed.'
            };
        });
    }

    function withDbLock(res, actionFn) {
        if (dbBusy) {
            sendJson(res, 409, { ok: false, error: 'Another database modification is in progress. Please wait.' });
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
            sendJson(res, 500, { ok: false, error: err.message });
        }
    }

    function queryDatabase() {
        var dvbsPath = path.join(dataDir, 'dvbs');
        var satPath = path.join(dataDir, 'sat');
        var ipsrvPath = path.join(dataDir, 'ipsrv');

        var sqlWithSat = 'PRAGMA busy_timeout = 3000; ' +
            "ATTACH '" + sqlPath(satPath) + "' AS sat_db; " +
            "SELECT S.major, S.srvName, IFNULL(T.tpFreq/1000, 0), IFNULL(T.tpPol, -1), IFNULL(T.tpSr, 0), IFNULL(SAT.satName, ''), S.scrambled, S.hidden, S.srvId, IFNULL(S.srvType, 1) " +
            'FROM SRV S ' +
            'LEFT JOIN CHNL C ON S.chId = C.chId ' +
            'LEFT JOIN sat_db.SAT_TP T ON C.chNum = T.tpId ' +
            'LEFT JOIN sat_db.SAT SAT ON T.satId = SAT.satId ' +
            'WHERE S.elim = 0 ' +
            'ORDER BY S.major ASC, S.srvId ASC;';

        var sqlNoSat = 'PRAGMA busy_timeout = 3000; ' +
            "SELECT major, srvName, 0, -1, 0, '', scrambled, hidden, srvId, IFNULL(srvType, 1) " +
            'FROM SRV WHERE elim = 0 ORDER BY major ASC, srvId ASC;';

        var cmd = wrapSh(
            'DB=' + shQuote(dvbsPath) + '; SAT=' + shQuote(satPath) + '; ' +
            'if [ ! -f "$DB" ]; then echo "__NO_DB__"; exit 0; fi; ' +
            'if [ -f "$SAT" ]; then sqlite3 -bail "$DB" ' + shQuote(sqlWithSat) + ' </dev/null; ' +
            'else sqlite3 -bail "$DB" ' + shQuote(sqlNoSat) + ' </dev/null; fi'
        );

        return ctx.execute(cmd, 10000).then(function (res) {
            if (res.exit_code !== 0) {
                return Promise.reject(new Error('Failed to query satellite channels: ' + (res.stderr || 'sqlite exit code ' + res.exit_code)));
            }

            var channels = [];
            var stdout = res.stdout || '';
            if (stdout && stdout.indexOf('__NO_DB__') < 0) {
                var lines = stdout.split('\n');
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    if (!line) continue;
                    var parts = line.split('|');
                    if (parts.length < 9) continue;
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
                    var srvType = parts.length >= 10 ? parseInt(parts[9], 10) : 1;
                    if (isNaN(srvType)) srvType = 1;

                    channels.push({
                        num: major,
                        name: name,
                        freq: freq,
                        pol: pol,
                        sr: sr,
                        sat: sat || 'Satellite',
                        type: 'dvbs',
                        srvType: srvType,
                        category: getServiceCategory(srvType),
                        scrambled: scrambled,
                        hidden: hidden,
                        srvId: srvId
                    });
                }
            }

            // Also query IPTV (Samsung TV Plus) from ipsrv
            var sqlIp = 'PRAGMA busy_timeout = 3000; SELECT major, srvName, hidden, srvId, IFNULL(srvType, -1) FROM SRV WHERE elim = 0 ORDER BY major ASC, srvId ASC;';
            var cmdIp = wrapSh(
                'DB=' + shQuote(ipsrvPath) + '; ' +
                'if [ ! -f "$DB" ]; then echo "__NO_DB__"; exit 0; fi; ' +
                'sqlite3 -bail "$DB" ' + shQuote(sqlIp) + ' </dev/null'
            );

            return ctx.execute(cmdIp, 5000).then(function (resIp) {
                if (resIp.exit_code !== 0) {
                    return Promise.reject(new Error('Failed to query IPTV channels: ' + (resIp.stderr || 'sqlite exit code ' + resIp.exit_code)));
                }
                var outIp = resIp.stdout || '';
                if (outIp && outIp.indexOf('__NO_DB__') < 0) {
                    var linesIp = outIp.split('\n');
                    for (var j = 0; j < linesIp.length; j++) {
                        var l = linesIp[j];
                        if (!l) continue;
                        var p = l.split('|');
                        if (p.length < 4) continue;
                        var m = parseInt(p[0], 10);
                        if (isNaN(m)) continue;
                        var ipSrvId = p[3] ? String(p[3]).trim() : '';
                        var ipSrvType = p.length >= 5 ? parseInt(p[4], 10) : -1;
                        if (isNaN(ipSrvType)) ipSrvType = -1;
                        channels.push({
                            num: m,
                            name: decodeUtf16(p[1]),
                            freq: 0,
                            pol: '',
                            sr: 0,
                            sat: 'Samsung TV Plus',
                            type: 'iptv',
                            srvType: ipSrvType,
                            category: 'iptv',
                            scrambled: false,
                            hidden: p[2] === '1',
                            srvId: ipSrvId
                        });
                    }
                }

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
            clearPendingImport();
            page = null;
            cachedChannels = null;
            lastFetchTime = 0;
            dbBusy = false;
            pendingReload = false;
        },

        status: function () {
            return {
                ok: true,
                count: cachedChannels ? cachedChannels.length : 0,
                pendingReload: pendingReload
            };
        },

        route: function (req, res, sub) {
            var action = (sub || '').split('?')[0];

            // GET api/ui
            if (action === 'ui' && req.method === 'GET') {
                if (!page) page = loadPage(ctx);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(page || '');
                return true;
            }

            // GET api/backup-status — check whether pre-import or pre-edit backups exist
            if (action === 'backup-status' && req.method === 'GET') {
                sendJson(res, 200, readBackupStatus());
                return true;
            }

            // GET api/list
            if (action === 'list' && req.method === 'GET') {
                var forceRefresh = req.url && req.url.indexOf('refresh=1') >= 0;
                if (!forceRefresh && cachedChannels && (Date.now() - lastFetchTime < 3000)) {
                    sendJson(res, 200, { ok: true, channels: cachedChannels, pendingReload: pendingReload });
                    return true;
                }

                queryDatabase()
                    .then(function (channels) {
                        sendJson(res, 200, { ok: true, channels: channels, pendingReload: pendingReload });
                    }, function (err) {
                        sendJson(res, 500, { ok: false, error: err.message });
                    });
                return true;
            }

            // POST api/tune — switch TV to selected channel number or direct srvId
            if ((sub === 'tune' || action === 'tune') && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        sendJson(res, 400, { ok: false, error: err.message });
                        return;
                    }

                    var chRaw = parsed.channel != null ? String(parsed.channel).trim() : '';
                    var channel = /^[0-9]+$/.test(chRaw) ? parseInt(chRaw, 10) : NaN;
                    var srvId = parsed.srvId != null ? String(parsed.srvId).trim() : null;
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

                    // METHOD 1: Instant Direct Tune via srvId (or Vetro TV Tuner control pipe when visible & unambiguous)
                    if (srvId && SRVID_RE.test(srvId)) {
                        var canUseTunerPipe = false;
                        if (!pendingReload && !isNaN(channel) && channel >= 1 && channel <= 9999 && Array.isArray(cachedChannels)) {
                            var matchedRow = null;
                            var sameNumVisible = 0;
                            for (var ci = 0; ci < cachedChannels.length; ci++) {
                                var row = cachedChannels[ci];
                                if (!row) continue;
                                if (row.srvId === srvId) matchedRow = row;
                                if (!row.hidden && row.num === channel) sameNumVisible++;
                            }
                            if (matchedRow && !matchedRow.hidden && matchedRow.num === channel && sameNumVisible === 1) {
                                canUseTunerPipe = true;
                            }
                        }

                        if (canUseTunerPipe) {
                            var tuneScript =
                                'if ' + VETRO_TUNER_SHOWN_SH + '; then ' +
                                '( exec 3<>' + shQuote(VETRO_TUNER_PIPE) + ' && echo ' + shQuote('tune ' + channel) + ' >&3 ) && echo "__METHOD__=tuner"; ' +
                                'else /usr/bin/launch_app org.tizen.tv-viewer tune_channel ' + srvId + ' </dev/null && echo "__METHOD__=direct"; fi';
                            ctx.execute(wrapSh(tuneScript), 4000).then(function (r) {
                                var methodUsed = (r.stdout || '').indexOf('__METHOD__=tuner') >= 0 ? 'tuner' : 'direct';
                                sendJson(res, 200, { ok: r.exit_code === 0, channel: channel, srvId: srvId, method: methodUsed });
                            }, function (e) {
                                sendJson(res, 500, { ok: false, error: e.message });
                            });
                            return;
                        }

                        var directScript =
                            '/usr/bin/launch_app org.tizen.tv-viewer tune_channel ' + srvId + ' </dev/null || exit $?; ' +
                            VETRO_TUNER_RESYNC_SH;
                        ctx.execute(wrapSh(directScript), 5000).then(function (r) {
                            sendJson(res, 200, { ok: r.exit_code === 0, channel: channel, srvId: srvId, method: 'direct' });
                        }, function (e) {
                            sendJson(res, 500, { ok: false, error: e.message });
                        });
                        return;
                    }

                    // METHOD 2 (Fallback): High-Speed Async D-Bus Key Injection (or Vetro TV Tuner pipe when shown)
                    if (!channel || isNaN(channel) || channel <= 0 || channel > 9999) {
                        sendJson(res, 400, { ok: false, error: 'invalid channel number (must be 1-9999) or srvId' });
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

                    var fallbackScript =
                        'if ' + VETRO_TUNER_SHOWN_SH + '; then ' +
                        '( exec 3<>' + shQuote(VETRO_TUNER_PIPE) + ' && echo ' + shQuote('tune ' + channel) + ' >&3 ) && echo "__METHOD__=tuner"; ' +
                        'else ' + keyCmds.join('; ') + '; fi';

                    ctx.execute(wrapSh(fallbackScript), 6000).then(function (r) {
                        var fallbackMethod = (r.stdout || '').indexOf('__METHOD__=tuner') >= 0 ? 'tuner' : 'keys';
                        sendJson(res, 200, { ok: r.exit_code === 0, channel: channel, method: fallbackMethod, stderr: r.stderr });
                    }, function (e) {
                        sendJson(res, 500, { ok: false, error: e.message });
                    });
                });
                return true;
            }

            // POST api/tvsource — switch input directly to Broadcast TV
            if ((sub === 'tvsource' || action === 'tvsource') && req.method === 'POST') {
                var switchCmd = wrapSh(
                    '/usr/bin/input_keyevent XF86Exit </dev/null; ' +
                    '/usr/bin/launch_app org.tizen.tv-viewer change_source 0 sourceType 0 sourceName TV mbrIndex -2 __K_EX_LAUNCH_REQUESTOR user </dev/null; ' +
                    'if ' + VETRO_TUNER_ALIVE_SH + '; then ( exec 3<>' + shQuote(VETRO_TUNER_PIPE) + ' && echo \'resume\' >&3 ) 2>/dev/null || true; fi'
                );
                ctx.execute(switchCmd, 6000).then(function (r) {
                    sendJson(res, 200, { ok: r.exit_code === 0 });
                }, function (e) {
                    sendJson(res, 500, { ok: false, error: e.message });
                });
                return true;
            }

            // POST api/reload — reload channel manager daemon (and Vetro TV Tuner if running) without forcing input source switch
            if ((sub === 'reload' || action === 'reload') && req.method === 'POST') {
                withDbLock(res, function (release) {
                    var reloadScript =
                        'exec 9>' + shQuote(lockFile) + '; ' +
                        '/usr/bin/flock -n 9 || { echo "LOCKED"; exit 10; }; ' +
                        TVS_UNIT_RESOLVE +
                        'if [ -n "$UNIT" ]; then systemctl restart "$UNIT" </dev/null; else pkill -9 tvs-daemon || true; fi && sleep 1 && ' +
                        VETRO_TUNER_RESTART_SH;
                    ctx.execute(wrapSh(reloadScript), 12000).then(function (r) {
                        release();
                        if (r.exit_code === 10 || (r.stdout || '').indexOf('LOCKED') >= 0) {
                            sendJson(res, 409, { ok: false, error: 'Database lock held by another operation. Please retry.' });
                            return;
                        }
                        if (r.exit_code !== 0) {
                            sendJson(res, 500, { ok: false, error: 'Reload failed: ' + (r.stderr || 'exit code ' + r.exit_code) });
                            return;
                        }
                        cachedChannels = null;
                        pendingReload = false;
                        sendJson(res, 200, { ok: true, pendingReload: pendingReload });
                    }, function (e) {
                        release();
                        sendJson(res, 500, { ok: false, error: e.message });
                    });
                });
                return true;
            }

            // POST api/key — send key event (e.g. Vol+, Vol-, CH+, CH-)
            if ((sub === 'key' || action === 'key') && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        sendJson(res, 400, { ok: false, error: err.message });
                        return;
                    }
                    var k = parsed.key;
                    var keySym = (typeof k === 'string' && hasOwn(ALLOWED_KEYS, k) && typeof ALLOWED_KEYS[k] === 'string')
                        ? ALLOWED_KEYS[k]
                        : null;

                    if (!keySym) {
                        sendJson(res, 400, { ok: false, error: 'Invalid key' });
                        return;
                    }

                    ctx.execute(buildKeyCommand(keySym), 3000).then(function (r) {
                        sendJson(res, 200, { ok: r.exit_code === 0, key: keySym });
                    }, function (e) {
                        sendJson(res, 500, { ok: false, error: e.message });
                    });
                });
                return true;
            }

            // POST api/edit — manage channels strictly by srvId (hide, unhide, delete, move, rename)
            if ((sub === 'edit' || action === 'edit') && req.method === 'POST') {
                readJson(req, 65536, function (err, parsed) {
                    if (err) {
                        sendJson(res, 400, { ok: false, error: err.message });
                        return;
                    }

                    withDbLock(res, function (release) {
                        var editAction = parsed.action;
                        var dvbsSrvIds = [];
                        var ipsrvSrvIds = [];

                        if (Array.isArray(parsed.dvbsSrvIds) || Array.isArray(parsed.ipsrvSrvIds)) {
                            dvbsSrvIds = parseSrvIdList(parsed.dvbsSrvIds);
                            ipsrvSrvIds = parseSrvIdList(parsed.ipsrvSrvIds);
                        } else {
                            var singleList = [];
                            if (Array.isArray(parsed.srvIds)) {
                                singleList = parseSrvIdList(parsed.srvIds);
                            } else if (parsed.srvId != null) {
                                singleList = parseSrvIdList([parsed.srvId]);
                            }
                            if (parsed.type === 'ipsrv') {
                                ipsrvSrvIds = singleList;
                            } else {
                                dvbsSrvIds = singleList;
                            }
                        }

                        var totalChannels = dvbsSrvIds.length + ipsrvSrvIds.length;
                        if (!editAction || totalChannels === 0) {
                            release();
                            sendJson(res, 400, { ok: false, error: 'missing action or valid srvIds' });
                            return;
                        }

                        var dvbsPath = path.join(dataDir, 'dvbs');
                        var ipsrvPath = path.join(dataDir, 'ipsrv');

                        // ACTION 1: DELETE (pure deletion by default; optional category-scoped gap closure on dvbs;
                        // uses single ATTACH transaction when deleting from both dvbs and ipsrv)
                        if (editAction === 'delete') {
                            var compactRequested = !!parsed.compact;
                            var dvbsDelSet = createDict();
                            for (var di = 0; di < dvbsSrvIds.length; di++) dvbsDelSet[dvbsSrvIds[di]] = true;
                            var ipsrvDelSet = createDict();
                            for (var ipi = 0; ipi < ipsrvSrvIds.length; ipi++) ipsrvDelSet[ipsrvSrvIds[ipi]] = true;

                            var pDvbs = dvbsSrvIds.length > 0 ? queryChannelsForEdit(ctx, dvbsPath, 1) : Promise.resolve([]);
                            var pIpsrv = ipsrvSrvIds.length > 0 ? queryChannelsForEdit(ctx, ipsrvPath, -1) : Promise.resolve([]);

                            Promise.all([pDvbs, pIpsrv]).then(function (results) {
                                var dvbsPlan = planDeleteAndCompact(results[0], dvbsDelSet, {
                                    allowCompact: true,
                                    compact: compactRequested
                                });
                                // Never compact Samsung TV Plus (ipsrv) numbers (they live in 4000+ range).
                                var ipPlan = planDeleteAndCompact(results[1], ipsrvDelSet, {
                                    allowCompact: false,
                                    compact: false
                                });

                                var totalDeleted = dvbsPlan.toDelete.length + ipPlan.toDelete.length;
                                var totalShifted = dvbsPlan.changes.length;
                                if (totalDeleted === 0) {
                                    release();
                                    sendJson(res, 200, {
                                        ok: true,
                                        action: 'delete',
                                        deleted: 0,
                                        shifted: 0,
                                        pendingReload: pendingReload
                                    });
                                    return;
                                }

                                function appendPlanSql(parts, tableRef, planObj) {
                                    var delIds = [];
                                    for (var x = 0; x < planObj.toDelete.length; x++) delIds.push(planObj.toDelete[x].srvId);
                                    parts.push('UPDATE ' + tableRef + ' SET elim = 1, hidden = 1, hideGuide = 1, numSel = 0, major = 0 WHERE srvId IN (' + delIds.join(',') + ') AND elim = 0;');
                                    if (planObj.changes.length > 0) {
                                        var cases = [];
                                        var chgIds = [];
                                        for (var y = 0; y < planObj.changes.length; y++) {
                                            cases.push('WHEN ' + planObj.changes[y].srvId + ' THEN ' + planObj.changes[y].newMajor);
                                            chgIds.push(planObj.changes[y].srvId);
                                        }
                                        parts.push('UPDATE ' + tableRef + ' SET major = CASE srvId ' + cases.join(' ') + ' END, modifiedByUser = 1 WHERE srvId IN (' + chgIds.join(',') + ') AND elim = 0;');
                                    }
                                }

                                var sqlParts = [
                                    '.bail on',
                                    '.timeout 5000',
                                    'PRAGMA busy_timeout = 5000;'
                                ];
                                var targetExecDb;
                                var both = dvbsPlan.toDelete.length > 0 && ipPlan.toDelete.length > 0;
                                if (both) {
                                    targetExecDb = dvbsPath;
                                    sqlParts.push("ATTACH '" + sqlPath(ipsrvPath) + "' AS ipsrv_db;");
                                    sqlParts.push('BEGIN IMMEDIATE;');
                                    appendPlanSql(sqlParts, 'main.SRV', dvbsPlan);
                                    appendPlanSql(sqlParts, 'ipsrv_db.SRV', ipPlan);
                                    sqlParts.push('COMMIT;');
                                    sqlParts.push('PRAGMA main.wal_checkpoint(TRUNCATE);');
                                    sqlParts.push('PRAGMA ipsrv_db.wal_checkpoint(TRUNCATE);');
                                } else if (dvbsPlan.toDelete.length > 0) {
                                    targetExecDb = dvbsPath;
                                    sqlParts.push('BEGIN IMMEDIATE;');
                                    appendPlanSql(sqlParts, 'SRV', dvbsPlan);
                                    sqlParts.push('COMMIT;');
                                    sqlParts.push('PRAGMA wal_checkpoint(TRUNCATE);');
                                } else {
                                    targetExecDb = ipsrvPath;
                                    sqlParts.push('BEGIN IMMEDIATE;');
                                    appendPlanSql(sqlParts, 'SRV', ipPlan);
                                    sqlParts.push('COMMIT;');
                                    sqlParts.push('PRAGMA wal_checkpoint(TRUNCATE);');
                                }

                                var bakTargets = [];
                                if (dvbsPlan.toDelete.length > 0) bakTargets.push('dvbs');
                                if (ipPlan.toDelete.length > 0) bakTargets.push('ipsrv');

                                return savePreEditBackup(bakTargets, 'delete (' + totalDeleted + ' channel(s))').then(function () {
                                    return runSqlFile(ctx, targetExecDb, sqlParts, 15000).then(function () {
                                        release();
                                        cachedChannels = null;
                                        pendingReload = true;
                                        sendJson(res, 200, {
                                            ok: true,
                                            action: 'delete',
                                            deleted: totalDeleted,
                                            shifted: totalShifted,
                                            pendingReload: pendingReload
                                        });
                                    });
                                });
                            }).then(null, function (delErr) {
                                release();
                                sendJson(res, 500, { ok: false, error: delErr.message });
                            });
                            return;
                        }

                        // ACTION 2: MOVE channel(s) strictly by srvId with slot-conserving displacement
                        if (editAction === 'move') {
                            if (dvbsSrvIds.length > 0 && ipsrvSrvIds.length > 0) {
                                release();
                                sendJson(res, 400, { ok: false, error: 'cannot move Satellite and TV Plus channels together' });
                                return;
                            }
                            var targetType = (parsed.type === 'ipsrv' || ipsrvSrvIds.length > 0) ? 'ipsrv' : 'dvbs';
                            var moveDbPath = targetType === 'ipsrv' ? ipsrvPath : dvbsPath;
                            var moveSrvIds = targetType === 'ipsrv' ? ipsrvSrvIds : dvbsSrvIds;
                            var defaultCatType = targetType === 'ipsrv' ? -1 : 1;
                            var target = parseInt(parsed.target, 10);
                            if (isNaN(target) || target < 1 || target > 9999) {
                                release();
                                sendJson(res, 400, { ok: false, error: 'target channel must be between 1 and 9999' });
                                return;
                            }

                            queryChannelsForEdit(ctx, moveDbPath, defaultCatType)
                                .then(function (dbChannels) {
                                    var plan = computeChannelMoves(dbChannels, moveSrvIds, target, targetType === 'dvbs');
                                    if (plan.error) {
                                        release();
                                        sendJson(res, 400, { ok: false, error: plan.error });
                                        return;
                                    }

                                    var changes = plan.changes || [];
                                    if (changes.length === 0) {
                                        release();
                                        sendJson(res, 200, { ok: true, action: 'move', changed: 0, message: 'Channels are already at the target location', pendingReload: pendingReload });
                                        return;
                                    }

                                    var caseParts = [];
                                    var srvIdList = [];
                                    for (var c = 0; c < changes.length; c++) {
                                        caseParts.push('WHEN ' + changes[c].srvId + ' THEN ' + changes[c].newMajor);
                                        srvIdList.push(changes[c].srvId);
                                    }

                                    var moveParts = [
                                        '.bail on',
                                        '.timeout 5000',
                                        'PRAGMA busy_timeout = 5000;',
                                        'BEGIN IMMEDIATE;',
                                        'UPDATE SRV SET major = CASE srvId ' + caseParts.join(' ') + ' END, modifiedByUser = 1 WHERE srvId IN (' + srvIdList.join(',') + ') AND elim = 0;',
                                        'COMMIT;',
                                        'PRAGMA wal_checkpoint(TRUNCATE);'
                                    ];

                                    return savePreEditBackup([targetType], 'move (' + moveSrvIds.length + ' channel(s) to #' + target + ')').then(function () {
                                        return runSqlFile(ctx, moveDbPath, moveParts, 15000).then(function () {
                                            release();
                                            cachedChannels = null;
                                            pendingReload = true;
                                            sendJson(res, 200, {
                                                ok: true,
                                                action: 'move',
                                                target: target,
                                                moved: moveSrvIds.length,
                                                changed: changes.length,
                                                changes: changes,
                                                pendingReload: pendingReload
                                            });
                                        });
                                    });
                                })
                                .then(null, function (mvErr) {
                                    release();
                                    sendJson(res, 500, { ok: false, error: mvErr.message });
                                });
                            return;
                        }

                        // ACTION 3: HIDE / UNHIDE strictly by srvId (atomic ATTACH when spanning both DBs)
                        if (editAction === 'hide' || editAction === 'unhide') {
                            var hideVal = editAction === 'hide' ? 1 : 0;
                            var numSelVal = editAction === 'hide' ? 0 : 1;
                            var visParts = [
                                '.bail on',
                                '.timeout 5000',
                                'PRAGMA busy_timeout = 5000;'
                            ];
                            var visDb;
                            if (dvbsSrvIds.length > 0 && ipsrvSrvIds.length > 0) {
                                visDb = dvbsPath;
                                visParts.push("ATTACH '" + sqlPath(ipsrvPath) + "' AS ipsrv_db;");
                                visParts.push('BEGIN IMMEDIATE;');
                                visParts.push('UPDATE main.SRV SET hidden = ' + hideVal + ', hideGuide = ' + hideVal + ', numSel = ' + numSelVal + ' WHERE srvId IN (' + dvbsSrvIds.join(',') + ') AND elim = 0;');
                                visParts.push('UPDATE ipsrv_db.SRV SET hidden = ' + hideVal + ', hideGuide = ' + hideVal + ', numSel = ' + numSelVal + ' WHERE srvId IN (' + ipsrvSrvIds.join(',') + ') AND elim = 0;');
                                visParts.push('COMMIT;');
                                visParts.push('PRAGMA main.wal_checkpoint(TRUNCATE);');
                                visParts.push('PRAGMA ipsrv_db.wal_checkpoint(TRUNCATE);');
                            } else {
                                visDb = dvbsSrvIds.length > 0 ? dvbsPath : ipsrvPath;
                                var visIds = dvbsSrvIds.length > 0 ? dvbsSrvIds : ipsrvSrvIds;
                                visParts.push('BEGIN IMMEDIATE;');
                                visParts.push('UPDATE SRV SET hidden = ' + hideVal + ', hideGuide = ' + hideVal + ', numSel = ' + numSelVal + ' WHERE srvId IN (' + visIds.join(',') + ') AND elim = 0;');
                                visParts.push('COMMIT;');
                                visParts.push('PRAGMA wal_checkpoint(TRUNCATE);');
                            }

                            runSqlFile(ctx, visDb, visParts, 12000).then(function () {
                                release();
                                cachedChannels = null;
                                pendingReload = true;
                                sendJson(res, 200, {
                                    ok: true,
                                    action: editAction,
                                    count: totalChannels,
                                    pendingReload: pendingReload
                                });
                            }, function (uErr) {
                                release();
                                sendJson(res, 500, { ok: false, error: uErr.message });
                            });
                            return;
                        }

                        // ACTION 4: RENAME strictly by srvId (no major fallback)
                        if (editAction === 'rename') {
                            var newName = (parsed.name || '').trim();
                            if (!newName) {
                                release();
                                sendJson(res, 400, { ok: false, error: 'missing channel name' });
                                return;
                            }
                            if (newName.length > MAX_CHANNEL_NAME_LEN || CONTROL_CHAR_RE.test(newName)) {
                                release();
                                sendJson(res, 400, { ok: false, error: 'channel name must be 1-' + MAX_CHANNEL_NAME_LEN + ' printable characters' });
                                return;
                            }
                            var renameTargetType = (parsed.type === 'ipsrv' || ipsrvSrvIds.length > 0) ? 'ipsrv' : 'dvbs';
                            var renameDbPath = renameTargetType === 'ipsrv' ? ipsrvPath : dvbsPath;
                            var srvIdStr = renameTargetType === 'ipsrv'
                                ? (ipsrvSrvIds.length > 0 ? ipsrvSrvIds[0] : '')
                                : (dvbsSrvIds.length > 0 ? dvbsSrvIds[0] : '');

                            if (!srvIdStr || !SRVID_RE.test(srvIdStr)) {
                                release();
                                sendJson(res, 400, { ok: false, error: 'missing valid channel srvId' });
                                return;
                            }

                            var hexName = encodeUtf16Hex(newName);
                            var renameParts = [
                                '.bail on',
                                '.timeout 5000',
                                'PRAGMA busy_timeout = 5000;',
                                'BEGIN IMMEDIATE;',
                                "UPDATE SRV SET srvName = CAST(X'" + hexName + "' AS TEXT), modifiedByUser = 1 WHERE srvId = " + srvIdStr + ' AND elim = 0;',
                                'COMMIT;',
                                'PRAGMA wal_checkpoint(TRUNCATE);'
                            ];
                            runSqlFile(ctx, renameDbPath, renameParts, 10000).then(function () {
                                release();
                                cachedChannels = null;
                                pendingReload = true;
                                sendJson(res, 200, {
                                    ok: true,
                                    action: 'rename',
                                    srvId: srvIdStr,
                                    count: 1,
                                    pendingReload: pendingReload
                                });
                            }, function (e) {
                                release();
                                sendJson(res, 500, { ok: false, error: e.message });
                            });
                            return;
                        }

                        release();
                        sendJson(res, 400, { ok: false, error: 'unsupported action' });
                    });
                });
                return true;
            }

            // GET api/export — export official Samsung Channel_list_<Version>.zip under DB lock
            // Includes metadata.xml only if it already exists on this TV (no hardcoded country codes).
            if ((sub === 'export' || action === 'export') && req.method === 'GET') {
                withDbLock(res, function (release) {
                    var expId = randomHex(8);
                    var tmpZipPath = path.join(tmpRoot, 'ch_exp_' + expId + '.zip');
                    var ownerUg = getDirOwnerUg();
                    var exportCmd = wrapSh(
                        'PRD="/etc/prd_info.ini"; ' +
                        'VER=""; ' +
                        'if [ -f "$PRD" ]; then VER=$(grep -i "^Version=" "$PRD" | head -n 1 | cut -d "=" -f2 | tr -d ";\\r\\n "); fi; ' +
                        'if [ -z "$VER" ]; then VER="backup"; fi; ' +
                        'ZIPNAME="Channel_list_${VER}.zip"; ' +
                        'ZIPPATH=' + shQuote(tmpZipPath) + '; ' +
                        'cd ' + shQuote(dataDir) + ' || exit 1; ' +
                        'FILES=""; ' +
                        'for f in dvbs sat ipsrv dvbt dvbc; do ' +
                        '  if [ -f "$f" ]; then sqlite3 -bail "$f" "PRAGMA wal_checkpoint(TRUNCATE);" </dev/null >/dev/null 2>&1 || true; FILES="$FILES $f"; fi; ' +
                        'done; ' +
                        'if [ -f "metadata.xml" ]; then FILES="$FILES metadata.xml"; fi; ' +
                        'if [ -z "$FILES" ]; then echo "NO_FILES"; exit 2; fi; ' +
                        'rm -f "$ZIPPATH"; ' +
                        '/usr/bin/zip -j "$ZIPPATH" $FILES </dev/null >/dev/null 2>&1 || exit 3; ' +
                        (ownerUg ? ('chown ' + shQuote(ownerUg) + ' "$ZIPPATH" 2>/dev/null && chmod 0600 "$ZIPPATH" 2>/dev/null || chmod 0644 "$ZIPPATH" 2>/dev/null || true; ') : 'chmod 0644 "$ZIPPATH" 2>/dev/null || true; ') +
                        'echo "$ZIPNAME"'
                    );

                    ctx.execute(exportCmd, 12000).then(function (r) {
                        // Snapshot file is complete on disk: release lock before streaming over slow links.
                        release();
                        var lines = (r.stdout || '').trim().split('\n');
                        var lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : '';
                        if (r.exit_code !== 0 || lastLine === 'NO_FILES') {
                            try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (e) { }
                            sendJson(res, 500, { ok: false, error: 'Failed to generate channel backup archive' });
                            return;
                        }
                        var zipName = lastLine.replace(/[^A-Za-z0-9._-]/g, '');
                        if (!zipName || zipName.indexOf('Channel_list_') !== 0) {
                            zipName = 'Channel_list_backup.zip';
                        }
                        try {
                            var stat = fs.statSync(tmpZipPath);
                            res.writeHead(200, {
                                'content-type': 'application/zip',
                                'content-disposition': 'attachment; filename="' + zipName + '"',
                                'content-length': stat.size,
                                'cache-control': 'no-store'
                            });
                            var cleaned = false;
                            function cleanupZip() {
                                if (cleaned) return;
                                cleaned = true;
                                try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (e) { }
                            }
                            var readStream = fs.createReadStream(tmpZipPath);
                            readStream.on('close', cleanupZip);
                            readStream.on('error', function () {
                                cleanupZip();
                                try { res.end(); } catch (e) { }
                            });
                            res.on('close', cleanupZip);
                            readStream.pipe(res);
                        } catch (fsErr) {
                            try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (e) { }
                            sendJson(res, 500, { ok: false, error: 'Backup archive could not be read: ' + fsErr.message });
                        }
                    }, function (e) {
                        release();
                        try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (ex) { }
                        sendJson(res, 500, { ok: false, error: e.message });
                    });
                });
                return true;
            }

            // POST api/import — import Samsung Channel_list_*.zip archive (two-phase safe import)
            if ((sub === 'import' || action === 'import') && req.method === 'POST') {
                withDbLock(res, function (release) {
                    var contentLen = parseInt(req.headers && req.headers['content-length'], 10);
                    if (!isNaN(contentLen) && contentLen > MAX_IMPORT_BYTES) {
                        release();
                        sendJson(res, 413, { ok: false, error: 'Archive exceeds 15 MB limit.' }, { 'connection': 'close' });
                        return;
                    }

                    var queryName = getQueryParam(req.url, 'name') || getQueryParam(sub, 'name');
                    var decodedName = queryName;
                    if (!decodedName && req.headers && req.headers['x-upload-filename']) {
                        var rawHeaderName = String(req.headers['x-upload-filename']);
                        try { decodedName = decodeURIComponent(rawHeaderName); } catch (e) { decodedName = rawHeaderName; }
                    }
                    var sourceName = sanitizeFileName(decodedName);
                    var importId = randomHex(8);
                    var uploadZip = path.join(tmpRoot, 'ch_up_' + importId + '.zip');
                    var tmpDir = path.join(tmpRoot, 'ch_imp_' + importId);

                    var receivedBytes = 0;
                    var outStream = fs.createWriteStream(uploadZip, { flags: 'wx', mode: 384 /* 0600 */ });
                    var outClosed = false;
                    var uploadEnded = false;
                    var settled = false;
                    var activeFinalize = null;

                    outStream.once('close', function () {
                        outClosed = true;
                    });

                    function abortUpload(statusCode, errMsg, destroyReqAfterRes, immediate) {
                        if (settled) return;
                        settled = true;

                        if (typeof req.unpipe === 'function') {
                            try { req.unpipe(outStream); } catch (e) { }
                        }

                        var finalized = false;
                        function finalizeCleanup() {
                            if (finalized) return;
                            finalized = true;
                            activeFinalize = null;
                            try { if (fs.existsSync(uploadZip)) fs.unlinkSync(uploadZip); } catch (e) { }
                            release();
                            if (destroyReqAfterRes && typeof req.destroy === 'function') {
                                if (res.writableEnded || res.finished) {
                                    try { req.destroy(); } catch (e) { }
                                } else {
                                    res.once('finish', function () {
                                        try { req.destroy(); } catch (e) { }
                                    });
                                }
                            }
                            if (!res.headersSent) {
                                sendJson(res, statusCode, { ok: false, error: errMsg }, statusCode === 413 ? { 'connection': 'close' } : null);
                            }
                        }
                        activeFinalize = finalizeCleanup;

                        if (outClosed || immediate) {
                            if (!outClosed) {
                                outStream.once('close', function () {
                                    try { if (fs.existsSync(uploadZip)) fs.unlinkSync(uploadZip); } catch (e) { }
                                });
                                if (typeof outStream.destroy === 'function') {
                                    try { outStream.destroy(); } catch (e) { }
                                } else if (typeof outStream.end === 'function') {
                                    try { outStream.end(); } catch (e) { }
                                }
                            }
                            finalizeCleanup();
                        } else {
                            outStream.once('close', finalizeCleanup);
                            if (typeof outStream.destroy === 'function') {
                                try { outStream.destroy(); } catch (e) { finalizeCleanup(); }
                            } else if (typeof outStream.end === 'function') {
                                try { outStream.end(); } catch (e) { finalizeCleanup(); }
                            } else {
                                finalizeCleanup();
                            }
                        }
                    }

                    req.on('data', function (chunk) {
                        if (settled) return;
                        receivedBytes += chunk.length;
                        if (receivedBytes > MAX_IMPORT_BYTES) {
                            abortUpload(413, 'Archive exceeds 15 MB limit.', true, false);
                        }
                    });

                    req.on('end', function () {
                        uploadEnded = true;
                    });

                    req.on('aborted', function () {
                        abortUpload(400, 'Upload aborted by client.', false, false);
                    });

                    req.on('close', function () {
                        if (!uploadEnded && !settled) {
                            abortUpload(400, 'Upload connection closed before completion.', false, false);
                        }
                    });

                    req.on('error', function (err) {
                        abortUpload(400, 'Upload failed: ' + err.message, false, false);
                    });

                    outStream.on('error', function (err) {
                        if (settled) {
                            if (typeof activeFinalize === 'function') activeFinalize();
                            return;
                        }
                        abortUpload(500, 'Failed writing upload stream: ' + err.message, true, true);
                    });

                    outStream.on('finish', function () {
                        if (settled) return;
                        settled = true;

                        runPhase1Validation(uploadZip, tmpDir, sourceName).then(function (p1) {
                            if (p1.error) {
                                release();
                                sendJson(res, p1.errorCode || 400, { ok: false, error: p1.error });
                                return;
                            }

                            if (p1.warnings && p1.warnings.length > 0) {
                                clearPendingImport();
                                var confirmToken = randomHex(12);
                                pendingImport = {
                                    token: confirmToken,
                                    tmpDir: tmpDir,
                                    dbFiles: p1.dbFiles,
                                    sourceName: sourceName,
                                    tvModel: p1.tvModel,
                                    hashes: p1.hashes,
                                    expiresAt: Date.now() + stagedImportTtlMs
                                };
                                pendingImportTimer = setTimeout(function () {
                                    clearPendingImport();
                                }, stagedImportTtlMs);
                                if (pendingImportTimer && typeof pendingImportTimer.unref === 'function') {
                                    pendingImportTimer.unref();
                                }
                                release();
                                sendJson(res, 200, {
                                    ok: true,
                                    needsConfirm: true,
                                    confirmToken: confirmToken,
                                    warnings: p1.warnings,
                                    files: p1.dbFiles
                                });
                                return;
                            }

                            return runPhase2Swap(tmpDir, p1.dbFiles, sourceName, p1.tvModel, p1.hashes).then(function (p2) {
                                release();
                                if (p2.ok) {
                                    sendJson(res, 200, p2);
                                } else {
                                    sendJson(res, p2.errorCode || 500, { ok: false, error: p2.error });
                                }
                            });
                        }, function (err) {
                            try { if (fs.existsSync(uploadZip)) fs.unlinkSync(uploadZip); } catch (e) { }
                            rmrfSync(tmpDir);
                            release();
                            sendJson(res, 500, { ok: false, error: err.message });
                        });
                    });

                    req.pipe(outStream);
                });
                return true;
            }

            // POST api/import-confirm — complete staged Phase 2 swap after explicit user confirmation
            if (action === 'import-confirm' && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    if (err) {
                        sendJson(res, 400, { ok: false, error: err.message });
                        return;
                    }
                    withDbLock(res, function (release) {
                        var tok = parsed.confirmToken ? String(parsed.confirmToken) : '';
                        if (!pendingImport || !tok || pendingImport.token !== tok) {
                            release();
                            sendJson(res, 400, { ok: false, error: 'No matching pending import found. Please upload the archive again.' });
                            return;
                        }
                        if (pendingImport.expiresAt && Date.now() > pendingImport.expiresAt) {
                            clearPendingImport();
                            release();
                            sendJson(res, 410, { ok: false, error: 'Staged import expired. Please upload the archive again.' });
                            return;
                        }
                        if (pendingImportTimer) {
                            clearTimeout(pendingImportTimer);
                            pendingImportTimer = null;
                        }
                        var staged = pendingImport;
                        pendingImport = null;

                        runPhase2Swap(staged.tmpDir, staged.dbFiles, staged.sourceName, staged.tvModel, staged.hashes).then(function (p2) {
                            release();
                            if (p2.ok) {
                                sendJson(res, 200, p2);
                            } else {
                                sendJson(res, p2.errorCode || 500, { ok: false, error: p2.error });
                            }
                        }, function (swapErr) {
                            release();
                            sendJson(res, 500, { ok: false, error: swapErr.message });
                        });
                    });
                });
                return true;
            }

            // POST api/import-cancel — discard a staged mismatch import without stopping the TV daemon
            if (action === 'import-cancel' && req.method === 'POST') {
                readJson(req, 4096, function (err, parsed) {
                    var tok = (!err && parsed && parsed.confirmToken) ? String(parsed.confirmToken) : '';
                    if (!tok || (pendingImport && pendingImport.token === tok)) {
                        clearPendingImport();
                    }
                    sendJson(res, 200, { ok: true });
                });
                return true;
            }

            // POST api/restore-backup — restore pre-edit or pre-import backup under stopped daemon
            if (action === 'restore-backup' && req.method === 'POST') {
                readJson(req, 4096, function (bodyErr, parsedBody) {
                    var requestedSlot = (!bodyErr && parsedBody && parsedBody.slot) ? String(parsedBody.slot).trim() : '';
                    if (requestedSlot && requestedSlot !== 'pre-import' && requestedSlot !== 'pre-edit') {
                        sendJson(res, 400, { ok: false, error: 'Invalid backup slot. Expected "pre-import" or "pre-edit".' });
                        return;
                    }

                    withDbLock(res, function (release) {
                        var bStatus = readBackupStatus();
                        var chosenSlot = requestedSlot;
                        if (!chosenSlot) {
                            chosenSlot = bStatus.preImport.available ? 'pre-import' : (bStatus.preEdit.available ? 'pre-edit' : '');
                        }
                        var slotInfo = chosenSlot === 'pre-edit' ? bStatus.preEdit : bStatus.preImport;
                        var slotDir = chosenSlot === 'pre-edit'
                            ? preEditDir
                            : ((bStatus.preImport && bStatus.preImport.legacy) ? backupDir : preImportDir);

                        if (!slotInfo || !slotInfo.available || slotInfo.files.length === 0) {
                            release();
                            sendJson(res, 404, { ok: false, error: 'Requested backup (' + (chosenSlot || 'any') + ') is not available on the TV.' });
                            return;
                        }

                        var files = slotInfo.files;
                        var idx = 0;
                        function verifyNextBackupDb() {
                            if (idx >= files.length) {
                                var fileArgs = '';
                                for (var fi = 0; fi < files.length; fi++) {
                                    fileArgs += (fi > 0 ? ' ' : '') + shQuote(files[fi]);
                                }
                                var rbId = randomHex(8);
                                var rbDir = path.join(tmpRoot, 'ch_rb_' + rbId);
                                var restoreScript =
                                    'exec 9>' + shQuote(lockFile) + '; ' +
                                    '/usr/bin/flock -n 9 || { echo "LOCKED"; exit 10; }; ' +
                                    TVS_UNIT_RESOLVE +
                                    'if [ -z "$UNIT" ]; then echo "NO_TVS_UNIT"; exit 11; fi; ' +
                                    'DATA_DIR=' + shQuote(dataDir) + '; ' +
                                    buildSavePermsSh() +
                                    'systemctl stop "$UNIT" </dev/null >/dev/null 2>&1 || { echo "STOP_FAILED"; exit 12; }; ' +
                                    'BACKUP_DIR=' + shQuote(slotDir) + '; ' +
                                    'RB_DIR=' + shQuote(rbDir) + '; ' +
                                    'RESTARTED=0; ' +
                                    'cleanup_start() { ' +
                                    '  rm -rf "$RB_DIR" 2>/dev/null || true; ' +
                                    '  if [ "$RESTARTED" -eq 0 ]; then systemctl start "$UNIT" </dev/null >/dev/null 2>&1 || true; RESTARTED=1; sleep 1; ' + VETRO_TUNER_RESTART_SH + '; fi; ' +
                                    '}; ' +
                                    'trap cleanup_start EXIT; ' +
                                    'rm -rf "$RB_DIR" && mkdir -p "$RB_DIR" || { echo "RESTORE_RB_MKDIR_FAILED"; exit 13; }; ' +
                                    'for f in dvbs sat ipsrv dvbt dvbc; do ' +
                                    '  if [ -f "$DATA_DIR/$f" ]; then ' +
                                    '    cp -p "$DATA_DIR/$f" "$RB_DIR/$f" || { echo "RESTORE_RB_COPY_FAILED"; exit 13; }; ' +
                                    '  fi; ' +
                                    'done; ' +
                                    'rm -f "$DATA_DIR"/*-wal "$DATA_DIR"/*-shm; ' +
                                    'COPY_ERR=0; ' +
                                    'for f in ' + fileArgs + '; do ' +
                                    '  get_perm "$f"; ' +
                                    '  cp "$BACKUP_DIR/$f" "$DATA_DIR/$f" && chmod "$P_M" "$DATA_DIR/$f" && chown "$P_O" "$DATA_DIR/$f" || { COPY_ERR=1; break; }; ' +
                                    'done; ' +
                                    'if [ "$COPY_ERR" -ne 0 ]; then ' +
                                    '  rm -f "$DATA_DIR"/*-wal "$DATA_DIR"/*-shm; ' +
                                    '  for f in dvbs sat ipsrv dvbt dvbc; do ' +
                                    '    if [ -f "$RB_DIR/$f" ]; then get_perm "$f"; cp "$RB_DIR/$f" "$DATA_DIR/$f" && chmod "$P_M" "$DATA_DIR/$f" && chown "$P_O" "$DATA_DIR/$f" || true; fi; ' +
                                    '  done; ' +
                                    '  for f in ' + fileArgs + '; do ' +
                                    '    if [ ! -f "$RB_DIR/$f" ]; then rm -f "$DATA_DIR/$f"; fi; ' +
                                    '  done; ' +
                                    '  echo "RESTORE_ROLLED_BACK"; exit 14; ' +
                                    'fi; ' +
                                    'for f in ' + fileArgs + '; do ' +
                                    '  [ -f "$DATA_DIR/$f" ] && sqlite3 -bail "$DATA_DIR/$f" "PRAGMA wal_checkpoint(TRUNCATE);" </dev/null >/dev/null 2>&1 || true; ' +
                                    'done; ' +
                                    'systemctl start "$UNIT" </dev/null >/dev/null 2>&1 || { echo "START_FAILED"; exit 15; }; ' +
                                    'RESTARTED=1; ' +
                                    'sleep 1; ' +
                                    VETRO_TUNER_RESTART_SH + '; ' +
                                    'echo "SUCCESS"';

                                return ctx.execute(wrapSh(restoreScript), 25000).then(function (r) {
                                    release();
                                    var out = String(r.stdout || '').trim();
                                    if (out.indexOf('SUCCESS') >= 0 && r.exit_code === 0) {
                                        cachedChannels = null;
                                        pendingReload = false;
                                        sendJson(res, 200, {
                                            ok: true,
                                            slot: chosenSlot,
                                            restored: files,
                                            message: 'Backup (' + chosenSlot + ') restored and TV channel manager reloaded!'
                                        });
                                        return;
                                    }
                                    if (out.indexOf('LOCKED') >= 0) {
                                        sendJson(res, 409, { ok: false, error: 'Database lock held by another operation. Please retry in a few seconds.' });
                                        return;
                                    }
                                    if (out.indexOf('RESTORE_ROLLED_BACK') >= 0) {
                                        sendJson(res, 500, { ok: false, error: 'Failed while copying backup files; previous TV databases were rolled back.' });
                                        return;
                                    }
                                    sendJson(res, 500, { ok: false, error: 'Restore failed (' + (out || r.stderr || 'exit code ' + r.exit_code) + ').' });
                                }, function (err) {
                                    release();
                                    sendJson(res, 500, { ok: false, error: err.message });
                                });
                            }

                            var f = files[idx++];
                            var bPath = path.join(slotDir, f);
                            return inspectDbSchema(ctx, bPath).then(function (bakSchema) {
                                // Validate against required baseline schema (null liveSchema) so a corrupt live DB never blocks restore
                                var schemaErr = validateDbSchema(f, bakSchema, null);
                                if (schemaErr) {
                                    release();
                                    sendJson(res, 500, { ok: false, error: 'Saved backup failed validation: ' + schemaErr });
                                    return;
                                }
                                return verifyNextBackupDb();
                            });
                        }

                        verifyNextBackupDb().then(null, function (vErr) {
                            release();
                            sendJson(res, 500, { ok: false, error: vErr.message });
                        });
                    });
                });
                return true;
            }

            return false;
        }
    };
}

channelsPlugin._internals = {
    ALLOWED_KEYS: ALLOWED_KEYS,
    TUNER_PIPE_KEYS: TUNER_PIPE_KEYS,
    VETRO_TUNER_RESTART_SH: VETRO_TUNER_RESTART_SH,
    buildKeyCommand: buildKeyCommand,
    ALLOWED_DBS: ALLOWED_DBS,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
    MAX_UNZIP_BYTES: MAX_UNZIP_BYTES,
    MAX_UNZIP_ENTRIES: MAX_UNZIP_ENTRIES,
    MAX_CHANNEL_NAME_LEN: MAX_CHANNEL_NAME_LEN,
    getServiceCategory: getServiceCategory,
    parseMetadataXml: parseMetadataXml,
    parsePrdModel: parsePrdModel,
    extractZipModelPrefix: extractZipModelPrefix,
    sanitizeFileName: sanitizeFileName,
    parseUnzipList: parseUnzipList,
    parseSchemaOutput: parseSchemaOutput,
    inspectDbSchema: inspectDbSchema,
    validateDbSchema: validateDbSchema,
    parseSrvIdList: parseSrvIdList,
    planDeleteAndCompact: planDeleteAndCompact,
    computeChannelMoves: computeChannelMoves,
    decodeUtf16: decodeUtf16,
    encodeUtf16Hex: encodeUtf16Hex,
    shQuote: shQuote,
    wrapSh: wrapSh,
    sqlPath: sqlPath
};

module.exports = channelsPlugin;
