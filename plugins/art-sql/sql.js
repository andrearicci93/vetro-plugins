'use strict';
// The query side of the Art SQL API: checks a client's SQL, fills in its :named parameters, builds the sqlite3
// command that runs it read-only as root (through ctx.execute), and parses the answer. No I/O here, so it can be
// tested on its own. Plain ES5: older TVs run Node 4.4.
//
// Why the checks matter: the query runs in the TV's own sqlite3 *shell* (3.33.0 on the tested TV), as root. -readonly
// stops writes to the database, but the shell adds functions and tables that reach the file system, and 3.33 has no
// -safe flag (3.37+) to turn them off:
//   readfile(), writefile(), edit(), fsdir(), zipfile    read, write or list any file as root
//   load_extension()                                     loads native code as root
//   ATTACH, VACUUM INTO, temp_store_directory            open or create other files
//   sha3_query()                                         runs SQL built from a string, past these checks
//   fts3_tokenizer()                                     known memory-safety hazard
// So: one statement only; it must start with SELECT, WITH, VALUES, PRAGMA or EXPLAIN; SELECT/WITH/VALUES are wrapped as
// a subquery (which also enforces "one statement" and lets us cap the rows); and any of the words below anywhere in
// the text, quoted or not, rejects the query. A string literal is scanned too, because SQLite accepts a quoted name
// as a table-valued function ('fsdir'('/')).

var BLOCKED = ['attach', 'detach', 'vacuum', 'readfile', 'writefile', 'edit', 'fsdir', 'zipfile', 'load_extension',
    'sha3_query', 'fts3_tokenizer', 'temp_store_directory', 'data_store_directory'];
var BLOCKED_RE = new RegExp('(^|[^a-z0-9_$])(' + BLOCKED.join('|') + ')(?![a-z0-9_$])', 'i');
var WRAPPED = { select: 1, 'with': 1, values: 1 }, RAW = { pragma: 1, explain: 1 };
var MAX_SQL = 32768, MAX_PARAM = 65536;

function bytes(s) { return Buffer.from && Buffer.from !== Uint8Array.from ? Buffer.from(s) : new Buffer(s); }
function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function literal(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }
function ident(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function fail(message, title) { var e = new Error(message); e.title = title || 'Invalid SQL'; e.status = 400; return e; }

// One pass over the SQL that knows about strings, quoted names and comments. It returns the first keyword, where
// each top-level ';' is, and every :name parameter outside strings and comments (Datasette's syntax). Parentheses
// must balance, so a query cannot close the SELECT * FROM ( ... ) it is wrapped in.
function scan(sql) {
    var i = 0, n = sql.length, first = null, semis = [], params = [], depth = 0, c, end, close;
    while (i < n) {
        c = sql.charAt(i);
        if (c === '-' && sql.charAt(i + 1) === '-') { end = sql.indexOf('\n', i); i = end < 0 ? n : end + 1; continue; }
        if (c === '/' && sql.charAt(i + 1) === '*') { end = sql.indexOf('*/', i + 2); if (end < 0) throw fail('Unterminated /* comment'); i = end + 2; continue; }
        if (c === "'" || c === '"' || c === '`' || c === '[') {
            close = c === '[' ? ']' : c; end = i + 1;
            for (;;) {
                end = sql.indexOf(close, end);
                if (end < 0) throw fail('Unterminated ' + (c === "'" ? 'string' : 'quoted name'));
                if (close !== ']' && sql.charAt(end + 1) === close) { end += 2; continue; }
                break;
            }
            if (first === null) first = '';
            i = end + 1; continue;
        }
        if (c === ';') { semis.push(i); i++; continue; }
        if (c === '(') depth++;
        if (c === ')' && --depth < 0) throw fail('Unbalanced parentheses');
        if (c === ':' && /[A-Za-z_]/.test(sql.charAt(i + 1))) {
            var m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
            params.push({ name: m[1], at: i, length: m[0].length }); i += m[0].length; continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            var w = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))[0];
            if (first === null) first = w.toLowerCase();
            i += w.length; continue;
        }
        if (first === null && !/\s/.test(c)) first = '';
        i++;
    }
    if (depth !== 0) throw fail('Unbalanced parentheses');
    return { first: first || '', semis: semis, params: params };
}

