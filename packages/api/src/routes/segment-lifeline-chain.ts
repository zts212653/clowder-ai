/** F257 Phase D — Version lifecycle chain builder. Pure, no Redis. */

import type {
  ActiveStage,
  EvalStageSummary,
  LifecycleEvent,
  OverrideChangeEvent,
  VersionEpoch,
  VersionEpochStatus,
  VersionOrigin,
} from '@cat-cafe/shared';
import type { CachedJudgment } from '../domains/prompt-hooks/SegmentJudgmentCache.js';

// Input types (pre-fetched data from stores)

export interface SegmentObservationInput {
  timestamp: number;
  version: number | null;
  /**
   * 判据② P1 (sol R5): producer-semantics fired predicate (segment-judgment-engine
   * isFired), computed at collection time from the raw trace segment. Observe-only
   * rows (pipelineStatus 'observed') are observations, NOT injections.
   */
  fired: boolean;
}

export interface ChainBuilderInput {
  /** Manifest baseline version (from hook.yaml). */
  manifestVersion: number;
  /** Override change events filtered for this segment, sorted by timestamp. */
  overrideEvents: OverrideChangeEvent[];
  /** Observations (timestamp + version + fired) within the query window. */
  observations: SegmentObservationInput[];
  /** Eval judgment history (all judgments, oldest first). P1-2: per-version eval. */
  judgmentHistory?: CachedJudgment[];
  /** Single judgment — backward compat. Use judgmentHistory for multi-eval. */
  cachedJudgment?: CachedJudgment | null;
  /** Current content version from override state. */
  currentContentVersion: number | null;
}

// Builder

/**
 * Build the version lifecycle chain from raw data.
 *
 * Algorithm:
 * 1. Start with manifest v1 epoch
 * 2. Walk override events chronologically — content-set creates user-edit
 *    events and may start new version epochs
 * 3. Attach observation counts to each epoch's tracing stage
 * 4. Attach cached judgment to the appropriate epoch's eval stage
 * 5. Derive each epoch's status from available data
 */
export function buildVersionChain(input: ChainBuilderInput): { chain: VersionEpoch[]; timeline: ActivationPoint[] } {
  const { manifestVersion, overrideEvents, observations } = input;

  // Merge judgment sources: judgmentHistory (P1-2) takes precedence, cachedJudgment for compat
  const allJudgments: CachedJudgment[] = input.judgmentHistory ?? (input.cachedJudgment ? [input.cachedJudgment] : []);

  // Single-pass event reducer: builds epochs AND activation timeline together.
  // This avoids timestamp-based lookups that break on same-ms events (R4 P1-1).
  const { epochs, timeline } = buildEpochsAndTimeline(manifestVersion, overrideEvents);

  // Attach observations using activation timeline
  attachObservations(epochs, observations, timeline);

  // Attach eval judgments — each distributed to its active epoch (P1-2)
  attachJudgments(epochs, allJudgments, timeline);

  // Mark active version from activation timeline (P1-3).
  // Timeline's last entry = currently active epoch. Handles version-activate,
  // rollback, content-clear — all encoded as timeline transitions.
  markActiveFromTimeline(epochs, timeline);

  // Derive status for each epoch
  for (const epoch of epochs) {
    epoch.status = deriveStatus(epoch);
  }

  return { chain: epochs, timeline };
}

// ---------------------------------------------------------------------------
// Single-pass event reducer: epochs + activation timeline (R4 fix)
// ---------------------------------------------------------------------------

/** A point in the activation timeline: from this timestamp, epochIndex is active. */
export interface ActivationPoint {
  timestamp: number;
  epochIndex: number;
}

/**
 * Single-pass event reducer: epochs + activation timeline (R4 P1-1).
 * Merged to avoid timestamp-based findIndex (broke on same-ms events).
 * State machine: content-set/activate → new active; rollback/clear → epoch 0;
 * enable/disable → no activation change. R9: tracks activeIdx, not last-created.
 */
