import type { CandidateHello, Capability, HandshakeRejectReason, WireMethodName } from '@clowder-ai/plugin-contract';

export const HOST_BROKER_SCHEMA_VERSION = 1 as const;

export type BrokerSessionPhase = 'transport_connected' | 'host_bound' | 'active' | 'draining' | 'closed';
export type BrokerRuntimeLeaseState = 'pending' | 'live' | 'expired' | 'revoked' | 'closed';
export type BrokerCallPhase = 'claimed' | 'dispatched' | 'settled_success' | 'settled_error';
export type BrokerTransportKind = 'builtin-loopback' | 'stdio';

export interface BrokerSessionRecord {
  readonly connectionId: string;
  readonly brokerSessionId: string;
  readonly runtimeLeaseId: string;
  readonly transportKind: BrokerTransportKind;
  readonly pluginInstanceId: string;
  readonly pluginId: string;
  readonly packageDigest: string;
  readonly contractVersion: string;
  readonly wireVersion: string;
  readonly phase: BrokerSessionPhase;
  readonly candidate?: CandidateHello;
  readonly grantRevision?: number;
  readonly effectiveGrants?: readonly Capability[];
  readonly bindingNonce?: string;
  readonly preActiveDeadlineAt: number;
  readonly activeLeaseExpiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt?: number;
  readonly closeReason?: string;
}

export interface BrokerRuntimeLeaseRecord {
  readonly runtimeLeaseId: string;
  readonly brokerSessionId: string;
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly grantRevision: number;
  readonly state: BrokerRuntimeLeaseState;
  readonly expiresAt: number;
  readonly updatedAt: number;
}

export interface BrokerCallError {
  readonly code: string;
  readonly message: string;
}

export interface BrokerCallRecord {
  readonly ledgerKey: string;
  readonly brokerSessionId: string;
  readonly runtimeLeaseId: string;
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly grantRevision: number;
  readonly method: WireMethodName;
  readonly settlementKey: string;
  readonly inputDigest: string;
  readonly phase: BrokerCallPhase;
  readonly revision: number;
  readonly result?: unknown;
  readonly error?: BrokerCallError;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface HostBrokerSnapshot {
  readonly schemaVersion: typeof HOST_BROKER_SCHEMA_VERSION;
  readonly sessions: readonly BrokerSessionRecord[];
  readonly runtimeLeases: readonly BrokerRuntimeLeaseRecord[];
  readonly calls: readonly BrokerCallRecord[];
}

export type HostBrokerErrorCode =
  | 'HANDSHAKE_REJECTED'
  | 'INSTANCE_NOT_READY'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_ACTIVE'
  | 'METHOD_NOT_READY'
  | 'METHOD_NOT_REGISTERED'
  | 'INVALID_CALL_INPUT'
  | 'INVALID_CALL_RESULT'
  | 'CAPABILITY_DENIED'
  | 'AUTHORITY_CHANGED'
  | 'CALL_CONFLICT'
  | 'CALL_IN_FLIGHT'
  | 'CORRUPT_SNAPSHOT'
  | 'UNSUPPORTED_SCHEMA'
  | 'BROKER_INVARIANT';

export class HostBrokerError extends Error {
  constructor(
    readonly code: HostBrokerErrorCode,
    message: string,
    readonly reason?: HandshakeRejectReason,
    readonly sessionCloseReason?: string,
  ) {
    super(message);
    this.name = 'HostBrokerError';
  }
}

export interface BrokerCallContext {
  readonly connectionId: string;
  readonly brokerSessionId: string;
  readonly runtimeLeaseId: string;
  readonly pluginInstanceId: string;
  readonly pluginId: string;
  readonly packageDigest: string;
  readonly contractVersion: string;
  readonly grantRevision: number;
  readonly effectiveGrants: readonly Capability[];
}

export type BrokerValidationResult<Value> = { readonly valid: true; readonly value: Value } | { readonly valid: false };

export interface BrokerMethodHandler<Input = unknown, Result = unknown> {
  readonly method: WireMethodName;
  /** K-1 already owns messaging settlement; bypass the generic Broker call ledger. */
  readonly settlementAuthority?: 'broker' | 'domain';
  validateInput(value: unknown): BrokerValidationResult<Input>;
  validateResult(value: unknown): value is Result;
  settlementKey(context: BrokerCallContext, input: Input): string;
  dispatch(context: BrokerCallContext, input: Input): Promise<Result>;
  lookupSettlement(context: BrokerCallContext, input: Input): Promise<Result | null>;
  serializePreEffectError(error: unknown): BrokerCallError | null;
  canRetrySettledErrorAfterAuthorityChange?(error: BrokerCallError): boolean;
  restoreSettledError(error: BrokerCallError): Error;
}
