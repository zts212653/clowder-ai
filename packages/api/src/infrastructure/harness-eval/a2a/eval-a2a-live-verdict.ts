import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from '../verdict-handoff.js';
import { buildA2aVerdictHandoff } from './eval-a2a-adapter.js';
// R3 cloud P1 fix on PR #2466: YAML artifact parsers extracted to a separate
// module to keep this file under the 350-line hard limit (AGENTS.md redline).
// Behavior unchanged; pure structural split.
import { parseAttribution, parseSnapshot } from './eval-a2a-artifact-parsers.js';
import { resolveA2aEvidenceBundle } from './eval-a2a-artifact-resolver.js';
import { formatLiveVerdictMarkdown } from './eval-a2a-verdict-renderer.js';

const SANITIZE_RULES_VERSION = 'f192-e-pilot-v1';
const SAFE_VERDICT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface GenerateA2aLiveVerdictInput {
  verdictId: string;
  rawSnapshotPath: string;
  rawAttributionPath: string;
  harnessFeedbackRoot: string;
  domain: EvalDomainRegistryEntry;
  generatedAt?: string;
  generatorCommit?: string;
  submittedPacket?: VerdictHandoffPacket; // 砚砚 R8 P1: Phase H cat-mediated (cat owns verdict; undefined = operator regen)
}

