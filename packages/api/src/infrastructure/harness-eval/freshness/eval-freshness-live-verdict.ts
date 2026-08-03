import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import { formatLiveVerdictMarkdown } from '../live-verdict-markdown.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from '../verdict-handoff.js';
import type { FreshnessReplayBundle, FreshnessReplayViolation } from './freshness-replay-types.js';

const SAFE_VERDICT_ID = /^[a-z0-9][a-z0-9-]*$/;
const COMPONENT_ID = 'freshness-closure-replay';
const SANITIZE_RULES_VERSION = 'f254-freshness-replay-v1';

export interface GenerateFreshnessLiveVerdictInput {
  verdictId: string;
  harnessFeedbackRoot: string;
  domain: EvalDomainRegistryEntry;
  replay: FreshnessReplayBundle;
  submittedPacket: VerdictHandoffPacket;
  generatedAt?: string;
  generatorCommit?: string;
}

export function generateFreshnessLiveVerdict(input: GenerateFreshnessLiveVerdictInput) {
  assertInput(input);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const rawDir = join(bundleDir, 'raw');
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const featureId = input.domain.handoffTargetResolver.featureId;
  const evalSnapshotId = `eval-${featureId}-${generatedAt.slice(0, 10)}`;
  const rawPath = join(rawDir, 'replay-events.json');
  writeJson(rawPath, input.replay);
  const rawSha256 = sha256File(rawPath);
  const snapshot = buildSnapshot(input, generatedAt, evalSnapshotId, rawSha256);
  const attribution = buildAttribution(input, generatedAt, evalSnapshotId);
  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [
      {
        path: relative(join(input.harnessFeedbackRoot, '..', '..'), rawPath).replace(/\\/g, '/'),
        sha256: rawSha256,
      },
    ],
    generatedAt,
    generator: {
      name: 'eval-freshness-live-verdict',
      version: '1',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
  };
  writeJson(join(bundleDir, 'snapshot.json'), snapshot);
  writeJson(join(bundleDir, 'attribution.json'), attribution);
  writeJson(join(bundleDir, 'provenance.json'), provenance);

  const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId: input.verdictId });
  const report = input.replay.report;
  const packet = parseVerdictHandoffPacket({
    ...input.submittedPacket,
    evidencePacket: {
      snapshotRefs: [resolved.snapshotRef],
      attributionRefs: resolved.attributionRefs,
      metricRefs: [
        'metric:freshness.replay.eligible_samples',
        'metric:freshness.replay.failed_samples',
        'metric:freshness.replay.attention_samples',
      ],
      sampleTraceRefs:
        input.replay.samples.length > 0
          ? input.replay.samples.map((sample) => sample.traceRef)
          : [`trace:freshness-replay/no-data/${sha256Json(input.replay.selector).slice(0, 16)}`],
    },
    dailyTrend: {
      window: `${input.replay.selector.windowStartMs}-${input.replay.selector.windowEndMs}`,
      current: {
        eligible_samples: report.eligibleSampleCount,
        failed_samples: report.failedSampleCount,
        attention_samples: report.attentionSampleCount,
      },
      baseline: { failed_samples: 0, attention_samples: 0 },
      threshold: { failed_samples: 0, attention_samples: 0 },
      direction: report.verdict === 'no_data' ? 'unknown' : report.verdict === 'healthy' ? 'flat' : 'regressed',
    },
  });
  const markdown = formatLiveVerdictMarkdown(
    packet.id,
    packet,
    resolved.snapshotRef,
    {
      domainId: 'eval:freshness',
      featureId: 'F254',
      topic: 'freshness',
    },
    buildReplayDetailBullets(input.replay),
  );
  writeFileSync(verdictPath, markdown, 'utf8');
  return { path: verdictPath, bundleDir, packet, markdown, isLive: true as const };
}

function assertInput(input: GenerateFreshnessLiveVerdictInput): void {
  if (!SAFE_VERDICT_ID.test(input.verdictId)) throw new Error(`unsafe_verdict_id: ${input.verdictId}`);
  if (input.domain.domainId !== 'eval:freshness' || input.submittedPacket.domainId !== input.domain.domainId) {
    throw new Error('freshness_generator_wrong_domain');
  }
  if (input.submittedPacket.harnessUnderEval.featureId !== input.domain.handoffTargetResolver.featureId) {
    throw new Error('submitted_packet_evidence_mismatch: freshness feature id');
  }
}