// Only whitespace, comments and stray semicolons after position `from`? (Anything else there is a second statement.)
function blankAfter(sql, from) { return !/[^\s;]/.test(stripComments(sql.slice(from))); }
function stripComments(s) { return s.replace(/--[^\n]*(\n|$)/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' '); }

// Check a query and turn it into the SQL that is actually run. params: { name: value } (values become string
// literals, like Datasette). maxRows: the cap; the SQL asks for one more so we can tell the result was truncated.
function prepare(sql, params, maxRows) {
    if (typeof sql !== 'string' || !sql.trim()) throw fail('Missing sql', 'Missing SQL');
    if (sql.length > MAX_SQL) throw fail('SQL is longer than ' + MAX_SQL + ' characters');
    if (/\0/.test(sql)) throw fail('SQL contains a NUL character');
    var hit = BLOCKED_RE.exec(sql);
    if (hit) throw fail('"' + hit[2] + '" is not allowed: this API is read-only and cannot reach other files', 'Forbidden SQL');
    var s = scan(sql);
    if (!WRAPPED[s.first] && !RAW[s.first]) throw fail('Only SELECT, WITH, VALUES, PRAGMA and EXPLAIN statements are allowed', 'Forbidden SQL');
    if (s.semis.length && !blankAfter(sql, s.semis[0] + 1)) throw fail('Only one statement per query');
    var body = s.semis.length ? sql.slice(0, s.semis[0]) : sql;
    if (s.first === 'pragma' && /=/.test(stripComments(body))) throw fail('PRAGMA can only read here (no "=")', 'Forbidden SQL');

    params = params || {};
    var out = '', last = 0, used = {};
    for (var k = 0; k < s.params.length; k++) {
        var p = s.params[k];
        if (p.at >= body.length) break;
        if (!Object.prototype.hasOwnProperty.call(params, p.name) || params[p.name] == null) throw fail('Missing parameter :' + p.name, 'Missing parameter');
        var v = String(params[p.name]);
        if (v.length > MAX_PARAM || /\0/.test(v)) throw fail('Parameter :' + p.name + ' is too long or contains a NUL character');
        out += body.slice(last, p.at) + literal(v); last = p.at + p.length; used[p.name] = v;
    }
    out += body.slice(last);
    var run = WRAPPED[s.first] ? 'SELECT * FROM (\n' + out + '\n) LIMIT ' + (maxRows + 1) : out;
    return { sql: run, params: used, wrapped: !!WRAPPED[s.first], first: s.first };
}

// The shell command. The SQL travels base64-encoded so no character of it is ever seen by the shell; stdin is
// /dev/null; .timeout waits up to 3 s when the Art app holds a write lock; .limit caps any one string or blob at
// 10 MB so a query cannot make sqlite3 (running as root) eat the TV's memory.
//
// out: { file, uid, blocks } writes the result to that file instead of stdout, because Vetro's agent keeps only the
// first 1 MiB of a command's output. The file is created private (root's umask on the TV is 0), handed to Vetro's
// own uid so the Shard can read and delete it, and capped by ulimit -f (blocks of 512 or 1024 bytes, by shell).
function command(sqlite, dbPath, sql, out) {
    var b64 = bytes(sql).toString('base64');
    var run = shQuote(sqlite) + ' -readonly -batch -bail -cmd ' + shQuote('.timeout 3000') + ' -cmd ' + shQuote('.limit length 10000000') +
        ' -cmd ' + shQuote('.mode json') + ' ' + shQuote(dbPath) + ' "$__q" </dev/null';
    var head = '__q="$(printf %s ' + b64 + ' | base64 -d)"; ';
    if (!out) return head + 'exec ' + run;
    var f = shQuote(out.file);
    return head + 'umask 077; ulimit -f ' + (out.blocks | 0) + ' 2>/dev/null; ' + run + ' > ' + f + '; __s=$?; chown ' + (out.uid | 0) + ' ' + f +
        ' 2>/dev/null; exit $__s';
}

// What Vetro's agent appends when it cut a command's output at 1 MiB.
function capped(stdout) { return /exceeded the 1 MiB capture limit\]\s*$/.test(String(stdout || '')); }

