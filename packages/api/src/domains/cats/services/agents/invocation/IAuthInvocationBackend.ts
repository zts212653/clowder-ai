/**
 * F174 Phase B — Backend port for callback auth invocation storage.
 *
 * MemoryAuthInvocationBackend (in-memory Map, current default for tests) and
 * RedisAuthInvocationBackend (Redis Hash + Lua, restart-resilient) both implement
 * this interface. The InvocationRegistry facade delegates to whichever backend
 * the factory wires up based on CAT_CAFE_INVOCATION_REGISTRY env.
 *
 * All methods are async to allow Redis IO uniformly; memory backend wraps in
 * `Promise.resolve` (negligible overhead).
 */

import type { CallerTraceContext } from '../../../../../infrastructure/telemetry/genai-semconv.js';
import type {
  AuthTerminalCommitInput,
  AuthTerminalCommitResult,
  InvocationRecord,
  VerifyResult,
} from './InvocationRegistry.js';

/** Active-record input; lifecycle fields are backend-owned. */
export type AuthInvocationInput = Omit<
  InvocationRecord,
  'state' | 'expiresAt' | 'endedAt' | 'endReason' | 'terminalRef'
>;

export interface IAuthInvocationBackend {
  /** Persist a new active invocation record. Active principals never carry a TTL. */
  create(input: AuthInvocationInput): Promise<void>;

  /**
   * Validate token + explicit lifecycle state. Successful active verification
   * is read-only apart from lazily PERSISTing legacy active keys.
   */
  verify(invocationId: string, callbackToken: string): Promise<VerifyResult>;

  /**
   * Verify token without changing lifecycle state. Active records may still be
   * lazily migrated from legacy TTL storage by verify()/verifyLatest().
   */
  peek(invocationId: string, callbackToken: string): Promise<VerifyResult>;

  /**
   * Atomic verify + isLatest. A terminal record returns its typed disposition
   * before latest-slot comparison; an active non-latest legacy record returns
   * stale_invocation.
   */
  verifyLatest(invocationId: string, callbackToken: string): Promise<VerifyResult>;

  /** Monotonic active → terminal first-write-wins transition. */
  commitTerminal(input: AuthTerminalCommitInput): Promise<AuthTerminalCommitResult>;

  /** Read-only fetch. Returns null only when unknown or after terminal GC. */
  getRecord(invocationId: string): Promise<InvocationRecord | null>;

  /**
   * Read raw record metadata without changing lifecycle state. Used by the
   * in-context notifier to associate typed terminal failures with their thread.
   * Returns null only when never present or after terminal tombstone GC.
   */
  peekRecord(invocationId: string): Promise<InvocationRecord | null>;

  /** Enumerate active records for bounded startup reconciliation. */
  listActiveRecords(): Promise<InvocationRecord[]>;

  /** Idempotently migrate still-present legacy TTL records and latest slots. */
  migrateLegacyRecords(): Promise<AuthInvocationMigrationResult>;

  /** Whether the invocationId is the latest for its (threadId, catId) slot. */
  isLatest(invocationId: string): Promise<boolean>;

  /** Latest invocationId for a (threadId, catId) slot, if any. */
  getLatestId(threadId: string, catId: string): Promise<string | undefined>;

  /**
   * Claim a clientMessageId for an invocation. Returns true on first claim,
   * false on duplicate or unknown invocation.
   */
  claimClientMessageId(invocationId: string, clientMessageId: string): Promise<boolean>;

  /**
   * F174 Phase C — Atomic claim of a per-invocation refresh cooldown.
   * Returns true if the cooldown was claimed (caller may proceed with refresh),
   * false if a previous claim is still active (caller must reject as 429).
   * Implementation must be racy-safe (Redis SET NX EX, or per-key Map check).
   */
  tryClaimRefreshCooldown(invocationId: string, cooldownMs: number): Promise<boolean>;

  /** F153: Persist caller trace context on an invocation for cross-route A2A propagation. */
  setTraceContext(invocationId: string, ctx: CallerTraceContext): Promise<void>;
}

export interface AuthInvocationMigrationResult {
  scanned: number;
  persistedActive: number;
  replaced: number;
  rebuiltLatest: number;
}
