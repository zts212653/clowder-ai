/**
 * Invocation Registry
 * 管理 MCP 回传工具的调用鉴权
 *
 * F174 Phase B — facade over IAuthInvocationBackend (memory or redis).
 * Public API stays stable; storage swappable via constructor injection.
 *
 * 安全契约:
 * - invocationId exactly binds one child TurnExecution attempt and callback token
 * - verify() checks token first, then explicit active/terminal lifecycle state
 * - active principals are durable; only terminal tombstones carry a GC deadline
 */

import { randomUUID } from 'node:crypto';
import type { CatId, ManagedWorkBinding } from '@cat-cafe/shared';
import type { CallerTraceContext } from '../../../../../infrastructure/telemetry/genai-semconv.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import type { ToolExecutionPolicy } from '../../types.js';
import { authTerminalFromTurnExecution } from './CallbackAuthTurnExecutionProjection.js';
import type { AuthInvocationMigrationResult, IAuthInvocationBackend } from './IAuthInvocationBackend.js';
import { MemoryAuthInvocationBackend } from './MemoryAuthInvocationBackend.js';
import type { OwnerAuthProvenance } from './owner-auth-provenance.js';
import { normalizeToolExecutionPolicy } from './tool-execution-policy.js';

export interface InvocationRecord {
  invocationId: string;
  callbackToken: string;
  userId: string;
  /** Authentication-grade provenance for the invocation owner; never inferred from userId. */
  ownerAuthProvenance: OwnerAuthProvenance;
  /** F275: server-resolved identity; never accepted from callback request payloads. */
  readonly managedWorkBinding?: ManagedWorkBinding;
  catId: CatId;
  /** Thread this invocation belongs to (for WebSocket room scoping) */
  threadId: string;
  /** F108 fix: InvocationRecordStore's parent invocation ID for worklist key alignment */
  parentInvocationId?: string;
  /** F121: The A2A trigger message ID — the @mention message that caused this cat to be invoked */
  a2aTriggerMessageId?: string;
  /**
   * Exact persisted message that triggered this turn, including direct user invocations.
   * Kept separate from a2aTriggerMessageId because direct turns must not acquire A2A replyTo semantics.
   */
  originTriggerMessageId?: string;
  traceContext?: CallerTraceContext;
  /** ADR-042 callback authorization boundary, persisted across API restarts. */
  toolExecutionPolicy?: ToolExecutionPolicy;
  /** In-invocation idempotency keys for callback post-message de-duplication. */
  clientMessageIds: Set<string>;
  createdAt: number;
  /** Active principals have no deadline; terminal tombstones expose their GC deadline. */
  expiresAt: number | null;
  state: AuthInvocationState;
  endedAt?: number;
  endReason?: string;
  terminalRef?: string;
}

export const AUTH_TERMINAL_DISPOSITIONS = [
  'completed',
  'failed',
  'interrupted',
  'replaced',
  'revoked',
  'canceled',
] as const;

export type AuthTerminalDisposition = (typeof AUTH_TERMINAL_DISPOSITIONS)[number];
export type AuthInvocationState = 'active' | AuthTerminalDisposition;

export interface AuthTerminalCommitInput {
  invocationId: string;
  disposition: AuthTerminalDisposition;
  endedAt: number;
  endReason: string;
  terminalRef?: string;
}

export type AuthTerminalCommitResult =
  | { outcome: 'committed' | 'already_terminal'; record: InvocationRecord }
  | { outcome: 'not_found'; record: null };

export type CallbackAuthLifecycleSignal =
  | { kind: 'canonical_terminal_with_active_auth'; invocationId: string; disposition: AuthTerminalDisposition }
  | {
      kind: 'callback_auth_terminal_conflict';
      invocationId: string;
      attempted: AuthTerminalDisposition;
      existing: AuthTerminalDisposition;
    };

export class AuthInvocationAdmissionError extends Error {
  readonly code = 'callback_auth_capacity_exceeded';

  constructor(message = 'Callback auth memory capacity exhausted; new admission rejected') {
    super(message);
    this.name = 'AuthInvocationAdmissionError';
  }
}

/**
 * F174-B P2 (cloud Codex review #1363) — pure helper that picks the backend kind
 * given the env var + Redis availability, throwing on unknown values so typos
 * (e.g. `REDUS=...`) don't silently fall back to in-memory and defeat Phase B.
 *
 * Returns 'redis' | 'memory'. Caller is responsible for actually wiring the
 * matching backend instance.
 */