function buildEpochsAndTimeline(
  manifestVersion: number,
  events: OverrideChangeEvent[],
): { epochs: VersionEpoch[]; timeline: ActivationPoint[] } {
  const epochs: VersionEpoch[] = [createEpoch(manifestVersion, 'manifest', 0)];
  const timeline: ActivationPoint[] = [{ timestamp: 0, epochIndex: 0 }];
  // R9: track active epoch (not last-created). content-set/activate/rollback/clear update it.
  let activeIdx = 0;

  for (const event of events) {
    const active = epochs[activeIdx];

    if (event.action === 'content-set') {
      const newVersion = event.epochVersion ?? epochs[epochs.length - 1].version + 1; // monotonic fallback
      const origin: VersionOrigin = event.source === 'operator' ? 'user-create' : 'auto-iterate';

      active.events.push({
        eventId: event.eventId,
        kind: origin === 'user-create' ? 'user-create' : 'auto-iterate',
        timestamp: event.timestamp,
        actorId: event.actorId,
        detail: `v${active.version} → v${newVersion}`,
      });

      const newEpoch = createEpoch(newVersion, origin, event.timestamp);
      const newIndex = epochs.length;
      epochs.push(newEpoch);
      activeIdx = newIndex;
      timeline.push({ timestamp: event.timestamp, epochIndex: newIndex });
    } else if (event.action === 'rollback' || event.action === 'content-clear') {
      active.events.push({
        eventId: event.eventId,
        kind: 'version-activate',
        timestamp: event.timestamp,
        actorId: event.actorId,
        detail:
          event.action === 'rollback'
            ? `rolled back to v${manifestVersion}`
            : `content cleared, reverted to v${manifestVersion}`,
      });
      activeIdx = 0;
      timeline.push({ timestamp: event.timestamp, epochIndex: 0 });
    } else if (event.action === 'version-activate') {
      const targetVersion = event.epochVersion ?? event.contentVersion;
      if (targetVersion != null) {
        const targetIdx = epochs.findIndex((e) => e.version === targetVersion);
        if (targetIdx >= 0) {
          active.events.push({
            eventId: event.eventId,
            kind: 'version-activate',
            timestamp: event.timestamp,
            actorId: event.actorId,
            detail: `activated v${targetVersion}`,
          });
          activeIdx = targetIdx;
          timeline.push({ timestamp: event.timestamp, epochIndex: targetIdx });
        }
      }
    } else if (event.action === 'enable' || event.action === 'disable') {
      // AF-5: distinguish operator governance vs auto-eval actions by event.source
      const kind: LifecycleEvent['kind'] =
        event.source === 'operator'
          ? event.action === 'enable'
            ? 'governance-approve'
            : 'governance-reject'
          : event.action === 'enable'
            ? 'eval-pass'
            : 'eval-reject';
      active.events.push({
        eventId: event.eventId,
        kind,
        timestamp: event.timestamp,
        actorId: event.actorId,
        detail: event.action === 'enable' ? 'enabled' : 'disabled',
      });
    }
  }

  return { epochs, timeline };
}

function createEpoch(version: number, origin: VersionOrigin, startedAt: number): VersionEpoch {
  return {
    version,
    origin,
    startedAt,
    status: 'idle',
    isActive: false,
    tracing: null,
    eval: null,
    governance: null,
    events: [],
  };
}

/** Resolve which epoch was active at a given timestamp using the activation timeline. */
export function resolveActiveEpochAt(
  timeline: ActivationPoint[],
  timestamp: number,
  epochs: VersionEpoch[],
): VersionEpoch {
  let idx = 0;
  for (const point of timeline) {
    if (point.timestamp <= timestamp) {
      idx = point.epochIndex;
    } else {
      break;
    }
  }
  return epochs[idx] ?? epochs[0];
}

/** Attribute guard events to epochs using the activation timeline (R15). */
export function attributeGuardEventsToEpochs(
  chain: VersionEpoch[],
  timeline: ActivationPoint[],
  guardEvents: Array<{ timestamp: number; guardId: string }>,
): Record<number, Array<{ guardId: string; count: number }>> {
  const counts = new Map<number, Map<string, number>>();
  for (const e of chain) counts.set(e.version, new Map());
  for (const ge of guardEvents) {
    const epoch = resolveActiveEpochAt(timeline, ge.timestamp, chain);
    const m = counts.get(epoch.version);
    if (m) m.set(ge.guardId, (m.get(ge.guardId) ?? 0) + 1);
  }
  const result: Record<number, Array<{ guardId: string; count: number }>> = {};
  for (const [ver, m] of counts) {
    result[ver] = [...m].map(([guardId, count]) => ({ guardId, count })).sort((a, b) => b.count - a.count);
  }
  return result;
}

// Observation attachment

function attachObservations(
  epochs: VersionEpoch[],
  observations: SegmentObservationInput[],
  timeline: ActivationPoint[],
): void {
  if (observations.length === 0) return;

  for (const obs of observations) {
    const epoch = resolveActiveEpochAt(timeline, obs.timestamp, epochs);

    if (!epoch.tracing) {
      epoch.tracing = { observationCount: 0, firedCount: 0, firstAt: null, lastAt: null };
    }

    epoch.tracing.observationCount++;
    if (obs.fired) epoch.tracing.firedCount++;
    if (epoch.tracing.firstAt === null || obs.timestamp < epoch.tracing.firstAt) {
      epoch.tracing.firstAt = obs.timestamp;
    }
    if (epoch.tracing.lastAt === null || obs.timestamp > epoch.tracing.lastAt) {
      epoch.tracing.lastAt = obs.timestamp;
    }
  }
}

// Active epoch marking

/**
 * Mark the active epoch from the activation timeline (P1-3).
 *
 * The last entry in the timeline determines which epoch is currently active.
 * This naturally handles all activation transitions: content-set, rollback,
 * content-clear, and version-activate — all encoded as timeline entries.
 */
function markActiveFromTimeline(epochs: VersionEpoch[], timeline: ActivationPoint[]): void {
  if (epochs.length === 0 || timeline.length === 0) return;
  const lastPoint = timeline[timeline.length - 1];
  const activeIdx = lastPoint.epochIndex;
  if (activeIdx >= 0 && activeIdx < epochs.length) {
    epochs[activeIdx].isActive = true;
  }
}

