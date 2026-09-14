/** F257 Phase D — Version lifecycle chain builder. Pure, no Redis. */

import type {
  LifecycleEvent,
  OverrideChangeEvent,
  VersionEpoch,
  VersionEpochStatus,
  VersionOrigin,
} from '@cat-cafe/shared';

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
  /** The hook was evaluated but disabled, so no content was injected. */
  disabled: boolean;
}

export interface ChainBuilderInput {
  /** Manifest baseline version (from hook.yaml). */
  manifestVersion: number;
  /** Override change events filtered for this segment, sorted by timestamp. */
  overrideEvents: OverrideChangeEvent[];
  /** Observations (timestamp + version + fired) within the query window. */
  observations: SegmentObservationInput[];
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
 * 4. Derive each epoch's tracing status. Evaluation and governance are read
 *    from CycleRecord by SegmentEvaluationReadModel, never projected here.
 */
export function buildVersionChain(input: ChainBuilderInput): { chain: VersionEpoch[]; timeline: ActivationPoint[] } {
  const { manifestVersion, overrideEvents, observations } = input;

  // Single-pass event reducer: builds epochs AND activation timeline together.
  // This avoids timestamp-based lookups that break on same-ms events (R4 P1-1).
  const { epochs, timeline } = buildEpochsAndTimeline(manifestVersion, overrideEvents);

  // Attach observations using activation timeline
  attachObservations(epochs, observations, timeline);

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
  const epochs: VersionEpoch[] = [createEpoch(manifestVersion, null, 'manifest', 0)];
  const timeline: ActivationPoint[] = [{ timestamp: 0, epochIndex: 0 }];
  // R9: track active epoch (not last-created). content-set/activate/rollback/clear update it.
  let activeIdx = 0;

  for (const event of events) {
    const active = epochs[activeIdx];

    if (event.action === 'content-set') {
      const newVersion = event.epochVersion ?? epochs[epochs.length - 1].version + 1; // monotonic fallback
      const origin: VersionOrigin = event.source === 'operator' ? 'user-create' : 'auto-iterate';
      const parentVersion = event.parentVersion ?? active.version;
      const parent = epochs.find((epoch) => epoch.version === parentVersion) ?? active;

      parent.events.push({
        eventId: event.eventId,
        kind: origin === 'user-create' ? 'user-create' : 'auto-iterate',
        timestamp: event.timestamp,
        actorId: event.actorId,
        detail: `v${parentVersion} → v${newVersion}`,
      });

      const newEpoch = createEpoch(newVersion, parentVersion, origin, event.timestamp);
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

function createEpoch(
  version: number,
  parentVersion: number | null,
  origin: VersionOrigin,
  startedAt: number,
): VersionEpoch {
  return {
    version,
    parentVersion,
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
      epoch.tracing = { observationCount: 0, firedCount: 0, disabledCount: 0, firstAt: null, lastAt: null };
    }

    epoch.tracing.observationCount++;
    if (obs.fired) epoch.tracing.firedCount++;
    if (obs.disabled) epoch.tracing.disabledCount++;
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
// Status derivation
// ---------------------------------------------------------------------------

function deriveStatus(epoch: VersionEpoch): VersionEpochStatus {
  // Check tracing
  if (epoch.tracing && epoch.tracing.observationCount > 0) return 'tracing';

  return 'idle';
}

// ---------------------------------------------------------------------------
// Summary status
// ---------------------------------------------------------------------------

/** Derive the legacy status field from the chain. */
export function deriveCurrentStatus(chain: VersionEpoch[]): 'idle' | 'tracing' | 'evaluated' {
  const active = chain.find((e) => e.isActive) ?? chain[chain.length - 1];
  if (!active) return 'idle';
  if (active.tracing && active.tracing.observationCount > 0) return 'tracing';
  return 'idle';
}
