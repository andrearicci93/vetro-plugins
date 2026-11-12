# Prometheus exporter

Prometheus metrics for the TV, for Grafana or any Prometheus server: CPU, load, memory, swap, network, Wi-Fi
signal, SoC temperature, uptime. Names follow `node_exporter` where the meaning is the same (`node_cpu_seconds_total`,
`node_memory_*`, `node_network_*`, `node_load1`…), so existing dashboards partly work. TV-only metrics start with
`tv_`. A **Prometheus** tab shows a few live readings, the scrape address, a ready-to-paste `prometheus.yml` block
and the raw metrics.

## Permissions

None. Everything is read from `/proc` and `/sys` as Vetro's own service user: no root, no commands.

## Commands it runs

None. It reads these files, with `fs`:

| File | Metrics |
| --- | --- |
| `/proc/stat` | `node_cpu_seconds_total`, `node_boot_time_seconds`, `node_context_switches_total`, `node_intr_total`, `node_forks_total`, `node_procs_running`, `node_procs_blocked` |
| `/proc/loadavg` | `node_load1`, `node_load5`, `node_load15`, `tv_processes` |
| `/proc/meminfo` | `node_memory_*` (every field; `Active(anon)` becomes `Active_anon`) |
| `/proc/net/dev` | `node_network_{receive,transmit}_{bytes,packets,errs,drop}_total` |
| `/proc/net/wireless` | `tv_wifi_link_quality`, `tv_wifi_signal_dbm`, `tv_wifi_noise_dbm` |
| `/sys/devices/platform/soc/*thermal*/temperature` | `tv_soc_temperature_celsius` (Samsung SoCs have no `/sys/class/thermal`) |
| — (Node `fs.statfs`, only on Node 18.15+) | `node_filesystem_size_bytes`, `node_filesystem_avail_bytes` for `/opt` and `/tmp` |

Plus `node_time_seconds`, `tv_time_zone_offset_seconds`, `tv_exporter_source_up{source}` (1 when a source could be
read on this TV), `tv_exporter_build_info` and `tv_exporter_collect_duration_seconds`. A missing file only turns its
source to 0. Readings are cached for 5 seconds, so frequent scrapes do not load the TV.

## Network

None of its own: it makes no connection. It answers `GET /plugins/prometheus/api/metrics` on Vetro's port, which,
like every Vetro route, only paired devices can reach.

## Scrape it

1. Pair a device for Prometheus with Vetro ("Pair a script" in Vetro's sign-in guide) and keep the token in a file
   only Prometheus can read.
2. Add to `scrape_configs` in `prometheus.yml` (the tab shows this with your TV's address):

   ```yaml
   - job_name: samsung-tv
     scrape_interval: 30s
     metrics_path: /plugins/prometheus/api/metrics
     authorization:
       type: Bearer
       credentials_file: /etc/prometheus/vetro-token
     static_configs:
       - targets: ['TV_IP:8099']
   ```

## Data it keeps

None. It does not use `ctx.config` or write any file.

## Tested

Samsung QE43Q60BAUXXN (Q60B, 2022, firmware T-NKLBDEUC-1720.7), Tizen 6.5, kernel 5.4, ARMv7, Vetro 0.5.0, Node
v12.16.3, installed from a file. **Other models are untested.**

- 274 lines of metrics through Vetro with a paired token, collected in 24 ms; every source up except `filesystem`
  (Node 12 has no `statfs`), SoC temperature 41 °C, Wi-Fi signal -26 dBm, time zone offset 3600 s (CET).
- Tests parse files captured from that TV and check every line against the exposition format.
