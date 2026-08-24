/**
 * #1208 invocation capacity owner.
 *
 * Each member invocation reads the current member setting once. Prompt
 * assembly, lifecycle checks, and provider-native controls consume that same
 * snapshot. A trusted carrier report may lower it during the invocation. The
 * active session persists that resolved capacity and may shrink, but cannot
 * expand until session rollover — not even when a later report exceeds the
 * pin, because that state cannot distinguish a polluted pin (#1381) from a
 * genuine provider shrink followed by genuine recovery. Polluted pins recover
 * explicitly via seal/rollover; the recoverable state is surfaced in the pin
 * provenance and logs.
 *
 * #1381: the snapshot carries two distinct quantities. `nativeWindowTokens` is
 * the raw provider window owned by member configuration and is the only value
 * a provider may inject as its native window; `capacity` is the effective
 * usable capacity that carrier reports and the session pin constrain one-way.
 * Codex reports `native * effective_context_window_percent`, so feeding the
 * effective value back as native recursed (258400 → 245480 → 233206 → …).
 */

import {
  type CatId,
  type ContextHealth,
  catRegistry,
  type SessionCapacityPin,
  type SessionPolicySnapshot,
  type StrategyAction,
} from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import {
  getMemberOutputReserve,
  getMemberWindowSetting,
  type ResolvedContextCapacity,
  resolveContextCapacity,
} from '../../../../../config/context-capacity.js';
import { resolveEffectiveOpenCodeModel } from '../../../../../config/opencode-model.js';
import { shouldTakeAction } from '../../../../../config/session-strategy.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { ISessionSealer } from '../../session/SessionSealer.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import { upsertCapacityPinRecoveryNote } from '../../stores/ports/SessionChainStore.js';
import {
  type AgentContextBinding,
  type AgentContextCapability,
  type AgentService,
  resolveCurrentContextUsage,
  type TokenUsage,
} from '../../types.js';

const UNRESOLVED_CAPABILITY: AgentContextCapability = {
  provider: 'unknown',
  carrier: 'unknown',
  reportsRuntimeWindow: false,
  authoritativeUsage: false,
  usageTelemetry: 'unavailable',
  nativeWindowControl: false,
  nativeCompressionControl: false,
  observesCompression: false,
  reason: 'service did not declare a concrete context capability',
};

const log = createModuleLogger('invocation-capacity-snapshot');

export interface InvocationCapacitySnapshot {
  readonly capacity: ResolvedContextCapacity;
  readonly capability: AgentContextCapability;
  /** Concrete model/window proof for this service spawn or invocation config. */
  readonly binding?: AgentContextBinding;
  /** Immutable resolver inputs captured at this invocation boundary. */
  readonly memberWindowTokens: number | null;
  readonly model: string | undefined;
  /**
   * #1381: raw/native provider window owned by member configuration (manual or
   * catalog source), captured before any session pin or carrier report applies.
   * This is the ONLY value a provider may inject as its native window; the
   * effective/pinned `capacity.windowTokens` must never feed back as native.
   * `null` means this invocation has no config-owned native window (capacity is
   * report-derived or unresolved) and the provider must not inject one.
   */
  readonly nativeWindowTokens: number | null;
  /**
   * #1381: raw carrier-reported window applied during this invocation, before
   * any resolver floor adjustment. Used to surface (never auto-expand) a
   * session pin sitting below the currently reported capacity — that state may
   * be pre-fix feedback-loop pollution, and recovery stays explicit via
   * seal/rollover.
   */
  readonly lastReportedWindowTokens?: number;
}

export interface AuthoritativeContextUsage {
  readonly usedTokens: number;
  readonly usedFrom: 'context' | 'last_turn';
}

function isUsableCapacityPin(pin: SessionCapacityPin | undefined): pin is SessionCapacityPin {
  return (
    pin != null &&
    Number.isFinite(pin.windowTokens) &&
    pin.windowTokens > 0 &&
    Number.isFinite(pin.inputCeilingTokens) &&
    pin.inputCeilingTokens >= 0 &&
    pin.source !== 'unresolved'
  );
}

