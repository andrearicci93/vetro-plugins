'use strict';
// Prometheus exporter: /plugins/prometheus/api/metrics in the text exposition format (0.0.4).
// Everything is read from /proc and /sys with fs, as Vetro's service user: no root, no commands, no network.
// Names follow node_exporter where the meaning is the same, so existing dashboards work; TV-only metrics use tv_.
// Readings are cached for a few seconds so frequent scrapes do not load the TV. Plain ES5: older TVs run Node 4.4.
var fs = require('fs'), path = require('path');
var VERSION = '1.0.0', CACHE_MS = 5000, USER_HZ = 100;
var THERMAL_ROOTS = ['/sys/devices/platform/soc', '/sys/devices/platform'];
var CPU_MODES = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; } }
function esc(v) { return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"'); }
function num(v) { return isFinite(v) ? String(v) : 'NaN'; }

// A small writer for the exposition format: HELP and TYPE once per family, then the samples.
function Out() { this.lines = []; this.seen = {}; }
Out.prototype.family = function (name, type, help) {
    if (this.seen[name]) return;
    this.seen[name] = true;
    this.lines.push('# HELP ' + name + ' ' + help, '# TYPE ' + name + ' ' + type);
};
Out.prototype.sample = function (name, labels, value) {
    var l = [];
    for (var k in labels) if (Object.prototype.hasOwnProperty.call(labels, k)) l.push(k + '="' + esc(labels[k]) + '"');
    this.lines.push(name + (l.length ? '{' + l.join(',') + '}' : '') + ' ' + num(value));
};
Out.prototype.text = function () { return this.lines.join('\n') + '\n'; };

// Each source adds its metrics and returns true, or returns false when its files are missing on this TV.
var SOURCES = {
    cpu: function (o, fsx) {
        var t = fsx('/proc/stat'); if (!t) return false;
        t.split('\n').forEach(function (line) {
            var p = line.trim().split(/\s+/);
            if (/^cpu\d+$/.test(p[0])) {
                o.family('node_cpu_seconds_total', 'counter', 'Seconds the CPUs spent in each mode.');
                CPU_MODES.forEach(function (mode, i) { if (p[i + 1] !== undefined) o.sample('node_cpu_seconds_total', { cpu: p[0].slice(3), mode: mode }, Number(p[i + 1]) / USER_HZ); });
            } else if (p[0] === 'btime') {
                o.family('node_boot_time_seconds', 'gauge', 'Node boot time, in unixtime.'); o.sample('node_boot_time_seconds', {}, Number(p[1]));
            } else if (p[0] === 'ctxt') {
                o.family('node_context_switches_total', 'counter', 'Total number of context switches.'); o.sample('node_context_switches_total', {}, Number(p[1]));
            } else if (p[0] === 'intr') {
                o.family('node_intr_total', 'counter', 'Total number of interrupts serviced.'); o.sample('node_intr_total', {}, Number(p[1]));
            } else if (p[0] === 'processes') {
                o.family('node_forks_total', 'counter', 'Total number of forks.'); o.sample('node_forks_total', {}, Number(p[1]));
            } else if (p[0] === 'procs_running' || p[0] === 'procs_blocked') {
                var n = 'node_' + p[0];
                o.family(n, 'gauge', p[0] === 'procs_running' ? 'Number of processes in runnable state.' : 'Number of processes blocked waiting for I/O to complete.');
                o.sample(n, {}, Number(p[1]));
            }
        });
        return true;
    },
    load: function (o, fsx) {
        var t = fsx('/proc/loadavg'); if (!t) return false;
        var p = t.trim().split(/\s+/);
        ['node_load1', 'node_load5', 'node_load15'].forEach(function (n, i) { o.family(n, 'gauge', i === 0 ? '1m load average.' : i === 1 ? '5m load average.' : '15m load average.'); o.sample(n, {}, Number(p[i])); });
        var procs = (p[3] || '').split('/');
        if (procs.length === 2) { o.family('tv_processes', 'gauge', 'Number of processes (threads) on the TV.'); o.sample('tv_processes', {}, Number(procs[1])); }
        return true;
    },
    memory: function (o, fsx) {
        var t = fsx('/proc/meminfo'); if (!t) return false;
        t.split('\n').forEach(function (line) {
            var m = /^([A-Za-z0-9_()]+):\s+(\d+)(\s+kB)?/.exec(line); if (!m) return;
            var n = 'node_memory_' + m[1].replace(/\((\w+)\)/, '_$1').replace(/[^A-Za-z0-9_]/g, '_') + (m[3] ? '_bytes' : '');
            o.family(n, 'gauge', 'Memory information field ' + m[1] + '.');
            o.sample(n, {}, Number(m[2]) * (m[3] ? 1024 : 1));
        });
        return true;
    },
    network: function (o, fsx) {
        var t = fsx('/proc/net/dev'); if (!t) return false;
        var cols = ['bytes', 'packets', 'errs', 'drop', 'fifo', 'frame', 'compressed', 'multicast'];
        var tcols = ['bytes', 'packets', 'errs', 'drop', 'fifo', 'colls', 'carrier', 'compressed'];
        t.split('\n').slice(2).forEach(function (line) {
            var m = /^\s*([^:\s]+):\s*(.*)$/.exec(line); if (!m) return;
            var v = m[2].trim().split(/\s+/).map(Number), dev = m[1];
            [['receive', cols, 0], ['transmit', tcols, 8]].forEach(function (d) {
                ['bytes', 'packets', 'errs', 'drop'].forEach(function (c) {
                    var n = 'node_network_' + d[0] + '_' + c + '_total';
                    o.family(n, 'counter', 'Network device statistic ' + d[0] + '_' + c + '.');
                    o.sample(n, { device: dev }, v[d[2] + d[1].indexOf(c)]);
                });
            });
        });
        return true;
    },
    wifi: function (o, fsx) {
        var t = fsx('/proc/net/wireless'); if (!t) return false;
        var found = false;
        t.split('\n').slice(2).forEach(function (line) {
            var m = /^\s*([^:\s]+):\s+\S+\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(line); if (!m) return;
            found = true;
            // Signal and noise are dBm; drivers that report them unsigned add 256 (230 means -26 dBm).
            var dbm = function (v) { v = parseFloat(v); return v > 63 ? v - 256 : v; };
            o.family('tv_wifi_link_quality', 'gauge', 'Wi-Fi link quality as reported by the driver.'); o.sample('tv_wifi_link_quality', { device: m[1] }, parseFloat(m[2]));
            o.family('tv_wifi_signal_dbm', 'gauge', 'Wi-Fi signal level in dBm.'); o.sample('tv_wifi_signal_dbm', { device: m[1] }, dbm(m[3]));
            o.family('tv_wifi_noise_dbm', 'gauge', 'Wi-Fi noise level in dBm.'); o.sample('tv_wifi_noise_dbm', { device: m[1] }, dbm(m[4]));
        });
        return found;
    },
    temperature: function (o, fsx, ls) {
        // Samsung SoCs have no /sys/class/thermal: the reading is a platform device's "temperature" file, in °C.
        var found = false;
        THERMAL_ROOTS.forEach(function (root) {
            (ls(root) || []).forEach(function (name) {
                if (found || !/thermal/.test(name)) return;
                var v = fsx(path.join(root, name, 'temperature'));
                if (v === null || !/^-?\d+(\.\d+)?\s*$/.test(v)) return;
                v = Number(v); if (Math.abs(v) > 1000) v = v / 1000; // millidegrees on some kernels
                o.family('tv_soc_temperature_celsius', 'gauge', 'SoC temperature in degrees Celsius.');
                o.sample('tv_soc_temperature_celsius', { sensor: name }, v);
                found = true;
            });
        });
        return found;
    },
    filesystem: function (o) {
        // Only where Node has statfs (18.15+); without root there is no other way to read sizes.
        if (typeof fs.statfsSync !== 'function') return false;
        var ok = false;
        ['/opt', '/tmp'].forEach(function (mp) {
            try {
                var s = fs.statfsSync(mp);
                o.family('node_filesystem_size_bytes', 'gauge', 'Filesystem size in bytes.'); o.sample('node_filesystem_size_bytes', { mountpoint: mp }, s.blocks * s.bsize);
                o.family('node_filesystem_avail_bytes', 'gauge', 'Filesystem space available to non-root users in bytes.'); o.sample('node_filesystem_avail_bytes', { mountpoint: mp }, s.bavail * s.bsize);
                ok = true;
            } catch (e) { /* not mounted here */ }
        });
        return ok;
    }
};

function collect(fsx, ls, now) {
    var o = new Out(), started = Date.now(), up = {};
    Object.keys(SOURCES).forEach(function (k) {
        try { up[k] = SOURCES[k](o, fsx, ls) ? 1 : 0; } catch (e) { up[k] = 0; }
    });
    var d = new Date(now);
    o.family('node_time_seconds', 'gauge', 'System time in seconds since epoch (1970).'); o.sample('node_time_seconds', {}, now / 1000);
    o.family('tv_time_zone_offset_seconds', 'gauge', 'Offset of the TV local time from UTC, as Vetro sees it.'); o.sample('tv_time_zone_offset_seconds', {}, -d.getTimezoneOffset() * 60);
    o.family('tv_exporter_source_up', 'gauge', '1 when a metric source could be read on this TV.');
    Object.keys(up).forEach(function (k) { o.sample('tv_exporter_source_up', { source: k }, up[k]); });
    o.family('tv_exporter_build_info', 'gauge', 'Version of the Prometheus exporter Shard.'); o.sample('tv_exporter_build_info', { version: VERSION, node: process.version }, 1);
    o.family('tv_exporter_collect_duration_seconds', 'gauge', 'Time spent collecting the metrics.'); o.sample('tv_exporter_collect_duration_seconds', {}, (Date.now() - started) / 1000);
    return { text: o.text(), up: up, at: now };
}

function defaultLs(dir) { try { return fs.readdirSync(dir); } catch (e) { return null; } }

// The page is rendered here from the same cached readings: no script, no extra file.
function html(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function value(text, re) { var m = re.exec(text); return m ? Number(m[1]) : null; }
function renderPage(m, host) {
    var t = m.text, target = /^[A-Za-z0-9.:\[\]-]{1,100}$/.test(host || '') ? host : 'TV_IP:8099';
    var mem = value(t, /^node_memory_MemTotal_bytes (\S+)$/m), avail = value(t, /^node_memory_MemAvailable_bytes (\S+)$/m);
    var tiles = [
        ['SoC temperature', value(t, /^tv_soc_temperature_celsius\{[^}]*\} (\S+)$/m), ' °C'],
        ['Load (1 min)', value(t, /^node_load1 (\S+)$/m), ''],
        ['Memory used', mem && avail !== null ? Math.round((mem - avail) / mem * 100) : null, ' %'],
        ['Wi-Fi signal', value(t, /^tv_wifi_signal_dbm\{[^}]*\} (\S+)$/m), ' dBm']
    ].map(function (x) { return '<div class="tile"><b>' + (x[1] === null ? '—' : html(Math.round(x[1] * 10) / 10) + x[2]) + '</b><span>' + x[0] + '</span></div>'; }).join('');
    var sources = Object.keys(m.up).map(function (k) { return '<span class="src ' + (m.up[k] ? 'on' : 'off') + '">' + html(k) + (m.up[k] ? '' : ' · not on this TV') + '</span>'; }).join('');
    var yml = '  - job_name: samsung-tv\n    scrape_interval: 30s\n    metrics_path: /plugins/prometheus/api/metrics\n' +
        '    authorization:\n      type: Bearer\n      credentials_file: /etc/prometheus/vetro-token   # a Vetro pairing token\n' +
        '    static_configs:\n      - targets: [\'' + target + '\']';
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<meta name="color-scheme" content="light dark"><title>Prometheus exporter</title><style>' +
        ':root{--bg:#080f23;--surface:#101c35;--raised:#192943;--border:#344360;--text:#f5f8ff;--muted:#aab8d1;--ok:#7fcba0}' +
        '@media (prefers-color-scheme:light){:root{--bg:#f5f8ff;--surface:#fff;--raised:#eef2fb;--border:#c9d3e6;--text:#0b1430;--muted:#4a5878;--ok:#1e7a4a}}' +
        '*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif}' +
        '.panel{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:16px;margin:0 0 16px;max-width:820px}' +
        'h2{margin:0 0 8px;font-size:16px}p{margin:0 0 8px}.note{color:var(--muted);font-size:12px}' +
        'pre,code{font:12px/1.45 ui-monospace,Menlo,Consolas,monospace}pre{margin:8px 0 0;padding:12px;background:var(--raised);border:1px solid var(--border);border-radius:8px;overflow:auto}' +
        '.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}.tile{background:var(--raised);border:1px solid var(--border);border-radius:10px;padding:10px 12px}' +
        '.tile b{display:block;font-size:20px}.tile span{color:var(--muted);font-size:12px}.src{display:inline-block;margin:0 6px 4px 0;padding:1px 8px;border:1px solid var(--border);border-radius:99px;font-size:12px}' +
        '.src.on{color:var(--ok)}.src.off{color:var(--muted)}a{color:inherit}</style></head><body>' +
        '<div class="panel"><h2>Now</h2><div class="tiles">' + tiles + '</div><p class="note" style="margin-top:8px">Read ' + html(new Date(m.at).toLocaleTimeString()) + ' · cached ' + (CACHE_MS / 1000) + ' s · <a href="">refresh</a></p>' + sources + '</div>' +
        '<div class="panel"><h2>Scrape it</h2><p>Address: <code>http://' + html(target) + '/plugins/prometheus/api/metrics</code></p>' +
        '<p class="note">Vetro answers only paired devices: pair one for Prometheus (Vetro\'s sign-in guide, "Pair a script") and give it the token as a Bearer token. Add this under <code>scrape_configs:</code> in <code>prometheus.yml</code>:</p><pre>' + html(yml) + '</pre></div>' +
        '<div class="panel"><h2>Metrics</h2><pre>' + html(t) + '</pre></div></body></html>';
}

module.exports = function (ctx, deps) {
    deps = deps || {};
    var fsx = deps.read || read, ls = deps.ls || defaultLs, clock = deps.now || function () { return Date.now(); };
    var cache = null, scrapes = 0;
    function metrics() {
        var now = clock();
        if (!cache || now - cache.at >= CACHE_MS || now < cache.at) cache = collect(fsx, ls, now);
        return cache;
    }
    return {
        start: function () { cache = null; },
        stop: function () { cache = null; },
        status: function () { return { scrapes: scrapes, sources: cache ? cache.up : null }; },
        route: function (req, res, sub) {
            if (req.method !== 'GET') return false;
            if (sub === 'metrics') {
                var m = metrics(); scrapes++;
                res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
                res.end(m.text);
                return true;
            }
            if (sub === 'ui') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(renderPage(metrics(), req.headers && req.headers.host));
                return true;
            }
            if (sub === 'info') {
                var c = metrics();
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ version: VERSION, scrapes: scrapes, sources: c.up, at: c.at, cacheSeconds: CACHE_MS / 1000 }));
                return true;
            }
            return false;
        }
    };
};
module.exports.collect = collect;
module.exports.VERSION = VERSION;