// ---------------------------------------------------------------------------
// Judgment attachment
// ---------------------------------------------------------------------------

/**
 * Project a CachedJudgment into the epoch eval stage summary (判据②).
 *
 * Propagates the judgment's OWN eval window + denominator — the query window
 * must never substitute for them; legacy entries carry explicit null
 * (fail-visible, normalized at the cache read seam).
 */
function toEvalStageSummary(judgment: CachedJudgment): EvalStageSummary {
  return {
    verdict: judgment.verdict,
    injectionCount: judgment.injectionCount,
    violationCount: judgment.violationCount,
    evaluatedAt: judgment.evaluatedAt,
    evalWindow: judgment.window ?? null,
    // P2 (sol R5): preserve the gap KIND — corrupted provenance must not be
    // mislabeled as a legacy missing field. Hand-built judgments without the
    // gap fields degrade to 'legacy-missing' (absent = legacy by definition).
    evalWindowGap: judgment.window ? null : (judgment.windowGap ?? 'legacy-missing'),
    denominatorKind: judgment.denominatorKind ?? null,
    denominatorGap: judgment.denominatorKind ? null : (judgment.denominatorGap ?? 'legacy-missing'),
  };
}

/**
 * Attach judgment history to epochs (R8: version-aware attribution).
 * segmentVersion (R7+) → direct epoch match; null → activation timeline fallback.
 * Latest-wins per epoch. Governance derivation on the winning judgment.
 */
function attachJudgments(epochs: VersionEpoch[], judgments: CachedJudgment[], timeline: ActivationPoint[]): void {
  if (epochs.length === 0 || judgments.length === 0) return;

  for (const judgment of judgments) {
    // R8: prefer direct version match (epochVersion is the truth source).
    // Only fall back to activation timeline for legacy judgments without version.
    let target: VersionEpoch | undefined;
    if (judgment.segmentVersion != null) {
      target = epochs.find((e) => e.version === judgment.segmentVersion);
    }
    if (!target) {
      target = resolveActiveEpochAt(timeline, judgment.evaluatedAt, epochs);
    }
    const existing = target.eval;

    // Latest-wins: only overwrite if this judgment is newer
    if (existing && existing.evaluatedAt !== null && existing.evaluatedAt >= judgment.evaluatedAt) {
      continue;
    }

    target.eval = toEvalStageSummary(judgment);

    // Governance derivation from the winning judgment
    if (judgment.verdict === 'alive' || judgment.verdict === 'dormant') {
      target.governance = { decision: 'pending', decidedAt: null, actorId: null };
    } else {
      // Clear governance if newer judgment doesn't warrant it
      target.governance = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

function deriveStatus(epoch: VersionEpoch): VersionEpochStatus {
  // Check governance first (most advanced stage)
  if (epoch.governance?.decision === 'approved') return 'governance-approved';
  if (epoch.governance?.decision === 'pending') return 'governance-pending';

  // Check eval
  if (epoch.eval) {
    if (epoch.eval.verdict === 'alive') return 'eval-pass';
    if (epoch.eval.verdict === 'dormant' || epoch.eval.verdict === 'retire-candidate') {
      return 'eval-reject';
    }
    return 'eval-pending';
  }

  // Check tracing
  if (epoch.tracing && epoch.tracing.observationCount > 0) return 'tracing';

  return 'idle';
}

// ---------------------------------------------------------------------------
// 判据① — activeStage: the loop's REAL stage (F257 #6 slice 6b)
// ---------------------------------------------------------------------------

/**
 * Derive the real stage of the lifecycle loop for the given (active) epoch.
 *
 * Loop model, not one-way pipeline: an eval that cannot conclude
 * (`unmeasurable` / `observability-debt` / `needs-denominator`) or rejects
 * (`retire-candidate`) returns the cycle to `tracing` — the lifeline must NOT
 * paint the cycle as stopped at eval/governance. Only a conclusive
 * `alive` / `dormant` verdict parks the cycle at `governance` (informational).
 *
 * Note: `governance.decision === 'pending'` is deliberately NOT an input here —
 * it is synthesized from alive/dormant and must never be read as
 * "operator action needed" (the original incident's false signal).
 */
export function deriveActiveStage(epoch: VersionEpoch | undefined): ActiveStage {
  if (!epoch) return 'tracing';
  const verdict = epoch.eval?.verdict;
  return verdict === 'alive' || verdict === 'dormant' ? 'governance' : 'tracing';
}

// ---------------------------------------------------------------------------
// Backward-compat status
// ---------------------------------------------------------------------------

/** Derive the legacy status field from the chain. */
export function deriveCurrentStatus(chain: VersionEpoch[]): 'idle' | 'tracing' | 'evaluated' {
  const active = chain.find((e) => e.isActive) ?? chain[chain.length - 1];
  if (!active) return 'idle';
  if (active.eval) return 'evaluated';
  if (active.tracing && active.tracing.observationCount > 0) return 'tracing';
  return 'idle';
}