function capacityPinFromResolved(capacity: ResolvedContextCapacity): SessionCapacityPin | undefined {
  if (capacity.source === 'unresolved' || capacity.windowTokens <= 0) return undefined;
  return {
    windowTokens: capacity.windowTokens,
    inputCeilingTokens: capacity.inputCeilingTokens,
    source: capacity.source,
    provenance: capacity.provenance,
    actionable: capacity.actionable,
  };
}

function snapshotWithCapacity(
  snapshot: InvocationCapacitySnapshot,
  capacity: ResolvedContextCapacity,
): InvocationCapacitySnapshot {
  if (!snapshot.binding || snapshot.binding.windowTokens === capacity.windowTokens) {
    return { ...snapshot, capacity };
  }
  const { binding: _discardedContradictoryBinding, ...withoutBinding } = snapshot;
  return { ...withoutBinding, capacity };
}

/**
 * Apply the active session's shrink-only capacity rule.
 *
 * This is intentionally a small session-owned value, not a reusable binding
 * cache. The current invocation may replace it with a smaller resolved value;
 * a larger value remains clamped until the old session is sealed and a new
 * active record is created.
 *
 * #1381 recovery semantics: a pin polluted by the pre-fix native/effective
 * feedback loop is indistinguishable from a genuine provider shrink — in both
 * cases a later carrier report can exceed the pin — so a larger report must
 * NEVER auto-expand the pin (that would bypass the rollover gate). Recovery
 * of polluted pins stays explicit: seal/roll over the session (#1313 manual
 * seal), after which the fresh session adopts the reported capacity. When a
 * fresh carrier report does exceed the pin, the state is surfaced observably
 * (log + provenance) so the operator knows a seal will recover capacity.
 */
