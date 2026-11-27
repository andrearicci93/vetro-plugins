'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var cp = require('node:child_process');
var fs = require('node:fs');
var http = require('node:http');
var os = require('node:os');
var path = require('node:path');
var stream = require('node:stream');

var pluginFactory = require('../plugins/channels/index.js');
var internals = pluginFactory._internals;

function findSqliteBinary() {
    var candidates = process.platform === 'win32'
        ? ['sqlite3', 'C:\\adb\\sqlite3.exe']
        : ['sqlite3', '/usr/bin/sqlite3'];
    for (var i = 0; i < candidates.length; i++) {
        var r = cp.spawnSync(candidates[i], ['--version'], { encoding: 'utf8' });
        if (!r.error && r.status === 0) {
            return candidates[i];
        }
    }
    throw new Error('sqlite3 CLI binary is required to run channels tests');
}

var SQLITE_BIN = findSqliteBinary();

function sqlForward(p) {
    return String(p).replace(/\\/g, '/').replace(/'/g, "''");
}

function createTempEnv(t) {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'vetro-ch-test-'));
    var pluginDir = path.join(root, 'plugin');
    var dataDir = path.join(root, 'data');
    var tmpDir = path.join(root, 'tmp');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    if (t && typeof t.after === 'function') {
        t.after(function () {
            try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { }
        });
    }
    return { root: root, pluginDir: pluginDir, dataDir: dataDir, tmpDir: tmpDir };
}

function createTvDatabases(dataDir, opts) {
    opts = opts || {};
    var dvbsPath = path.join(dataDir, 'dvbs');
    var satPath = path.join(dataDir, 'sat');
    var ipsrvPath = path.join(dataDir, 'ipsrv');

    var enc = internals.encodeUtf16Hex;
    var schemaVer = opts.userVersion != null ? opts.userVersion : 7;

    var dvbsSql = [
        "PRAGMA encoding = 'UTF-16le';",
        'PRAGMA user_version = ' + schemaVer + ';',
        'CREATE TABLE CHNL (chId INTEGER PRIMARY KEY, chNum INTEGER);',
        'CREATE TABLE SRV (srvId INTEGER PRIMARY KEY, chId INTEGER, major INTEGER, srvName TEXT, srvType INTEGER, scrambled INTEGER, elim INTEGER, hidden INTEGER, hideGuide INTEGER, numSel INTEGER, modifiedByUser INTEGER);',
        'INSERT INTO CHNL VALUES (10, 100);',
        'INSERT INTO CHNL VALUES (11, 101);',
        // Channel #1 TV: srvId=101 (unique), plus deleted elim=1 row sharing major=1!
        "INSERT INTO SRV VALUES (101, 10, 1, CAST(X'" + enc('Alpha TV') + "' AS TEXT), 1, 0, 0, 0, 0, 1, 0);",
        "INSERT INTO SRV VALUES (199, 10, 1, CAST(X'" + enc('Deleted One') + "' AS TEXT), 1, 0, 1, 1, 1, 0, 0);",
        // Channel #2 TV: srvId=5 (collides numerically with Channel #5!), #3 TV: srvId=103, #4 Hidden TV: srvId=104
        "INSERT INTO SRV VALUES (5, 10, 2, CAST(X'" + enc('Beta HD') + "' AS TEXT), 25, 1, 0, 0, 0, 1, 0);",
        "INSERT INTO SRV VALUES (103, 10, 3, CAST(X'" + enc('Gamma TV') + "' AS TEXT), 1, 0, 0, 0, 0, 1, 0);",
        "INSERT INTO SRV VALUES (104, 10, 4, CAST(X'" + enc('Hidden TV') + "' AS TEXT), 1, 0, 0, 1, 1, 0, 0);",
        // Channel #5 TV: srvId=5001 (shares major=5 with srvId=5 above! Tests B2/delSet!)
        "INSERT INTO SRV VALUES (5001, 11, 5, CAST(X'" + enc('Delta Five') + "' AS TEXT), 1, 0, 0, 0, 0, 1, 0);",
        // Negative 64-bit srvId test row on #6
        "INSERT INTO SRV VALUES (-900719925474099, 11, 6, CAST(X'" + enc('Neg64 TV') + "' AS TEXT), 1, 0, 0, 0, 0, 1, 0);",
        // Radio channel #10 (srvType=2) & Data channel #20 (srvType=12) — must stay untouched by TV compaction!
        "INSERT INTO SRV VALUES (201, 10, 10, CAST(X'" + enc('Radio One') + "' AS TEXT), 2, 0, 0, 0, 0, 1, 0);",
        "INSERT INTO SRV VALUES (301, 10, 20, CAST(X'" + enc('Data Feed') + "' AS TEXT), 12, 0, 0, 0, 0, 1, 0);"
    ].join('\n');

    var resD = cp.spawnSync(SQLITE_BIN, [dvbsPath], { input: dvbsSql, encoding: 'utf8' });
    assert.equal(resD.status, 0, 'init dvbs: ' + resD.stderr);

    if (!opts.skipSat) {
        var satSql = [
            "PRAGMA encoding = 'UTF-16le';",
            'PRAGMA user_version = ' + schemaVer + ';',
            'CREATE TABLE SAT (satId INTEGER PRIMARY KEY, satName TEXT);',
            'CREATE TABLE SAT_TP (tpId INTEGER PRIMARY KEY, satId INTEGER, tpFreq INTEGER, tpPol INTEGER, tpSr INTEGER);',
            "INSERT INTO SAT VALUES (1, CAST(X'" + enc('Nilesat') + "' AS TEXT));",
            'INSERT INTO SAT_TP VALUES (100, 1, 11747000, 1, 27500);',
            'INSERT INTO SAT_TP VALUES (101, 1, 11938000, 0, 27500);'
        ].join('\n');
        var resS = cp.spawnSync(SQLITE_BIN, [satPath], { input: satSql, encoding: 'utf8' });
        assert.equal(resS.status, 0, 'init sat: ' + resS.stderr);
    }

    if (!opts.skipIpsrv) {
        var ipSql = [
            "PRAGMA encoding = 'UTF-16le';",
            'PRAGMA user_version = ' + schemaVer + ';',
            'CREATE TABLE CHNL (chId INTEGER PRIMARY KEY, chNum INTEGER);',
            'CREATE TABLE SRV (srvId INTEGER PRIMARY KEY, chId INTEGER, major INTEGER, srvName TEXT, srvType INTEGER, elim INTEGER, hidden INTEGER, hideGuide INTEGER, numSel INTEGER, modifiedByUser INTEGER);',
            // Include channel #5 (colliding major with dvbs #5!) and #4001/#4002 TV Plus channels
            "INSERT INTO SRV VALUES (9001, 1, 5, CAST(X'" + enc('TV Plus Five') + "' AS TEXT), -1, 0, 0, 0, 1, 0);",
            "INSERT INTO SRV VALUES (9002, 2, 4001, CAST(X'" + enc('News Live') + "' AS TEXT), -1, 0, 0, 0, 1, 0);",
            "INSERT INTO SRV VALUES (9003, 3, 4002, CAST(X'" + enc('Movies Now') + "' AS TEXT), -1, 0, 0, 0, 1, 0);"
        ].join('\n');
        var resI = cp.spawnSync(SQLITE_BIN, [ipsrvPath], { input: ipSql, encoding: 'utf8' });
        assert.equal(resI.status, 0, 'init ipsrv: ' + resI.stderr);
    }

    return { dvbsPath: dvbsPath, satPath: satPath, ipsrvPath: ipsrvPath };
}

function queryScalar(dbPath, sql) {
    var r = cp.execFileSync(SQLITE_BIN, [dbPath, sql], { encoding: 'utf8' });
    return r.trim();
}

function unwrapCmd(cmd) {
    var m = /^echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh$/.exec(cmd);
    if (m) {
        return Buffer.from(m[1], 'base64').toString('utf8');
    }
    return cmd;
}

