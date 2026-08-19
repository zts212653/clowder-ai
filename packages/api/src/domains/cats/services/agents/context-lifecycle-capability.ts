import type { SessionExecutionReason, SessionExecutionStatus, SessionStrategy } from '@cat-cafe/shared';
import type { AgentContextCapability } from '../types.js';

export type ContextLifecycleStrategy = 'handoff' | 'compress' | 'hybrid';

export interface ContextLifecycleSupport {
  supported: boolean;
  reason: string;
}

/**
 * Invocation-owned proof used to derive policy execution status.
 *
 * The booleans describe evidence available to this concrete managed
 * invocation. They do not encode a fallback policy and must never be
 * persisted as provider defaults.
 */
export interface SessionExecutionEvidence {
  managedInvocationBoundary: boolean;
  effectiveInputCeiling: boolean;
  carrierBinding: boolean;
  authoritativeUsage: boolean;
  sessionRotation: boolean;
  continuityBootstrap: boolean;
  observesCompression: boolean;
}

function hybridMissingCapabilities(evidence: SessionExecutionEvidence): SessionExecutionReason[] {
  const missingCapabilities: SessionExecutionReason[] = [];
  if (!evidence.observesCompression) missingCapabilities.push('compression_signal');
  if (!evidence.sessionRotation) missingCapabilities.push('session_rotation');
  if (!evidence.continuityBootstrap) missingCapabilities.push('continuity_bootstrap');
  return missingCapabilities;
}

function handoffMissingCapabilities(evidence: SessionExecutionEvidence): SessionExecutionReason[] {
  const missingCapabilities: SessionExecutionReason[] = [];
  if (!evidence.effectiveInputCeiling) missingCapabilities.push('effective_input_ceiling');
  if (!evidence.carrierBinding) missingCapabilities.push('carrier_binding');
  if (!evidence.authoritativeUsage) missingCapabilities.push('authoritative_usage');
  if (!evidence.sessionRotation) missingCapabilities.push('session_rotation');
  if (!evidence.continuityBootstrap) missingCapabilities.push('continuity_bootstrap');
  return missingCapabilities;
}

/**
 * Derive execution status without changing persisted policy, effective policy,
 * or runtime action family.
 */
export function resolveSessionExecutionStatus(
  policy: SessionStrategy,
  evidence: SessionExecutionEvidence,
): SessionExecutionStatus {
  if (!evidence.managedInvocationBoundary) {
    return {
      status: 'unavailable',
      missingCapabilities: ['managed_invocation_boundary'],
    };
  }

  if (policy === 'compress') {
    return { status: 'active', missingCapabilities: [] };
  }

  if (policy === 'hybrid') {
    const missingCapabilities = hybridMissingCapabilities(evidence);
    return {
      status: missingCapabilities.length === 0 ? 'active' : 'degraded',
      missingCapabilities,
    };
  }

  const missingCapabilities = handoffMissingCapabilities(evidence);
  return {
    status: missingCapabilities.length === 0 ? 'active' : 'unavailable',
    missingCapabilities,
  };
}

/**
 * @deprecated #1329: use resolveSessionExecutionStatus with invocation-owned
 * evidence. Retained temporarily for provider capability matrix compatibility.
 */
export function resolveContextLifecycleSupport(
  capability: AgentContextCapability,
  strategy: ContextLifecycleStrategy,
): ContextLifecycleSupport {
  if (!capability.authoritativeUsage || capability.usageTelemetry !== 'available') {
    return {
      supported: false,
      reason:
        capability.usageTelemetry === 'conditional'
          ? 'Context usage unavailable until this carrier emits authoritative usage telemetry'
          : 'Context usage unavailable for this carrier',
    };
  }
  if (strategy === 'compress' && !capability.nativeCompressionControl) {
    return { supported: false, reason: 'Native compression control is unavailable for this carrier' };
  }
  if (strategy === 'hybrid') {
    if (!capability.nativeCompressionControl) {
      return { supported: false, reason: 'Native compression control is unavailable for this carrier' };
    }
    if (!capability.observesCompression) {
      return { supported: false, reason: 'Native compression events are unavailable for this carrier' };
    }
  }
  return { supported: true, reason: capability.reason };
}
