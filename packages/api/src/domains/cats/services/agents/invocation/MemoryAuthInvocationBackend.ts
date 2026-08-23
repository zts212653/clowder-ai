/** Explicit non-durable callback-auth backend for unit/local use. */

import type { CallerTraceContext } from '../../../../../infrastructure/telemetry/genai-semconv.js';
import type {
  AuthInvocationInput,
  AuthInvocationMigrationResult,
  IAuthInvocationBackend,
} from './IAuthInvocationBackend.js';
import {
  AuthInvocationAdmissionError,
  type AuthTerminalCommitInput,
  type AuthTerminalCommitResult,
  type AuthTerminalDisposition,
  type InvocationRecord,
  type VerifyResult,
} from './InvocationRegistry.js';
import { normalizeOwnerAuthProvenance } from './owner-auth-provenance.js';

const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_TOMBSTONE_GC_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLIENT_MESSAGE_IDS = 1000;

function isTerminal(record: InvocationRecord): record is InvocationRecord & { state: AuthTerminalDisposition } {
  return record.state !== 'active';
}

export class MemoryAuthInvocationBackend implements IAuthInvocationBackend {
  private readonly records = new Map<string, InvocationRecord>();
  private readonly latestByThreadCat = new Map<string, string>();
  private readonly refreshCooldown = new Map<string, number>();
  private readonly maxRecords: number;
  private readonly tombstoneGcTtlMs: number;

  constructor(options?: { maxRecords?: number; tombstoneGcTtlMs?: number }) {
    this.maxRecords = options?.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.tombstoneGcTtlMs = options?.tombstoneGcTtlMs ?? DEFAULT_TOMBSTONE_GC_TTL_MS;
  }

  async create(input: AuthInvocationInput): Promise<void> {
    this.cleanupTerminalTombstones();
    if (this.records.size >= this.maxRecords) throw new AuthInvocationAdmissionError();

    const slot = `${input.threadId}:${input.catId as string}`;
    const previousId = this.latestByThreadCat.get(slot);
    if (previousId && previousId !== input.invocationId) {
      const previous = this.records.get(previousId);
      if (previous?.state === 'active') {
        this.commitTerminalInTurn({
          invocationId: previousId,
          disposition: 'replaced',
          endedAt: input.createdAt,
          endReason: `preempt_by:${input.invocationId}`,
          terminalRef: input.invocationId,
        });
      }
    }

    this.records.set(input.invocationId, {
      ...input,
      ownerAuthProvenance: normalizeOwnerAuthProvenance(input.ownerAuthProvenance),
      state: 'active',
      expiresAt: null,
    });
    this.latestByThreadCat.set(slot, input.invocationId);
  }

  async peek(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    return this.verifyInTurn(invocationId, callbackToken, false);
  }

  async verifyLatest(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    return this.verifyInTurn(invocationId, callbackToken, true);
  }

  async verify(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    return this.verifyInTurn(invocationId, callbackToken, false);
  }

  async commitTerminal(input: AuthTerminalCommitInput): Promise<AuthTerminalCommitResult> {
    this.cleanupTerminalTombstones();
    return this.commitTerminalInTurn(input);
  }

  async getRecord(invocationId: string): Promise<InvocationRecord | null> {
    this.cleanupTerminalTombstones();
    return this.records.get(invocationId) ?? null;
  }

  async peekRecord(invocationId: string): Promise<InvocationRecord | null> {
    this.cleanupTerminalTombstones();
    return this.records.get(invocationId) ?? null;
  }

  async listActiveRecords(): Promise<InvocationRecord[]> {
    this.cleanupTerminalTombstones();
    return [...this.records.values()].filter((record) => record.state === 'active');
  }

  async migrateLegacyRecords(): Promise<AuthInvocationMigrationResult> {
    return { scanned: this.records.size, persistedActive: 0, replaced: 0, rebuiltLatest: 0 };
  }

  async isLatest(invocationId: string): Promise<boolean> {
    const record = await this.getRecord(invocationId);
    if (!record || record.state !== 'active') return false;
    return this.latestByThreadCat.get(`${record.threadId}:${record.catId as string}`) === invocationId;
  }

  async getLatestId(threadId: string, catId: string): Promise<string | undefined> {
    return this.latestByThreadCat.get(`${threadId}:${catId}`);
  }

  async claimClientMessageId(invocationId: string, clientMessageId: string): Promise<boolean> {
    const record = this.records.get(invocationId);
    if (!record || record.state !== 'active') return false;
    if (record.clientMessageIds.has(clientMessageId)) return false;
    while (record.clientMessageIds.size >= MAX_CLIENT_MESSAGE_IDS) {
      const oldest = record.clientMessageIds.values().next().value;
      if (oldest === undefined) break;
      record.clientMessageIds.delete(oldest);
    }
    record.clientMessageIds.add(clientMessageId);
    return true;
  }

  async tryClaimRefreshCooldown(invocationId: string, cooldownMs: number): Promise<boolean> {
    const now = Date.now();
    const existing = this.refreshCooldown.get(invocationId);
    if (existing && existing > now) return false;
    for (const [key, deadline] of this.refreshCooldown) {
      if (deadline <= now) this.refreshCooldown.delete(key);
    }
    while (this.refreshCooldown.size >= this.maxRecords) {
      const oldest = this.refreshCooldown.keys().next().value;
      if (oldest === undefined) break;
      this.refreshCooldown.delete(oldest);
    }
    this.refreshCooldown.set(invocationId, now + cooldownMs);
    return true;
  }

  async setTraceContext(invocationId: string, ctx: CallerTraceContext): Promise<void> {
    const record = this.records.get(invocationId);
    if (record?.state === 'active') record.traceContext = ctx;
  }

  private verifyInTurn(invocationId: string, callbackToken: string, requireLatest: boolean): VerifyResult {
    this.cleanupTerminalTombstones();
    const record = this.records.get(invocationId);
    if (!record) return { ok: false, reason: 'unknown_invocation' };
    if (record.callbackToken !== callbackToken) return { ok: false, reason: 'invalid_token' };
    if (isTerminal(record)) return { ok: false, reason: record.state };
    if (requireLatest && this.latestByThreadCat.get(`${record.threadId}:${record.catId as string}`) !== invocationId) {
      return { ok: false, reason: 'stale_invocation' };
    }
    return { ok: true, record };
  }

  private commitTerminalInTurn(input: AuthTerminalCommitInput): AuthTerminalCommitResult {
    const record = this.records.get(input.invocationId);
    if (!record) return { outcome: 'not_found', record: null };
    if (record.state !== 'active') return { outcome: 'already_terminal', record };
    record.state = input.disposition;
    record.endedAt = input.endedAt;
    record.endReason = input.endReason;
    if (input.terminalRef !== undefined) record.terminalRef = input.terminalRef;
    record.expiresAt = Date.now() + this.tombstoneGcTtlMs;
    this.refreshCooldown.delete(input.invocationId);
    return { outcome: 'committed', record };
  }

  private cleanupTerminalTombstones(): void {
    const now = Date.now();
    for (const [invocationId, record] of this.records) {
      if (!isTerminal(record) || record.expiresAt === null || now < record.expiresAt) continue;
      this.records.delete(invocationId);
      this.refreshCooldown.delete(invocationId);
      const slot = `${record.threadId}:${record.catId as string}`;
      if (this.latestByThreadCat.get(slot) === invocationId) this.latestByThreadCat.delete(slot);
    }
  }
}