function buildSnapshot(
  input: GenerateFreshnessLiveVerdictInput,
  generatedAt: string,
  evalSnapshotId: string,
  rawSha256: string,
) {
  const report = input.replay.report;
  const activationCounts: Record<string, number> = {
    eligible_samples: report.eligibleSampleCount,
    passed_samples: report.passedSampleCount,
    fixture_samples: report.fixtureSampleCount,
    live_samples: report.liveSampleCount,
    attention_samples: report.attentionSampleCount,
  };
  for (const [scenario, count] of Object.entries(report.scenarioCounts)) {
    activationCounts[`scenario_${scenario}`] = count;
  }
  activationCounts.provider_native_cells = input.replay.providerNativeCoverage.cells.length;
  activationCounts.provider_native_all_tool_carriers = input.replay.providerNativeCoverage.carriers.filter(
    (carrier) => carrier.allToolCoverage,
  ).length;
  activationCounts.provider_native_opportunities = input.replay.providerNativeCoverage.cells.reduce(
    (sum, cell) => sum + cell.opportunityCount,
    0,
  );
  activationCounts.provider_native_delivered = input.replay.providerNativeCoverage.cells.reduce(
    (sum, cell) => sum + cell.deliveredCount,
    0,
  );
  activationCounts.provider_native_seen = input.replay.providerNativeCoverage.cells.reduce(
    (sum, cell) => sum + cell.seenCount,
    0,
  );
  activationCounts.provider_native_handled = input.replay.providerNativeCoverage.cells.reduce(
    (sum, cell) => sum + cell.handledCount,
    0,
  );
  const frictionCounts: Record<string, number> = { failed_samples: report.failedSampleCount };
  for (const violation of allViolations()) {
    frictionCounts[`violation_${violation}`] = report.evaluations.filter((item) =>
      item.violations.includes(violation),
    ).length;
  }
  return {
    verdictId: input.verdictId,
    evalSnapshotId,
    featureId: input.domain.handoffTargetResolver.featureId,
    generatedAt,
    window: {
      startMs: input.replay.selector.windowStartMs,
      endMs: input.replay.selector.windowEndMs,
      durationHours: (input.replay.selector.windowEndMs - input.replay.selector.windowStartMs) / 3_600_000,
    },
    replayVerdict: report.verdict,
    healthy: report.healthy,
    ...(report.noDataReason ? { noDataReason: report.noDataReason } : {}),
    rawReplaySha256: rawSha256,
    components: [
      {
        id: COMPONENT_ID,
        name: 'F254 replayable freshness closure invariants',
        confidence: report.verdict === 'no_data' ? 'no-data' : report.fixtureSampleCount >= 8 ? 'high' : 'medium',
        activationCounts,
        frictionCounts,
      },
      {
        id: 'provider-native-freshness-coverage',
        name: 'F254 provider by carrier by tool-surface coverage',
        confidence:
          input.replay.providerNativeCoverage.verdict === 'no_data'
            ? 'no-data'
            : input.replay.providerNativeCoverage.verdict === 'all_tool_covered'
              ? 'high'
              : 'medium',
        activationCounts: {
          cells: input.replay.providerNativeCoverage.cells.length,
          carrier_rows: input.replay.providerNativeCoverage.carriers.length,
          all_tool_carriers: input.replay.providerNativeCoverage.carriers.filter((carrier) => carrier.allToolCoverage)
            .length,
        },
        frictionCounts: {
          missed: input.replay.providerNativeCoverage.cells.reduce((sum, cell) => sum + cell.missedCount, 0),
          partial_carriers: input.replay.providerNativeCoverage.carriers.filter((carrier) => !carrier.allToolCoverage)
            .length,
        },
      },
    ],
  };
}

function buildAttribution(input: GenerateFreshnessLiveVerdictInput, generatedAt: string, evalSnapshotId: string) {
  const findings = input.replay.report.evaluations
    .filter((evaluation) => evaluation.violations.length > 0 || evaluation.attentionReasons.length > 0)
    .map((evaluation, index) => {
      const signal = evaluation.violations[0] ?? evaluation.attentionReasons[0];
      const failed = evaluation.violations.length > 0;
      return {
        id: `F254-${generatedAt.slice(0, 10)}-${index + 1}`,
        relatedFeature: 'F254',
        frictionSignal: {
          type: `freshness.replay.${signal}`,
          severity: failed ? ('high' as const) : ('medium' as const),
          confidence: 1,
          detectedAt: generatedAt,
        },
        attribution: {
          primaryLayer: failed ? 'freshness_invariant' : 'durable_responsibility',
          evidence: [
            {
              type: 'replay-trace',
              anchor: `${COMPONENT_ID}/${failed ? 'failed_samples' : 'attention_samples'}`,
              excerpt: `${evaluation.traceRef}: ${signal}`,
            },
          ],
        },
        proposedAction: [
          {
            action: failed ? 'fix' : 'investigate',
            target: `${COMPONENT_ID}/${evaluation.sampleId}`,
            rationale: `${evaluation.scenario}: ${signal}`,
          },
        ],
      };
    });
  const noFindingRecord =
    findings.length > 0
      ? {}
      : {
          noFindingRecord: {
            reason:
              input.replay.report.verdict === 'no_data' ? 'no_eligible_samples' : 'all_replay_invariants_satisfied',
            evidence:
              input.replay.report.noDataReason ??
              `${input.replay.report.eligibleSampleCount} replay samples satisfied all F254 invariants.`,
          },
        };
  return {
    verdictId: input.verdictId,
    featureId: input.domain.handoffTargetResolver.featureId,
    evalSnapshotId,
    generatedAt,
    findings,
    ...noFindingRecord,
  };
}

function buildReplayDetailBullets(replay: FreshnessReplayBundle): string[] {
  const report = replay.report;
  return [
    `- Derived replay: \`${report.verdict}\``,
    `- Healthy: \`${report.healthy}\``,
    `- Eligible samples: ${report.eligibleSampleCount}`,
    `- Failed samples: ${report.failedSampleCount}`,
    `- Attention samples: ${report.attentionSampleCount}`,
    `- Provider-native coverage: \`${replay.providerNativeCoverage.verdict}\``,
    `- Provider-native all-tool carriers: ${replay.providerNativeCoverage.carriers.filter((carrier) => carrier.allToolCoverage).length}`,
    ...(report.noDataReason ? [`- No-data reason: ${report.noDataReason}`] : []),
  ];
}

function allViolations(): FreshnessReplayViolation[] {
  return [
    'responsibility_without_custody',
    'formal_final_limit_exceeded',
    'known_stale_final_visible',
    'target_outcome_missing',
    'same_batch_sibling_triggered',
    'automatic_attempt_budget_exceeded',
    'commit_recheck_budget_exceeded',
    'terminal_evidence_missing',
  ];
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
