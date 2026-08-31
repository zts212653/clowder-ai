/**
 * F257 Harness Ledger — run snapshot provider (KD-17 snapshot-first pattern).
 *
 * Produces a normalized guard-rejection-event snapshot BEFORE the eval cat
 * is invoked. The eval cat receives the snapshot summary in its invocation
 * content (evidence-first, not blind). The generator adapter later reads
 * the SAME stored snapshot file (single-read by evalRunId, no re-query).
 *
 * Invariant: trigger produces → eval cat reads summary → generator reads
 * stored snapshot. Decision and artifact share one data source. Drift = 0.
 *
 * Storage: `harness-feedback/run-snapshots/<evalRunId>.json`
 * Fail-closed: Redis error in queryWindowStrict propagates (no false zero).
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuardRejectionEventLog } from './GuardRejectionEventLog.js';
import { coalesceGuardEpisodes, type GuardEpisode } from './guard-episode-coalescing.js';
import { isEscalationEligible, skipReasonCategory } from './skip-reason-eligibility.js';

/** Normalized per-guard aggregate in the stored snapshot. */
export interface GuardAggregate {
  /** Raw rejection events (preserved per PR #41 verdict). */
  count: number;
  kinds: string[];
  /** Coalesced distinct episodes — the incident count (PR #41 verdict). */
  episodeCount: number;
  /** Episode metadata with per-episode anchors for independent recheck. */
  episodes: GuardEpisode[];
}

/** Shape of the stored run snapshot (persisted JSON). */
export interface HarnessLedgerRunSnapshot {
  evalRunId: string;
  producedAt: string;
  /**
   * Owner scope — the snapshot is scoped to this single owner (sol R9 P1-2).
   * Persisted so the evidence package self-documents its scope.
   */
  ownerUserId: string;
  window: {
    startMs: number;
    endMs: number;
    durationHours: number;
  };
  totalEvents: number;
  byKind: Record<string, number>;
  /** Per-guard aggregate — generator uses this for attribution findings. */
  byGuard: Record<string, GuardAggregate>;
  /** First N events for provenance anchoring (no raw payload, metadata only). */
  sampleAnchors: Array<{
    eventId: string;
    kind: string;
    guardId: string;
    timestamp: number;
  }>;
  /** how_counted — judgment schema v1 §2 alignment. */
  howCounted: 'zset-window-scan';
  /**
   * sol P2-1: true when the window hit the hard query cap — counts are lower
   * bounds and the eval verdict must flag incompleteness explicitly.
   */
  truncated: boolean;
  /**
   * Sol R1 P2-1: per-reason breakdown with eligibility and category.
   * Self-documents which skip reasons contributed to the snapshot —
   * a bundle can prove "all 3 events were dedup_active" without external
   * reasoning. Optional for backward compat with pre-classification snapshots.
   */
  byReason?: Record<string, { count: number; category: string; eligible: boolean }>;
  /**
   * Sol R1 P2-1: server-injected thread coordinate of the trigger source.
   * Escalation path: event.threadId. Manual trigger: invocation thread.
   * NOT self-reported by eval cat — Fable ruling: owner-scope discipline.
   * Optional: scheduled triggers have no specific source thread.
   */
  sourceThreadId?: string;
  /**
   * Sol R4 P1-1 / Fable ruling: escalation kind provenance.
   * 'confirmed' = episodeCount ≥ threshold. 'uncertainty_probe' = truncation-only.
   * Absent for manual/scheduled triggers (not escalation-driven).
   */
  escalationKind?: 'confirmed' | 'uncertainty_probe';
}

