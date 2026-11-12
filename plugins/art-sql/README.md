# Art SQL API

A read-only HTTP API over the Samsung **Art app's** database (`artapp.db`), so another app on your network can send SQL and
get JSON back. The URLs and JSON follow a subset of [Datasette](https://datasette.io)'s JSON API, so a client written
for Datasette mostly works. This is **not** Datasette and is not affiliated with it: it is a few hundred lines of Node and the
TV's own `sqlite3`.

## Use

1. Install it, switch it on, open the **Art SQL** tab. It shows the endpoint (`http://TV-IP:8642/artapp.json`) and an
   API key.
2. Send the key as `Authorization: Bearer <key>` (or `X-API-Key: <key>`, or `?_key=<key>` for a quick test in a
   browser, though that puts the key in URLs and logs).

```sh
KEY=...   # from the tab
curl -H "Authorization: Bearer $KEY" 'http://192.168.1.45:8642/artapp.json'                      # tables and columns
curl -H "Authorization: Bearer $KEY" 'http://192.168.1.45:8642/artapp.json?sql=select+count(*)+as+n+from+sqlite_master'
curl -H "Authorization: Bearer $KEY" 'http://192.168.1.45:8642/artapp/Content.json?_size=20&ArtistName__contains=Monet'
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"sql":"select ContentID, ArtworkTitle from Content where ArtistName = :artist","params":{"artist":"Claude Monet"}}' 'http://192.168.1.45:8642/artapp.json'
```

The tab also has a box to try queries and a list of tables you can click.

## API

| Request | Answer |
| --- | --- |
| `GET /.json` | the one database: `{"artapp": {...}}` |
| `GET /-/versions.json` | sqlite3 version and this Shard's version |
| `GET /artapp.json` | `{"ok": true, "tables": [{"name", "type", "columns": [...]}]}` |
| `GET /artapp.json?sql=…` | run a query. `:name` in the SQL is filled from `?name=value` (always as a string, as Datasette does) |
| `POST /artapp.json` | the same, with a JSON body `{"sql": "…", "params": {"name": "value"}}`, for long queries |
| `GET /artapp/<table>.json` | rows of one table: `?_size=` (default 100), `?_sort=` / `?_sort_desc=`, `?_next=` (from the previous page's `next`), and filters `?col=value`, `?col__gt=`, `__gte`, `__lt`, `__lte`, `__not`, `__contains`, `__startswith`, `__endswith`, `__like`, `__glob`, `__isnull=1`, `__notnull=1` |

The answer to a query is

```json
{"ok": true, "database": "artapp", "query": {"sql": "…", "params": {}}, "columns": ["…"], "rows": [{"…": "…"}],
 "truncated": false, "query_ms": 41}
```

`?_shape=array` gives just the rows (`[{…}, {…}]`), `?_shape=array&_nl=on` gives one JSON object per line,
`?_shape=arrays` gives `{"columns": [...], "rows": [[...], ...]}`, and `?_shape=objects` gives `{"rows": [...]}`.
Errors are `{"ok": false, "error": "…", "status": 400, "title": "Invalid SQL"}` with that HTTP status; a wrong key is
`401`, a full queue is `429`.

A query returns at most **1000 rows** (the *Row limit* setting); past that `truncated` is `true`. CORS is open (`*`) by
default so a web page can call the API with the key; set an origin, or nothing, on the tab.

**Differences from Datasette:** one database, read-only, JSON only (no HTML pages), `_next` is a row offset instead of a
keyset token, `columns` is empty for a query with no rows, there is no `_where`, `_facet`, `_col`, row pages or
`/-/metadata`, integers above 2^53 lose precision (they pass through JSON), and a blob comes back as whatever text
sqlite3 prints for it (use `hex(col)` in the query for something reliable).

## What it can and cannot run

The query runs in the TV's `sqlite3` shell **as root**, with `-readonly`. Read-only stops writes to the database, but the
shell has functions that reach the file system, and the TV's sqlite3 (3.33.0 on the tested TV) is older than the
`-safe` flag (3.37) that turns them off. So the Shard checks every query first ([`sql.js`](sql.js)):

- **One statement**, starting with `SELECT`, `WITH`, `VALUES`, `PRAGMA` (reading only: no `=`) or `EXPLAIN`.
  `SELECT`/`WITH`/`VALUES` run as `SELECT * FROM (<your query>) LIMIT <row limit + 1>`.
- **These words are refused anywhere in the text**, even quoted or inside a string: `attach`, `detach`, `vacuum`,
  `readfile`, `writefile`, `edit`, `fsdir`, `zipfile`, `load_extension`, `sha3_query`, `fts3_tokenizer`,
  `temp_store_directory`, `data_store_directory`. So a column named `edit` cannot be queried by name (use `select *`), and
  `where note like '%edit%'` is refused too: pass the text as a parameter (`where note like :q`, `?q=%25edit%25`), which
  is not scanned.
- The SQL reaches the shell base64-encoded, so no character of it is seen by `sh`. A string or blob is capped at 10 MB
  (`.limit length`), and a query is stopped after the *Time limit* (10 s by default, up to 30 s).

Treat the API key like a password: anyone with it can read everything in the Art app's database.

## Permissions

`exec`: the database is in the Art app's sandbox (`/opt/usr/home/owner/apps_rw/org.tizen.art-app/`, Smack label
`User::Pkg::org.tizen.art-app`), which Vetro's own user cannot read, so the query runs as root through Vetro's agent.

## Commands it runs

All through `ctx.execute`, as root.

| When | Command | Why |
| --- | --- | --- |
| the Shard starts, the database path changes, **Check sqlite3** | `/usr/bin/sqlite3 -version`; `[ -r <database> ]` | find out whether sqlite3 is there and new enough (3.33+, for JSON output), and whether the file exists |
| every query, from the API or the tab | `__q="$(printf %s <base64 SQL> \| base64 -d)"; exec /usr/bin/sqlite3 -readonly -batch -bail -cmd '.timeout 3000' -cmd '.limit length 10000000' -cmd '.mode json' <database> "$__q" </dev/null` | run the checked query read-only and get JSON. `.timeout` waits up to 3 s if the Art app is writing |

Queries run one at a time, because every Vetro command shares one queue; up to 8 more wait, after that the API answers `429`.
A long query makes the rest of Vetro wait too, which is why the time limit is capped at 30 s.

## Network

It opens no outbound connection. It listens on **one port** (default **8642**, set on the tab; 8001 and 8002 are taken by Samsung's own `msf-server` on every Samsung TV), bound to all interfaces
(`0.0.0.0`), plain HTTP. Every request except a CORS preflight needs the API key. The key travels in clear over HTTP,
so keep the TV on a trusted network and **never forward this port to the Internet**.

## Data it keeps

Its own `config.json`: the API key, the port, the database path, the CORS origin, the time and row limits. It keeps no
query results and no log of queries; the tab shows only counters and the last error. Removing the Shard deletes the key.

## Effect on the Art app

The file is opened read-only with a rollback journal (the tested database has `artapp.db-journal`, not WAL), so a query
creates no files next to the database and changes nothing in it. While a query reads, the Art app cannot write for that
moment; if the Art app is writing, the query waits up to 3 s and then fails with `database is locked`. This is not
supported by Samsung, and a firmware update may move or change the database.

## Tested

_Off-device_ (macOS, Node 26), with the same end-to-end suite run against **sqlite3 3.33.0** (built from the official
amalgamation, the version the tested TV has) and 3.53: every endpoint and `_shape`, table filters and paging,
parameters (including an injection attempt through one), the API key, CORS preflight, 27 queries that must be refused,
the queue limit, the time limit, and switching off with requests in flight. On 3.33.0 it also confirmed that
`readfile()`, `writefile()` and `fsdir()` work despite `-readonly` and that `-safe` does not exist, which is why the
checks above are needed, and that a query leaves the database and its journal byte-for-byte unchanged and creates no
files. 3.33.0 echoes the `.limit` line to stdout; the Shard strips it.

_On the TV_ — Samsung The Frame **QN75LS03B** (2022), Tizen 6.5, `/usr/bin/sqlite3` 3.33.0, Vetro 0.5.0, installed in
Developer mode, queried with `curl` over the LAN on port 8642:

- no key and a wrong key get `401`; `/-/versions.json`, `/artapp.json` (16 tables and views, 285 columns) and queries
  answer `200`; a `group by` over the 9,358 rows of `Content` takes about 0.7 s, small queries 10-130 ms;
- `:name` parameters (GET and POST), `/artapp/Content.json` paging with `next_url`, `_shape=array|objects`, and the
  1000-row cap (`truncated: true`) work;
- `readfile()` and `DELETE` are refused with `400`, a bad column gives sqlite3's own message, the CORS preflight is `204`;
- the Art app's database folder is unchanged afterwards: the same two files, owner, Smack label and timestamps.

Port 8001, the first default, is taken by Samsung's `msf-server` on every Samsung TV, hence 8642.
