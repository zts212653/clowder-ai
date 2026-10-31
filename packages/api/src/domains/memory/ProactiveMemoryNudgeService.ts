import {
  proactiveMemoryCandidateCount,
  proactiveMemoryScanDuration,
  proactiveMemoryScanTotal,
} from '../../infrastructure/telemetry/instruments.js';
import type { ProactiveCandidateNudgeReceiptStore } from './ProactiveCandidateNudgeReceiptStore.js';
import type { ProactiveCandidateRegistryMatch } from './ProactiveCandidateRegistryResolver.js';
import type { ProactiveMemoryCandidateDetectorInput } from './ProactiveMemoryCandidateDetector.js';
import type {
  ProactiveMemoryCandidate,
  ProactiveMemoryCandidateConfig,
} from './proactive-memory-candidate-contract.js';

interface ProactiveCandidateDetectorPort {
  getConfig(): Pick<ProactiveMemoryCandidateConfig, 'windowMs' | 'maxNudgesPerTurn'>;
  detect(input: ProactiveMemoryCandidateDetectorInput): Promise<ProactiveMemoryCandidate[]>;
}

interface ProactiveCandidateRegistryPort {
  resolve(input: { ownerUserId: string; phrase: string }): Promise<ProactiveCandidateRegistryMatch>;
}

export interface ProactiveMemoryNudgeServiceDeps {
  detector: ProactiveCandidateDetectorPort;
  registryResolver: ProactiveCandidateRegistryPort;
  receiptStore: ProactiveCandidateNudgeReceiptStore;
  claimLeaseMs?: number;
}

export interface PreparedProactiveMemoryNudge {
  readonly context: string;
  readonly candidates: readonly PreparedProactiveMemoryCandidate[];
  readonly claimIds: readonly string[];
}

type EligibleRegistryMatch = Extract<
  ProactiveCandidateRegistryMatch,
  { kind: 'unregistered' | 'registered_entity' | 'registered_person' }
>;

export interface PreparedProactiveMemoryCandidate extends ProactiveMemoryCandidate {
  readonly registryMatch: EligibleRegistryMatch;
}

const DEFAULT_CLAIM_LEASE_MS = 2 * 60 * 1_000;

function formatCoordinates(candidate: ProactiveMemoryCandidate): string {
  return candidate.sourceCoordinates
    .map((coordinate) => `${coordinate.threadId}#${coordinate.messageIds.join(',')}`)
    .join(' | ');
}

function formatContext(candidates: readonly PreparedProactiveMemoryCandidate[]): string {
  if (candidates.length === 0) return '';
  const lines = candidates.map(
    (candidate) =>
      `- 「${candidate.phrase}」: ${candidate.distinctThreadCount} threads / ` +
      `${candidate.distinctMessageCount} messages; window ` +
      `${new Date(candidate.window.sinceInclusive).toISOString()}..` +
      `${new Date(candidate.window.untilInclusive).toISOString()}\n` +
      `  ↳ background ${candidate.frequency.background.distinctMessageCount}/` +
      `${candidate.frequency.background.eligibleMessageCount} messages; recent ` +
      `${candidate.frequency.recentBurst.distinctMessageCount}/` +
      `${candidate.frequency.recentBurst.eligibleMessageCount} messages\n` +
      `  ↳ registry=${candidate.registryMatch.kind}` +
      `${candidate.registryMatch.kind === 'unregistered' ? '' : '; known-person delta'}\n` +
      `  ↳ ${formatCoordinates(candidate)}`,
  );
  return (
    '\n[proactive-memory-candidate]\n' +
    '以下仅为同一 owner 公开 workspace 消息的机械重复统计；未分类，也未判断重要性：\n' +
    lines.join('\n') +
    '\n[/proactive-memory-candidate]'
  );
}

export class ProactiveMemoryNudgeService {
  private readonly claimLeaseMs: number;

  constructor(private readonly deps: ProactiveMemoryNudgeServiceDeps) {
    this.claimLeaseMs = deps.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  }

  async prepare(input: ProactiveMemoryCandidateDetectorInput): Promise<PreparedProactiveMemoryNudge> {
    const scanStartedAt = performance.now();
    try {
      const detected = await this.deps.detector.detect(input);
      proactiveMemoryScanTotal.add(1);
      proactiveMemoryScanDuration.record(performance.now() - scanStartedAt);
      proactiveMemoryCandidateCount.record(detected.length);
      const eligibleCandidates: PreparedProactiveMemoryCandidate[] = [];
      for (const candidate of detected) {
        const match = await this.deps.registryResolver.resolve({
          ownerUserId: input.ownerUserId,
          phrase: candidate.phrase,
        });
        if (match.kind === 'unregistered' || match.kind === 'registered_entity' || match.kind === 'registered_person') {
          eligibleCandidates.push({ ...candidate, registryMatch: match });
        }
      }

      const config = this.deps.detector.getConfig();
      const candidates: PreparedProactiveMemoryCandidate[] = [];
      const claimIds: string[] = [];
      for (const candidate of eligibleCandidates) {
        if (candidates.length >= config.maxNudgesPerTurn) break;
        const windowEndsAt = candidate.window.untilInclusive + config.windowMs;
        const claim = this.deps.receiptStore.claim({
          ownerUserId: input.ownerUserId,
          normalizedSubject: candidate.normalizedPhrase,
          now: input.now ?? Date.now(),
          leaseMs: this.claimLeaseMs,
          windowEndsAt,
        });
        if (claim.outcome !== 'claimed') {
          if (claim.receipt.windowEndsAt === windowEndsAt) {
            return { context: '', candidates: [], claimIds: [] };
          }
          continue;
        }
        candidates.push(candidate);
        claimIds.push(claim.receipt.claimId);
      }
      return { context: formatContext(candidates), candidates, claimIds };
    } catch {
      proactiveMemoryScanTotal.add(1);
      proactiveMemoryScanDuration.record(performance.now() - scanStartedAt);
      proactiveMemoryCandidateCount.record(0);
      return { context: '', candidates: [], claimIds: [] };
    }
  }

  finalize(prepared: PreparedProactiveMemoryNudge, deliveredAt = Date.now()): number {
    let finalized = 0;
    for (const claimId of prepared.claimIds) {
      try {
        if (this.deps.receiptStore.finalize({ claimId, deliveredAt })) finalized += 1;
      } catch {
        // The carrier already joined the invocation prompt. Receipt persistence is
        // operational suppression only, so a storage failure must not break routing.
      }
    }
    return finalized;
  }
}