export interface A2aLiveVerdictArtifact {
  path: string;
  bundleDir: string;
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

// ParsedMarkdownYaml + RawRecord + YAML parser helpers extracted to
// eval-a2a-artifact-parsers.ts (R3 cloud P1 fix: 350-line cap).

export function generateA2aLiveVerdict(input: GenerateA2aLiveVerdictInput): A2aLiveVerdictArtifact {
  assertSafeVerdictId(input.verdictId);
  const rawSnapshot = parseSnapshot(input.rawSnapshotPath);
  const rawAttribution = parseAttribution(input.rawAttributionPath);
  if (rawSnapshot.featureId !== rawAttribution.featureId) {
    throw new Error(
      `raw artifact feature mismatch: snapshot=${rawSnapshot.featureId} attribution=${rawAttribution.featureId}`,
    );
  }
  if (rawSnapshot.evalSnapshotId !== rawAttribution.evalSnapshotId) {
    throw new Error(
      `raw artifact eval snapshot mismatch: snapshot=${rawSnapshot.evalSnapshotId} attribution=${rawAttribution.evalSnapshotId}`,
    );
  }

  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const selectedFinding = strongestFinding(rawAttribution.findings);
  const citedComponentIds = selectedFinding
    ? new Set(selectedFinding.attribution.evidence.map((evidence) => evidence.anchor.split('/')[0]))
    : new Set(rawSnapshot.components.map((component) => component.id));

  const snapshotBundle = {
    verdictId: input.verdictId,
    evalSnapshotId: rawSnapshot.evalSnapshotId,
    featureId: rawSnapshot.featureId,
    generatedAt: rawSnapshot.generatedAt,
    window: rawSnapshot.window,
    // F167 sibling-PR (P1 gpt52 review fix): forward counterWindow when the
    // raw snapshot YAML carried one. Skipping this field is what made the
    // silent false positive fix invisible to eval cats reading the bundle.
    ...(rawSnapshot.counterWindow ? { counterWindow: rawSnapshot.counterWindow } : {}),
    components: rawSnapshot.components.filter((component) => citedComponentIds.has(component.id)),
  };
  const attributionBundle = {
    verdictId: input.verdictId,
    featureId: rawAttribution.featureId,
    evalSnapshotId: rawAttribution.evalSnapshotId,
    generatedAt: rawAttribution.generatedAt,
    findings: selectedFinding ? [selectedFinding] : [],
    ...(selectedFinding ? {} : { noFindingRecord: rawAttribution.noFindingRecord }),
  };
  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [
      {
        path: repoRelativeRawInputPath(input.rawSnapshotPath, input.harnessFeedbackRoot),
        sha256: sha256File(input.rawSnapshotPath),
      },
      {
        path: repoRelativeRawInputPath(input.rawAttributionPath, input.harnessFeedbackRoot),
        sha256: sha256File(input.rawAttributionPath),
      },
    ],
    generatedAt: input.generatedAt ?? rawAttribution.generatedAt,
    generator: {
      name: 'eval-a2a-live-verdict',
      version: '1',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
  };

  writeJson(join(bundleDir, 'snapshot.json'), snapshotBundle);
  writeJson(join(bundleDir, 'attribution.json'), attributionBundle);
  writeJson(join(bundleDir, 'provenance.json'), provenance);

  const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId: input.verdictId });
  // 砚砚 R8 P1: cat owns verdict (only override bundle refs below); undefined = operator regen.
  const submitted = input.submittedPacket;
  if (submitted && submitted.harnessUnderEval.featureId !== rawSnapshot.featureId) {
    throw new Error(
      `submitted_packet_evidence_mismatch: packet.featureId=${submitted.harnessUnderEval.featureId} vs snapshot.featureId=${rawSnapshot.featureId}`,
    );
  }
  const basePacket: VerdictHandoffPacket =
    submitted ??
    buildA2aVerdictHandoff({
      domain: input.domain,
      snapshot: resolved.snapshot,
      attributionReport: resolved.attributionReport,
    });
  const packetWithBundleRefs = parseVerdictHandoffPacket({
    ...basePacket,
    evidencePacket: {
      ...basePacket.evidencePacket,
      snapshotRefs: [resolved.snapshotRef],
      attributionRefs: resolved.attributionRefs,
    },
  });
  const markdown = formatLiveVerdictMarkdown(input.verdictId, packetWithBundleRefs, resolved.snapshotRef);
  writeFileSync(verdictPath, markdown, 'utf8');

  return {
    path: verdictPath,
    bundleDir,
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

function assertSafeVerdictId(verdictId: string): void {
  if (!SAFE_VERDICT_ID_PATTERN.test(verdictId)) {
    throw new Error('verdictId must be a safe slug');
  }
}

// parseAttribution + parseMarkdownYaml + evalSnapshotIdFromGeneratedAt extracted to
// eval-a2a-artifact-parsers.ts (R3 cloud P1 fix: 350-line cap).
// formatLiveVerdictMarkdown extracted to eval-a2a-verdict-renderer.ts (earlier split).

function strongestFinding(findings: ReturnType<typeof parseAttribution>['findings'][number][]) {
  if (findings.length === 0) return undefined;
  return findings.reduce((strongest, candidate) =>
    findingRank(candidate) > findingRank(strongest) ? candidate : strongest,
  );
}

function findingRank(finding: ReturnType<typeof parseAttribution>['findings'][number]): number {
  const severity =
    finding.frictionSignal.severity === 'high' ? 3 : finding.frictionSignal.severity === 'medium' ? 2 : 1;
  return severity * 1_000 + finding.frictionSignal.confidence;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function repoRelativeRawInputPath(rawPath: string, harnessFeedbackRoot: string): string {
  const normalizedRawPath = normalize(rawPath);
  if (!isAbsolute(normalizedRawPath)) {
    if (isPathOutsideRoot(normalizedRawPath)) {
      throw new Error('raw input path must be inside the repository root');
    }
    return toPosixPath(normalizedRawPath);
  }

  const repoRoot = resolve(dirname(dirname(harnessFeedbackRoot)));
  const relativePath = relative(repoRoot, normalizedRawPath);
  if (isPathOutsideRoot(relativePath)) {
    throw new Error('raw input path must be inside the repository root');
  }
  return toPosixPath(relativePath);
}

function isPathOutsideRoot(path: string): boolean {
  return path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path);
}

function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

// YAML scalar/object helpers (countRecord, severityValue, numberValue, optionalNumber,
// stringValue, optionalStringValue, arrayOfRecords, recordValue, asRecord) extracted
// to eval-a2a-artifact-parsers.ts as private helpers (R3 cloud P1 fix: 350-line cap).
