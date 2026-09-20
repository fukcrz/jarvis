# Jarvis Performance Benchmarks

This directory contains isolated, repeatable performance runners for the Jarvis server and production client.

## Prerequisites

```text
npm run build
npm exec playwright install chromium
```

The runners require Node 24+, use only existing project dependencies, and never use port `9528`. Each run creates temporary fixture data under the system temp directory, sets isolated Jarvis/Pi environment paths, binds Fastify to `127.0.0.1:0`, and removes fixtures and sockets on exit.

## Profiles

- `quick`: short smoke baseline for local validation.
- `standard`: representative baseline for comparison.
- `stress`: larger session, workspace, event, and subscriber fixtures.

All runners accept `--profile`, `--out`, `--iterations`, and `--warmup`. The UI runner also accepts `--cpu-throttle` and `--headful`.

## Runners

```text
node bench/http.mjs --profile quick --out .tmp/benchmarks/http-quick
node bench/disk.mjs --profile standard --out .tmp/benchmarks/disk-standard
node bench/websocket.mjs --profile standard --out .tmp/benchmarks/ws-standard
node bench/ui.mjs --profile quick --out .tmp/benchmarks/ui-quick
```

Each runner writes `summary.json` and `report.md` to its output directory.

- `http.mjs` compares Fastify `app.inject` with real loopback `fetch` for health, workspace, session, timeline, runtime, and file-search endpoints.
- `disk.mjs` measures cold app/fixture reconstruction and warm session, timeline, runtime, and workspace search reads.
- `websocket.mjs` measures connection setup, real WebSocket fan-out at multiple subscriber counts, delivery completeness, sequence order, payload bytes, latency, event-loop delay, and direct in-process EventHub cost.
- `ui.mjs` measures desktop/mobile production navigation, session switching, same-page A→B→A transcript-cache restoration, stale-response protection, history prepend, assistant delta delivery, burst coalescing, rich Markdown rendering, composer input, CDP runtime deltas, Long Tasks, layout shifts, resources, DOM scale, and browser errors.

## Comparing runs

Compare two `summary.json` files from the same runner and profile on the same machine class. The comparator rejects mismatched runner kinds or profiles and uses UI business metrics such as `switchBackMs` for same-page roundtrips and `socketToDomMs` for stream scenarios:

```text
node bench/compare.mjs before/summary.json after/summary.json --out .tmp/benchmarks/compare
```

The comparator writes `comparison.json` and `comparison.md`. Positive latency deltas are possible regressions, but a single quick run is not a gate. Use repeated standard runs and compare p95/p99 together with application errors, browser errors, RSS, and event-loop delay.

## Interpretation

Keep host, Node, Chromium, build mode, and profile stable when comparing baselines. `app.inject` isolates application handling; `fetch` includes TCP/HTTP loopback overhead; real WebSocket scenarios include framing and network scheduling; direct EventHub scenarios intentionally exclude those costs. Browser CDP metrics are Chromium-relative and should be compared with the same browser version.

The first benchmark version is observational, not a CI hard gate. Promote a metric to a threshold only after collecting stable baselines across repeated runs.
