import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import type { MemoryLibraryHealth, MemoryRecallMetrics } from '../eval-memory-adapter.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from '../verdict-handoff.js';
import { buildAttribution, buildSnapshot } from './eval-memory-bundle-builder.js';
import { formatLiveVerdictMarkdown } from './eval-memory-renderer.js';
import { assertMemorySubmittedPacket } from './memory-submitted-packet-guard.js';

/**
 * F192 publish_verdict eval:memory wire-up — live verdict generator.
 *
 * Mirrors `eval-capability-wakeup-live-verdict.ts` shape:
 *   1. Validate verdictId slug
 *   2. Build snapshot.json + attribution.json from cat-submitted packet + resolved metrics
 *   3. Write raw inputs (recall-metrics.json + library-health.json) outside bundle
 *      at `<repoRoot>/generated/memory/<verdictId>/` — referenced by provenance.json
 *      sha256; publisher MUST stage this dir via extraStagedPaths or auto-PR loses
 *      replayable evidence.
 *   4. Resolve evidence bundle refs (snapshot + attribution names)
 *   5. Render verdict.md with packet + resolved refs
 *
 * 砚砚 R8 P1 (cw mirror): cat-submitted packet wins; generator only overrides
 * bundle refs in evidencePacket (snapshot/attribution names point to the bundle
 * we just wrote, not the cat's placeholders).
 */

const SANITIZE_RULES_VERSION = 'f192-memory-recall-v1';
const SAFE_VERDICT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface GenerateMemoryLiveVerdictInput {
  verdictId: string;
  harnessFeedbackRoot: string;
  domain: EvalDomainRegistryEntry;
  recallMetrics: MemoryRecallMetrics;
  libraryHealth: MemoryLibraryHealth;
  windowDays: number;
  filters: { catId?: string; toolName?: string };
  generatedAt?: string;
  generatorCommit?: string;
  /** Cat-submitted packet (cat owns verdict; generator only overrides bundle refs). */
  submittedPacket: VerdictHandoffPacket;
}

export interface MemoryLiveVerdictArtifact {
  path: string;
  bundleDir: string;
  /**
   * Replayed raw inputs (`recall-metrics.json` + `library-health.json`) live OUTSIDE
   * `bundleDir` at `<repoRoot>/generated/memory/<verdictId>/`. `provenance.json` (inside
   * bundleDir) references them by relative path + sha256. Publisher MUST stage this dir
   * via extraStagedPaths or auto-PR omits replayable inputs.
   */
  rawInputDir: string;
  packet: VerdictHandoffPacket;
  markdown: string;
  refs: {
    bundleDir: string;
    snapshotRef: string;
    attributionRefs: string[];
  };
  isLive: true;
  sentCrossThreadMessage: false;
}

export function generateMemoryLiveVerdict(input: GenerateMemoryLiveVerdictInput): MemoryLiveVerdictArtifact {
  assertSafeVerdictId(input.verdictId);
  // All packet/input field invariants live in the single guard module — keeps
  // this generator pure-transform. Guard concentrates: domainId check,
  // totalEvents check, packet.featureId regex (imports BUNDLE_FEATURE_ID_REGEX
  // from bundle resolver = single source of truth). Refactor lesson from cloud
  // Codex R5→R10 补锅匠 cycle: per-finding inline checks drift from bundle
  // invariants. Single guard = no drift possible.
  assertMemorySubmittedPacket({
    domain: input.domain,
    recallMetrics: input.recallMetrics,
    submittedPacket: input.submittedPacket,
    windowDays: input.windowDays,
  });

  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const generatedAt = input.generatedAt ?? input.submittedPacket.createdAt;
  // packet's featureId wins (mirrors eval-memory-adapter resolveHandoffFeatureId
  // cross-feature contract; guard already validated F\d{3} format).
  const featureId = input.submittedPacket.harnessUnderEval.featureId;
  const evalSnapshotId = `eval-${featureId}-memory-${generatedAt.slice(0, 10)}`;

  const snapshot = buildSnapshot({
    verdictId: input.verdictId,
    evalSnapshotId,
    featureId,
    generatedAt,
    windowDays: input.windowDays,
    recallMetrics: input.recallMetrics,
    libraryHealth: input.libraryHealth,
  });
  const attribution = buildAttribution({
    verdictId: input.verdictId,
    evalSnapshotId,
    featureId,
    generatedAt,
    packet: input.submittedPacket,
  });

  const repoRoot = dirname(dirname(input.harnessFeedbackRoot));
  const rawInputDir = join(repoRoot, 'generated', 'memory', input.verdictId);
  mkdirSync(rawInputDir, { recursive: true });
  const rawMetricsPath = join(rawInputDir, 'recall-metrics.json');
  const rawHealthPath = join(rawInputDir, 'library-health.json');
  writeJson(rawMetricsPath, {
    verdictId: input.verdictId,
    featureId,
    windowDays: input.windowDays,
    filters: input.filters,
    generatedAt,
    metrics: input.recallMetrics,
  });
  writeJson(rawHealthPath, {
    verdictId: input.verdictId,
    featureId,
    windowDays: input.windowDays,
    filters: input.filters,
    generatedAt,
    libraryHealth: input.libraryHealth,
  });
  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [
      { path: repoRelativePath(rawMetricsPath, repoRoot), sha256: sha256File(rawMetricsPath) },
      { path: repoRelativePath(rawHealthPath, repoRoot), sha256: sha256File(rawHealthPath) },
    ],
    generatedAt,
    generator: {
      name: 'eval-memory-live-verdict',
      version: '1',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
  };

  writeJson(join(bundleDir, 'snapshot.json'), snapshot);
  writeJson(join(bundleDir, 'attribution.json'), attribution);
  writeJson(join(bundleDir, 'provenance.json'), provenance);

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
  const markdown = formatLiveVerdictMarkdown(
    input.verdictId,
    packetWithBundleRefs,
    resolved.snapshotRef,
    input.windowDays,
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
    sentCrossThreadMessage: false,
  };
}

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