export function selectInvocationBackendKind(envValue: string | undefined, redisAvailable: boolean): 'redis' | 'memory' {
  if (envValue !== undefined && envValue !== 'redis' && envValue !== 'memory') {
    throw new Error(
      `Invalid CAT_CAFE_INVOCATION_REGISTRY="${envValue}". ` +
        `Allowed values: 'redis' (default when Redis available), 'memory' (fallback / opt-out).`,
    );
  }
  if (envValue === 'redis' && !redisAvailable) {
    throw new Error('CAT_CAFE_INVOCATION_REGISTRY=redis requires an available Redis backend');
  }
  if (!redisAvailable && envValue !== 'memory') {
    throw new Error(
      'Durable callback auth requires Redis; set CAT_CAFE_INVOCATION_REGISTRY=memory only for explicit degraded local/test mode',
    );
  }
  return (envValue ?? 'redis') as 'redis' | 'memory';
}

export function callbackAuthCapabilityForBackend(
  kind: 'redis' | 'memory',
): { backend: 'redis'; durability: 'durable' } | { backend: 'memory'; durability: 'degraded_memory' } {
  return kind === 'redis'
    ? { backend: 'redis', durability: 'durable' }
    : { backend: 'memory', durability: 'degraded_memory' };
}

/**
 * F174 Phase A — Structured auth failure reasons.
 *
 * Discriminated union returned by verify() so downstream telemetry (Phase D)
 * and degradation (Phase E) can branch on a typed reason instead of regex-matching
 * error strings.
 *
 * `stale_invocation` remains for legacy active non-latest data so
 * verifyLatest() can reject it atomically.
 */
export type AuthFailureReason = 'invalid_token' | 'unknown_invocation' | 'stale_invocation' | AuthTerminalDisposition;

export type VerifyResult = { ok: true; record: InvocationRecord } | { ok: false; reason: AuthFailureReason };

export class InvocationRegistry {
  private readonly backend: IAuthInvocationBackend;
  private readonly turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
  private readonly onLifecycleSignal?: (signal: CallbackAuthLifecycleSignal) => void;
  private startupRecoveryComplete: boolean;

  constructor(options?: {
    ttlMs?: number;
    maxRecords?: number;
    tombstoneGcTtlMs?: number;
    backend?: IAuthInvocationBackend;
    startupRecoveryRequired?: boolean;
    turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
    onLifecycleSignal?: (signal: CallbackAuthLifecycleSignal) => void;
  }) {
    this.backend =
      options?.backend ??
      new MemoryAuthInvocationBackend({
        maxRecords: options?.maxRecords ?? 500,
        ...(options?.tombstoneGcTtlMs !== undefined ? { tombstoneGcTtlMs: options.tombstoneGcTtlMs } : {}),
      });
    this.turnExecutionStore = options?.turnExecutionStore;
    this.onLifecycleSignal = options?.onLifecycleSignal;
    this.startupRecoveryComplete = options?.startupRecoveryRequired !== true;
  }

  isStartupRecoveryComplete(): boolean {
    return this.startupRecoveryComplete;
  }

  markStartupRecoveryComplete(): void {
    this.startupRecoveryComplete = true;
  }

  /**
   * Create a new invocation and return the auth credentials.
   * The caller should pass these as env vars to the CLI subprocess.
   */
  async create(
    userId: string,
    catId: CatId,
    threadId: string = 'default',
    parentInvocationId?: string,
    a2aTriggerMessageId?: string,
    toolExecutionPolicy?: ToolExecutionPolicy,
    originTriggerMessageId?: string,
    ownerAuthProvenance: OwnerAuthProvenance = 'unknown',
    managedWorkBinding?: ManagedWorkBinding,
  ): Promise<{ invocationId: string; callbackToken: string }> {
    if (managedWorkBinding) {
      if (ownerAuthProvenance !== 'strict') {
        throw new Error('Managed-work invocation binding requires strict owner authentication');
      }
      if (managedWorkBinding.workId.trim().length === 0 || managedWorkBinding.attemptId.trim().length === 0) {
        throw new Error('Managed-work invocation binding requires non-empty server identifiers');
      }
    }
    const invocationId = randomUUID();
    const callbackToken = randomUUID();
    const now = Date.now();

    await this.backend.create({
      invocationId,
      callbackToken,
      userId,
      ownerAuthProvenance,
      ...(managedWorkBinding ? { managedWorkBinding: Object.freeze({ ...managedWorkBinding }) } : {}),
      catId,
      threadId,
      ...(parentInvocationId ? { parentInvocationId } : {}),
      ...(a2aTriggerMessageId ? { a2aTriggerMessageId } : {}),
      ...(originTriggerMessageId ? { originTriggerMessageId } : {}),
      ...(toolExecutionPolicy ? { toolExecutionPolicy: normalizeToolExecutionPolicy(toolExecutionPolicy) } : {}),
      clientMessageIds: new Set<string>(),
      createdAt: now,
    });

    return { invocationId, callbackToken };
  }

