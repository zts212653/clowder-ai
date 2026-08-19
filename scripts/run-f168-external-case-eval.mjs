#!/usr/bin/env node

/**
 * F168 External Case Closure telemetry runner.
 *
 * Writes one F168-only snapshot + attribution pair for Eval Hub publication.
 * It intentionally does not reuse the F167 snapshot: sharing that aggregate
 * would make unrelated no-traffic domains lower each other's confidence.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  findingFingerprint,
  generateAttributionReport,
} from '../packages/api/dist/infrastructure/harness-eval/attribution.js';
import { generateExternalCaseClosureSnapshot } from '../packages/api/dist/infrastructure/harness-eval/external-case-closure-eval.js';
import {
  fetchMetrics,
  fetchProcessInfo,
  fetchTracesStats,
} from '../packages/api/dist/infrastructure/harness-eval/telemetry-adapter.js';
import { formatAttributionYaml, formatSnapshotYaml } from './lib/format-eval-yaml.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    cookie: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    store: { type: 'boolean', default: false },
  },
});

const baseUrl = values['base-url'] || process.env.EVAL_BASE_URL || 'http://localhost:3004';
const cookie = values.cookie || process.env.EVAL_SESSION_COOKIE || '';
const dryRun = values['dry-run'] ?? false;
const storeMode = values.store ?? false;
const dateStr = new Date().toISOString().slice(0, 10);

function parseMetricsText(text) {
  const metrics = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const spaceIndex = line.lastIndexOf(' ');
    if (spaceIndex < 0) continue;
    const value = Number.parseFloat(line.slice(spaceIndex + 1));
    if (!Number.isNaN(value)) metrics[line.slice(0, spaceIndex)] = value;
  }
  return metrics;
}

async function main() {
  const config = { baseUrl, cookie };
  console.log(`F168 External Case Closure Eval - ${dateStr}`);
  console.log(`  baseUrl: ${baseUrl}`);
  console.log(`  dryRun: ${dryRun}`);

  const [traceStats, metricsText, processInfo] = await Promise.all([
    fetchTracesStats(config),
    fetchMetrics(config),
    fetchProcessInfo(config).catch((error) => {
      console.warn(`  warn: fetchProcessInfo failed (${error.message}) - counterWindow omitted`);
      return null;
    }),
  ]);
  const metrics = parseMetricsText(metricsText);
  const snapshot = generateExternalCaseClosureSnapshot({
    metrics,
    traceStats,
    ...(processInfo ? { processStartMs: processInfo.processStartMs, processUptimeSec: processInfo.uptimeSec } : {}),
  });
  const report = generateAttributionReport({ featureId: 'F168', snapshot });

  console.log(
    `  confidence: ${snapshot.overallConfidence} | findings: ${report.findings.length} | ` +
      `gaps: ${snapshot.components[0].telemetryGaps.length}`,
  );

  const snapshotDir = join(ROOT, 'docs/harness-feedback/snapshots');
  const attributionDir = join(ROOT, 'docs/harness-feedback/attributions');
  mkdirSync(snapshotDir, { recursive: true });
  mkdirSync(attributionDir, { recursive: true });
  const snapshotPath = join(snapshotDir, `${dateStr}-F168-external-case-eval.yaml`);
  const attributionPath = join(attributionDir, `${dateStr}-F168-external-case-attribution.yaml`);

  if (storeMode && existsSync(snapshotPath) && existsSync(attributionPath)) {
    console.log('  DEDUP: snapshot and attribution already exist; no overwrite.');
    return;
  }

  const snapshotYaml = formatSnapshotYaml(snapshot, dateStr);
  const attributionYaml = formatAttributionYaml(report, dateStr, findingFingerprint);
  if (dryRun) {
    console.log('\n--- SNAPSHOT (dry-run) ---');
    console.log(snapshotYaml);
    console.log('\n--- ATTRIBUTION (dry-run) ---');
    console.log(attributionYaml);
    return;
  }

  writeFileSync(snapshotPath, snapshotYaml, 'utf8');
  writeFileSync(attributionPath, attributionYaml, 'utf8');
  console.log(`  snapshot: ${snapshotPath}`);
  console.log(`  attribution: ${attributionPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