export async function applyActiveSessionCapacityPin(options: {
  snapshot: InvocationCapacitySnapshot;
  catId: CatId;
  threadId: string;
  userId?: string;
  sessionChainStore: ISessionChainStore | undefined;
}): Promise<InvocationCapacitySnapshot> {
  const { snapshot, catId, threadId, userId, sessionChainStore } = options;
  if (!sessionChainStore) return snapshot;

  const active = await sessionChainStore.getActive(catId, threadId, userId);
  if (!active) return snapshot;

  const resolvedPin = capacityPinFromResolved(snapshot.capacity);
  let existingPin = isUsableCapacityPin(active.capacityPin) ? active.capacityPin : undefined;

  // Upgrade active sessions created before capacityPin existed without letting
  // the first post-upgrade invocation expand beyond their last known window.
  if (!existingPin && active.contextHealth?.windowTokens && active.contextHealth.windowTokens > 0) {
    const windowTokens = active.contextHealth.windowTokens;
    existingPin = {
      windowTokens,
      inputCeilingTokens: Math.max(0, windowTokens - getMemberOutputReserve(catId)),
      source: active.contextHealth.source === 'exact' ? 'reported' : 'catalog',
      provenance: `Active session context health → ${windowTokens.toLocaleString()} tokens`,
      actionable: active.contextHealth.source === 'exact',
    };
  }

  if (!existingPin) {
    if (!resolvedPin) return snapshot;
    // #1382 maintainer P1: even first-pin establishment goes through the
    // atomic shrink-only write — a concurrent invocation may have landed a
    // smaller pin between our read and this write.
    const applied = await sessionChainStore.shrinkCapacityPin(active.id, resolvedPin);
    const currentPin = applied?.capacityPin;
    if (currentPin && isUsableCapacityPin(currentPin) && currentPin.windowTokens < snapshot.capacity.windowTokens) {
      return snapshotWithCapacity(snapshot, {
        windowTokens: currentPin.windowTokens,
        inputCeilingTokens: currentPin.inputCeilingTokens,
        source: currentPin.source,
        provenance: `${currentPin.provenance}; session-pinned (shrink allowed, expansion requires rollover)`,
        actionable: currentPin.actionable,
      });
    }
    return snapshot;
  }

  if (resolvedPin && resolvedPin.windowTokens <= existingPin.windowTokens) {
    // #1382 maintainer P1: the numeric shrink applies atomically against the
    // CURRENT stored pin — two concurrent shrink candidates must never
    // reorder into an expansion (delayed 180K must not overwrite a landed
    // 150K).
    const applied = await sessionChainStore.shrinkCapacityPin(active.id, resolvedPin);
    const currentPin = applied?.capacityPin;
    if (currentPin && isUsableCapacityPin(currentPin) && currentPin.windowTokens < resolvedPin.windowTokens) {
      // A concurrent smaller shrink won the race — clamp this invocation's
      // view to the stricter stored pin, not the candidate we prepared.
      return snapshotWithCapacity(snapshot, {
        windowTokens: currentPin.windowTokens,
        inputCeilingTokens: currentPin.inputCeilingTokens,
        source: currentPin.source,
        provenance: `${currentPin.provenance}; session-pinned (shrink allowed, expansion requires rollover)`,
        actionable: currentPin.actionable,
      });
    }
    return snapshotWithCapacity(snapshot, snapshot.capacity);
  }

  // #1381: a fresh carrier report above the pin is observable evidence that the
  // pin may have been polluted by the pre-fix feedback loop — but it is equally
  // consistent with a genuine provider shrink followed by genuine recovery, so
  // it must not auto-expand. Surface the recoverable state; expansion still
  // requires an explicit seal/rollover.
  const freshReport = snapshot.lastReportedWindowTokens;
  // #1382 maintainer P1: compare the RAW report against the ACTIVE pin, never
  // the resolved candidate — KNOWN_MIN floor-raising (or a manual member cap)
  // can lift resolvedPin above the raw report and silently suppress a
  // legitimate recovery hint. Strict >: a report equal to the pin agrees with
  // it and proves nothing recoverable.
  const pinBelowCarrierReport = freshReport != null && freshReport > existingPin.windowTokens;
  if (pinBelowCarrierReport) {
    log.warn(
      {
        catId,
        threadId,
        sessionId: active.id,
        pinnedTokens: existingPin.windowTokens,
        freshReportTokens: freshReport,
      },
      'session capacity pin is below the carrier-reported window; if polluted by the pre-#1381 feedback loop, seal the session to recover (expansion requires rollover)',
    );
  }

  // #1382 maintainer P1: persist the recovery hint on the STORED pin — the
  // returned snapshot is per-invocation while the Hub and digests read the
  // session record. The note is merged atomically against the CURRENT stored
  // pin: writing back this caller's stale pin object could undo a concurrent
  // shrink (lost-update race). Dedup lives in the store operation.
  const recoveryNote = pinBelowCarrierReport
    ? `; carrier now reports ${freshReport.toLocaleString()} tokens — seal the session to recover if this pin was polluted`
    : '';
  if (!isUsableCapacityPin(active.capacityPin)) {
    // Same one-way fence for the upgrade materialization: a concurrent usable
    // pin that constrains harder must survive.
    const applied = await sessionChainStore.shrinkCapacityPin(active.id, existingPin);
    const currentPin = applied?.capacityPin;
    if (currentPin && isUsableCapacityPin(currentPin) && currentPin.windowTokens < existingPin.windowTokens) {
      existingPin = currentPin;
    }
  }
  if (recoveryNote !== '') {
    await sessionChainStore.appendCapacityPinProvenance(active.id, recoveryNote);
  }
  // #1382 review P1: build the returned snapshot from the CURRENT stored pin
  // — the linearization point of the atomic writes above. A concurrent
  // smaller shrink must shape this invocation's returned view too, not just
  // the store (probe: stored 150000 while the caller still returned 200000).
  const currentRecord = await sessionChainStore.get(active.id);
  const currentPin = currentRecord?.capacityPin;
  if (currentPin && isUsableCapacityPin(currentPin) && currentPin.windowTokens < existingPin.windowTokens) {
    existingPin = currentPin;
  }
  // Canonical evidence provenance: the recovery note appears exactly once,
  // whether it was already persisted on the stored pin or is fresh to this
  // invocation, and a jittered report number replaces the older note in
  // place. The stored pin (merged atomically above) and the returned
  // snapshot share this single deduplicated form.
  const evidenceProvenance =
    recoveryNote !== '' ? upsertCapacityPinRecoveryNote(existingPin.provenance, recoveryNote) : existingPin.provenance;
  return snapshotWithCapacity(snapshot, {
    windowTokens: existingPin.windowTokens,
    inputCeilingTokens: existingPin.inputCeilingTokens,
    source: existingPin.source,
    provenance: `${evidenceProvenance}; session-pinned (shrink allowed, expansion requires rollover)`,
    actionable: existingPin.actionable,
  });
}

