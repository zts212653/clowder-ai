/**
 * F192 sop-wiring: SOP live verdict generator (file-writer layer).
 *
 * Mirrors eval-memory-live-verdict.ts pattern:
 *   1. Validate verdictId slug
 *   2. Write raw inputs (trace.json + eval-results.json) at
 *      `<repoRoot>/generated/sop/<verdictId>/` — referenced by provenance sha256
 *   3. Build snapshot.json + attribution.json conforming to shared a2a bundle schema
 *      (required by eval-hub-read-model.ts → resolveA2aEvidenceBundle)
 *   4. Render verdict.md with YAML frontmatter (feedback_type: live-verdict) +
 *      standard bullet format consumed by Eval Hub
 *
 * Cat-submitted packet wins; generator only overrides bundle refs in evidencePacket.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from '../verdict-handoff.js';
import { buildSopAttribution, buildSopSnapshot } from './eval-sop-bundle-builder.js';
import type { SopEvalResult } from './sop-predicate-evaluator.js';
import type { SopTrace } from './sop-trace-adapter.js';

const SAFE_VERDICT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SANITIZE_RULES_VERSION = 'f192-sop-trace-v1';

export interface GenerateSopLiveVerdictInput {
  verdictId: string;
  harnessFeedbackRoot: string;
  trace: SopTrace;
  evalResults: readonly SopEvalResult[];
  submittedPacket: VerdictHandoffPacket;
  generatedAt?: string;
  generatorCommit?: string;
}

export interface SopLiveVerdictArtifact {
  path: string;
  bundleDir: string;
  rawInputDir: string;
  packet: VerdictHandoffPacket;
  markdown: string;
  refs: {
    bundleDir: string;
    snapshotRef: string;
    attributionRefs: string[];
  };
  isLive: true;
}

export function generateSopLiveVerdict(input: GenerateSopLiveVerdictInput): SopLiveVerdictArtifact {
  assertSafeVerdictId(input.verdictId);

  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const generatedAt = input.generatedAt ?? input.submittedPacket.createdAt;
  const featureId = input.submittedPacket.harnessUnderEval.featureId;
  const evalSnapshotId = `sop-${input.verdictId}`;

  // ---- Raw inputs (outside bundle, referenced by provenance sha256) ----
  const repoRoot = dirname(dirname(input.harnessFeedbackRoot));
  const rawInputDir = join(repoRoot, 'generated', 'sop', input.verdictId);
  mkdirSync(rawInputDir, { recursive: true });

  const rawTracePath = join(rawInputDir, 'trace.json');
  const rawResultsPath = join(rawInputDir, 'eval-results.json');

  writeJson(rawTracePath, {
    verdictId: input.verdictId,
    featureId,
    generatedAt,
    trace: input.trace,
  });
  writeJson(rawResultsPath, {
    verdictId: input.verdictId,
    featureId,
    generatedAt,
    evalResults: input.evalResults,
  });

  // ---- Bundle artifacts (shared a2a schema required by eval-hub-read-model) ----
  const snapshot = buildSopSnapshot({
    verdictId: input.verdictId,
    evalSnapshotId,
    featureId,
    generatedAt,
    trace: input.trace,
    evalResults: input.evalResults,
  });

  const attribution = buildSopAttribution({
    verdictId: input.verdictId,
    evalSnapshotId,
    featureId,
    generatedAt,
    trace: input.trace,
    evalResults: input.evalResults,
    packet: input.submittedPacket,
  });

  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [
      { path: repoRelativePath(rawTracePath, repoRoot), sha256: sha256File(rawTracePath) },
      { path: repoRelativePath(rawResultsPath, repoRoot), sha256: sha256File(rawResultsPath) },
    ],
    generatedAt,
    generator: {
      name: 'eval-sop-live-verdict',
      version: '2',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
  };

  writeJson(join(bundleDir, 'snapshot.json'), snapshot);
  writeJson(join(bundleDir, 'attribution.json'), attribution);
  writeJson(join(bundleDir, 'provenance.json'), provenance);

  // ---- Resolve canonical bundle refs (shared a2a schema validation + format) ----
  // Must call resolveA2aEvidenceBundle AFTER writing bundle files — it reads them
  // back, validates via Zod, and returns canonical `snapshot:bundle/…` refs that
  // eval-hub-read-model.ts expects. Mirrors eval-memory-live-verdict.ts:151.
  const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId: input.verdictId });
  const basePacket = input.submittedPacket;
  const packetWithBundleRefs = parseVerdictHandoffPacket({
    ...basePacket,
    evidencePacket: {
      ...basePacket.evidencePacket,
      snapshotRefs: [resolved.snapshotRef],
      attributionRefs: resolved.attributionRefs,
    },
  });

  // ---- Render verdict.md (frontmatter + standard bullet format for Hub) ----
  const markdown = formatSopVerdictMarkdown(
    input.verdictId,
    packetWithBundleRefs,
    resolved.snapshotRef,
    input.evalResults,
  );
  writeFileSync(verdictPath, markdown, 'utf8');

  return {
    path: verdictPath,
    bundleDir,
    rawInputDir,
    packet: packetWithBundleRefs,
    markdown,
    refs: {
      bundleDir,
      snapshotRef: resolved.snapshotRef,
      attributionRefs: resolved.attributionRefs,
    },
    isLive: true,
  };
}

// ---- Markdown renderer (mirrors eval-memory-renderer.ts contract) ----

function formatSopVerdictMarkdown(
  verdictId: string,
  packet: VerdictHandoffPacket,
  sourceSnapshotRef: string,
  evalResults: readonly SopEvalResult[],
): string {
  const violations = evalResults.filter((r) => r.status === 'violation');
  const passed = evalResults.filter((r) => r.status === 'pass');
  const skipped = evalResults.filter((r) => r.status === 'skipped');

  const lines: string[] = [
    // YAML frontmatter required by eval-hub-read-model.ts (lines 128-132)
    '---',
    `feature_ids: [F192, ${packet.harnessUnderEval.featureId}]`,
    'topics: [harness-eval, sop-compliance, live-verdict]',
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    'domain_id: eval:sop',
    `packet_id: ${packet.id}`,
    'window_days: 14',
    `source_snapshot: "${sourceSnapshotRef}"`,
    '---',
    '',
    `# Live Verdict — ${verdictId}`,
    '',
    // Standard bullet format expected by eval-hub-read-model.ts (lines 205-218)
    `- Verdict: \`${packet.verdict}\``,
    `- Phenomenon: ${packet.phenomenon}`,
    `- Harness: ${packet.harnessUnderEval.featureId}/${packet.harnessUnderEval.componentId} (sop-compliance)`,
    `- Owner ask: ${packet.ownerAsk.requestedAction}`,
    `- Re-eval: next eval at ${packet.acceptanceReevalPlan.nextEvalAt}`,
    '',
    'Evidence:',
    ...packet.evidencePacket.snapshotRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.attributionRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.metricRefs.map((ref) => `- metric:${ref.startsWith('metric:') ? ref.slice(7) : ref}`),
    '',
    // SOP-specific detail section (below the Hub-consumed header)
    '## SOP Evaluation Detail',
    '',
    `| Status | Count |`,
    `|--------|-------|`,
    `| Passed | ${passed.length} |`,
    `| Violations | ${violations.length} |`,
    `| Skipped (manual) | ${skipped.length} |`,
    '',
  ];

  if (violations.length > 0) {
    lines.push('## Violations', '');
    for (const v of violations) {
      lines.push(
        `### ${v.ruleId} (${v.violation?.severity ?? 'unknown'})`,
        '',
        `- Stage: ${v.violation?.stageId ?? 'unknown'}`,
        `- Predicate: ${v.violation?.predicateType ?? 'unknown'}`,
        `- Message: ${v.violation?.message ?? 'no message'}`,
        `- Trace Anchor: ${v.violation?.traceAnchor ?? 'none'}`,
        '',
      );
    }
  }

  return lines.join('\n');
}

// ---- Helpers ----

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function repoRelativePath(path: string, repoRoot: string): string {
  return relative(repoRoot, path).replace(/\\/g, '/');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertSafeVerdictId(verdictId: string): void {
  if (!SAFE_VERDICT_ID_PATTERN.test(verdictId)) {
    throw new Error('verdictId must be a safe slug');
  }
}
