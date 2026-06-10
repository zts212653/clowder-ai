import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from '../verdict-handoff.js';
import { formatTaskOutcomeLiveVerdictMarkdown } from './eval-task-outcome-renderer.js';
import type { ResolvedTaskOutcomeWindow } from './task-outcome-source-resolver.js';
import { sha256File } from './task-outcome-source-resolver.js';

const SAFE_VERDICT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SANITIZE_RULES_VERSION = 'f192-task-outcome-v1';

export interface GenerateTaskOutcomeLiveVerdictInput {
  verdictId: string;
  harnessFeedbackRoot: string;
  domain: EvalDomainRegistryEntry;
  sourceWindow: ResolvedTaskOutcomeWindow;
  generatedAt?: string;
  generatorCommit?: string;
  submittedPacket: VerdictHandoffPacket;
}

export interface TaskOutcomeLiveVerdictArtifact {
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

export function generateTaskOutcomeLiveVerdict(
  input: GenerateTaskOutcomeLiveVerdictInput,
): TaskOutcomeLiveVerdictArtifact {
  assertSafeVerdictId(input.verdictId);
  assertSubmittedPacketMatches(input.submittedPacket, input.domain);

  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  const rawDir = join(bundleDir, 'raw');
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const snapshot = buildSnapshot(input.sourceWindow, input.verdictId, input.domain, generatedAt);
  const attribution = buildAttribution(input.sourceWindow, input.verdictId, input.domain, generatedAt);
  const rawEpisodesPath = join(rawDir, 'episodes.json');
  writeJson(rawEpisodesPath, {
    verdictId: input.verdictId,
    windowStartMs: input.sourceWindow.windowStartMs,
    windowEndMs: input.sourceWindow.windowEndMs,
    taskOutcomeDbPath: input.sourceWindow.taskOutcomeDbPath,
    eventMemoryDbPath: input.sourceWindow.eventMemoryDbPath,
    episodes: input.sourceWindow.episodes,
    signals: input.sourceWindow.signals,
    eventRows: input.sourceWindow.eventRows,
  });
  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [
      {
        path: relative(join(input.harnessFeedbackRoot, '..', '..'), rawEpisodesPath).replace(/\\/g, '/'),
        sha256: sha256File(rawEpisodesPath),
      },
    ],
    generatedAt,
    generator: {
      name: 'eval-task-outcome-live-verdict',
      version: '1',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
  };

  writeJson(join(bundleDir, 'snapshot.json'), snapshot);
  writeJson(join(bundleDir, 'attribution.json'), attribution);
  writeJson(join(bundleDir, 'provenance.json'), provenance);

  const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId: input.verdictId });
  const packetWithBundleRefs = parseVerdictHandoffPacket({
    ...input.submittedPacket,
    evidencePacket: {
      ...input.submittedPacket.evidencePacket,
      snapshotRefs: [resolved.snapshotRef],
      attributionRefs: resolved.attributionRefs,
    },
  });
  const markdown = formatTaskOutcomeLiveVerdictMarkdown(input.verdictId, packetWithBundleRefs, resolved.snapshotRef);
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

function buildSnapshot(
  sourceWindow: ResolvedTaskOutcomeWindow,
  verdictId: string,
  domain: EvalDomainRegistryEntry,
  generatedAt: string,
) {
  const terminalCounts = countBy(sourceWindow.episodes, (episode) => episode.terminalState);
  const categoryCounts = countBy(sourceWindow.signals, (signal) => signal.category);
  const typeCounts = countBy(sourceWindow.signals, (signal) =>
    typeof signal.record.type === 'string' ? signal.record.type : 'unknown',
  );
  const confidenceCounts = countBy(sourceWindow.eventRows, (event) => event.confidence);

  return {
    verdictId,
    evalSnapshotId: `eval-${domain.handoffTargetResolver.featureId}-${generatedAt.slice(0, 10)}`,
    featureId: domain.handoffTargetResolver.featureId,
    generatedAt,
    window: {
      startMs: sourceWindow.windowStartMs,
      endMs: sourceWindow.windowEndMs,
      durationHours: Math.max(
        0,
        Math.round(((sourceWindow.windowEndMs - sourceWindow.windowStartMs) / 3_600_000) * 1000) / 1000,
      ),
    },
    components: [
      {
        id: 'Phase-G-v0',
        name: 'task-outcome eval pipeline',
        confidence: sourceWindow.episodes.length > 0 ? 'medium' : 'low',
        activationCounts: {
          episodes_total: sourceWindow.episodes.length,
          completed_total: terminalCounts.completed ?? 0,
          in_progress_total: terminalCounts.in_progress ?? 0,
          abandoned_total: terminalCounts.abandoned ?? 0,
          escalated_cvo_total: terminalCounts.escalated_cvo ?? 0,
          corrected_then_completed_total: terminalCounts.corrected_then_completed ?? 0,
          a1_signals_total: categoryCounts.a1 ?? 0,
          a2_signals_total: categoryCounts.a2 ?? 0,
          proxy_signals_total: categoryCounts.proxy ?? 0,
        },
        frictionCounts: {
          permission_cancel_total: typeCounts.permission_cancel ?? 0,
          proposal_reject_total: typeCounts.proposal_reject ?? 0,
          magic_word_ref_total: typeCounts.magic_word_ref ?? 0,
        },
      },
      {
        id: 'F227-event-memory',
        name: 'event memory timeline',
        confidence: sourceWindow.eventRows.length > 0 ? 'medium' : 'low',
        activationCounts: {
          events_backfilled_visible: sourceWindow.eventRows.length,
          confidence_high_count: confidenceCounts.high ?? 0,
          confidence_mid_count: confidenceCounts.mid ?? 0,
          confidence_low_count: confidenceCounts.low ?? 0,
        },
        frictionCounts: {},
      },
    ],
  };
}

