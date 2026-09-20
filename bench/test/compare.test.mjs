import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compareReports, renderComparisonMarkdown } from "../compare.mjs";

function metrics(p50, p95, p99) {
  return { count: 3, p50, p95, p99, mean: p50, min: p50, max: p99, total: p50 * 3 };
}

async function writeReport(directory, name, report) {
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(report)}\n`, "utf8");
  return path;
}

describe("benchmark comparisons", () => {
  it("uses the UI primary metric and includes browser errors in deltas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-bench-compare-"));
    try {
      const beforePath = await writeReport(directory, "before.json", {
        kind: "ui",
        profile: "standard",
        runId: "before",
        scenarios: [{
          name: "stream-single-delta",
          metrics: metrics(100, 110, 120),
          errors: [],
          frontend: { socketToDomMs: metrics(4, 6, 8), browserErrors: ["console.warn"] },
        }],
      });
      const afterPath = await writeReport(directory, "after.json", {
        kind: "ui",
        profile: "standard",
        runId: "after",
        scenarios: [{
          name: "stream-single-delta",
          metrics: metrics(120, 130, 140),
          errors: [],
          frontend: { socketToDomMs: metrics(7, 9, 11), browserErrors: ["console.warn", "pageerror"] },
        }],
      });

      const result = await compareReports(beforePath, afterPath);
      const scenario = result.scenarios[0];
      assert.equal(scenario.primary.before, "socketToDomMs");
      assert.equal(scenario.primary.after, "socketToDomMs");
      assert.equal(scenario.primary.values.p95.delta, 3);
      assert.equal(scenario.metrics.p95.delta, 20);
      assert.equal(scenario.errors.delta, 1);
      assert.equal(scenario.browserErrors.delta, 1);
      assert.equal(result.summary.regressionsP95, 1);
      assert.equal(result.summary.errorDelta, 1);

      const markdown = renderComparisonMarkdown(result);
      assert.match(markdown, /socketToDomMs/);
      assert.match(markdown, /Browser errors Δ/);
      assert.match(markdown, /\+3\.000/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses switch-back timing for same-page roundtrip scenarios", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-bench-compare-"));
    try {
      const beforePath = await writeReport(directory, "before.json", {
        kind: "ui",
        profile: "standard",
        scenarios: [{
          name: "session-roundtrip-desktop",
          metrics: metrics(100, 110, 120),
          errors: [],
          frontend: { switchBackMs: metrics(40, 50, 60), browserErrors: [] },
        }],
      });
      const afterPath = await writeReport(directory, "after.json", {
        kind: "ui",
        profile: "standard",
        scenarios: [{
          name: "session-roundtrip-desktop",
          metrics: metrics(90, 100, 110),
          errors: [],
          frontend: { switchBackMs: metrics(25, 35, 45), browserErrors: [] },
        }],
      });

      const result = await compareReports(beforePath, afterPath);
      const scenario = result.scenarios[0];
      assert.equal(scenario.primary.before, "switchBackMs");
      assert.equal(scenario.primary.after, "switchBackMs");
      assert.equal(scenario.primary.values.p95.delta, -15);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("handles added and removed scenarios without throwing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-bench-compare-"));
    try {
      const beforePath = await writeReport(directory, "before.json", {
        kind: "http",
        profile: "quick",
        scenarios: [{ name: "removed", metrics: metrics(1, 2, 3), errors: [] }],
      });
      const afterPath = await writeReport(directory, "after.json", {
        kind: "http",
        profile: "quick",
        scenarios: [{ name: "added", metrics: metrics(4, 5, 6), errors: [] }],
      });

      const result = await compareReports(beforePath, afterPath);
      assert.equal(result.summary.added, 1);
      assert.equal(result.summary.removed, 1);
      assert.equal(result.summary.compared, 0);
      assert.equal(result.summary.regressionsP95, 0);
      assert.match(renderComparisonMarkdown(result), /\| added \| added \|/);
      assert.match(renderComparisonMarkdown(result), /\| removed \| removed \|/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back to duration when only one side has UI metrics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-bench-compare-"));
    try {
      const beforePath = await writeReport(directory, "before.json", {
        kind: "ui",
        profile: "standard",
        scenarios: [{ name: "session-switch-desktop", metrics: metrics(100, 110, 120), errors: [] }],
      });
      const afterPath = await writeReport(directory, "after.json", {
        kind: "ui",
        profile: "standard",
        scenarios: [{
          name: "session-switch-desktop",
          metrics: metrics(150, 160, 170),
          errors: [],
          frontend: { switchMs: metrics(7, 9, 11), browserErrors: [] },
        }],
      });

      const result = await compareReports(beforePath, afterPath);
      const scenario = result.scenarios[0];
      assert.equal(scenario.primary.before, "durationMs");
      assert.equal(scenario.primary.after, "durationMs");
      assert.equal(scenario.primary.values.p95.delta, 50);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects reports with different kinds or profiles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-bench-compare-"));
    try {
      const base = {
        runId: "run",
        scenarios: [],
      };
      const httpPath = await writeReport(directory, "http.json", { ...base, kind: "http", profile: "quick" });
      const uiPath = await writeReport(directory, "ui.json", { ...base, kind: "ui", profile: "quick" });
      const standardPath = await writeReport(directory, "standard.json", { ...base, kind: "http", profile: "standard" });

      await assert.rejects(compareReports(httpPath, uiPath), /different benchmark kinds/);
      await assert.rejects(compareReports(httpPath, standardPath), /different benchmark profiles/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
