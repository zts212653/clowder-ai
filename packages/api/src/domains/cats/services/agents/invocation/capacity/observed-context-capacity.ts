import type { NativeSessionBinding } from '@cat-cafe/shared';
import { getMemberOutputReserve } from '../../../../../../config/context-capacity.js';
import type { ObservedContextWindow } from '../../../types.js';
import type { InvocationCapacitySnapshot } from './invocation-capacity-types.js';

/** The current verified init may supersede routing's model, but never supplies a window. */
export function applyVerifiedNativeModelToInvocationSnapshot(
  snapshot: InvocationCapacitySnapshot,
  binding: NativeSessionBinding,
  sessionId: string,
): InvocationCapacitySnapshot {
  if (
    snapshot.capability.provider !== 'google' ||
    snapshot.capability.carrier !== 'agy_stream_json' ||
    binding.v !== 1 ||
    binding.carrier !== 'agy_stream_json' ||
    !sessionId ||
    binding.cliSessionId !== sessionId ||
    typeof binding.model !== 'string' ||
    !binding.model.trim() ||
    snapshot.model === binding.model
  )
    return snapshot;
  const { binding: _previousModelProof, ...withoutBinding } = snapshot;
  return {
    ...withoutBinding,
    model: binding.model,
    capacity: snapshot.capacity.source === 'observed' ? { ...snapshot.capacity, actionable: false } : snapshot.capacity,
  };
}

/** Bind only evidence attached by the current verified carrier; catalog names alone prove nothing. */
export function applyObservedContextCapacity(
  snapshot: InvocationCapacitySnapshot,
  catId: string,
  observation: ObservedContextWindow | undefined,
): InvocationCapacitySnapshot {
  if (
    !observation ||
    snapshot.capability.provider !== 'google' ||
    snapshot.capability.carrier !== 'agy_stream_json' ||
    observation.provider !== 'google' ||
    observation.carrier !== 'agy_stream_json' ||
    !snapshot.capability.authoritativeUsage ||
    snapshot.capability.usageTelemetry !== 'available' ||
    !snapshot.model?.trim() ||
    observation.model !== snapshot.model ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(observation.cliVersion) ||
    !/^[a-f0-9]{64}$/.test(observation.scopeId) ||
    !Number.isSafeInteger(observation.windowTokens) ||
    observation.windowTokens <= getMemberOutputReserve(catId) ||
    !Number.isFinite(observation.observedAt) ||
    observation.observedAt <= 0 ||
    !/^agy_native_checkpoint:[^\s:]+:\d+$/.test(observation.evidenceRef)
  )
    return snapshot;
  const ceilings = [observation.windowTokens];
  if (snapshot.capacity.windowTokens > 0) ceilings.push(snapshot.capacity.windowTokens);
  if (snapshot.memberWindowTokens != null && snapshot.memberWindowTokens > 0)
    ceilings.push(snapshot.memberWindowTokens);
  const windowTokens = Math.min(...ceilings);
  return {
    ...snapshot,
    binding: { source: 'observed', model: snapshot.model, windowTokens },
    capacity: {
      source: 'observed',
      actionable: true,
      windowTokens,
      inputCeilingTokens: Math.max(0, windowTokens - getMemberOutputReserve(catId)),
      provenance: `Observed AGY ${observation.cliVersion} automatic checkpoint (${observation.evidenceRef}, scope ${observation.scopeId}) → ${observation.windowTokens} tokens; bounded by this invocation's catalog/member/session ceiling → ${windowTokens}`,
    },
  };
}
