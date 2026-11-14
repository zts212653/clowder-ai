import type { BallCustodyEvent, BallCustodyProjection } from '@cat-cafe/shared';

export type BallRecoveryLane = 'probe' | 'idle';
export interface BallRecoveryLaneFacts {
  scope: string;
  revision: number;
  failures: number;
  nextAt: number;
  disposition?: 'needs_attention' | 'settled';
  reasonCode?: string;
  intentAt?: number;
}
export interface BallWakeAudit {
  key: string;
  scope: string;
  messageId: string;
  event: BallCustodyEvent;
  failures: number;
  revision: number;
  nextAt: number;
  disposition?: 'settled' | 'needs_attention';
}
export interface BallRecoveryOwner {
  userId: string;
  threadId: string;
  taskId: string;
}
export interface BallRecoveryNotice {
  key: string;
  lane: BallRecoveryLane;
  scope: string;
  owner: BallRecoveryOwner;
  reasonCode: string;
  nextAt: number;
  failures: number;
  state: 'pending' | 'delivered' | 'owner_unavailable' | 'needs_attention';
}
export interface BallProbeRecoveryFacts {
  v: 1;
  subjectKey: string;
  generation: number;
  source?: { state: string; episode: number | null; lastEventAt: number; eventCount: number };
  rebuilding?: boolean;
  probe?: BallRecoveryLaneFacts;
  idle?: BallRecoveryLaneFacts;
  wakeReceipt?: { scope: string; messageId: string; at: number; eventId: string; eventRecorded?: boolean };
  wakeAudits?: Record<string, BallWakeAudit>;
  latestWakeAttention?: string;
  notices: Record<string, BallRecoveryNotice>;
  noticeReceipts?: Partial<Record<BallRecoveryLane, string>>;
  disposition?: 'needs_attention';
  reasonCode?: string;
  originalRaw?: string;
}
export interface BallRecoveryCandidate {
  subjectKey: string;
  lane: BallRecoveryLane;
  scope: string;
  revision: number;
  intentAt?: number;
}
export type BallRecoveryOutcome = 'waiting' | 'retryable_error' | 'permanent_error' | 'stale' | 'settled';
export const BALL_IDLE_STATES = new Set(['active', 'blocked', 'parked', 'void']);

export function reconcileBallProbeFacts(
  subjectKey: string,
  projection: BallCustodyProjection | null,
  existing: BallProbeRecoveryFacts | null,
  finishRebuild = false,
): BallProbeRecoveryFacts {
  const facts: BallProbeRecoveryFacts = structuredClone(existing ?? { v: 1, subjectKey, generation: 0, notices: {} });
  if (facts.rebuilding && !finishRebuild) return facts;
  if (finishRebuild) delete facts.rebuilding;
  if (!projection) return facts;
  const episode = projection.blockedSinceAt ?? null;
  const previous = facts.source;
  if (projection.state === 'blocked' && (!previous || previous.state !== 'blocked' || previous.episode !== episode)) {
    facts.generation++;
    facts.probe = { scope: `${subjectKey}:g${facts.generation}`, revision: 1, failures: 0, nextAt: 0 };
    delete facts.wakeReceipt;
  }
  if (projection.state === 'blocked' && typeof projection.lastWakeAt === 'number' && facts.probe) {
    facts.probe.disposition = 'settled';
    facts.probe.reasonCode = 'original_wake_event_confirmed';
  }
  if (!facts.idle || !previous || previous.lastEventAt !== projection.lastEventAt) {
    facts.idle = {
      scope: `${subjectKey}:event:${projection.lastEventAt}:${projection.appliedEventCount}`,
      revision: (facts.idle?.revision ?? 0) + 1,
      failures: 0,
      nextAt: 0,
    };
  }
  facts.source = {
    state: projection.state,
    episode,
    lastEventAt: projection.lastEventAt,
    eventCount: projection.appliedEventCount,
  };
  return facts;
}

export function ballProbeScores(
  projection: BallCustodyProjection | null,
  facts: BallProbeRecoveryFacts,
): {
  probe: number | null;
  idle: number | null;
  retry: number | null;
  notice: number | null;
  audit: number | null;
} {
  const audits = Object.values(facts.wakeAudits ?? {})
    .filter((audit) => !audit.disposition)
    .map((audit) => audit.nextAt);
  const scores = {
    audit: audits.length ? Math.min(...audits) : null,
    probe: null as number | null,
    idle: null as number | null,
    retry: null as number | null,
    notice: null,
  };
  if (!projection || facts.rebuilding || facts.disposition || !projection.subjectKey.startsWith('ball:task:'))
    return scores;
  if (projection.state === 'blocked' && facts.probe && !facts.probe.disposition && !facts.idle?.disposition)
    scores.probe = facts.probe.nextAt;
  if (BALL_IDLE_STATES.has(projection.state) && facts.idle && !facts.idle.disposition) {
    if (facts.idle.nextAt > 0) scores.retry = facts.idle.nextAt;
    else scores.idle = projection.lastEventAt;
  }
  return scores;
}

export function finishBallProbeFacts(
  facts: BallProbeRecoveryFacts,
  candidate: BallRecoveryCandidate,
  outcome: BallRecoveryOutcome,
  now: number,
  reasonCode = 'ball_recovery_failed',
): boolean {
  const lane = facts[candidate.lane];
  if (
    !lane ||
    lane.scope !== candidate.scope ||
    lane.revision !== candidate.revision ||
    facts.rebuilding ||
    lane.disposition === 'settled'
  )
    return false;
  if (outcome === 'stale') return false;
  lane.revision++;
  lane.nextAt = now + 60_000;
  if (outcome === 'settled') lane.disposition = 'settled';
  else if (outcome === 'retryable_error') lane.failures++;
  else lane.failures = 0;
  if (outcome === 'permanent_error' || lane.failures >= 5) {
    lane.disposition = 'needs_attention';
    lane.reasonCode = reasonCode;
  }
  return true;
}