function bindCatalogCapacityToCarrier(
  capacity: ResolvedContextCapacity,
  capability: AgentContextCapability,
  binding: AgentContextBinding | undefined,
  model: string | undefined,
): ResolvedContextCapacity {
  if (
    capacity.source !== 'catalog' ||
    !binding ||
    binding.model !== model ||
    binding.windowTokens !== capacity.windowTokens ||
    !capability.nativeWindowControl ||
    !capability.authoritativeUsage ||
    capability.usageTelemetry !== 'available'
  ) {
    return capacity;
  }
  return {
    ...capacity,
    actionable: true,
    provenance: `${capacity.provenance}; bound by ${binding.source} to ${capability.provider}/${capability.carrier}`,
  };
}

/** Project a newly-applied native model/window proof onto this invocation. */
export function applyContextBindingToInvocationSnapshot(options: {
  snapshot: InvocationCapacitySnapshot;
  binding: AgentContextBinding;
}): InvocationCapacitySnapshot {
  const { snapshot, binding } = options;
  return {
    ...snapshot,
    binding,
    capacity: bindCatalogCapacityToCarrier(snapshot.capacity, snapshot.capability, binding, snapshot.model),
  };
}

/** Fail closed: aggregate input/total counters are never current-context evidence. */
export function resolveAuthoritativeContextUsage(
  usage: TokenUsage,
  capability: AgentContextCapability,
): AuthoritativeContextUsage | undefined {
  if (!capability.authoritativeUsage) return undefined;
  return resolveCurrentContextUsage(usage);
}

/** Apply a trusted carrier report to this invocation without re-reading member configuration. */
export function applyReportedWindowToInvocationSnapshot(options: {
  snapshot: InvocationCapacitySnapshot;
  catId: CatId | string;
  reportedWindowSize?: number;
}): InvocationCapacitySnapshot {
  const { snapshot, catId, reportedWindowSize } = options;
  if (!snapshot.capability.reportsRuntimeWindow || reportedWindowSize == null) return snapshot;
  return {
    ...snapshot,
    // #1381: keep the RAW report as provider evidence for polluted-pin
    // observability; the resolver may floor-adjust the capacity, but the
    // pin-below-report check keys on what the carrier actually reported.
    lastReportedWindowTokens: reportedWindowSize,
    capacity: resolveContextCapacity({
      catId,
      memberWindowTokens: snapshot.memberWindowTokens,
      reportedWindowSize,
      model: snapshot.model,
    }),
  };
}

/**
 * Apply usage evidence observed by this invocation's concrete carrier.
 *
 * ACP can start with conditional telemetry and prove authoritative usage only
 * after its first usage_update. Refresh the capability on the existing
 * snapshot, then apply an optional runtime-window report, without re-reading
 * member configuration or model routing inputs.
 */
export function applyUsageEvidenceToInvocationSnapshot(options: {
  snapshot: InvocationCapacitySnapshot;
  catId: CatId | string;
  capability: AgentContextCapability;
  reportedWindowSize?: number;
}): InvocationCapacitySnapshot {
  const { snapshot, catId, capability, reportedWindowSize } = options;
  const capabilityRefreshed: InvocationCapacitySnapshot = {
    ...snapshot,
    capability,
    capacity: bindCatalogCapacityToCarrier(snapshot.capacity, capability, snapshot.binding, snapshot.model),
  };
  return applyReportedWindowToInvocationSnapshot({
    snapshot: capabilityRefreshed,
    catId,
    reportedWindowSize,
  });
}