// sqlite3 -json prints one array per statement, nothing at all for no rows. EXPLAIN QUERY PLAN is the exception: the
// shell always draws it as a text tree, so that comes back as one row per line, { plan: "..." }.
// sqlite3 3.33 also echoes the .limit it was given ("              length 10000000") to stdout, before the results.
function parseOutput(stdout, first) {
    var text = String(stdout || '').replace(/^[ \t]*length[ \t]+\d+[ \t]*\r?\n?/, '').replace(/^\s+|\s+$/g, '');
    if (!text) return [];
    if (first === 'explain' && text.charAt(0) !== '[') return text.split('\n').map(function (l) { return { plan: l }; });
    try { var v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch (e) { /* several statements: take the last */ }
    var parts = JSON.parse('[' + text.replace(/\]\s*\n\s*\[/g, '],[') + ']');
    return parts.length ? parts[parts.length - 1] : [];
}
function columnsOf(rows) { return rows.length ? Object.keys(rows[0]) : []; }

// sqlite3 writes "Error: no such table: x" (3.33) or "Parse error in 11th command line argument: ..." (newer): keep the useful part.
function cleanError(stderr) {
    var s = String(stderr || '').replace(/^\s+|\s+$/g, '').split('\n')[0] || 'sqlite3 failed';
    return s.replace(/^(Error|Parse error|Runtime error)( in \S+ command line argument| near line \d+)?:\s*/, '').slice(0, 500);
}

// SQL for GET /<db>/<table>.json. Filters follow Datasette: ?col=value, ?col__gt=5, ?col__contains=x ...
var OPS = { exact: '= ?', not: '!= ?', gt: '> ?', gte: '>= ?', lt: '< ?', lte: '<= ?', like: 'LIKE ?', glob: 'GLOB ?',
    contains: "LIKE '%' || ? || '%'", startswith: "LIKE ? || '%'", endswith: "LIKE '%' || ?" };
function tableQuery(table, query, maxRows) {
    var where = [], params = {}, n = 0;
    Object.keys(query).forEach(function (key) {
        if (key.charAt(0) === '_') return;
        var vals = [].concat(query[key]), col = key, op = 'exact', m = /^(.+)__([a-z]+)$/.exec(key);
        if (m && (OPS[m[2]] || m[2] === 'isnull' || m[2] === 'notnull')) { col = m[1]; op = m[2]; }
        vals.forEach(function (v) {
            if (op === 'isnull' || op === 'notnull') { where.push(ident(col) + (op === 'isnull' ? ' IS NULL' : ' IS NOT NULL')); return; }
            var name = 'p' + (n++); params[name] = v;
            where.push(ident(col) + ' ' + OPS[op].replace('?', ':' + name));
        });
    });
    var size = parseInt(query._size, 10); if (!(size > 0)) size = Math.min(100, maxRows); size = Math.min(size, maxRows);
    var offset = parseInt(query._next, 10); if (!(offset > 0)) offset = 0;
    var sort = query._sort_desc || query._sort, order = sort ? ' ORDER BY ' + ident(sort) + (query._sort_desc ? ' DESC' : '') : '';
    var sql = 'SELECT * FROM ' + ident(table) + (where.length ? ' WHERE ' + where.join(' AND ') : '') + order +
        ' LIMIT ' + (size + 1) + ' OFFSET ' + offset;
    return { sql: sql, params: params, size: size, offset: offset };
}

var SCHEMA_SQL = "SELECT m.name AS tbl, m.type AS type, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p " +
    "WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid";
function schemaOf(rows) {
    var out = [], byName = {};
    rows.forEach(function (r) {
        var t = byName[r.tbl];
        if (!t) { t = byName[r.tbl] = { name: r.tbl, type: r.type, columns: [] }; out.push(t); }
        t.columns.push(r.col);
    });
    return out;
}

module.exports = { prepare: prepare, scan: scan, command: command, capped: capped, parseOutput: parseOutput, columnsOf: columnsOf,
    cleanError: cleanError, tableQuery: tableQuery, SCHEMA_SQL: SCHEMA_SQL, schemaOf: schemaOf, BLOCKED: BLOCKED, shQuote: shQuote };
