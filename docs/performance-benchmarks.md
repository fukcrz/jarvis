# Performance Benchmarks

Jarvis performance baselines live under `bench/` and produce isolated JSON plus Markdown reports under `.tmp/benchmarks/`.

## Coverage

- HTTP application handling versus real loopback HTTP.
- Cold and warm session JSONL, projection, runtime, and workspace file reads.
- WebSocket connection setup, session fan-out, subscriber scaling, delivery completeness, ordering, bytes, and publish-to-receive latency.
- Production-build browser startup and hydration on desktop and mobile, session switching, same-page A→B→A transcript-cache restoration with stale-response checks, history loading, streaming delta coalescing, rich Markdown/tool-heavy DOM work, composer interaction, Chromium runtime metrics, Long Tasks, layout shifts, resource bytes, and heap/DOM indicators.

## Isolation

Every runner uses temporary fixture roots and isolated `JARVIS_HOME`, `PI_CODING_AGENT_DIR`, and `PI_CODING_AGENT_SESSION_DIR` values. Fastify listens on `127.0.0.1` with port `0`; the production service on port `9528` is not touched. Cleanup runs after normal completion and error paths.

## Baseline workflow

1. Build the server and client with `npm run build`.
2. Install the existing Playwright Chromium browser once with `npm exec playwright install chromium`.
3. Run `quick` to validate the environment.
4. Run repeated `standard` profiles on a stable host.
5. Compare matching summaries with `bench/compare.mjs`; the comparator requires the same runner kind and profile.

The benchmark suite intentionally does not fail CI on latency thresholds yet. The comparison report uses UI business metrics such as same-page `switchBackMs` and socket-to-DOM latency when present, while retaining runner duration for context. First collect stable p50/p95/p99 distributions and then introduce thresholds per scenario if the noise envelope is understood.