/** Read the current member configuration once for one invocation. */
export function resolveInvocationCapacitySnapshot(options: {
  catId: CatId | string;
  service: AgentService;
  reportedWindowSize?: number;
}): InvocationCapacitySnapshot {
  const { catId, service, reportedWindowSize } = options;
  const config = catRegistry.tryGet(catId)?.config;
  const memberWindowTokens = getMemberWindowSetting(catId) ?? null;
  const serviceBinding = service.contextBinding?.();
  const configuredModel = config ? getCatModel(String(catId)) : undefined;
  const model =
    serviceBinding?.model ??
    (config?.clientId === 'opencode'
      ? (resolveEffectiveOpenCodeModel(config.provider, configuredModel)?.model ?? configuredModel)
      : configuredModel);
  const capability = service.contextCapability?.() ?? UNRESOLVED_CAPABILITY;
  const resolvedCapacity = resolveContextCapacity({
    catId,
    memberWindowTokens,
    reportedWindowSize: capability.reportsRuntimeWindow ? reportedWindowSize : undefined,
    model,
  });
  const binding = serviceBinding ?? service.contextBindingForCapacity?.(resolvedCapacity);
  const capacity = bindCatalogCapacityToCarrier(resolvedCapacity, capability, binding, model);
  return {
    capacity,
    capability,
    ...(binding ? { binding } : {}),
    memberWindowTokens,
    model,
    // #1381: only member configuration (manual/catalog) owns a native window.
    // A report-derived or unresolved capacity has no raw value to inject —
    // feeding the effective number back as Codex's native model_context_window
    // is the recursive shrink this field exists to prevent.
    nativeWindowTokens:
      resolvedCapacity.source === 'manual' || resolvedCapacity.source === 'catalog'
        ? resolvedCapacity.windowTokens
        : null,
  };
}

/**
 * Evaluate a repair action before provider launch. Handoff snapshots are
 * unavailable here because this invocation has not emitted authoritative
 * usage yet; only a policy whose own proof is already active (for example an
 * already-observed hybrid epoch) may cross this boundary.
 */
export function resolvePreInvocationCapacityAction(options: {
  snapshot: InvocationCapacitySnapshot;
  contextHealth: ContextHealth | undefined;
  hybridProgressCount: number | null;
  policySnapshot: SessionPolicySnapshot;
}): StrategyAction {
  const { snapshot, contextHealth, hybridProgressCount, policySnapshot } = options;
  const inputCeiling = snapshot.capacity.inputCeilingTokens;
  if (
    !snapshot.capacity.actionable ||
    inputCeiling <= 0 ||
    contextHealth?.source !== 'exact' ||
    (contextHealth.usedFrom !== 'context' && contextHealth.usedFrom !== 'last_turn')
  ) {
    return { type: 'none' };
  }
  if (policySnapshot.execution.status !== 'active') return { type: 'none' };
  const fillRatio = Math.min(contextHealth.usedTokens / inputCeiling, 1);
  return shouldTakeAction(
    fillRatio,
    inputCeiling,
    contextHealth.usedTokens,
    hybridProgressCount,
    policySnapshot.config,
  );
}

/** Repair an already-proven policy transition before provider launch. */
export async function sealBeforeInvocationIfNeeded(options: {
  snapshot: InvocationCapacitySnapshot;
  catId: CatId;
  threadId: string;
  userId?: string;
  sessionChainStore: ISessionChainStore | undefined;
  sessionSealer: ISessionSealer | undefined;
  policySnapshot: SessionPolicySnapshot;
  clearProviderSession: () => Promise<void>;
}): Promise<boolean> {
  const { snapshot, catId, threadId, userId, sessionChainStore, sessionSealer, policySnapshot, clearProviderSession } =
    options;
  if (!sessionChainStore || !sessionSealer) return false;

  const active = await sessionChainStore.getActive(catId, threadId, userId);
  if (!active) return false;

  const action = resolvePreInvocationCapacityAction({
    snapshot,
    contextHealth: active.contextHealth,
    hybridProgressCount: active.hybridProgress?.observedCount ?? null,
    policySnapshot,
  });
  if (action.type !== 'seal' && action.type !== 'seal_after_compress') return false;

  const result = await sessionSealer.requestSeal({
    sessionId: active.id,
    reason: action.reason,
    expectedPolicyRevision: policySnapshot.revision,
  });
  if (!result.accepted) return false;

  await clearProviderSession();
  await sessionSealer.finalize({ sessionId: active.id });
  return true;
}
