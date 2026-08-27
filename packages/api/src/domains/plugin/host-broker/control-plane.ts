import { randomUUID } from 'node:crypto';
import {
  type Capability,
  type EventsPublishInput,
  type EventsPublishResult,
  type HandshakeRejectReason,
  hasHandshakeAuthorityInjection,
  type SessionBinding,
  validateBrokerReadyParams,
  validateCandidateHello,
  validateSessionBinding,
  WIRE_METHOD_REGISTRY,
  WIRE_VERSION,
  type WireMethodName,
} from '@clowder-ai/plugin-contract';
import type { PluginInventoryStore, PluginInventoryTransaction } from '../host-inventory/ports.js';
import type { PluginGrantRecord, PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';
import {
  type BrokerConnection,
  type BrokerConnectionController,
  type BuiltinBrokerConnection,
  createBrokerConnection,
  createBuiltinBrokerConnection,
} from './builtin-loopback.js';
import { digestBrokerValue } from './canonical-json.js';
import type { HostBrokerStore, HostBrokerTransaction } from './ports.js';
import type {
  BrokerCallContext,
  BrokerCallError,
  BrokerCallRecord,
  BrokerMethodHandler,
  BrokerRuntimeLeaseRecord,
  BrokerSessionRecord,
  BrokerTransportKind,
} from './types.js';
import { HostBrokerError } from './types.js';

export interface HostBrokerControlPlaneOptions {
  readonly inventory: PluginInventoryStore;
  readonly store: HostBrokerStore;
  readonly now?: () => number;
  readonly createConnectionId?: () => string;
  readonly createSessionId?: () => string;
  readonly createRuntimeLeaseId?: () => string;
  readonly createBindingNonce?: () => string;
  readonly preActiveTimeoutMs?: number;
  readonly activeLeaseTtlMs?: number;
  readonly methods?: readonly BrokerMethodHandler[];
}

interface CurrentAuthority {
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: PluginPackageRecord;
  readonly grants: PluginGrantRecord;
}

type CallLedgerDecision =
  | { readonly kind: 'claim'; readonly record: BrokerCallRecord }
  | { readonly kind: 'dispatch'; readonly record: BrokerCallRecord }
  | { readonly kind: 'recover'; readonly record: BrokerCallRecord }
  | { readonly kind: 'replay'; readonly result: unknown }
  | { readonly kind: 'failed'; readonly error: BrokerCallError };

type RuntimeLeaseRenewalDecision =
  | { readonly kind: 'renewed' }
  | {
      readonly kind: 'lost_authority';
      readonly closeRequired: boolean;
      readonly proposedCloseReason: string;
    };

type RuntimeLeaseAssessment =
  | { readonly live: true; readonly lease: BrokerRuntimeLeaseRecord }
  | { readonly live: false; readonly closeReason: string };

const DEFAULT_PRE_ACTIVE_TIMEOUT_MS = 10_000;
const DEFAULT_ACTIVE_LEASE_TTL_MS = 30_000;

function handshakeError(reason: HandshakeRejectReason, message: string): HostBrokerError {
  return new HostBrokerError('HANDSHAKE_REJECTED', message, reason);
}

function sessionForConnection(transaction: HostBrokerTransaction, connectionId: string): BrokerSessionRecord {
  const session = transaction.sessions.getByConnectionId(connectionId);
  if (!session) throw new HostBrokerError('SESSION_NOT_FOUND', `unknown Broker connection ${connectionId}`);
  return session;
}

function sameGrants(left: readonly Capability[], right: readonly Capability[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((grant, index) => grant === sortedRight[index]);
}

function authorityChanged(
  session: BrokerSessionRecord,
  lease: BrokerRuntimeLeaseRecord,
  authority: CurrentAuthority,
): boolean {
  return (
    authority.instance.runtimeState !== 'healthy' ||
    authority.instance.packageDigest !== session.packageDigest ||
    authority.grants.grantRevision !== session.grantRevision ||
    authority.grants.grantRevision !== lease.grantRevision ||
    lease.pluginInstanceId !== session.pluginInstanceId ||
    lease.packageDigest !== session.packageDigest ||
    lease.brokerSessionId !== session.brokerSessionId ||
    !sameGrants(authority.grants.effectiveGrants, session.effectiveGrants ?? [])
  );
}

function assessRuntimeLease(
  session: BrokerSessionRecord,
  lease: BrokerRuntimeLeaseRecord | undefined,
  now: number,
): RuntimeLeaseAssessment {
  const expiredWhileActive =
    session.phase === 'active' &&
    ((session.activeLeaseExpiresAt !== undefined && session.activeLeaseExpiresAt <= now) ||
      (lease !== undefined && lease.expiresAt <= now));
  if (
    session.phase === 'active' &&
    session.activeLeaseExpiresAt !== undefined &&
    !expiredWhileActive &&
    lease?.state === 'live'
  ) {
    return { live: true, lease };
  }
  return {
    live: false,
    closeReason:
      session.phase !== 'active'
        ? (session.closeReason ?? 'session_not_active')
        : expiredWhileActive
          ? 'runtime_lease_expired'
          : 'session_not_active',
  };
}

export class HostBrokerControlPlane implements BrokerConnectionController {
  private readonly now: () => number;
  private readonly preActiveTimeoutMs: number;
  private readonly activeLeaseTtlMs: number;
  private readonly methods = new Map<WireMethodName, BrokerMethodHandler>();

  constructor(readonly options: HostBrokerControlPlaneOptions) {
    this.now = options.now ?? Date.now;
    this.preActiveTimeoutMs = options.preActiveTimeoutMs ?? DEFAULT_PRE_ACTIVE_TIMEOUT_MS;
    this.activeLeaseTtlMs = options.activeLeaseTtlMs ?? DEFAULT_ACTIVE_LEASE_TTL_MS;
    for (const handler of options.methods ?? []) {
      if (this.methods.has(handler.method)) {
        throw new HostBrokerError('BROKER_INVARIANT', `duplicate Broker handler for ${handler.method}`);
      }
      this.methods.set(handler.method, handler);
    }
  }

  get activeRuntimeLeaseTtlMs(): number {
    return this.activeLeaseTtlMs;
  }

  async openBuiltinConnection(pluginInstanceId: string): Promise<BuiltinBrokerConnection> {
    const connectionId = await this.openConnection(pluginInstanceId, 'builtin-loopback');
    return createBuiltinBrokerConnection(this, connectionId);
  }

  async openExternalConnection(pluginInstanceId: string): Promise<BrokerConnection> {
    const connectionId = await this.openConnection(pluginInstanceId, 'stdio');
    return createBrokerConnection(this, connectionId);
  }

  private async openConnection(pluginInstanceId: string, transportKind: BrokerTransportKind): Promise<string> {
    const authority = await this.currentAuthority(pluginInstanceId, true);
    const now = this.now();
    const connectionId = this.options.createConnectionId?.() ?? `conn_${randomUUID()}`;
    const brokerSessionId = this.options.createSessionId?.() ?? `bs_${randomUUID()}`;
    const runtimeLeaseId = this.options.createRuntimeLeaseId?.() ?? `lease_${randomUUID()}`;
    await this.options.store.transaction((transaction) => {
      if (transaction.sessions.getByConnectionId(connectionId)) {
        throw new HostBrokerError('BROKER_INVARIANT', `connection id collision: ${connectionId}`);
      }
      const currentSession = transaction.sessions
        .list()
        .find((session) => session.pluginInstanceId === pluginInstanceId && session.phase !== 'closed');
      if (currentSession) {
        throw new HostBrokerError('INSTANCE_NOT_READY', `${pluginInstanceId} already has an open Broker session`);
      }
      transaction.sessions.put({
        connectionId,
        brokerSessionId,
        runtimeLeaseId,
        transportKind,
        pluginInstanceId,
        pluginId: authority.instance.pluginId,
        packageDigest: authority.instance.packageDigest,
        contractVersion: authority.packageRecord.contractVersion,
        wireVersion: WIRE_VERSION,
        phase: 'transport_connected',
        preActiveDeadlineAt: now + this.preActiveTimeoutMs,
        createdAt: now,
        updatedAt: now,
      });
    });
    return connectionId;
  }

  async hello(connectionId: string, candidate: unknown): Promise<SessionBinding> {
    if (hasHandshakeAuthorityInjection(candidate)) {
      return this.rejectHandshake(connectionId, 'AUTHORITY_VIOLATION', 'candidate supplied Host authority fields');
    }
    if (!validateCandidateHello(candidate)) {
      return this.rejectHandshake(connectionId, 'MALFORMED_HELLO', 'candidate hello is malformed');
    }
    const session = await this.readSession(connectionId);
    if (session.phase !== 'transport_connected') {
      await this.rejectHandshake(connectionId, 'BINDING_REPLAY', 'hello may run only once per connection');
    }
    if (this.now() >= session.preActiveDeadlineAt) {
      await this.rejectHandshake(connectionId, 'DEADLINE_EXPIRED', 'candidate hello missed the Host deadline');
    }
    const authority = await this.currentAuthority(session.pluginInstanceId, true);
    const mismatch = this.candidateMismatch(authority, candidate);
    if (mismatch) await this.rejectHandshake(connectionId, mismatch, 'candidate claims do not match Host inventory');

    const now = this.now();
    const bindingNonce = this.options.createBindingNonce?.() ?? `nonce_${randomUUID()}`;
    const binding: SessionBinding = {
      pluginId: authority.instance.pluginId,
      packageDigest: authority.instance.packageDigest,
      contractVersion: authority.packageRecord.contractVersion,
      wireVersion: WIRE_VERSION,
      pluginInstanceId: authority.instance.pluginInstanceId,
      brokerSessionId: session.brokerSessionId,
      grantRevision: authority.grants.grantRevision,
      effectiveGrants: [...authority.grants.effectiveGrants],
      bindingNonce,
    };
    if (!validateSessionBinding(binding)) {
      await this.rejectHandshake(connectionId, 'AUTHORITY_VIOLATION', 'Host produced an invalid session binding');
    }
    await this.options.store.transaction((transaction) => {
      const current = sessionForConnection(transaction, connectionId);
      if (current.phase !== 'transport_connected') {
        throw handshakeError('BINDING_REPLAY', 'concurrent hello changed the session state');
      }
      transaction.sessions.put({
        ...current,
        phase: 'host_bound',
        candidate: structuredClone(candidate),
        grantRevision: binding.grantRevision,
        effectiveGrants: [...binding.effectiveGrants],
        bindingNonce,
        updatedAt: now,
      });
    });
    return structuredClone(binding);
  }

  async ready(connectionId: string, params: unknown): Promise<null> {
    const session = await this.readSession(connectionId);
    if (session.phase !== 'host_bound') {
      await this.rejectHandshake(connectionId, 'BINDING_REPLAY', 'ready requires a fresh Host binding');
    }
    if (this.now() >= session.preActiveDeadlineAt) {
      await this.rejectHandshake(connectionId, 'DEADLINE_EXPIRED', 'ready missed the Host deadline');
    }
    if (!validateBrokerReadyParams(params) || params.bindingNonce !== session.bindingNonce) {
      return this.rejectHandshake(connectionId, 'BINDING_REPLAY', 'ready binding nonce is invalid or already used');
    }
    const authority = await this.currentAuthority(session.pluginInstanceId, true);
    if (
      authority.instance.packageDigest !== session.packageDigest ||
      authority.grants.grantRevision !== session.grantRevision ||
      !sameGrants(authority.grants.effectiveGrants, session.effectiveGrants ?? [])
    ) {
      await this.rejectHandshake(connectionId, 'AUTHORITY_VIOLATION', 'Host authority changed during handshake');
    }

    const now = this.now();
    const expiresAt = now + this.activeLeaseTtlMs;
    await this.options.store.transaction((transaction) => {
      const current = sessionForConnection(transaction, connectionId);
      if (current.phase !== 'host_bound' || current.bindingNonce !== params.bindingNonce) {
        throw handshakeError('BINDING_REPLAY', 'concurrent ready changed the session state');
      }
      transaction.sessions.put({
        ...current,
        phase: 'active',
        bindingNonce: undefined,
        activeLeaseExpiresAt: expiresAt,
        updatedAt: now,
      });
      transaction.runtimeLeases.put({
        runtimeLeaseId: current.runtimeLeaseId,
        brokerSessionId: current.brokerSessionId,
        pluginInstanceId: current.pluginInstanceId,
        packageDigest: current.packageDigest,
        grantRevision: authority.grants.grantRevision,
        state: 'live',
        expiresAt,
        updatedAt: now,
      });
    });
    try {
      await this.setInventoryRuntimeState(session.pluginInstanceId, session.packageDigest, 'healthy');
    } catch (error) {
      await this.close(connectionId, 'inventory_projection_failed');
      throw error;
    }
    return null;
  }

  async call(connectionId: string, method: WireMethodName, input: unknown): Promise<unknown> {
    const row = WIRE_METHOD_REGISTRY[method];
    if (!row?.ready || row.direction !== 'plugin-to-host') {
      throw new HostBrokerError('METHOD_NOT_READY', `${method} is not a contract-ready plugin-to-Host row`);
    }
    const handler = this.methods.get(method);
    if (!handler) throw new HostBrokerError('METHOD_NOT_REGISTERED', `Host has no handler for ${method}`);
    const context = await this.currentCallContext(connectionId, row.grant);
    const validated = handler.validateInput(input);
    if (!validated.valid) throw new HostBrokerError('INVALID_CALL_INPUT', `${method} input is invalid`);
    if (handler.settlementAuthority === 'domain') {
      const result = await handler.dispatch(context, validated.value);
      if (!handler.validateResult(result)) {
        throw new HostBrokerError('INVALID_CALL_RESULT', `${method} handler returned an invalid result`);
      }
      return structuredClone(result);
    }
    const settlementKey = handler.settlementKey(context, validated.value);
    if (typeof settlementKey !== 'string' || settlementKey.length === 0 || settlementKey.length > 4096) {
      throw new HostBrokerError('BROKER_INVARIANT', `${method} produced an invalid settlement key`);
    }
    const inputDigest = digestBrokerValue(validated.value);
    const ledgerKey = digestBrokerValue([context.pluginInstanceId, method, settlementKey]);
    const now = this.now();
    const decision = await this.beginCall(
      {
        ledgerKey,
        brokerSessionId: context.brokerSessionId,
        runtimeLeaseId: context.runtimeLeaseId,
        pluginInstanceId: context.pluginInstanceId,
        packageDigest: context.packageDigest,
        grantRevision: context.grantRevision,
        method,
        settlementKey,
        inputDigest,
        phase: 'claimed',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      handler,
    );
    return this.executeCallDecision(decision, handler, context, validated.value);
  }

  async publishOwnerImportedSignal(pluginInstanceId: string, input: EventsPublishInput): Promise<EventsPublishResult> {
    const sessions = (await this.options.store.snapshot()).sessions.filter(
      (candidate) => candidate.pluginInstanceId === pluginInstanceId && candidate.phase === 'active',
    );
    if (sessions.length === 0) {
      throw new HostBrokerError('INSTANCE_NOT_READY', `${pluginInstanceId} has no active Broker session`);
    }
    if (sessions.length !== 1) {
      throw new HostBrokerError('BROKER_INVARIANT', `${pluginInstanceId} has multiple active Broker sessions`);
    }
    return this.call(sessions[0].connectionId, 'events.publish', input) as Promise<EventsPublishResult>;
  }

  async authorizeHostCall(pluginInstanceId: string, requiredGrant: Capability): Promise<BrokerCallContext> {
    const sessions = (await this.options.store.snapshot()).sessions.filter(
      (candidate) => candidate.pluginInstanceId === pluginInstanceId && candidate.phase === 'active',
    );
    if (sessions.length === 0) {
      throw new HostBrokerError('INSTANCE_NOT_READY', `${pluginInstanceId} has no active Broker session`);
    }
    if (sessions.length !== 1) {
      throw new HostBrokerError('BROKER_INVARIANT', `${pluginInstanceId} has multiple active Broker sessions`);
    }
    return this.currentCallContext(sessions[0].connectionId, requiredGrant);
  }

  async renewRuntimeLease(connectionId: string): Promise<number> {
    const context = await this.currentCallContext(connectionId, 'protocol-intrinsic');
    const now = this.now();
    const expiresAt = now + this.activeLeaseTtlMs;
    const decision = await this.options.store.transaction<RuntimeLeaseRenewalDecision>((transaction) => {
      const session = sessionForConnection(transaction, connectionId);
      const lease = transaction.runtimeLeases.get(session.runtimeLeaseId);
      const leaseExpiredWhileActive =
        session.phase === 'active' &&
        ((session.activeLeaseExpiresAt !== undefined && session.activeLeaseExpiresAt <= now) ||
          (lease !== undefined && lease.expiresAt <= now));
      const contextStillMatches =
        session.brokerSessionId === context.brokerSessionId &&
        session.runtimeLeaseId === context.runtimeLeaseId &&
        lease?.brokerSessionId === context.brokerSessionId &&
        lease.pluginInstanceId === context.pluginInstanceId &&
        lease.packageDigest === context.packageDigest &&
        lease.grantRevision === context.grantRevision;
      if (
        session.phase !== 'active' ||
        session.activeLeaseExpiresAt === undefined ||
        leaseExpiredWhileActive ||
        !lease ||
        lease.state !== 'live' ||
        !contextStillMatches
      ) {
        const proposedCloseReason =
          session.phase === 'closed'
            ? (session.closeReason ?? 'session_not_active')
            : leaseExpiredWhileActive
              ? 'runtime_lease_expired'
              : !contextStillMatches
                ? 'authority_changed'
                : 'session_not_active';
        return {
          kind: 'lost_authority',
          closeRequired: session.phase !== 'closed',
          proposedCloseReason,
        };
      }
      transaction.sessions.put({
        ...session,
        activeLeaseExpiresAt: expiresAt,
        updatedAt: now,
      });
      transaction.runtimeLeases.put({
        ...lease,
        expiresAt,
        updatedAt: now,
      });
      return { kind: 'renewed' };
    });
    if (decision.kind === 'lost_authority') {
      await this.throwPersistedInactiveSession(
        connectionId,
        decision.proposedCloseReason,
        decision.closeRequired,
        `${connectionId} lost Broker authority before renewal`,
      );
    }
    return expiresAt;
  }

  private async executeCallDecision(
    decision: CallLedgerDecision,
    handler: BrokerMethodHandler,
    context: BrokerCallContext,
    input: unknown,
  ): Promise<unknown> {
    if (decision.kind === 'replay') return decision.result;
    if (decision.kind === 'failed') throw handler.restoreSettledError(decision.error);
    const dispatchDecision = decision.kind === 'claim' ? await this.acquireDispatchClaim(decision.record) : decision;
    if (dispatchDecision.kind === 'replay') return dispatchDecision.result;
    if (dispatchDecision.kind === 'failed') throw handler.restoreSettledError(dispatchDecision.error);
    if (dispatchDecision.kind === 'recover') {
      const recovered = await handler.lookupSettlement(context, input);
      if (recovered === null) {
        throw new HostBrokerError('CALL_IN_FLIGHT', `${handler.method} has an unresolved durable dispatch`);
      }
      return this.settleCallSuccess(dispatchDecision.record, handler, recovered);
    }
    let result: unknown;
    try {
      result = await handler.dispatch(context, input);
    } catch (error) {
      const terminalError = handler.serializePreEffectError(error);
      if (terminalError === null) throw error;
      await this.settleCallError(dispatchDecision.record, terminalError);
      throw error;
    }
    return this.settleCallSuccess(dispatchDecision.record, handler, result);
  }

  async close(connectionId: string, reason = 'closed'): Promise<void> {
    let session: BrokerSessionRecord | undefined;
    const now = this.now();
    await this.options.store.transaction((transaction) => {
      const current = transaction.sessions.getByConnectionId(connectionId);
      if (!current || current.phase === 'closed') return;
      session = current;
      transaction.sessions.put({
        ...current,
        phase: 'closed',
        bindingNonce: undefined,
        activeLeaseExpiresAt: undefined,
        closeReason: reason,
        closedAt: now,
        updatedAt: now,
      });
      const lease = transaction.runtimeLeases.get(current.runtimeLeaseId);
      if (lease) transaction.runtimeLeases.put({ ...lease, state: 'closed', updatedAt: now });
    });
    if (session) await this.setInventoryRuntimeState(session.pluginInstanceId, session.packageDigest, 'stopped');
  }

  async recoverAfterRestart(): Promise<number> {
    const affected = new Map<string, string>();
    let changed = 0;
    const now = this.now();
    await this.options.store.transaction((transaction) => {
      for (const session of transaction.sessions.list()) {
        if (session.phase === 'closed') continue;
        changed += 1;
        affected.set(session.pluginInstanceId, session.packageDigest);
        transaction.sessions.put({
          ...session,
          phase: 'closed',
          bindingNonce: undefined,
          activeLeaseExpiresAt: undefined,
          closeReason: 'host_restart',
          closedAt: now,
          updatedAt: now,
        });
      }
      for (const lease of transaction.runtimeLeases.list()) {
        if (lease.state === 'closed') continue;
        transaction.runtimeLeases.put({ ...lease, state: 'closed', updatedAt: now });
      }
    });
    for (const [pluginInstanceId, packageDigest] of affected) {
      await this.setInventoryRuntimeState(pluginInstanceId, packageDigest, 'stopped');
    }
    return changed;
  }

  private async rejectHandshake(connectionId: string, reason: HandshakeRejectReason, message: string): Promise<never> {
    await this.close(connectionId, reason);
    throw handshakeError(reason, message);
  }

  private async readSession(connectionId: string): Promise<BrokerSessionRecord> {
    const session = (await this.options.store.snapshot()).sessions.find(
      (candidate) => candidate.connectionId === connectionId,
    );
    if (!session) throw new HostBrokerError('SESSION_NOT_FOUND', `unknown Broker connection ${connectionId}`);
    return session;
  }

  private async currentCallContext(
    connectionId: string,
    requiredGrant: Capability | 'protocol-intrinsic',
  ): Promise<BrokerCallContext> {
    const brokerSnapshot = await this.options.store.snapshot();
    const session = brokerSnapshot.sessions.find((candidate) => candidate.connectionId === connectionId);
    if (!session) throw new HostBrokerError('SESSION_NOT_FOUND', `unknown Broker connection ${connectionId}`);
    const assessment = assessRuntimeLease(
      session,
      brokerSnapshot.runtimeLeases.find((candidate) => candidate.runtimeLeaseId === session.runtimeLeaseId),
      this.now(),
    );
    if (!assessment.live) {
      return this.throwPersistedInactiveSession(
        connectionId,
        assessment.closeReason,
        session.phase !== 'closed',
        `${connectionId} has no live Broker authority`,
      );
    }
    const { lease } = assessment;
    let authority: CurrentAuthority;
    try {
      authority = await this.currentAuthority(session.pluginInstanceId, true);
    } catch {
      await this.close(connectionId, 'authority_changed').catch(() => undefined);
      throw new HostBrokerError('AUTHORITY_CHANGED', `${connectionId} inventory authority changed`);
    }
    if (authorityChanged(session, lease, authority)) {
      await this.close(connectionId, 'authority_changed').catch(() => undefined);
      throw new HostBrokerError('AUTHORITY_CHANGED', `${connectionId} grant or package authority changed`);
    }
    if (requiredGrant !== 'protocol-intrinsic' && !authority.grants.effectiveGrants.includes(requiredGrant)) {
      throw new HostBrokerError('CAPABILITY_DENIED', `${connectionId} lacks required grant ${requiredGrant}`);
    }
    return {
      connectionId,
      brokerSessionId: session.brokerSessionId,
      runtimeLeaseId: session.runtimeLeaseId,
      pluginInstanceId: session.pluginInstanceId,
      pluginId: session.pluginId,
      packageDigest: session.packageDigest,
      contractVersion: session.contractVersion,
      grantRevision: authority.grants.grantRevision,
      effectiveGrants: [...authority.grants.effectiveGrants],
    };
  }

  private async throwPersistedInactiveSession(
    connectionId: string,
    proposedCloseReason: string,
    closeRequired: boolean,
    message: string,
  ): Promise<never> {
    if (closeRequired) await this.close(connectionId, proposedCloseReason).catch(() => undefined);
    const persistedSession = await this.readSession(connectionId);
    const closeReason =
      persistedSession.phase === 'closed'
        ? (persistedSession.closeReason ?? 'session_not_active')
        : 'session_not_active';
    throw new HostBrokerError('SESSION_NOT_ACTIVE', message, undefined, closeReason);
  }

  private async settleCallSuccess(
    record: BrokerCallRecord,
    handler: BrokerMethodHandler,
    result: unknown,
  ): Promise<unknown> {
    if (!handler.validateResult(result)) {
      throw new HostBrokerError('INVALID_CALL_RESULT', `${record.method} handler returned an invalid result`);
    }
    const settled = structuredClone(result);
    await this.options.store.transaction((transaction) => {
      const current = transaction.calls.get(record.ledgerKey);
      if (!current || current.inputDigest !== record.inputDigest) {
        throw new HostBrokerError('BROKER_INVARIANT', `${record.method} call ledger changed before settlement`);
      }
      if (current.phase === 'settled_success') return;
      if (current.phase !== 'dispatched') {
        throw new HostBrokerError('BROKER_INVARIANT', `${record.method} cannot settle from ${current.phase}`);
      }
      transaction.calls.put({
        ...current,
        phase: 'settled_success',
        revision: current.revision + 1,
        result: settled,
        updatedAt: this.now(),
      });
    });
    return structuredClone(settled);
  }

  private async acquireDispatchClaim(record: BrokerCallRecord): Promise<CallLedgerDecision> {
    return this.options.store.transaction((transaction) => {
      const current = transaction.calls.get(record.ledgerKey);
      if (!current || current.inputDigest !== record.inputDigest) {
        throw new HostBrokerError('BROKER_INVARIANT', `${record.method} call ledger changed after claim`);
      }
      if (current.phase === 'settled_success') {
        return { kind: 'replay', result: structuredClone(current.result) };
      }
      if (current.phase === 'settled_error') {
        if (!current.error) {
          throw new HostBrokerError('BROKER_INVARIANT', `${record.method} lost its error settlement`);
        }
        return { kind: 'failed', error: current.error };
      }
      if (current.phase === 'dispatched') return { kind: 'recover', record: current };
      if (current.revision !== record.revision) {
        throw new HostBrokerError('BROKER_INVARIANT', `${record.method} claim revision changed unexpectedly`);
      }
      const dispatched: BrokerCallRecord = {
        ...current,
        phase: 'dispatched',
        revision: current.revision + 1,
        updatedAt: this.now(),
      };
      transaction.calls.put(dispatched);
      return { kind: 'dispatch', record: dispatched };
    });
  }

  private async beginCall(record: BrokerCallRecord, handler: BrokerMethodHandler): Promise<CallLedgerDecision> {
    return this.options.store.transaction((transaction) => {
      const existing = transaction.calls.get(record.ledgerKey);
      if (existing) {
        this.assertSameCallIdentity(existing, record);
        const retried = this.retrySettledErrorAfterAuthorityChange(existing, record, handler);
        if (retried) {
          transaction.calls.put(retried);
          return { kind: 'claim', record: retried };
        }
        return this.decisionForExistingCall(existing, record);
      }
      transaction.calls.put(record);
      return { kind: 'claim', record };
    });
  }

  private assertSameCallIdentity(existing: BrokerCallRecord, requested: BrokerCallRecord): void {
    if (
      existing.pluginInstanceId !== requested.pluginInstanceId ||
      existing.method !== requested.method ||
      existing.settlementKey !== requested.settlementKey ||
      existing.inputDigest !== requested.inputDigest
    ) {
      throw new HostBrokerError('CALL_CONFLICT', `${requested.method} settlement key is bound to different input`);
    }
  }

  private retrySettledErrorAfterAuthorityChange(
    existing: BrokerCallRecord,
    requested: BrokerCallRecord,
    handler: BrokerMethodHandler,
  ): BrokerCallRecord | null {
    if (existing.phase !== 'settled_error' || !existing.error) return null;
    const authorityChanged =
      existing.brokerSessionId !== requested.brokerSessionId || existing.runtimeLeaseId !== requested.runtimeLeaseId;
    if (!authorityChanged || !handler.canRetrySettledErrorAfterAuthorityChange?.(existing.error)) return null;
    const { error: _error, result: _result, ...durableIdentity } = existing;
    return {
      ...durableIdentity,
      brokerSessionId: requested.brokerSessionId,
      runtimeLeaseId: requested.runtimeLeaseId,
      packageDigest: requested.packageDigest,
      grantRevision: requested.grantRevision,
      phase: 'claimed',
      revision: existing.revision + 1,
      updatedAt: this.now(),
    };
  }

  private decisionForExistingCall(existing: BrokerCallRecord, requested: BrokerCallRecord): CallLedgerDecision {
    this.assertSameCallIdentity(existing, requested);
    if (existing.phase === 'settled_success') {
      return { kind: 'replay', result: structuredClone(existing.result) };
    }
    if (existing.phase === 'settled_error') {
      if (!existing.error) {
        throw new HostBrokerError('BROKER_INVARIANT', `${requested.method} lost its error settlement`);
      }
      return { kind: 'failed', error: existing.error };
    }
    return existing.phase === 'claimed' ? { kind: 'claim', record: existing } : { kind: 'recover', record: existing };
  }

  private async settleCallError(record: BrokerCallRecord, error: BrokerCallError): Promise<void> {
    await this.options.store.transaction((transaction) => {
      const current = transaction.calls.get(record.ledgerKey);
      if (!current || current.inputDigest !== record.inputDigest) {
        throw new HostBrokerError('BROKER_INVARIANT', `${record.method} call ledger changed before error settlement`);
      }
      if (current.phase === 'settled_error') return;
      if (current.phase !== 'dispatched') {
        throw new HostBrokerError('BROKER_INVARIANT', `${record.method} cannot settle error from ${current.phase}`);
      }
      transaction.calls.put({
        ...current,
        phase: 'settled_error',
        revision: current.revision + 1,
        error: structuredClone(error),
        updatedAt: this.now(),
      });
    });
  }

  private async currentAuthority(pluginInstanceId: string, requireReady: boolean): Promise<CurrentAuthority> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    const current = instance
      ? snapshot.instances.find(
          (candidate) => candidate.pluginId === instance.pluginId && candidate.lifecycleState === 'installed',
        )
      : undefined;
    if (
      !instance ||
      current?.pluginInstanceId !== pluginInstanceId ||
      instance.lifecycleState !== 'installed' ||
      (requireReady && (instance.configReadiness !== 'ready' || instance.activationState !== 'enabled'))
    ) {
      throw new HostBrokerError('INSTANCE_NOT_READY', `${pluginInstanceId} is not a current enabled instance`);
    }
    const packageRecord = snapshot.packages.find(
      (candidate) => candidate.packageDigest === instance.packageDigest && candidate.packageState === 'installed',
    );
    const grants = snapshot.grants.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    if (!packageRecord || !grants) {
      throw new HostBrokerError('BROKER_INVARIANT', `${pluginInstanceId} has incomplete inventory authority`);
    }
    return { instance, packageRecord, grants };
  }

  private candidateMismatch(
    authority: CurrentAuthority,
    candidate: {
      readonly pluginId: string;
      readonly packageDigest: string;
      readonly contractVersion: string;
      readonly wireVersion: string;
    },
  ): HandshakeRejectReason | undefined {
    if (
      candidate.pluginId !== authority.instance.pluginId ||
      candidate.packageDigest !== authority.instance.packageDigest
    ) {
      return 'PACKAGE_MISMATCH';
    }
    if (candidate.contractVersion !== authority.packageRecord.contractVersion) return 'CONTRACT_INCOMPATIBLE';
    if (candidate.wireVersion !== WIRE_VERSION) return 'WIRE_INCOMPATIBLE';
    return undefined;
  }

  private async setInventoryRuntimeState(
    pluginInstanceId: string,
    packageDigest: string,
    runtimeState: 'healthy' | 'stopped',
  ): Promise<void> {
    const now = this.now();
    await this.options.inventory.transaction((transaction: PluginInventoryTransaction) => {
      const instance = transaction.instances.get(pluginInstanceId);
      if (!instance || instance.lifecycleState !== 'installed' || instance.packageDigest !== packageDigest) {
        throw new HostBrokerError(
          'INSTANCE_NOT_READY',
          `${pluginInstanceId} authority changed before runtime projection`,
        );
      }
      transaction.instances.put({ ...instance, runtimeState, updatedAt: now });
    });
  }
}
