/**
 * #1208 invocation capacity owner.
 *
 * Each member invocation reads the current member setting once. Prompt
 * assembly, lifecycle checks, and provider-native controls consume that same
 * snapshot. A trusted carrier report may lower it during the invocation. The
 * active session persists that resolved capacity and may shrink, but cannot
 * expand until session rollover.
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
import type { ISessionSealer } from '../../session/SessionSealer.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
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

export interface InvocationCapacitySnapshot {
  readonly capacity: ResolvedContextCapacity;
  readonly capability: AgentContextCapability;
  /** Concrete model/window proof for this service spawn or invocation config. */
  readonly binding?: AgentContextBinding;
  /** Immutable resolver inputs captured at this invocation boundary. */
  readonly memberWindowTokens: number | null;
  readonly model: string | undefined;
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
    await sessionChainStore.update(active.id, { capacityPin: resolvedPin, updatedAt: Date.now() });
    return snapshot;
  }

  if (resolvedPin && resolvedPin.windowTokens <= existingPin.windowTokens) {
    await sessionChainStore.update(active.id, { capacityPin: resolvedPin, updatedAt: Date.now() });
    return snapshotWithCapacity(snapshot, snapshot.capacity);
  }

  if (!isUsableCapacityPin(active.capacityPin)) {
    await sessionChainStore.update(active.id, { capacityPin: existingPin, updatedAt: Date.now() });
  }
  return snapshotWithCapacity(snapshot, {
    windowTokens: existingPin.windowTokens,
    inputCeilingTokens: existingPin.inputCeilingTokens,
    source: existingPin.source,
    provenance: `${existingPin.provenance}; session-pinned (shrink allowed, expansion requires rollover)`,
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