export interface ProduceSnapshotDeps {
  guardRejectionLog: GuardRejectionEventLog;
  harnessFeedbackRoot: string;
  /**
   * Owner scope (sol R9 P1-2): REQUIRED — snapshots MUST be scoped to a single
   * owner. The event contract defines ownerUserId as the read isolation boundary;
   * unscoped queries would mix events across owners, corrupting verdicts.
   * Manual trigger: use input.userId; scheduled: use config.defaultUserId.
   */
  ownerUserId: string;
  /** Override window duration (default: 7 days). */
  windowMs?: number;
  /**
   * Server-injected source thread coordinate (sol R1 P2-1).
   * Escalation: event.threadId. Manual trigger: invocation thread.
   * Scheduled: undefined (no specific source thread).
   */
  sourceThreadId?: string;
  /**
   * Sol R4 P1-1: escalation kind from threshold check.
   * Propagated to snapshot for bundle provenance.
   */
  escalationKind?: 'confirmed' | 'uncertainty_probe';
}

export interface ProduceSnapshotResult {
  evalRunId: string;
  storagePath: string;
  snapshot: HarnessLedgerRunSnapshot;
  /** Human-readable summary for eval invocation injection. */
  summary: string;
  /**
   * Raw guard events from queryWindowStrict (full threadId/catId).
   * Exposed for judgment engine per-event correlation (±120s window join).
   * Not persisted in the snapshot file — transient in-process only.
   */
  rawEvents: Array<{ eventId: string; guardId: string; threadId: string; catId: string; timestamp: number }>;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 3600 * 1000;
const SAMPLE_ANCHOR_LIMIT = 5;

export async function produceHarnessLedgerRunSnapshot(deps: ProduceSnapshotDeps): Promise<ProduceSnapshotResult> {
  // sol R10 supplementary: TypeScript `string` alone is insufficient — empty string
  // passes type check but skips iterateWindow's ownerUserId filter (truthy guard),
  // silently producing an unscoped snapshot. Fail-closed at runtime.
  if (!deps.ownerUserId) {
    throw new Error(
      'harness_ledger_snapshot_owner_required: ownerUserId must be a non-empty string. ' +
        'Empty/missing owner scope would produce an unscoped snapshot (sol R9 P1-2 violation).',
    );
  }
  const evalRunId = `hlr-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();
  const windowStartMs = now - windowMs;

  // Fail-closed: queryWindowStrictComplete propagates Redis errors.
  // Completeness-preserving (sol P2-1): the old default-200 slice silently
  // dropped events; `truncated` is surfaced in the snapshot so eval verdicts
  // can flag incomplete windows instead of asserting over partial data.
  // sol R9 P1-2: scoped to ownerUserId — never mix events across owners.
  const { events, truncated } = await deps.guardRejectionLog.queryWindowStrictComplete({
    since: windowStartMs,
    until: now,
    ownerUserId: deps.ownerUserId,
  });

  // Aggregate by kind
  const byKind: Record<string, number> = {};
  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  }

  // Aggregate by guard (with kinds per guard — generator needs this for attribution)
  const byGuard: Record<string, GuardAggregate> = {};
  for (const e of events) {
    const existing = byGuard[e.guardId];
    if (existing) {
      existing.count += 1;
      if (!existing.kinds.includes(e.kind)) existing.kinds.push(e.kind);
    } else {
      byGuard[e.guardId] = { count: 1, kinds: [e.kind], episodeCount: 0, episodes: [] };
    }
  }

  // Coalesce episodes via the canonical coalescer (PR #41 verdict) — the SAME
  // implementation the real-time threshold path uses, so decision and artifact
  // can never drift on accounting.
  for (const episode of coalesceGuardEpisodes(events)) {
    const agg = byGuard[episode.guardId];
    if (agg) {
      agg.episodeCount += 1;
      agg.episodes.push(episode);
    }
  }

  // Sol R1 P2-1: per-reason breakdown with eligibility classification.
  // Self-documents "3 events were dedup_active (ineligible)" in the snapshot
  // so bundle can prove the claim without external reasoning.
  // Sol R2 P1-2: null-prototype object prevents callback-controlled reason
  // strings (e.g. "__proto__", "constructor") from polluting Object.prototype.
  const byReason = Object.create(null) as Record<string, { count: number; category: string; eligible: boolean }>;
  for (const e of events) {
    const reason = e.normalizedReason ?? 'unspecified';
    const existing = byReason[reason];
    if (existing) {
      existing.count += 1;
    } else {
      byReason[reason] = {
        count: 1,
        category: skipReasonCategory(reason),
        eligible: isEscalationEligible(reason),
      };
    }
  }

  const snapshot: HarnessLedgerRunSnapshot = {
    evalRunId,
    producedAt: new Date().toISOString(),
    ownerUserId: deps.ownerUserId,
    window: {
      startMs: windowStartMs,
      endMs: now,
      durationHours: Math.round(windowMs / (3600 * 1000)),
    },
    totalEvents: events.length,
    byKind,
    byGuard,
    byReason,
    ...(deps.sourceThreadId ? { sourceThreadId: deps.sourceThreadId } : {}),
    ...(deps.escalationKind ? { escalationKind: deps.escalationKind } : {}),
    sampleAnchors: events.slice(0, SAMPLE_ANCHOR_LIMIT).map((e) => ({
      eventId: e.eventId,
      kind: e.kind,
      guardId: e.guardId,
      timestamp: e.timestamp,
    })),
    howCounted: 'zset-window-scan',
    truncated,
  };

  // Persist snapshot to filesystem (generator reads by evalRunId).
  const dir = join(deps.harnessFeedbackRoot, 'run-snapshots');
  mkdirSync(dir, { recursive: true });
  const storagePath = join(dir, `${evalRunId}.json`);
  writeFileSync(storagePath, JSON.stringify(snapshot, null, 2));

  const summary = buildSnapshotSummary(snapshot, byGuard, windowStartMs, now, evalRunId, truncated, events.length);

  // Expose raw events for judgment engine (per-event correlation, not persisted).
  const rawEvents = events.map((e) => ({
    eventId: e.eventId,
    guardId: e.guardId,
    threadId: e.threadId,
    catId: e.catId,
    timestamp: e.timestamp,
  }));

  return { evalRunId, storagePath, snapshot, summary, rawEvents };
}

// ── Extracted helper (sol R11 P3-1: reduce cognitive complexity of main fn) ──

/** Build human-readable summary for eval cat injection (KD-17 last-hop). */
function buildSnapshotSummary(
  snapshot: HarnessLedgerRunSnapshot,
  byGuard: Record<string, GuardAggregate>,
  windowStartMs: number,
  windowEndMs: number,
  evalRunId: string,
  truncated: boolean,
  eventCount: number,
): string {
  const guardSummary = Object.entries(byGuard)
    .map(
      (entry) =>
        `  - ${entry[0]}: ${entry[1].count} raw event(s) / ${entry[1].episodeCount} episode(s) [${entry[1].kinds.join(', ')}]`,
    )
    .join('\n');
  // Provide exact sourceRefs JSON so eval cat copies raw values
  // (no ISO→epoch conversion that could drift by 1ms and trigger window_mismatch).
  const exactSourceRefs = {
    kind: 'prompt-segments' as const,
    windowStartMs,
    windowEndMs,
    evalRunId,
  };
  return [
    `### Pre-computed Guard Rejection Snapshot (evalRunId: ${evalRunId})`,
    '',
    `- **Window**: ${snapshot.window.durationHours}h [${new Date(windowStartMs).toISOString()} → ${new Date(windowEndMs).toISOString()})`,
    `- **Total events**: ${eventCount}`,
    ...(truncated
      ? ['- ⚠️ **WINDOW TRUNCATED at hard cap** — all counts below are LOWER BOUNDS; flag incompleteness in the verdict']
      : []),
    ...(snapshot.escalationKind === 'uncertainty_probe'
      ? [
          '- ⚠️ **UNCERTAINTY PROBE** — this eval was triggered by truncation (incomplete scan), NOT confirmed harmful threshold. byReason only covers the capped portion; the unscanned tail is unknown.',
        ]
      : []),
    eventCount > 0
      ? `- **By guard**:\n${guardSummary}`
      : '- No guard rejection events in this window (baseline accumulation phase)',
    '',
    '**Copy this exact sourceRefs when publishing** (do NOT modify values or convert formats):',
    '```json',
    JSON.stringify(exactSourceRefs, null, 2),
    '```',
  ].join('\n');
}
