import {
  type Capability,
  validateBindingNonce,
  validateCandidateHello,
  validateContractVersion,
  validateEffectiveGrants,
  validatePackageDigest,
  validatePluginId,
  validateWireVersion,
  WIRE_METHOD_NAMES,
} from '@clowder-ai/plugin-contract';
import type {
  BrokerCallPhase,
  BrokerCallRecord,
  BrokerRuntimeLeaseRecord,
  BrokerRuntimeLeaseState,
  BrokerSessionPhase,
  BrokerSessionRecord,
  HostBrokerSnapshot,
} from './types.js';
import { HOST_BROKER_SCHEMA_VERSION, HostBrokerError } from './types.js';

const SESSION_PHASES = new Set<BrokerSessionPhase>([
  'transport_connected',
  'host_bound',
  'active',
  'draining',
  'closed',
]);
const LEASE_STATES = new Set<BrokerRuntimeLeaseState>(['pending', 'live', 'expired', 'revoked', 'closed']);
const CALL_PHASES = new Set<BrokerCallPhase>(['claimed', 'dispatched', 'settled_success', 'settled_error']);
const METHODS = new Set<string>(WIRE_METHOD_NAMES);

function corrupt(message: string): never {
  throw new HostBrokerError('CORRUPT_SNAPSHOT', message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) corrupt(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) corrupt(`${label} must be a non-empty string`);
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    corrupt(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveRevision(value: unknown, label: string): number {
  const revision = timestamp(value, label);
  if (revision < 1) corrupt(`${label} must be positive`);
  return revision;
}

function enumValue<Value extends string>(value: unknown, values: ReadonlySet<Value>, label: string): Value {
  if (typeof value !== 'string' || !values.has(value as Value)) corrupt(`${label} has an unsupported value`);
  return value as Value;
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : timestamp(value, label);
}

function sessionIdentity(raw: Record<string, unknown>, label: string) {
  const pluginId = string(raw.pluginId, `${label}.pluginId`);
  const packageDigest = string(raw.packageDigest, `${label}.packageDigest`);
  const contractVersion = string(raw.contractVersion, `${label}.contractVersion`);
  const wireVersion = string(raw.wireVersion, `${label}.wireVersion`);
  if (
    !validatePluginId(pluginId) ||
    !validatePackageDigest(packageDigest) ||
    !validateContractVersion(contractVersion) ||
    !validateWireVersion(wireVersion)
  ) {
    corrupt(`${label} has invalid contract identity`);
  }
  const candidate = raw.candidate;
  if (candidate !== undefined && !validateCandidateHello(candidate)) corrupt(`${label}.candidate is invalid`);
  if (
    candidate !== undefined &&
    (candidate.pluginId !== pluginId ||
      candidate.packageDigest !== packageDigest ||
      candidate.contractVersion !== contractVersion ||
      candidate.wireVersion !== wireVersion)
  ) {
    corrupt(`${label}.candidate does not echo the bound package`);
  }
  return { pluginId, packageDigest, contractVersion, wireVersion, candidate };
}

function sessionEffectiveGrants(value: unknown, label: string): Capability[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((grant) => typeof grant === 'string') || !validateEffectiveGrants(value)) {
    corrupt(`${label}.effectiveGrants is invalid`);
  }
  return [...value] as Capability[];
}

function assertSessionPhase(
  phase: BrokerSessionPhase,
  authority: {
    readonly candidate: unknown;
    readonly grantRevision?: number;
    readonly effectiveGrants?: readonly Capability[];
    readonly bindingNonce?: string;
    readonly activeLeaseExpiresAt?: number;
  },
  label: string,
): void {
  if (
    phase === 'transport_connected' &&
    (authority.candidate !== undefined ||
      authority.grantRevision !== undefined ||
      authority.effectiveGrants !== undefined)
  ) {
    corrupt(`${label} transport-connected state already contains Host binding authority`);
  }
  if (
    phase === 'host_bound' &&
    (!authority.candidate ||
      authority.grantRevision === undefined ||
      !authority.effectiveGrants ||
      !authority.bindingNonce)
  ) {
    corrupt(`${label} host-bound state is incomplete`);
  }
  if (
    phase === 'active' &&
    (!authority.candidate ||
      authority.grantRevision === undefined ||
      !authority.effectiveGrants ||
      authority.bindingNonce ||
      authority.activeLeaseExpiresAt === undefined)
  ) {
    corrupt(`${label} active state is incomplete`);
  }
}

function parseSession(value: unknown, index: number): BrokerSessionRecord {
  const label = `sessions[${index}]`;
  const raw = object(value, label);
  const identity = sessionIdentity(raw, label);
  const grantRevision =
    raw.grantRevision === undefined ? undefined : positiveRevision(raw.grantRevision, `${label}.grantRevision`);
  const effectiveGrants = sessionEffectiveGrants(raw.effectiveGrants, label);
  const bindingNonce = raw.bindingNonce;
  if (bindingNonce !== undefined && !validateBindingNonce(bindingNonce)) corrupt(`${label}.bindingNonce is invalid`);
  const phase = enumValue(raw.phase, SESSION_PHASES, `${label}.phase`);
  const activeLeaseExpiresAt = optionalTimestamp(raw.activeLeaseExpiresAt, `${label}.activeLeaseExpiresAt`);
  assertSessionPhase(
    phase,
    { candidate: identity.candidate, grantRevision, effectiveGrants, bindingNonce, activeLeaseExpiresAt },
    label,
  );
  const createdAt = timestamp(raw.createdAt, `${label}.createdAt`);
  const updatedAt = timestamp(raw.updatedAt, `${label}.updatedAt`);
  if (updatedAt < createdAt) corrupt(`${label}.updatedAt precedes creation`);
  return {
    connectionId: string(raw.connectionId, `${label}.connectionId`),
    brokerSessionId: string(raw.brokerSessionId, `${label}.brokerSessionId`),
    runtimeLeaseId: string(raw.runtimeLeaseId, `${label}.runtimeLeaseId`),
    transportKind: enumValue(
      raw.transportKind,
      new Set(['builtin-loopback', 'stdio'] as const),
      `${label}.transportKind`,
    ),
    pluginInstanceId: string(raw.pluginInstanceId, `${label}.pluginInstanceId`),
    pluginId: identity.pluginId,
    packageDigest: identity.packageDigest,
    contractVersion: identity.contractVersion,
    wireVersion: identity.wireVersion,
    phase,
    ...(identity.candidate === undefined ? {} : { candidate: structuredClone(identity.candidate) }),
    ...(grantRevision === undefined ? {} : { grantRevision }),
    ...(effectiveGrants === undefined ? {} : { effectiveGrants }),
    ...(bindingNonce === undefined ? {} : { bindingNonce }),
    preActiveDeadlineAt: timestamp(raw.preActiveDeadlineAt, `${label}.preActiveDeadlineAt`),
    ...(activeLeaseExpiresAt === undefined ? {} : { activeLeaseExpiresAt }),
    createdAt,
    updatedAt,
    ...(raw.closedAt === undefined ? {} : { closedAt: timestamp(raw.closedAt, `${label}.closedAt`) }),
    ...(raw.closeReason === undefined ? {} : { closeReason: string(raw.closeReason, `${label}.closeReason`) }),
  };
}

function parseLease(value: unknown, index: number): BrokerRuntimeLeaseRecord {
  const label = `runtimeLeases[${index}]`;
  const raw = object(value, label);
  const packageDigest = string(raw.packageDigest, `${label}.packageDigest`);
  if (!validatePackageDigest(packageDigest)) corrupt(`${label}.packageDigest is invalid`);
  return {
    runtimeLeaseId: string(raw.runtimeLeaseId, `${label}.runtimeLeaseId`),
    brokerSessionId: string(raw.brokerSessionId, `${label}.brokerSessionId`),
    pluginInstanceId: string(raw.pluginInstanceId, `${label}.pluginInstanceId`),
    packageDigest,
    grantRevision: positiveRevision(raw.grantRevision, `${label}.grantRevision`),
    state: enumValue(raw.state, LEASE_STATES, `${label}.state`),
    expiresAt: timestamp(raw.expiresAt, `${label}.expiresAt`),
    updatedAt: timestamp(raw.updatedAt, `${label}.updatedAt`),
  };
}

function parseCallOutcome(raw: Record<string, unknown>, phase: BrokerCallPhase, label: string) {
  const hasResult = Object.hasOwn(raw, 'result');
  const hasError = Object.hasOwn(raw, 'error');
  if (phase === 'settled_success' && (!hasResult || hasError)) corrupt(`${label} success settlement is malformed`);
  if (phase === 'settled_error' && (!hasError || hasResult)) corrupt(`${label} error settlement is malformed`);
  if ((phase === 'claimed' || phase === 'dispatched') && (hasResult || hasError)) {
    corrupt(`${label} nonterminal call contains a terminal outcome`);
  }
  if (!hasError) return hasResult ? { result: structuredClone(raw.result) } : {};
  const error = object(raw.error, `${label}.error`);
  return {
    error: {
      code: string(error.code, `${label}.error.code`),
      message: string(error.message, `${label}.error.message`),
    },
  };
}

function parseCall(value: unknown, index: number): BrokerCallRecord {
  const label = `calls[${index}]`;
  const raw = object(value, label);
  const method = string(raw.method, `${label}.method`);
  if (!METHODS.has(method)) corrupt(`${label}.method is not in the public registry`);
  const packageDigest = string(raw.packageDigest, `${label}.packageDigest`);
  if (!validatePackageDigest(packageDigest)) corrupt(`${label}.packageDigest is invalid`);
  const phase = enumValue(raw.phase, CALL_PHASES, `${label}.phase`);
  const outcome = parseCallOutcome(raw, phase, label);
  const createdAt = timestamp(raw.createdAt, `${label}.createdAt`);
  const updatedAt = timestamp(raw.updatedAt, `${label}.updatedAt`);
  if (updatedAt < createdAt) corrupt(`${label}.updatedAt precedes creation`);
  return {
    ledgerKey: string(raw.ledgerKey, `${label}.ledgerKey`),
    brokerSessionId: string(raw.brokerSessionId, `${label}.brokerSessionId`),
    runtimeLeaseId: string(raw.runtimeLeaseId, `${label}.runtimeLeaseId`),
    pluginInstanceId: string(raw.pluginInstanceId, `${label}.pluginInstanceId`),
    packageDigest,
    grantRevision: positiveRevision(raw.grantRevision, `${label}.grantRevision`),
    method: method as BrokerCallRecord['method'],
    settlementKey: string(raw.settlementKey, `${label}.settlementKey`),
    inputDigest: string(raw.inputDigest, `${label}.inputDigest`),
    phase,
    revision: positiveRevision(raw.revision, `${label}.revision`),
    ...outcome,
    createdAt,
    updatedAt,
  };
}

function indexSessions(sessions: BrokerSessionRecord[]): Map<string, BrokerSessionRecord> {
  const sessionById = new Map<string, BrokerSessionRecord>();
  const connectionIds = new Set<string>();
  const runtimeLeaseIds = new Set<string>();
  for (const session of sessions) {
    if (connectionIds.has(session.connectionId) || sessionById.has(session.brokerSessionId)) {
      corrupt('duplicate Broker session identity');
    }
    if (runtimeLeaseIds.has(session.runtimeLeaseId)) corrupt('duplicate Broker runtime lease identity');
    connectionIds.add(session.connectionId);
    sessionById.set(session.brokerSessionId, session);
    runtimeLeaseIds.add(session.runtimeLeaseId);
  }
  return sessionById;
}

function indexLeases(
  runtimeLeases: BrokerRuntimeLeaseRecord[],
  sessionById: ReadonlyMap<string, BrokerSessionRecord>,
): Map<string, BrokerRuntimeLeaseRecord> {
  const leaseById = new Map<string, BrokerRuntimeLeaseRecord>();
  for (const lease of runtimeLeases) {
    if (leaseById.has(lease.runtimeLeaseId)) corrupt(`duplicate runtime lease ${lease.runtimeLeaseId}`);
    const session = sessionById.get(lease.brokerSessionId);
    if (
      !session ||
      session.runtimeLeaseId !== lease.runtimeLeaseId ||
      session.pluginInstanceId !== lease.pluginInstanceId ||
      session.packageDigest !== lease.packageDigest ||
      session.grantRevision !== lease.grantRevision
    ) {
      corrupt(`runtime lease ${lease.runtimeLeaseId} does not match its session authority`);
    }
    leaseById.set(lease.runtimeLeaseId, lease);
  }
  return leaseById;
}

function assertSessionLeaseStates(
  sessions: BrokerSessionRecord[],
  leaseById: ReadonlyMap<string, BrokerRuntimeLeaseRecord>,
): void {
  for (const session of sessions) {
    const lease = leaseById.get(session.runtimeLeaseId);
    if (session.phase === 'active' && (!lease || lease.state !== 'live')) {
      corrupt(`active session ${session.brokerSessionId} has no live lease`);
    }
    if (session.phase === 'closed' && lease && lease.state !== 'closed') {
      corrupt(`closed session ${session.brokerSessionId} retains a live lease`);
    }
  }
}

function assertCallReferences(calls: BrokerCallRecord[], sessionById: ReadonlyMap<string, BrokerSessionRecord>): void {
  const ledgerKeys = new Set<string>();
  for (const call of calls) {
    if (ledgerKeys.has(call.ledgerKey)) corrupt(`duplicate call ledger ${call.ledgerKey}`);
    const session = sessionById.get(call.brokerSessionId);
    if (
      !session ||
      session.runtimeLeaseId !== call.runtimeLeaseId ||
      session.pluginInstanceId !== call.pluginInstanceId ||
      session.packageDigest !== call.packageDigest
    ) {
      corrupt(`call ${call.ledgerKey} does not match its session authority`);
    }
    ledgerKeys.add(call.ledgerKey);
  }
}

function assertReferences(
  sessions: BrokerSessionRecord[],
  runtimeLeases: BrokerRuntimeLeaseRecord[],
  calls: BrokerCallRecord[],
): void {
  const sessionById = indexSessions(sessions);
  const leaseById = indexLeases(runtimeLeases, sessionById);
  assertSessionLeaseStates(sessions, leaseById);
  assertCallReferences(calls, sessionById);
}

export function emptyHostBrokerSnapshot(): HostBrokerSnapshot {
  return { schemaVersion: HOST_BROKER_SCHEMA_VERSION, sessions: [], runtimeLeases: [], calls: [] };
}

export function cloneHostBrokerSnapshot(snapshot: HostBrokerSnapshot): HostBrokerSnapshot {
  return structuredClone(snapshot);
}

export function parseHostBrokerSnapshot(value: unknown): HostBrokerSnapshot {
  const raw = object(value, 'Host Broker snapshot');
  if (raw.schemaVersion !== HOST_BROKER_SCHEMA_VERSION) {
    if (typeof raw.schemaVersion === 'number') {
      throw new HostBrokerError('UNSUPPORTED_SCHEMA', `unsupported Host Broker schema ${raw.schemaVersion}`);
    }
    corrupt('Host Broker snapshot schemaVersion must be 1');
  }
  if (!Array.isArray(raw.sessions) || !Array.isArray(raw.runtimeLeases) || !Array.isArray(raw.calls)) {
    corrupt('Host Broker snapshot collections must be arrays');
  }
  const sessions = raw.sessions.map(parseSession);
  const runtimeLeases = raw.runtimeLeases.map(parseLease);
  const calls = raw.calls.map(parseCall);
  assertReferences(sessions, runtimeLeases, calls);
  return { schemaVersion: HOST_BROKER_SCHEMA_VERSION, sessions, runtimeLeases, calls };
}