  /**
   * Verify invocationId + callbackToken binding.
   * Returns a discriminated VerifyResult — on failure, includes a typed reason
   * so callers (preHandler / telemetry / degradation) can branch precisely
   * instead of regex-matching error strings. (F174 Phase A — KD-4)
   */
  async verify(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    return this.repairFromCanonical(await this.backend.verify(invocationId, callbackToken));
  }

  /**
   * Check if an invocationId is the latest for its thread+cat slot.
   * Stale callbacks from preempted invocations return false.
   * (Cloud Codex P1 + 缅因猫 R3 suggestion)
   */
  async isLatest(invocationId: string): Promise<boolean> {
    return this.backend.isLatest(invocationId);
  }

  /** Get the latest invocationId for a given thread+cat slot, if any. */
  async getLatestId(threadId: string, catId: string): Promise<string | undefined> {
    return this.backend.getLatestId(threadId, catId);
  }

  /**
   * Claim a callback clientMessageId for an invocation.
   * Returns true if this ID is first-seen, false if duplicate or invocation missing.
   */
  async claimClientMessageId(invocationId: string, clientMessageId: string): Promise<boolean> {
    return this.backend.claimClientMessageId(invocationId, clientMessageId);
  }

  /**
   * F174 Phase C — claim per-invocation refresh cooldown atomically.
   * Returns true if cooldown was claimed (refresh may proceed),
   * false if a previous claim is still active (caller should reject 429).
   */
  async tryClaimRefreshCooldown(invocationId: string, cooldownMs: number): Promise<boolean> {
    return this.backend.tryClaimRefreshCooldown(invocationId, cooldownMs);
  }

  async setTraceContext(invocationId: string, ctx: CallerTraceContext): Promise<void> {
    return this.backend.setTraceContext(invocationId, ctx);
  }

  /**
   * Read-only fetch. Returns null only when unknown or after terminal GC.
   */
  async getRecord(invocationId: string): Promise<InvocationRecord | null> {
    return this.backend.getRecord(invocationId);
  }

  /**
   * Pure record read used by the in-context surface to recover metadata from
   * typed terminal tombstones without mutating lifecycle state.
   */
  async peekRecord(invocationId: string): Promise<InvocationRecord | null> {
    return this.backend.peekRecord(invocationId);
  }

  /**
   * Verify token without changing lifecycle state. Used by
   * refresh-token onRequest hook so bad-auth requests can't burn cooldown.
   */
  async peek(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    return this.repairFromCanonical(await this.backend.peek(invocationId, callbackToken));
  }

  async verifyLatest(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    return this.repairFromCanonical(await this.backend.verifyLatest(invocationId, callbackToken));
  }

  async commitTerminal(input: AuthTerminalCommitInput): Promise<AuthTerminalCommitResult> {
    const result = await this.backend.commitTerminal(input);
    if (result.outcome === 'already_terminal' && result.record.state !== input.disposition) {
      this.onLifecycleSignal?.({
        kind: 'callback_auth_terminal_conflict',
        invocationId: input.invocationId,
        attempted: input.disposition,
        existing: result.record.state as AuthTerminalDisposition,
      });
    }
    return result;
  }

  async listActiveRecords(): Promise<InvocationRecord[]> {
    return this.backend.listActiveRecords();
  }

  async migrateLegacyRecords(): Promise<AuthInvocationMigrationResult> {
    return this.backend.migrateLegacyRecords();
  }

  private async repairFromCanonical(result: VerifyResult): Promise<VerifyResult> {
    if (!result.ok || !this.turnExecutionStore) return result;
    const canonical = await this.turnExecutionStore.get(result.record.invocationId);
    if (!canonical) {
      const repaired = await this.backend.commitTerminal({
        invocationId: result.record.invocationId,
        disposition: 'revoked',
        endedAt: Date.now(),
        endReason: 'unadmitted_orphan',
      });
      return repaired.outcome === 'not_found'
        ? { ok: false, reason: 'unknown_invocation' }
        : { ok: false, reason: repaired.record.state as AuthTerminalDisposition };
    }
    if (canonical.status === 'running') return result;
    const terminal = authTerminalFromTurnExecution(canonical);
    this.onLifecycleSignal?.({
      kind: 'canonical_terminal_with_active_auth',
      invocationId: canonical.invocationId,
      disposition: terminal.disposition,
    });
    const repaired = await this.commitTerminal(terminal);
    return repaired.outcome === 'not_found'
      ? { ok: false, reason: 'unknown_invocation' }
      : { ok: false, reason: repaired.record.state as AuthTerminalDisposition };
  }
}