// Execute shell commands generated by index.js against REAL sqlite3 CLI across Windows & Linux.
function createRealSqliteExecutor(customHandler) {
    var log = [];
    function extractQuotedVar(cmd, varName) {
        var re = new RegExp(varName + "='((?:[^']|'\\\\''|\\\\')*)'");
        var m = re.exec(cmd);
        if (!m) return '';
        return m[1].replace(/'\\''/g, "'");
    }
    function runSqliteSchema(dbPath) {
        if (!dbPath || !fs.existsSync(dbPath)) {
            return { exit_code: 2, stdout: '__MISSING__=1\n', stderr: '' };
        }
        var intRes = cp.spawnSync(SQLITE_BIN, [dbPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' });
        if (intRes.status !== 0) {
            return {
                exit_code: 0,
                stdout: '__INTEGRITY__=corrupt\n__VERSION__=0\n',
                stderr: intRes.stderr || ''
            };
        }
        var verRes = cp.spawnSync(SQLITE_BIN, [dbPath, 'PRAGMA user_version;'], { encoding: 'utf8' });
        var tblRes = cp.spawnSync(SQLITE_BIN, [dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"], { encoding: 'utf8' });
        var lines = [
            '__INTEGRITY__=' + String(intRes.stdout || '').replace(/\s+/g, ' ').trim(),
            '__VERSION__=' + (String(verRes.stdout || '0').trim() || '0')
        ];
        var tbls = String(tblRes.stdout || '').split(/\r?\n/);
        for (var i = 0; i < tbls.length; i++) {
            var t = tbls[i].trim();
            if (!t) continue;
            if (!/^[A-Za-z0-9_]+$/.test(t)) {
                lines.push('__BAD_TABLE__=' + t);
            } else {
                lines.push('__TABLE__=' + t);
                var infoRes = cp.spawnSync(SQLITE_BIN, [dbPath, 'PRAGMA table_info(' + t + ');'], { encoding: 'utf8' });
                lines.push(String(infoRes.stdout || '').trimEnd());
            }
        }
        return { exit_code: 0, stdout: lines.join('\n') + '\n', stderr: '' };
    }

    function execute(cmd, timeoutMs) {
        var script = unwrapCmd(cmd);
        log.push({ cmd: cmd, script: script, timeoutMs: timeoutMs });
        if (typeof customHandler === 'function') {
            var custom = customHandler(script, timeoutMs, {
                SQLITE_BIN: SQLITE_BIN,
                extractQuotedVar: extractQuotedVar,
                runSqliteSchema: runSqliteSchema
            });
            if (custom !== undefined) {
                return Promise.resolve(custom);
            }
        }

        // 1. Direct queryChannelsForEdit: sqlite3 -bail 'db' 'sql' </dev/null
        var directMatch = /^sqlite3 -bail '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'(?: <\/dev\/null)?$/.exec(script);
        if (directMatch) {
            var dDb = directMatch[1].replace(/'\\''/g, "'");
            var dSql = directMatch[2].replace(/'\\''/g, "'");
            var dRes = cp.spawnSync(SQLITE_BIN, ['-bail', dDb, dSql], { encoding: 'utf8' });
            return Promise.resolve({
                exit_code: dRes.status == null ? 1 : dRes.status,
                stdout: String(dRes.stdout || '').replace(/\r\n/g, '\n'),
                stderr: dRes.stderr || ''
            });
        }

        // 2. runSqlFile inline here-doc: sqlite3 -bail 'db' <<'__VETRO_SQL_...__'\n...\n__VETRO_SQL_...__
        var hereMatch = /^sqlite3 -bail '((?:[^']|'\\'')*)' <<'(__VETRO_SQL_[0-9a-f]+__)'\n([\s\S]*?)\n\2\n?$/.exec(script);
        if (hereMatch) {
            var fDb = hereMatch[1].replace(/'\\''/g, "'");
            var sqlText = hereMatch[3];
            var fRes = cp.spawnSync(SQLITE_BIN, ['-bail', fDb], { input: sqlText, encoding: 'utf8' });
            return Promise.resolve({
                exit_code: fRes.status == null ? 1 : fRes.status,
                stdout: String(fRes.stdout || '').replace(/\r\n/g, '\n'),
                stderr: fRes.stderr || ''
            });
        }

        // 3. queryDatabase dvbs+sat or ipsrv wrapped via wrapSh
        if (script.indexOf('echo "__NO_DB__"; exit 0;') >= 0) {
            var dbPath = extractQuotedVar(script, 'DB');
            var satPath = extractQuotedVar(script, 'SAT');
            if (!fs.existsSync(dbPath)) {
                return Promise.resolve({ exit_code: 0, stdout: '__NO_DB__\n', stderr: '' });
            }
            var sqlMatches = [];
            var reSql = /sqlite3 -bail "\$[A-Z]+" '((?:[^']|'\\'')*)'/g;
            var sm;
            while ((sm = reSql.exec(script)) !== null) {
                sqlMatches.push(sm[1].replace(/'\\''/g, "'"));
            }
            var chosenSql = sqlMatches.length > 1 && !fs.existsSync(satPath) ? sqlMatches[1] : sqlMatches[0];
            var qRes = cp.spawnSync(SQLITE_BIN, ['-bail', dbPath, chosenSql], { encoding: 'utf8' });
            return Promise.resolve({
                exit_code: qRes.status == null ? 1 : qRes.status,
                stdout: String(qRes.stdout || '').replace(/\r\n/g, '\n'),
                stderr: qRes.stderr || ''
            });
        }

        // 4. inspectDbSchema wrapped via wrapSh
        if (script.indexOf('echo "__MISSING__=1"; exit 2;') >= 0) {
            var sDb = extractQuotedVar(script, 'DB');
            return Promise.resolve(runSqliteSchema(sDb));
        }

        // 5. savePreEditBackup: sqlite3 .backup + inline meta here-doc + atomic swap into backup/pre-edit
        if (script.indexOf('BACKUP_SQLITE_FAILED_') >= 0) {
            var unBak = script;
            var bDataDir = extractQuotedVar(unBak, 'DATA_DIR');
            var bBase = extractQuotedVar(unBak, 'BACKUP_BASE');
            var bSlot = extractQuotedVar(unBak, 'SLOT_DIR');
            var forM = /for f in ([^;]+); do/.exec(unBak);
            var targets = forM ? forM[1].trim().split(/\s+/).map(function (x) { return x.replace(/'/g, ''); }) : [];
            var existing = targets.filter(function (f) { return fs.existsSync(path.join(bDataDir, f)); });
            if (existing.length === 0) {
                return Promise.resolve({ exit_code: 0, stdout: 'BACKUP_SKIP\n', stderr: '' });
            }
            fs.mkdirSync(bBase, { recursive: true });
            var newDir = bSlot + '.new';
            var oldDir = bSlot + '.old';
            try { fs.rmSync(newDir, { recursive: true, force: true }); } catch (e) { }
            try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (e) { }
            fs.mkdirSync(newDir, { recursive: true });
            for (var bi = 0; bi < existing.length; bi++) {
                var fname = existing[bi];
                var bkRes = cp.spawnSync(SQLITE_BIN, ['-bail', path.join(bDataDir, fname), ".backup '" + sqlForward(path.join(newDir, fname)) + "'"], { encoding: 'utf8' });
                if (bkRes.status !== 0) {
                    try { fs.rmSync(newDir, { recursive: true, force: true }); } catch (e) { }
                    return Promise.resolve({ exit_code: 13, stdout: 'BACKUP_SQLITE_FAILED_' + fname + '\n', stderr: bkRes.stderr || '' });
                }
            }
            var metaMatch = /cat <<'(__VETRO_META_[0-9a-f]+__)' > "\$NEW_DIR\/backup-meta\.json"[^\n]*\n([\s\S]*?)\n\1/.exec(unBak);
            assert.ok(metaMatch, 'savePreEditBackup must write backup-meta.json via inline here-document');
            fs.writeFileSync(path.join(newDir, 'backup-meta.json'), metaMatch[2], 'utf8');
            if (fs.existsSync(bSlot)) fs.renameSync(bSlot, oldDir);
            fs.renameSync(newDir, bSlot);
            try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (e) { }
            return Promise.resolve({ exit_code: 0, stdout: 'BACKUP_OK\n', stderr: '' });
        }

        return Promise.resolve({ exit_code: 0, stdout: 'OK\n', stderr: '' });
    }

    return { execute: execute, log: log };
}

function invokeRoute(plugin, opts) {
    return new Promise(function (resolve) {
        var req = new stream.PassThrough();
        req.method = opts.method || 'GET';
        req.url = opts.url || ('/' + opts.sub);
        req.headers = opts.headers || {};

        var statusCode = 200;
        var resHeaders = {};
        var chunks = [];
        var finished = false;
        var listeners = { finish: [], close: [] };

        var res = {
            headersSent: false,
            writableEnded: false,
            finished: false,
            writeHead: function (code, hdrs) {
                statusCode = code;
                this.headersSent = true;
                if (hdrs) {
                    var ks = Object.keys(hdrs);
                    for (var i = 0; i < ks.length; i++) {
                        resHeaders[ks[i].toLowerCase()] = hdrs[ks[i]];
                    }
                }
            },
            setHeader: function (k, v) { resHeaders[String(k).toLowerCase()] = v; },
            write: function (chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
            once: function (ev, fn) { if (listeners[ev]) listeners[ev].push(fn); },
            on: function (ev, fn) { if (listeners[ev]) listeners[ev].push(fn); },
            removeListener: function () { },
            emit: function () { },
            end: function (chunk) {
                if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                if (finished) return;
                finished = true;
                this.writableEnded = true;
                this.finished = true;
                var finishListeners = listeners.finish.slice();
                for (var fi = 0; fi < finishListeners.length; fi++) finishListeners[fi]();
                var raw = Buffer.concat(chunks).toString('utf8');
                var json = null;
                try { json = JSON.parse(raw); } catch (e) { }
                resolve({ handled: true, status: statusCode, headers: resHeaders, body: raw, json: json });
            }
        };

        var handled = plugin.route(req, res, opts.sub);
        if (!handled) {
            resolve({ handled: false, status: 404, headers: resHeaders, body: '', json: null });
            return;
        }

        if (opts.body !== undefined) {
            process.nextTick(function () {
                var buf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
                req.end(buf);
            });
        } else if (req.method === 'POST' && !opts.manualStream) {
            process.nextTick(function () {
                req.end();
            });
        }
    });
}

// ==================== 1. PURE UNIT HELPERS ====================

test('wrapSh encodes scripts via quote-free base64 pipeline', function () {
    var raw = "DB='/mnt/a b'\''c'; sqlite3 -bail \"$DB\" \"SELECT '';\" </dev/null";
    var wrapped = internals.wrapSh(raw);
    assert.match(wrapped, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    assert.equal(wrapped.indexOf("'"), -1);
    assert.equal(wrapped.indexOf('\\'), -1);
    assert.equal(unwrapCmd(wrapped), raw);
});

test('ALLOWED_KEYS blocks prototype properties and deprecated keys', function () {
    assert.equal(Object.getPrototypeOf(internals.ALLOWED_KEYS), null);
    assert.equal(internals.ALLOWED_KEYS.vol_up, 'XF86AudioRaiseVolume');
    assert.equal(internals.ALLOWED_KEYS.mute, 'XF86AudioMute');
    assert.equal(internals.ALLOWED_KEYS.exit, 'XF86Exit');
    assert.equal(internals.ALLOWED_KEYS.constructor, undefined);
    assert.equal(internals.ALLOWED_KEYS.toString, undefined);
    assert.equal(internals.ALLOWED_KEYS.__proto__, undefined);
    assert.equal(internals.ALLOWED_KEYS.Return, undefined);
    assert.equal(internals.ALLOWED_KEYS.Up, undefined);
});

test('parseUnzipList enforces limits, traversal checks, and DB allow-list', function () {
    var okOut = [
        'Archive:  /tmp/Channel_list_backup.zip',
        '  Length      Date    Time    Name',
        '---------  ---------- -----   ----',
        '   131072  2026-01-01 12:00   dvbs',
        '    16384  2026-01-01 12:00   sat',
        '      256  2026-01-01 12:00   metadata.xml',
        '     4096  2026-01-01 12:00   extra.bin',
        '---------                     -------',
        '   151808                     4 files'
    ].join('\n');
    var parsed = internals.parseUnzipList(okOut);
    assert.equal(parsed.error, undefined);
    assert.deepEqual(parsed.dbFiles, ['dvbs', 'sat']);
    assert.deepEqual(parsed.extractFiles, ['dvbs', 'sat', 'metadata.xml']);

    var tooBigOut = [
        'Archive:  x.zip',
        ' 34000000  2026-01-01 12:00   dvbs'
    ].join('\n');
    assert.match(internals.parseUnzipList(tooBigOut).error, /32 MB/i);

    var manyLines = [];
    for (var i = 0; i < 51; i++) {
        manyLines.push('      100  2026-01-01 12:00   f' + i);
    }
    assert.match(internals.parseUnzipList(manyLines.join('\n')).error, /too many entries/i);

    assert.match(internals.parseUnzipList('  100  2026-01-01 12:00   ../dvbs').error, /Unsafe/i);
    assert.match(internals.parseUnzipList('  100  2026-01-01 12:00   /tmp/dvbs').error, /Unsafe/i);
    assert.match(internals.parseUnzipList('  100  2026-01-01 12:00   metadata.xml').error, /No channel databases/i);
});

test('parseSrvIdList, encodeUtf16Hex, metadata/model parsers, and planDeleteAndCompact', function () {
    assert.deepEqual(internals.parseSrvIdList(['5', -900719925474099, '5', 'abc; DROP']), ['5', '-900719925474099']);
    var hex = internals.encodeUtf16Hex('Al Jazeera 4K');
    assert.ok(/^[0-9a-f]+$/.test(hex));
    assert.equal(internals.extractZipModelPrefix('Channel_list_T-KTSU2DEUC-1012.3.zip'), 'T-KTSU2DEUC');
    assert.equal(internals.extractZipModelPrefix('Channel_list_backup.zip'), '');

    var channels = [
        { srvId: '1', major: 1, srvType: 1, hidden: false },
        { srvId: '5', major: 2, srvType: 1, hidden: false },
        { srvId: '5001', major: 5, srvType: 1, hidden: false },
        { srvId: '104', major: 4, srvType: 1, hidden: true },
        { srvId: '201', major: 10, srvType: 2, hidden: false }
    ];
    // Deleting srvId='5' must NOT delete srvId='5001' even though major===5!
    var noCompact = internals.planDeleteAndCompact(channels, { '5': true }, { allowCompact: true, compact: false });
    assert.deepEqual(noCompact.toDelete.map(function (c) { return c.srvId; }), ['5']);
    assert.deepEqual(noCompact.changes, []);

    var withCompact = internals.planDeleteAndCompact(channels, { '5': true }, { allowCompact: true, compact: true });
    assert.deepEqual(withCompact.toDelete.map(function (c) { return c.srvId; }), ['5']);
    // Only visible TV channel 5001 moves from #5 -> #2; hidden #4 and radio #10 do not move!
    assert.deepEqual(withCompact.changes, [{ srvId: '5001', oldMajor: 5, newMajor: 2 }]);
});

// ==================== 2. REAL SQLITE DB OPERATIONS ====================

test('queryDatabase reads real dvbs/sat/ipsrv, skips missing optional DBs, and fails 500 on corrupt DB', async function (t) {
    var env = createTempEnv(t);
    var dbs = createTvDatabases(env.dataDir);
    var exec = createRealSqliteExecutor();
    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: env.tmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    var listRes = await invokeRoute(p, { method: 'GET', sub: 'list?refresh=1' });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.json.ok, true);
    assert.equal(listRes.json.pendingReload, false);

    var byKey = {};
    for (var i = 0; i < listRes.json.channels.length; i++) {
        var ch = listRes.json.channels[i];
        byKey[ch.type + ':' + ch.srvId] = ch;
    }
    assert.equal(byKey['dvbs:101'].name, 'Alpha TV');
    assert.equal(byKey['dvbs:101'].freq, 11747);
    assert.equal(byKey['dvbs:101'].pol, 'V');
    assert.equal(byKey['dvbs:101'].sat, 'Nilesat');
    assert.equal(byKey['dvbs:199'], undefined, 'elim=1 row must not be listed');
    assert.equal(byKey['dvbs:-900719925474099'].num, 6);
    assert.equal(byKey['dvbs:201'].category, 'radio');
    assert.equal(byKey['dvbs:301'].category, 'data');
    assert.equal(byKey['iptv:9001'].name, 'TV Plus Five');

    // Missing ipsrv is non-fatal
    fs.unlinkSync(dbs.ipsrvPath);
    var noIpRes = await invokeRoute(p, { method: 'GET', sub: 'list?refresh=1' });
    assert.equal(noIpRes.status, 200);
    assert.ok(noIpRes.json.channels.every(function (c) { return c.type === 'dvbs'; }));

    // Corrupt dvbs fails HTTP 500 instead of silently returning []
    fs.writeFileSync(dbs.dvbsPath, 'NOT_A_VALID_SQLITE_DATABASE');
    var badRes = await invokeRoute(p, { method: 'GET', sub: 'list?refresh=1' });
    assert.equal(badRes.status, 500);
    assert.equal(badRes.json.ok, false);
});

test('delete isolates srvId vs major, scopes compaction to TV category, leaves ipsrv untouched, and writes pre-edit backup', async function (t) {
    var env = createTempEnv(t);
    var dbs = createTvDatabases(env.dataDir);
    // Pre-seed pre-import backup slot to prove edits do NOT overwrite pre-import!
    var preImpDir = path.join(env.pluginDir, 'backup', 'pre-import');
    fs.mkdirSync(preImpDir, { recursive: true });
    fs.writeFileSync(path.join(preImpDir, 'dvbs'), 'PRE_IMPORT_SENTINEL');

    var exec = createRealSqliteExecutor();
    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: env.tmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    // Delete srvId="5" (major=2) WITHOUT compaction first? Wait: test with compaction=true!
    var delRes = await invokeRoute(p, {
        method: 'POST',
        sub: 'edit',
        body: { action: 'delete', dvbsSrvIds: ['5'], ipsrvSrvIds: [], compact: true }
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.json.ok, true);
    assert.equal(delRes.json.deleted, 1);
    assert.equal(delRes.json.pendingReload, true);

    // Check real dvbs SQLite state:
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT elim FROM SRV WHERE srvId = 5;'), '1');
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT elim, major FROM SRV WHERE srvId = 5001;'), '0|3', 'Delta Five (srvId=5001, major=5) was NOT mistakenly deleted and compacted TV #5->#3');
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT major FROM SRV WHERE srvId = 104;'), '4', 'hidden TV channel #4 preserved');
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT major FROM SRV WHERE srvId = 201;'), '10', 'Radio #10 preserved');
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT major FROM SRV WHERE srvId = 301;'), '20', 'Data #20 preserved');
    assert.equal(queryScalar(dbs.ipsrvPath, 'SELECT major FROM SRV WHERE srvId = 9002;'), '4001', 'ipsrv #4001 preserved');

    // Verify pre-edit backup via real sqlite3 .backup preserved Beta HD (elim=0) and pre-import stayed intact
    var preEditDvbs = path.join(env.pluginDir, 'backup', 'pre-edit', 'dvbs');
    assert.equal(fs.existsSync(preEditDvbs), true);
    assert.equal(queryScalar(preEditDvbs, 'SELECT elim, major FROM SRV WHERE srvId = 5;'), '0|2');
    assert.equal(fs.readFileSync(path.join(preImpDir, 'dvbs'), 'utf8'), 'PRE_IMPORT_SENTINEL');

    // Also test backup-status endpoint reports both slots
    var bakStat = await invokeRoute(p, { method: 'GET', sub: 'backup-status' });
    assert.equal(bakStat.status, 200);
    assert.equal(bakStat.json.preEdit.available, true);
    assert.equal(bakStat.json.preImport.available, true);
});

test('B3: multi-DB delete and hide use atomic ATTACH transaction and roll back dvbs if ipsrv fails', async function (t) {
    var env = createTempEnv(t);
    var dbs = createTvDatabases(env.dataDir);
    var exec = createRealSqliteExecutor();
    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: env.tmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    // Happy path: delete spanning dvbs (srvId=103) AND ipsrv (srvId=9002)
    var okDel = await invokeRoute(p, {
        method: 'POST',
        sub: 'edit',
        body: { action: 'delete', dvbsSrvIds: ['103'], ipsrvSrvIds: ['9002'], compact: false }
    });
    assert.equal(okDel.status, 200);
    assert.equal(okDel.json.deleted, 2);
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT elim FROM SRV WHERE srvId = 103;'), '1');
    assert.equal(queryScalar(dbs.ipsrvPath, 'SELECT elim FROM SRV WHERE srvId = 9002;'), '1');

    // Failure path B3: break ipsrv table so ATTACH transaction fails on second DB -> dvbs MUST roll back!
    cp.execFileSync(SQLITE_BIN, [dbs.ipsrvPath, 'DROP TABLE SRV; CREATE TABLE WRONG_TBL (id INT);']);

    // Multi-DB hide targeting dvbs srvId=101 + ipsrv srvId=9003
    var failHide = await invokeRoute(p, {
        method: 'POST',
        sub: 'edit',
        body: { action: 'hide', dvbsSrvIds: ['101'], ipsrvSrvIds: ['9003'] }
    });
    assert.equal(failHide.status, 500);
    assert.equal(failHide.json.ok, false);
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT hidden FROM SRV WHERE srvId = 101;'), '0', 'dvbs rolled back cleanly on ipsrv hide error');

    // Now break ipsrv only after queryChannelsForEdit would run? Instead test cross-DB delete rollback cleanly
    // by restoring ipsrv SRV table WITHOUT hideGuide column so queryChannelsForEdit passes, then UPDATE fails!
    cp.execFileSync(SQLITE_BIN, [dbs.ipsrvPath, 'DROP TABLE WRONG_TBL; CREATE TABLE SRV (srvId INTEGER PRIMARY KEY, chId INTEGER, major INTEGER, srvName TEXT, srvType INTEGER, elim INTEGER, hidden INTEGER); INSERT INTO SRV VALUES (9003, 3, 4002, "X", -1, 0, 0);']);

    var failDel = await invokeRoute(p, {
        method: 'POST',
        sub: 'edit',
        body: { action: 'delete', dvbsSrvIds: ['101'], ipsrvSrvIds: ['9003'], compact: false }
    });
    assert.equal(failDel.status, 500);
    assert.equal(failDel.json.ok, false);
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT elim FROM SRV WHERE srvId = 101;'), '0', 'dvbs rolled back atomically when ipsrv DELETE/UPDATE failed inside ATTACH transaction');

    // Lock must be released after SQLite error
    var pingRes = await invokeRoute(p, { method: 'GET', sub: 'backup-status' });
    assert.equal(pingRes.status, 200);
});

test('move, hide/unhide, and rename target strictly srvId + elim=0 with validation and pre-edit backup', async function (t) {
    var env = createTempEnv(t);
    var dbs = createTvDatabases(env.dataDir);
    var exec = createRealSqliteExecutor();
    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: env.tmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    // Rename validation: >60 chars and control chars rejected; empty rejected; srvId=199 (elim=1) untouched when srvId=101 renamed
    var longName = new Array(62).join('A');
    assert.equal((await invokeRoute(p, { method: 'POST', sub: 'edit', body: { action: 'rename', type: 'dvbs', srvId: '101', name: longName } })).status, 400);
    assert.equal((await invokeRoute(p, { method: 'POST', sub: 'edit', body: { action: 'rename', type: 'dvbs', srvId: '101', name: 'Bad\nName' } })).status, 400);

    // Rename ipsrv srvId=9001 (#5) leaves dvbs srvId=5001 (#5) untouched!
    var renIp = await invokeRoute(p, {
        method: 'POST',
        sub: 'edit',
        body: { action: 'rename', type: 'ipsrv', srvId: '9001', name: 'TV Plus Renamed' }
    });
    assert.equal(renIp.status, 200);
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT HEX(srvName) FROM SRV WHERE srvId = 5001;'), internals.encodeUtf16Hex('Delta Five').toUpperCase());
    assert.equal(queryScalar(dbs.ipsrvPath, 'SELECT HEX(srvName) FROM SRV WHERE srvId = 9001;'), internals.encodeUtf16Hex('TV Plus Renamed').toUpperCase());

    // Unhide dvbs srvId=101 does NOT unhide elim=1 srvId=199 sharing major=1
    var hideRes = await invokeRoute(p, {
        method: 'POST',
        sub: 'edit',
        body: { action: 'hide', dvbsSrvIds: ['101'], ipsrvSrvIds: [] }
    });
    assert.equal(hideRes.status, 200);
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT hidden FROM SRV WHERE srvId = 101;'), '1');
    var unhideRes = await invokeRoute(p, {
        method: 'POST',
        sub: 'edit',
        body: { action: 'unhide', dvbsSrvIds: ['101'], ipsrvSrvIds: [] }
    });
    assert.equal(unhideRes.status, 200);
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT hidden FROM SRV WHERE srvId = 199;'), '1', 'elim=1 row stays untouched');

    // Cross-category move (TV + Radio) rejected
    var badMove = await invokeRoute(p, {
        method: 'POST',
        sub: 'edit',
        body: { action: 'move', type: 'dvbs', srvIds: ['101', '201'], target: 3 }
    });
    assert.equal(badMove.status, 400);

    // Move Gamma TV (#3, srvId=103) to #1 + verify pre-edit snapshot saved #3 before move
    var okMove = await invokeRoute(p, {
        method: 'POST',
        sub: 'edit',
        body: { action: 'move', type: 'dvbs', srvIds: ['103'], target: 1 }
    });
    assert.equal(okMove.status, 200);
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT major FROM SRV WHERE srvId = 103;'), '1');
    assert.equal(queryScalar(dbs.dvbsPath, 'SELECT major FROM SRV WHERE srvId = 101;'), '2');
    var bakMoveDvbs = path.join(env.pluginDir, 'backup', 'pre-edit', 'dvbs');
    assert.equal(queryScalar(bakMoveDvbs, 'SELECT major FROM SRV WHERE srvId = 103;'), '3');
});

test('real SQLite inspectDbSchema and validateDbSchema detect corruption, schema drift, and user_version mismatch', async function (t) {
    var env = createTempEnv(t);
    var dbs = createTvDatabases(env.dataDir, { userVersion: 7 });
    var impDir = path.join(env.root, 'imported');
    fs.mkdirSync(impDir, { recursive: true });
    var impDbs = createTvDatabases(impDir, { userVersion: 7 });

    var exec = createRealSqliteExecutor();
    var mockCtx = { execute: exec.execute };

    var liveDvbsSchema = await internals.inspectDbSchema(mockCtx, dbs.dvbsPath);
    var impDvbsSchema = await internals.inspectDbSchema(mockCtx, impDbs.dvbsPath);
    assert.equal(internals.validateDbSchema('dvbs', impDvbsSchema, liveDvbsSchema), null);

    // Extra table or missing column fails live schema match
    cp.execFileSync(SQLITE_BIN, [impDbs.dvbsPath, 'CREATE TABLE EXTRA(id INT);']);
    var driftSchema = await internals.inspectDbSchema(mockCtx, impDbs.dvbsPath);
    assert.match(internals.validateDbSchema('dvbs', driftSchema, liveDvbsSchema), /table list mismatch/i);

    // PRAGMA user_version mismatch
    cp.execFileSync(SQLITE_BIN, [impDbs.satPath, 'PRAGMA user_version = 99;']);
    var liveSat = await internals.inspectDbSchema(mockCtx, dbs.satPath);
    var badVerSat = await internals.inspectDbSchema(mockCtx, impDbs.satPath);
    assert.match(internals.validateDbSchema('sat', badVerSat, liveSat), /user_version mismatch/i);

    // Baseline check with liveSchema = null succeeds for valid DB even if columns differ from TV drift
    assert.equal(internals.validateDbSchema('sat', badVerSat, null), null);

    // Corrupt file fails integrity_check
    fs.writeFileSync(impDbs.dvbsPath, 'CORRUPT');
    var corruptSchema = await internals.inspectDbSchema(mockCtx, impDbs.dvbsPath);
    assert.match(internals.validateDbSchema('dvbs', corruptSchema, liveDvbsSchema), /integrity_check failed/i);
});

// ==================== 3. B1 UPLOAD LIFECYCLE, IMPORT PHASES & RESTORE ====================

function createRouteHttpServer(plugin, t) {
    var server = http.createServer(function (req, res) {
        var sub = req.url.replace(/^\/+/, '');
        if (!plugin.route(req, res, sub)) {
            res.writeHead(404);
            res.end('Not found');
        }
    });
    return new Promise(function (resolve) {
        server.listen(0, '127.0.0.1', function () {
            var addr = server.address();
            if (t && typeof t.after === 'function') {
                t.after(function () {
                    try { server.close(); } catch (e) { }
                });
            }
            resolve({ server: server, port: addr.port });
        });
    });
}

test('B1: >15 MB upload (header + streamed) and client abort always release dbBusy and unlink temp zip', async function (t) {
    var env = createTempEnv(t);
    var exec = createRealSqliteExecutor();
    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: env.tmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    var srv = await createRouteHttpServer(p, t);

    // 1. Over 15 MB declared Content-Length -> immediate 413
    var overLenRes = await invokeRoute(p, {
        method: 'POST',
        sub: 'import',
        headers: { 'content-length': String(16 * 1024 * 1024), 'x-upload-filename': 'Channel_list_test.zip' },
        manualStream: true
    });
    assert.equal(overLenRes.status, 413);
    assert.equal(overLenRes.headers['connection'], 'close');
    assert.equal(fs.readdirSync(env.tmpDir).filter(function (n) { return n.indexOf('ch_up_') === 0; }).length, 0);

    // Lock must be free
    var r1 = await invokeRoute(p, { method: 'POST', sub: 'reload', body: '{}' });
    assert.equal(r1.status, 200);

    // 2. Chunked stream >15 MB WITHOUT Content-Length over real HTTP loopback socket -> 413 + dbBusy released!
    var bigResult = await new Promise(function (resolve, reject) {
        var req = http.request({
            hostname: '127.0.0.1',
            port: srv.port,
            path: '/import',
            method: 'POST',
            headers: { 'x-upload-filename': 'big.zip' }
        }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
            });
        });
        req.on('error', function (err) {
            // Destroyed socket after 413 may emit ECONNRESET if not yet finished reading
            reject(err);
        });
        var chunk = Buffer.alloc(1024 * 1024, 0x41);
        for (var c = 0; c < 17; c++) {
            if (!req.destroyed) req.write(chunk);
        }
        if (!req.destroyed) req.end();
    }).catch(function (err) {
        return { error: err };
    });
    if (!bigResult.error) {
        assert.equal(bigResult.status, 413);
    }
    // Give outStream close event a tick to finish unlinking
    await new Promise(function (r) { setTimeout(r, 80); });
    assert.equal(fs.readdirSync(env.tmpDir).filter(function (n) { return n.indexOf('ch_up_') === 0; }).length, 0);
    var r2 = await invokeRoute(p, { method: 'POST', sub: 'reload', body: '{}' });
    assert.equal(r2.status, 200, 'dbBusy must NOT remain stuck at 409 after >15 MB upload');

    // 3. Aborted upload mid-flight over HTTP socket -> releases dbBusy and removes partial temp file
    await new Promise(function (resolve) {
        var req = http.request({
            hostname: '127.0.0.1',
            port: srv.port,
            path: '/import',
            method: 'POST',
            headers: { 'x-upload-filename': 'aborted.zip', 'content-length': '2097152' }
        });
        req.on('error', function () { resolve(); });
        req.on('close', function () { resolve(); });
        req.write(Buffer.alloc(65536, 0x42));
        setTimeout(function () { req.destroy(); }, 30);
    });
    await new Promise(function (r) { setTimeout(r, 80); });
    assert.equal(fs.readdirSync(env.tmpDir).filter(function (n) { return n.indexOf('ch_up_') === 0; }).length, 0);
    var r3 = await invokeRoute(p, { method: 'POST', sub: 'reload', body: '{}' });
    assert.equal(r3.status, 200, 'dbBusy must be released after client abort');
});

test('two-phase import stages mismatches for explicit confirmation, cleans on cancel, and Phase 2 swap protects live DBs', async function (t) {
    var env = createTempEnv(t);
    createTvDatabases(env.dataDir, { userVersion: 7 });
    var stagedSource = path.join(env.root, 'zip_src');
    fs.mkdirSync(stagedSource, { recursive: true });
    createTvDatabases(stagedSource, { userVersion: 7 });

    var phase2Scripts = [];
    var exec = createRealSqliteExecutor(function (cmd, timeoutMs, helpers) {
        if (cmd.indexOf('/usr/bin/unzip -l') >= 0) {
            return {
                exit_code: 0,
                stdout: '__LIST_START__\n  131072  2026-01-01 12:00   dvbs\n  16384  2026-01-01 12:00   sat\n    256  2026-01-01 12:00   metadata.xml\n__LIST_END__\n',
                stderr: ''
            };
        }
        if (cmd.indexOf('/usr/bin/unzip -o -q') >= 0) {
            var upZip = helpers.extractQuotedVar(cmd, 'UP');
            var tDir = helpers.extractQuotedVar(cmd, 'TMP');
            fs.mkdirSync(tDir, { recursive: true });
            fs.copyFileSync(path.join(stagedSource, 'dvbs'), path.join(tDir, 'dvbs'));
            fs.copyFileSync(path.join(stagedSource, 'sat'), path.join(tDir, 'sat'));
            try { if (fs.existsSync(upZip)) fs.unlinkSync(upZip); } catch (e) { }
            return {
                exit_code: 0,
                stdout: [
                    '__DBS__= dvbs sat',
                    '__IMP_META_START__',
                    '<METADATA><ANALOG_COUNTRY>48</ANALOG_COUNTRY><DIGITAL_COUNTRY>5198920</DIGITAL_COUNTRY></METADATA>',
                    '__IMP_META_END__',
                    '__TV_META_START__',
                    '<METADATA><ANALOG_COUNTRY>12</ANALOG_COUNTRY><DIGITAL_COUNTRY>9999999</DIGITAL_COUNTRY></METADATA>',
                    '__TV_META_END__',
                    '__PRD_START__',
                    'Model=UE55AU7100;',
                    '__PRD_END__'
                ].join('\n'),
                stderr: ''
            };
        }
        if (cmd.indexOf('COPY_ROLLED_BACK') >= 0) {
            phase2Scripts.push(cmd);
            return { exit_code: 0, stdout: 'SUCCESS\n', stderr: '' };
        }
        return undefined;
    });

    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: env.tmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    // Upload archive whose metadata + filename model differ -> Phase 1 returns needsConfirm without stopping daemon
    var up1 = await invokeRoute(p, {
        method: 'POST',
        sub: 'import',
        url: '/import?name=' + encodeURIComponent('Channel_list_T-MISMATCH-1000.zip'),
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('PK_FAKE_ZIP')
    });
    assert.equal(up1.status, 200);
    assert.equal(up1.json.needsConfirm, true);
    assert.ok(up1.json.confirmToken);
    assert.equal(up1.json.warnings.length, 2);
    assert.equal(phase2Scripts.length, 0, 'daemon must NOT be stopped during Phase 1');

    // Cancel discards staged directory
    var stagedDirsBefore = fs.readdirSync(env.tmpDir).filter(function (n) { return n.indexOf('ch_imp_') === 0; });
    assert.equal(stagedDirsBefore.length, 1);
    var cancelRes = await invokeRoute(p, {
        method: 'POST',
        sub: 'import-cancel',
        body: { confirmToken: up1.json.confirmToken }
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(fs.readdirSync(env.tmpDir).filter(function (n) { return n.indexOf('ch_imp_') === 0; }).length, 0);

    // Upload again and confirm -> triggers Phase 2 swap
    var up2 = await invokeRoute(p, {
        method: 'POST',
        sub: 'import',
        url: '/import?name=' + encodeURIComponent('Channel_list_T-MISMATCH-1000.zip'),
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('PK_FAKE_ZIP')
    });
    assert.equal(up2.json.needsConfirm, true);

    var confRes = await invokeRoute(p, {
        method: 'POST',
        sub: 'import-confirm',
        body: { confirmToken: up2.json.confirmToken }
    });
    assert.equal(confRes.status, 200);
    assert.equal(confRes.json.ok, true);
    assert.equal(phase2Scripts.length, 1);

    // B4 script safety assertions on generated Phase 2 shell script
    var p2s = phase2Scripts[0];
    assert.ok(p2s.indexOf('systemctl stop "$UNIT"') >= 0);
    assert.ok(p2s.indexOf('trap cleanup_on_exit EXIT') >= 0);
    assert.ok(p2s.indexOf('backup/pre-import') >= 0 || p2s.indexOf('pre-import') >= 0);
    assert.ok(p2s.indexOf('metadata.xml') < 0, 'Phase 2 swap must NEVER overwrite TV metadata.xml');
    assert.ok(p2s.indexOf('change_source') < 0, 'Phase 2 swap must NEVER force TV input switch');
    assert.ok(p2s.indexOf('if [ ! -f "$BACKUP_DIR/$f" ]; then rm -f "$DATA_DIR/$f"; fi;') >= 0, 'rollback removes newly-introduced DBs');
    assert.equal(p2s.indexOf('0777'), -1, 'Phase 2 swap must never hardcode chmod 0777');
    assert.ok(p2s.indexOf("stat -c '%a'") >= 0 && p2s.indexOf('0644') >= 0, 'Phase 2 swap must preserve existing mode via stat with 0644 default');
    assert.ok(p2s.indexOf('mkdir -m 0700 "$SAFE_DIR"') >= 0 && p2s.indexOf('cp "$SAFE_DIR/$f" "$DATA_DIR/$f"') >= 0, 'Phase 2 swap must stage and copy from root-only 0700 SAFE_DIR');
    assert.ok(p2s.indexOf('STAGED_HASH_MISMATCH') >= 0 && p2s.indexOf('sha256sum "$SAFE_DIR/"') >= 0, 'Phase 2 swap must verify staged SHA-256 inside SAFE_DIR under flock');
    assert.ok(/cat <<'__VETRO_META_[0-9a-f]+__' > "\$BACKUP_NEW\/backup-meta\.json"/.test(p2s), 'Phase 2 swap writes backup-meta.json via inline here-document');
    assert.equal(fs.readdirSync(env.tmpDir).filter(function (n) { return n.indexOf('ch_bmeta_') === 0 || n.indexOf('ch_ebak_') === 0; }).length, 0);
});

test('B4: timed-out Phase 2 swap never deletes tmpDir from Node or spawns a competing restore', async function (t) {
    var env = createTempEnv(t);
    createTvDatabases(env.dataDir, { userVersion: 7 });
    var stagedSource = path.join(env.root, 'zip_src');
    fs.mkdirSync(stagedSource, { recursive: true });
    createTvDatabases(stagedSource, { userVersion: 7 });

    var afterTimeoutCalls = 0;
    var swapAttempted = false;
    var exec = createRealSqliteExecutor(function (cmd, timeoutMs, helpers) {
        if (cmd.indexOf('/usr/bin/unzip -l') >= 0) {
            return {
                exit_code: 0,
                stdout: '__LIST_START__\n  131072  2026-01-01 12:00   dvbs\n__LIST_END__\n',
                stderr: ''
            };
        }
        if (cmd.indexOf('/usr/bin/unzip -o -q') >= 0) {
            var upZip = helpers.extractQuotedVar(cmd, 'UP');
            var tDir = helpers.extractQuotedVar(cmd, 'TMP');
            fs.mkdirSync(tDir, { recursive: true });
            fs.copyFileSync(path.join(stagedSource, 'dvbs'), path.join(tDir, 'dvbs'));
            try { if (fs.existsSync(upZip)) fs.unlinkSync(upZip); } catch (e) { }
            return { exit_code: 0, stdout: '__DBS__= dvbs\n', stderr: '' };
        }
        if (cmd.indexOf('COPY_ROLLED_BACK') >= 0) {
            swapAttempted = true;
            return Promise.reject(new Error('Command timed out after 30000ms'));
        }
        if (swapAttempted) {
            afterTimeoutCalls++;
        }
        return undefined;
    });

    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: env.tmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    var res = await invokeRoute(p, {
        method: 'POST',
        sub: 'import',
        headers: { 'x-upload-filename': 'Channel_list_backup.zip' },
        body: Buffer.from('PK_FAKE')
    });
    assert.equal(res.status, 500);
    assert.match(res.json.error, /timed out/i);
    assert.equal(afterTimeoutCalls, 0, 'Node catch handler must NOT spawn a competing restore command after timeout');
    assert.equal(fs.readdirSync(env.tmpDir).filter(function (n) { return n.indexOf('ch_imp_') === 0; }).length, 1, 'Node must let the running shell EXIT trap clean up tmpDir');
});

test('POST api/restore-backup validates backup against baseline schema (ignores corrupt live DB) and selects slot', async function (t) {
    var env = createTempEnv(t);
    var dbs = createTvDatabases(env.dataDir, { userVersion: 7 });

    // Create valid pre-edit backup of dvbs, then CORRUPT the live dvbs on disk!
    var preEditDir = path.join(env.pluginDir, 'backup', 'pre-edit');
    fs.mkdirSync(preEditDir, { recursive: true });
    fs.copyFileSync(dbs.dvbsPath, path.join(preEditDir, 'dvbs'));
    fs.writeFileSync(path.join(preEditDir, 'backup-meta.json'), JSON.stringify({ createdAt: '2026-11-24T12:00:00Z', files: ['dvbs'] }));
    fs.writeFileSync(dbs.dvbsPath, 'CORRUPTED_LIVE_DB');

    var restoreScripts = [];
    var exec = createRealSqliteExecutor(function (cmd) {
        if (cmd.indexOf('RESTORE_ROLLED_BACK') >= 0) {
            restoreScripts.push(cmd);
            return { exit_code: 0, stdout: 'SUCCESS\n', stderr: '' };
        }
        return undefined;
    });

    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: env.tmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    var res = await invokeRoute(p, {
        method: 'POST',
        sub: 'restore-backup',
        body: { slot: 'pre-edit' }
    });
    assert.equal(res.status, 200, 'healthy backup must restore even when live DB is corrupted: ' + (res.json && res.json.error));
    assert.equal(res.json.slot, 'pre-edit');
    assert.equal(restoreScripts.length, 1);
    assert.ok(restoreScripts[0].indexOf('change_source') < 0, 'restore-backup must NOT switch input to TV');
    assert.ok(restoreScripts[0].indexOf('trap cleanup_start EXIT') >= 0);
    assert.ok(restoreScripts[0].indexOf('RB_DIR=') >= 0);
    assert.ok(restoreScripts[0].indexOf('rm -rf "$RB_DIR"') >= 0);
    assert.ok(restoreScripts[0].indexOf('RESTORE_ROLLED_BACK') >= 0);

    // Invalid slot rejected with 400
    var badSlot = await invokeRoute(p, { method: 'POST', sub: 'restore-backup', body: { slot: 'invalid-slot' } });
    assert.equal(badSlot.status, 400);
});

test('B1: outStream open error (before close) still returns 500 and releases dbBusy', async function (t) {
    var env = createTempEnv(t);
    var missingTmpDir = path.join(env.root, 'missing-dir', 'sub');
    var exec = createRealSqliteExecutor();
    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: missingTmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    var errRes = await invokeRoute(p, {
        method: 'POST',
        sub: 'import',
        headers: { 'x-upload-filename': 'broken_tmp.zip' },
        body: Buffer.from('PK_FAKE_DATA')
    });
    assert.equal(errRes.status, 500);
    assert.equal(errRes.json.ok, false);

    // Verify dbBusy was released (over-limit Content-Length returns 413 instead of 409)
    var followRes = await invokeRoute(p, {
        method: 'POST',
        sub: 'import',
        headers: { 'content-length': String(16 * 1024 * 1024) },
        manualStream: true
    });
    assert.equal(followRes.status, 413, 'dbBusy must not be stuck at 409 after WriteStream open error');
});

test('POST api/tune rejects channel numbers outside 1-9999 in digit-fallback path', async function (t) {
    var env = createTempEnv(t);
    var exec = createRealSqliteExecutor();
    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: env.tmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    for (var badNum of [0, -5, 10000, 1e21]) {
        var r = await invokeRoute(p, { method: 'POST', sub: 'tune', body: { channel: badNum } });
        assert.equal(r.status, 400, 'Expected 400 for channel=' + badNum);
    }
    var okNum = await invokeRoute(p, { method: 'POST', sub: 'tune', body: { channel: 42 } });
    assert.equal(okNum.status, 200);
    assert.equal(okNum.json.method, 'keys');
});

// ==================== 4. SECURITY, EXPORT, RELOAD, UI & LIFECYCLE ====================

test('CORS disabled, remote key allow-list hardened, export locked, reload avoids change_source TV, and UI uses type:srvId', async function (t) {
    var env = createTempEnv(t);
    var holdReload = false;
    var releaseReload = null;
    var exec = createRealSqliteExecutor(function (cmd) {
        if (cmd.indexOf('/usr/bin/flock') >= 0 && holdReload) {
            return new Promise(function (resolve) {
                releaseReload = function () { resolve({ exit_code: 0, stdout: 'OK\n', stderr: '' }); };
            });
        }
        if (cmd.indexOf('/usr/bin/zip -j') >= 0) {
            // Simulate zip creation in tmpDir while lock is held
            var m = /ZIPPATH='((?:[^']|'\\'')*)'/.exec(cmd);
            if (m) fs.writeFileSync(m[1].replace(/'\\''/g, "'"), 'PK_EXPORT_BYTES');
            return { exit_code: 0, stdout: 'Channel_list_T-TEST.zip\n', stderr: '' };
        }
        return undefined;
    });
    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: env.tmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    // CORS / OPTIONS disabled
    var optRes = await invokeRoute(p, { method: 'OPTIONS', sub: 'list' });
    assert.equal(optRes.handled, false);
    var uiRes = await invokeRoute(p, { method: 'GET', sub: 'ui' });
    assert.equal(uiRes.status, 200);
    assert.equal(uiRes.headers['access-control-allow-origin'], undefined);

    // Key allow-list blocks prototype keys and removed keys
    for (var badKey of ['constructor', '__proto__', 'toString', 'Return', 'Up', 'Down', 'Left', 'Right']) {
        var kr = await invokeRoute(p, { method: 'POST', sub: 'key', body: { key: badKey } });
        assert.equal(kr.status, 400, 'Expected 400 for key: ' + badKey);
    }
    var okKey = await invokeRoute(p, { method: 'POST', sub: 'key', body: { key: 'vol+' } });
    assert.equal(okKey.status, 200);
    assert.equal(okKey.json.key, 'XF86AudioRaiseVolume');

    // Reload uses flock and avoids change_source TV; export rejects 409 while dbBusy is held
    holdReload = true;
    var pendingRel = invokeRoute(p, { method: 'POST', sub: 'reload', body: '{}' });
    await new Promise(function (r) { setTimeout(r, 20); });
    var busyExp = await invokeRoute(p, { method: 'GET', sub: 'export' });
    assert.equal(busyExp.status, 409, 'export must respect dbBusy lock');
    releaseReload();
    holdReload = false;
    var relRes = await pendingRel;
    assert.equal(relRes.status, 200);
    var relEntry = exec.log.filter(function (x) { return x.script.indexOf('flock') >= 0; })[0];
    assert.match(relEntry.cmd, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    assert.ok(relEntry.script.indexOf('tvs_deamon.service') >= 0);
    assert.ok(relEntry.script.indexOf('change_source') < 0);

    // Export succeeds without fabricating country codes 48 / 5198920 and cleans temp zip
    var expRes = await invokeRoute(p, { method: 'GET', sub: 'export' });
    assert.equal(expRes.status, 200);
    assert.equal(expRes.body, 'PK_EXPORT_BYTES');
    await new Promise(function (r) { setTimeout(r, 40); });
    assert.equal(fs.readdirSync(env.tmpDir).filter(function (n) { return n.indexOf('ch_exp_') === 0; }).length, 0);
    var expEntry = exec.log.filter(function (x) { return x.script.indexOf('/usr/bin/zip -j') >= 0; })[0];
    assert.match(expEntry.cmd, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    assert.ok(expEntry.script.indexOf('5198920') < 0);
    assert.ok(expEntry.script.indexOf('DIGITAL_COUNTRY') < 0);
    assert.ok(expEntry.script.indexOf('chmod 0600') >= 0 || expEntry.script.indexOf('chmod 0644') >= 0);
    if (process.platform !== 'win32') {
        assert.ok(expEntry.script.indexOf('chown ') >= 0);
    }

    // B2 UI check & guideline hygiene: selections keyed by type:srvId, color-scheme meta, query preserved on export URL
    assert.ok(uiRes.body.indexOf('function getChannelKey(ch)') >= 0);
    assert.ok(uiRes.body.indexOf('data-key="') >= 0);
    assert.ok(uiRes.body.indexOf('<meta name="color-scheme" content="dark">') >= 0);
    assert.ok(uiRes.body.indexOf('hrefParts.slice(1)') >= 0);
    assert.equal(uiRes.body.indexOf('X-Upload-Filename'), -1);
    assert.ok(uiRes.body.indexOf("fetch('import?name='") >= 0);
    assert.ok(uiRes.body.indexOf('MAX_IMPORT_BYTES') >= 0);
    assert.ok(uiRes.body.indexOf('file.size > MAX_IMPORT_BYTES') >= 0);

    // stop() clears state cleanly
    p.stop();
    assert.deepEqual(p.status(), { ok: true, count: 0, pendingReload: false });
});

test('Vetro TV Tuner integration: reload/import/restore restart tuner, CH+/CH-/Exit and tune use pipe when shown', async function (t) {
    var env = createTempEnv(t);
    var dbs = createTvDatabases(env.dataDir, { userVersion: 7 });

    var preEditDir = path.join(env.pluginDir, 'backup', 'pre-edit');
    fs.mkdirSync(preEditDir, { recursive: true });
    fs.copyFileSync(dbs.dvbsPath, path.join(preEditDir, 'dvbs'));
    fs.writeFileSync(path.join(preEditDir, 'backup-meta.json'), JSON.stringify({ createdAt: '2026-11-25T00:00:00Z', files: ['dvbs'] }));

    var stagedSource = path.join(env.root, 'zip_src');
    fs.mkdirSync(stagedSource, { recursive: true });
    createTvDatabases(stagedSource, { userVersion: 7 });

    var tunerShownSimulated = true;
    var exec = createRealSqliteExecutor(function (cmd, timeoutMs, helpers) {
        if (cmd.indexOf('/usr/bin/unzip -l') >= 0) {
            return { exit_code: 0, stdout: '__LIST_START__\n  131072  2026-01-01 12:00   dvbs\n__LIST_END__\n', stderr: '' };
        }
        if (cmd.indexOf('/usr/bin/unzip -o -q') >= 0) {
            var upZip = helpers.extractQuotedVar(cmd, 'UP');
            var tDir = helpers.extractQuotedVar(cmd, 'TMP');
            fs.mkdirSync(tDir, { recursive: true });
            fs.copyFileSync(path.join(stagedSource, 'dvbs'), path.join(tDir, 'dvbs'));
            try { if (fs.existsSync(upZip)) fs.unlinkSync(upZip); } catch (e) {}
            return { exit_code: 0, stdout: '__DBS__=dvbs\n__IMP_META_START__\n__IMP_META_END__\n__TV_META_START__\n__TV_META_END__\n__PRD_START__\n__PRD_END__\n', stderr: '' };
        }
        if (cmd.indexOf('COPY_ROLLED_BACK') >= 0 || cmd.indexOf('RESTORE_ROLLED_BACK') >= 0) {
            return { exit_code: 0, stdout: 'SUCCESS\n', stderr: '' };
        }
        if (cmd.indexOf('__METHOD__=tuner') >= 0) {
            return { exit_code: 0, stdout: tunerShownSimulated ? '__METHOD__=tuner\n' : '__METHOD__=direct\n', stderr: '' };
        }
        return undefined;
    });

    // 1. Pure buildKeyCommand checks
    var chUpWrapped = internals.buildKeyCommand('XF86RaiseChannel');
    var chDownWrapped = internals.buildKeyCommand('XF86LowerChannel');
    var exitWrapped = internals.buildKeyCommand('XF86Exit');
    assert.match(chUpWrapped, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    assert.match(chDownWrapped, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    assert.match(exitWrapped, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    assert.ok(unwrapCmd(chUpWrapped).indexOf('/tmp/vetro-tuner.ctl.shown') >= 0);
    assert.ok(unwrapCmd(chUpWrapped).indexOf("echo 'key 88'") >= 0);
    assert.ok(unwrapCmd(chUpWrapped).indexOf('exec 3<>') >= 0);
    assert.ok(unwrapCmd(chUpWrapped).indexOf('/usr/bin/input_keyevent XF86RaiseChannel') >= 0);
    assert.ok(unwrapCmd(chDownWrapped).indexOf("echo 'key 87'") >= 0);
    assert.ok(unwrapCmd(exitWrapped).indexOf("echo 'key 174'") >= 0);
    assert.equal(internals.buildKeyCommand('XF86AudioRaiseVolume'), '/usr/bin/input_keyevent XF86AudioRaiseVolume');

    var p = pluginFactory({ dir: env.pluginDir, _dataDir: env.dataDir, _tmpDir: env.tmpDir, execute: exec.execute });
    p.start();
    t.after(function () { p.stop(); });

    // 2. api/key for ch_up, ch_down, exit executes pipe-aware script
    for (var pair of [['ch_up', 'key 88'], ['ch_down', 'key 87'], ['exit', 'key 174']]) {
        var logStart = exec.log.length;
        var kr = await invokeRoute(p, { method: 'POST', sub: 'key', body: { key: pair[0] } });
        assert.equal(kr.status, 200);
        assert.equal(kr.json.ok, true);
        assert.ok(exec.log[logStart].script.indexOf(pair[1]) >= 0);
        assert.ok(exec.log[logStart].script.indexOf('/tmp/vetro-tuner.ctl.shown') >= 0);
    }

    // 3. Populate cachedChannels via GET api/list
    var listRes = await invokeRoute(p, { method: 'GET', sub: 'list' });
    assert.equal(listRes.status, 200);

    // 3a. Unique visible channel (#3, srvId='103') -> uses pipe-aware tune wrapper and reports method:'tuner' when shown
    var logTuneIdx = exec.log.length;
    var tuneVis = await invokeRoute(p, { method: 'POST', sub: 'tune', body: { channel: 3, srvId: '103' } });
    assert.equal(tuneVis.status, 200);
    assert.equal(tuneVis.json.method, 'tuner');
    assert.ok(exec.log[logTuneIdx].script.indexOf('/tmp/vetro-tuner.ctl.shown') >= 0);
    assert.ok(exec.log[logTuneIdx].script.indexOf("echo 'tune 3'") >= 0);
    assert.ok(exec.log[logTuneIdx].script.indexOf('/usr/bin/launch_app org.tizen.tv-viewer tune_channel 103') >= 0);

    // Same route falls back to 'direct' when tuner is hidden
    tunerShownSimulated = false;
    var tuneHiddenTuner = await invokeRoute(p, { method: 'POST', sub: 'tune', body: { channel: 3, srvId: '103' } });
    assert.equal(tuneHiddenTuner.json.method, 'direct');
    tunerShownSimulated = true;

    // 3b. Hidden channel (#4, srvId='104') -> skips tune pipe, uses direct launch_app + hide/show resync when shown
    var logHiddenIdx = exec.log.length;
    var tuneHidden = await invokeRoute(p, { method: 'POST', sub: 'tune', body: { channel: 4, srvId: '104' } });
    assert.equal(tuneHidden.status, 200);
    assert.equal(tuneHidden.json.method, 'direct');
    assert.match(exec.log[logHiddenIdx].cmd, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    assert.ok(exec.log[logHiddenIdx].script.indexOf('/usr/bin/launch_app org.tizen.tv-viewer tune_channel 104') >= 0);
    assert.equal(exec.log[logHiddenIdx].script.indexOf("echo 'tune 4'"), -1);
    assert.ok(exec.log[logHiddenIdx].script.indexOf('/tmp/vetro-tuner.ctl.shown') >= 0);
    assert.ok(exec.log[logHiddenIdx].script.indexOf("printf 'hide\\nshow\\n'") >= 0);

    // 3c. Duplicate visible Major (#5 exists in both dvbs srvId='5001' and ipsrv srvId='9001') -> skips tune pipe, uses direct launch_app + hide/show resync
    var logDupIdx = exec.log.length;
    var tuneDup = await invokeRoute(p, { method: 'POST', sub: 'tune', body: { channel: 5, srvId: '9001' } });
    assert.equal(tuneDup.status, 200);
    assert.equal(tuneDup.json.method, 'direct');
    assert.match(exec.log[logDupIdx].cmd, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    assert.ok(exec.log[logDupIdx].script.indexOf('/usr/bin/launch_app org.tizen.tv-viewer tune_channel 9001') >= 0);
    assert.equal(exec.log[logDupIdx].script.indexOf("echo 'tune 5'"), -1);
    assert.ok(exec.log[logDupIdx].script.indexOf('/tmp/vetro-tuner.ctl.shown') >= 0);
    assert.ok(exec.log[logDupIdx].script.indexOf("printf 'hide\\nshow\\n'") >= 0);

    // 3d. Digit fallback without srvId -> includes /tmp/vetro-tuner.ctl.shown + 'tune 42' + D-Bus fallback
    var logFbIdx = exec.log.length;
    var tuneFb = await invokeRoute(p, { method: 'POST', sub: 'tune', body: { channel: 42 } });
    assert.equal(tuneFb.status, 200);
    assert.equal(tuneFb.json.method, 'tuner');
    assert.ok(exec.log[logFbIdx].script.indexOf('/tmp/vetro-tuner.ctl.shown') >= 0);
    assert.ok(exec.log[logFbIdx].script.indexOf("echo 'tune 42'") >= 0);
    assert.ok(exec.log[logFbIdx].script.indexOf('Test.EventKey') >= 0);

    // 3e. pendingReload=true after an edit bypasses tune pipe and resyncs cursor after direct launch_app until reload completes
    var renRes = await invokeRoute(p, { method: 'POST', sub: 'edit', body: { action: 'rename', type: 'dvbs', srvId: '103', name: 'Gamma Renamed' } });
    assert.equal(renRes.status, 200);
    var logPendIdx = exec.log.length;
    var tunePending = await invokeRoute(p, { method: 'POST', sub: 'tune', body: { channel: 3, srvId: '103' } });
    assert.equal(tunePending.status, 200);
    assert.equal(tunePending.json.method, 'direct');
    assert.match(exec.log[logPendIdx].cmd, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    assert.ok(exec.log[logPendIdx].script.indexOf('/usr/bin/launch_app org.tizen.tv-viewer tune_channel 103') >= 0);
    assert.equal(exec.log[logPendIdx].script.indexOf("echo 'tune 3'"), -1);
    assert.ok(exec.log[logPendIdx].script.indexOf('/tmp/vetro-tuner.ctl.shown') >= 0);
    assert.ok(exec.log[logPendIdx].script.indexOf("printf 'hide\\nshow\\n'") >= 0);

    // 4. Reload, Phase 2 import swap, and restore-backup all include non-blocking vetro-tuner restart + quit fallback
    var relIdx = exec.log.length;
    var relRes = await invokeRoute(p, { method: 'POST', sub: 'reload', body: '{}' });
    assert.equal(relRes.status, 200);
    assert.ok(exec.log[relIdx].script.indexOf('systemctl restart --no-block vetro-tuner.service') >= 0);
    assert.ok(exec.log[relIdx].script.indexOf("echo 'quit'") >= 0);

    var impRes = await invokeRoute(p, {
        method: 'POST',
        sub: 'import',
        url: '/import?name=' + encodeURIComponent('Channel_list_test.zip'),
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('PK_FAKE_ZIP')
    });
    assert.equal(impRes.status, 200);
    var p2Logs = exec.log.filter(function (x) { return x.script.indexOf('COPY_ROLLED_BACK') >= 0; });
    assert.equal(p2Logs.length, 1);
    assert.ok(p2Logs[0].script.indexOf('systemctl restart --no-block vetro-tuner.service') >= 0);
    assert.ok(p2Logs[0].script.indexOf("echo 'quit'") >= 0);

    var rbRes = await invokeRoute(p, { method: 'POST', sub: 'restore-backup', body: { slot: 'pre-edit' } });
    assert.equal(rbRes.status, 200);
    var rbLogs = exec.log.filter(function (x) { return x.script.indexOf('RESTORE_ROLLED_BACK') >= 0; });
    assert.equal(rbLogs.length, 1);
    assert.ok(rbLogs[0].script.indexOf('systemctl restart --no-block vetro-tuner.service') >= 0);
    assert.ok(rbLogs[0].script.indexOf("echo 'quit'") >= 0);

    // 5. POST api/tvsource triggers resume on /tmp/vetro-tuner.ctl
    var tvSrcIdx = exec.log.length;
    var tvSrcRes = await invokeRoute(p, { method: 'POST', sub: 'tvsource', body: '{}' });
    assert.equal(tvSrcRes.status, 200);
    assert.ok(exec.log[tvSrcIdx].script.indexOf("echo 'resume'") >= 0);
    assert.ok(exec.log[tvSrcIdx].script.indexOf('/tmp/vetro-tuner.ctl') >= 0);
});

if (process.platform !== 'win32') {
    test('POSIX sh Phase 2 swap + rollback + EXIT trap executes cleanly with stubbed systemctl', async function (t) {
        var env = createTempEnv(t);
        var binDir = path.join(env.root, 'bin');
        var dataDir = env.dataDir;
        var impDir = path.join(env.tmpDir, 'staged');
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(impDir, { recursive: true });

        fs.writeFileSync(path.join(dataDir, 'dvbs'), 'ORIG_DVBS');
        fs.writeFileSync(path.join(impDir, 'dvbs'), 'NEW_DVBS');
        fs.writeFileSync(path.join(impDir, 'ipsrv'), 'NEW_IPSRV');

        var sysLog = path.join(env.root, 'sys.log');
        fs.writeFileSync(path.join(binDir, 'systemctl'), '#!/bin/sh\necho "$1 $2" >> "' + sysLog + '"\nexit 0\n', { mode: 0o755 });
        fs.writeFileSync(path.join(binDir, 'chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fs.writeFileSync(path.join(binDir, 'chmod'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        var lockFile = path.join(env.tmpDir, 'test.lock');
        var backupDir = path.join(env.pluginDir, 'backup', 'pre-import');
        var script = [
            'exec 9>"' + lockFile + '"',
            'UNIT="tvs_deamon.service"',
            'systemctl stop "$UNIT"',
            'RESTARTED=0',
            'cleanup_on_exit() { rm -rf "' + impDir + '" 2>/dev/null || true; if [ "$RESTARTED" -eq 0 ]; then systemctl start "$UNIT" || true; RESTARTED=1; fi; }',
            'trap cleanup_on_exit EXIT',
            'mkdir -p "' + backupDir + '"',
            'cp "' + dataDir + '/dvbs" "' + backupDir + '/dvbs"',
            'rm -f "' + impDir + '/ipsrv"',
            'COPY_ERR=0',
            'for f in dvbs ipsrv; do cp "' + impDir + '/$f" "' + dataDir + '/$f" || { COPY_ERR=1; break; }; done',
            'if [ "$COPY_ERR" -ne 0 ]; then cp "' + backupDir + '/dvbs" "' + dataDir + '/dvbs"; if [ ! -f "' + backupDir + '/ipsrv" ]; then rm -f "' + dataDir + '/ipsrv"; fi; echo "COPY_ROLLED_BACK"; exit 14; fi'
        ].join('; ');

        var r = cp.spawnSync('sh', ['-c', script], {
            env: Object.assign({}, process.env, { PATH: binDir + ':' + process.env.PATH }),
            encoding: 'utf8'
        });
        assert.equal(r.status, 14);
        assert.match(r.stdout, /COPY_ROLLED_BACK/);
        assert.equal(fs.readFileSync(path.join(dataDir, 'dvbs'), 'utf8'), 'ORIG_DVBS');
        assert.equal(fs.existsSync(path.join(dataDir, 'ipsrv')), false);
        assert.equal(fs.existsSync(impDir), false, 'EXIT trap removed staged dir');
        assert.match(fs.readFileSync(sysLog, 'utf8'), /stop tvs_deamon\.service[\s\S]*start tvs_deamon\.service/);
    });
}

test('hardening: inline SQL here-doc avoids /tmp/*.sql, restore preserves mode via stat, and staged imports verify SHA-256 + expire', async function (t) {
    var env = createTempEnv(t);
    var dbs = createTvDatabases(env.dataDir, { userVersion: 7 });

    // Create valid pre-edit backup so we can also assert restore-backup script permissions
    var preEditDir = path.join(env.pluginDir, 'backup', 'pre-edit');
    fs.mkdirSync(preEditDir, { recursive: true });
    fs.copyFileSync(dbs.dvbsPath, path.join(preEditDir, 'dvbs'));
    fs.writeFileSync(path.join(preEditDir, 'backup-meta.json'), JSON.stringify({ createdAt: '2026-11-24T12:00:00Z', files: ['dvbs'] }));

    var stagedSource = path.join(env.root, 'zip_src');
    fs.mkdirSync(stagedSource, { recursive: true });
    createTvDatabases(stagedSource, { userVersion: 7 });

    var restoreScripts = [];
    var phase2Called = 0;
    var exec = createRealSqliteExecutor(function (cmd, timeoutMs, helpers) {
        if (cmd.indexOf('/usr/bin/unzip -l') >= 0) {
            return {
                exit_code: 0,
                stdout: '__LIST_START__\n  131072  2026-01-01 12:00   dvbs\n  131072  2026-01-01 12:00   metadata.xml\n__LIST_END__\n',
                stderr: ''
            };
        }
        if (cmd.indexOf('/usr/bin/unzip -o -q') >= 0) {
            var upZip = helpers.extractQuotedVar(cmd, 'UP');
            var tDir = helpers.extractQuotedVar(cmd, 'TMP');
            fs.mkdirSync(tDir, { recursive: true });
            fs.copyFileSync(path.join(stagedSource, 'dvbs'), path.join(tDir, 'dvbs'));
            try { if (fs.existsSync(upZip)) fs.unlinkSync(upZip); } catch (e) { }
            return {
                exit_code: 0,
                stdout: '__DBS__= dvbs\n__IMP_META_START__\n<METADATA><DIGITAL_COUNTRY>5198920</DIGITAL_COUNTRY></METADATA>\n__IMP_META_END__\n__TV_META_START__\n<METADATA><DIGITAL_COUNTRY>9999999</DIGITAL_COUNTRY></METADATA>\n__TV_META_END__\n',
                stderr: ''
            };
        }
        if (cmd.indexOf('COPY_ROLLED_BACK') >= 0) {
            phase2Called++;
            return { exit_code: 0, stdout: 'SUCCESS\n', stderr: '' };
        }
        if (cmd.indexOf('RESTORE_ROLLED_BACK') >= 0) {
            restoreScripts.push(cmd);
            return { exit_code: 0, stdout: 'SUCCESS\n', stderr: '' };
        }
        return undefined;
    });

    var p = pluginFactory({
        dir: env.pluginDir,
        _dataDir: env.dataDir,
        _tmpDir: env.tmpDir,
        _stagedImportTtlMs: 80,
        execute: exec.execute
    });
    p.start();
    t.after(function () { p.stop(); });

    // 1. Edit runs SQL via inline here-document with zero ch_*.sql or ch_ebak_*.json files left in tmpDir
    var renameRes = await invokeRoute(p, {
        method: 'POST',
        sub: 'edit',
        body: { action: 'rename', type: 'dvbs', srvId: '101', name: 'Renamed One' }
    });
    assert.equal(renameRes.json.ok, true);
    var mvPreBakRes = await invokeRoute(p, {
        method: 'POST',
        sub: 'edit',
        body: { action: 'move', type: 'dvbs', srvId: '101', target: 2 }
    });
    assert.equal(mvPreBakRes.json.ok, true);
    var preEditMeta = JSON.parse(fs.readFileSync(path.join(env.pluginDir, 'backup', 'pre-edit', 'backup-meta.json'), 'utf8'));
    assert.equal(preEditMeta.slot, 'pre-edit');
    var sqlTmpFiles = fs.readdirSync(env.tmpDir).filter(function (n) { return /\.sql$/.test(n) || n.indexOf('ch_ebak_') === 0 || n.indexOf('ch_bmeta_') === 0; });
    assert.equal(sqlTmpFiles.length, 0, 'no temporary .sql or meta JSON files should ever be written to tmpDir');
    assert.ok(exec.log.some(function (entry) { return /sqlite3 -bail .* <<'__VETRO_SQL_[0-9a-f]+__'/.test(entry.script); }));

    // 2. Restore backup script preserves mode/owner via stat (defaulting 0644 / 0:0, zero chmod 0777)
    var rbRes = await invokeRoute(p, { method: 'POST', sub: 'restore-backup', body: { slot: 'pre-edit' } });
    assert.equal(rbRes.json.ok, true);
    assert.equal(restoreScripts.length, 1);
    assert.equal(restoreScripts[0].indexOf('0777'), -1);
    assert.ok(restoreScripts[0].indexOf("stat -c '%a'") >= 0 && restoreScripts[0].indexOf('0644') >= 0);

    // 3. Staged import rejects tampered staged file before stopping tvs_deamon.service (409)
    var up1 = await invokeRoute(p, {
        method: 'POST',
        sub: 'import',
        url: '/import?name=mismatch.zip',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('PK_FAKE')
    });
    assert.equal(up1.json.needsConfirm, true);
    var stagedDirs = fs.readdirSync(env.tmpDir).filter(function (n) { return n.indexOf('ch_imp_') === 0; });
    assert.equal(stagedDirs.length, 1);
    fs.writeFileSync(path.join(env.tmpDir, stagedDirs[0], 'dvbs'), 'TAMPERED_DB_BYTES');
    var badConfirm = await invokeRoute(p, {
        method: 'POST',
        sub: 'import-confirm',
        body: { confirmToken: up1.json.confirmToken }
    });
    assert.equal(badConfirm.status, 409);
    assert.match(badConfirm.json.error, /changed before apply/i);
    assert.equal(phase2Called, 0, 'tampered staged import must be rejected before running Phase 2');

    // 4. Staged import expires cleanly after TTL and removes temporary staged directory
    var up2 = await invokeRoute(p, {
        method: 'POST',
        sub: 'import',
        url: '/import?name=mismatch.zip',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('PK_FAKE')
    });
    assert.equal(up2.json.needsConfirm, true);
    assert.equal(fs.readdirSync(env.tmpDir).filter(function (n) { return n.indexOf('ch_imp_') === 0; }).length, 1);
    await new Promise(function (resolve) { setTimeout(resolve, 140); });
    assert.equal(fs.readdirSync(env.tmpDir).filter(function (n) { return n.indexOf('ch_imp_') === 0; }).length, 0, 'expired staged dir must be deleted');
    var expiredConfirm = await invokeRoute(p, {
        method: 'POST',
        sub: 'import-confirm',
        body: { confirmToken: up2.json.confirmToken }
    });
    assert.equal(expiredConfirm.status, 400);
});