function buildAttribution(
  sourceWindow: ResolvedTaskOutcomeWindow,
  verdictId: string,
  domain: EvalDomainRegistryEntry,
  generatedAt: string,
) {
  const inProgressCount = sourceWindow.episodes.filter((episode) => episode.terminalState === 'in_progress').length;
  const proposalRejectCount = sourceWindow.signals.filter((signal) => signal.record.type === 'proposal_reject').length;

  const finding =
    inProgressCount > 0
      ? {
          id: `TO-${generatedAt.slice(0, 10)}-open-window`,
          relatedFeature: domain.handoffTargetResolver.featureId,
          frictionSignal: {
            type: 'task_outcome.in_progress_total',
            severity: inProgressCount > 1 ? 'medium' : 'low',
            confidence: 0.8,
            detectedAt: generatedAt,
          },
          attribution: {
            primaryLayer: 'needs_investigation',
            evidence: [
              {
                type: 'counter',
                anchor: 'Phase-G-v0/in_progress_total',
                excerpt: `${inProgressCount} episode(s) are still in progress inside the selected window`,
              },
            ],
          },
          proposedAction: [
            {
              action: 'inspect-open-window',
              target: `${domain.handoffTargetResolver.featureId}/Phase-G-v0`,
              rationale: 'Open episodes in the selected window need manual review before verdict writeback exists.',
            },
          ],
          status: 'open',
        }
      : proposalRejectCount > 0
        ? {
            id: `TO-${generatedAt.slice(0, 10)}-proposal-reject`,
            relatedFeature: domain.handoffTargetResolver.featureId,
            frictionSignal: {
              type: 'task_outcome.proposal_reject_total',
              severity: 'low',
              confidence: 0.75,
              detectedAt: generatedAt,
            },
            attribution: {
              primaryLayer: 'harness_fix_needed',
              evidence: [
                {
                  type: 'counter',
                  anchor: 'Phase-G-v0/proposal_reject_total',
                  excerpt: `${proposalRejectCount} proposal reject signal(s) recorded in the selected window`,
                },
              ],
            },
            proposedAction: [
              {
                action: 'observe-proposal-reject-pattern',
                target: `${domain.handoffTargetResolver.featureId}/Phase-G-v0`,
                rationale:
                  'Proposal reject coverage is wired; keep observing whether the signal stabilizes across more windows.',
              },
            ],
            status: 'open',
          }
        : null;

  return finding
    ? {
        verdictId,
        featureId: domain.handoffTargetResolver.featureId,
        evalSnapshotId: `eval-${domain.handoffTargetResolver.featureId}-${generatedAt.slice(0, 10)}`,
        generatedAt,
        findings: [finding],
      }
    : {
        verdictId,
        featureId: domain.handoffTargetResolver.featureId,
        evalSnapshotId: `eval-${domain.handoffTargetResolver.featureId}-${generatedAt.slice(0, 10)}`,
        generatedAt,
        findings: [],
        noFindingRecord: {
          reason: 'no actionable task-outcome finding exceeded threshold in the selected window',
          evidence: 'Phase-G-v0/episodes_total',
        },
      };
}

function assertSubmittedPacketMatches(submitted: VerdictHandoffPacket, domain: EvalDomainRegistryEntry): void {
  if (submitted.domainId !== domain.domainId) {
    throw new Error(
      `submitted_packet_evidence_mismatch: packet.domainId=${submitted.domainId} vs input.domain.domainId=${domain.domainId}`,
    );
  }
  if (submitted.harnessUnderEval.featureId !== domain.handoffTargetResolver.featureId) {
    throw new Error(
      `submitted_packet_evidence_mismatch: packet.harnessUnderEval.featureId=${submitted.harnessUnderEval.featureId} vs domain.handoffTargetResolver.featureId=${domain.handoffTargetResolver.featureId}`,
    );
  }
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function assertSafeVerdictId(verdictId: string): void {
  if (!SAFE_VERDICT_ID_PATTERN.test(verdictId)) {
    throw new Error('verdictId must be a safe slug');
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
