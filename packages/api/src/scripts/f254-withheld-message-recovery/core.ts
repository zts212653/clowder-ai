import type { CatId } from '@cat-cafe/shared';
import type {
  AppendMessageInput,
  IMessageStore,
  StoredMessage,
} from '../../domains/cats/services/stores/ports/MessageStore.js';
import { type RecoveryManifestEntry, sha256Text, type ValidatedRecoveryManifest } from './manifest.js';

export {
  extractRecoveryEntryFromEvents,
  type RecoveryManifestEntry,
  type RecoveryManifestInput,
  type RecoverySourceProof,
  type RecoveryTranscriptEvent,
  sha256Text,
  type ValidatedRecoveryManifest,
  validateRecoveryManifest,
} from './manifest.js';

const PRODUCTION_CONFIRMATION = 'RESTORE F254 TO 6399';

export type RecoveryPlanOutcome =
  | 'insert'
  | 'insert_stream_companion'
  | 'already_restored'
  | 'already_formal'
  | 'conflict';

export interface RecoveryPlanItem {
  entry: RecoveryManifestEntry;
  outcome: RecoveryPlanOutcome;
  existingMessageId?: string;
  reason?: string;
}

export interface RecoveryPlan {
  manifestSha256: string;
  items: RecoveryPlanItem[];
  summary: Record<RecoveryPlanOutcome, number>;
}

type RecoveryMessageStore = Pick<IMessageStore, 'append' | 'getByIdempotencyKey'>;

export interface RecoveryApplyJournal {
  manifestSha256: string;
  cvoDecisionRef: string;
  recoveredAt: number;
  created: StoredMessage[];
  alreadyPresent: StoredMessage[];
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`recovery manifest ${field} must be a non-empty string`);
  }
}

function messageInvocationId(message: StoredMessage): string | undefined {
  return (
    message.extra?.recovery?.invocationId ??
    message.extra?.stream?.turnInvocationId ??
    message.extra?.stream?.invocationId
  );
}

export function planRecovery(
  manifest: ValidatedRecoveryManifest,
  existingMessages: readonly StoredMessage[],
): RecoveryPlan {
  const byInvocation = new Map<string, StoredMessage[]>();
  for (const message of existingMessages) {
    const invocationId = messageInvocationId(message);
    if (!invocationId) continue;
    const list = byInvocation.get(invocationId) ?? [];
    list.push(message);
    byInvocation.set(invocationId, list);
  }
  const summary: Record<RecoveryPlanOutcome, number> = {
    insert: 0,
    insert_stream_companion: 0,
    already_restored: 0,
    already_formal: 0,
    conflict: 0,
  };
  const items = manifest.entries.map((entry): RecoveryPlanItem => {
    const candidates = (byInvocation.get(entry.invocationId) ?? []).filter(
      (message) =>
        message.threadId === entry.threadId && message.userId === entry.userId && message.catId === entry.catId,
    );
    if (candidates.length === 0) {
      summary.insert += 1;
      return { entry, outcome: 'insert' };
    }
    const exact = candidates.find((message) => sha256Text(message.content) === entry.contentSha256);
    if (!exact && candidates.every((message) => message.origin === 'callback')) {
      summary.insert_stream_companion += 1;
      return {
        entry,
        outcome: 'insert_stream_companion',
        existingMessageId: candidates[0]?.id,
        reason: 'callback speech exists; withheld stream work-log remains independently recoverable',
      };
    }
    if (!exact) {
      summary.conflict += 1;
      return {
        entry,
        outcome: 'conflict',
        existingMessageId: candidates[0]?.id,
        reason: 'same invocation identity has different formal content',
      };
    }
    if (exact.extra?.recovery?.kind === 'f254_withheld_message') {
      summary.already_restored += 1;
      return { entry, outcome: 'already_restored', existingMessageId: exact.id };
    }
    summary.already_formal += 1;
    return { entry, outcome: 'already_formal', existingMessageId: exact.id };
  });
  return { manifestSha256: manifest.manifestSha256, items, summary };
}

function idempotencyKey(invocationId: string): string {
  return `f254-recovery:${invocationId}`;
}

export function toRecoveryAppendInput(
  entry: RecoveryManifestEntry,
  manifest: ValidatedRecoveryManifest,
  recoveredAt: number,
): AppendMessageInput {
  return {
    userId: entry.userId,
    threadId: entry.threadId,
    catId: entry.catId as CatId,
    content: entry.content,
    mentions: [],
    timestamp: entry.timestamp,
    origin: 'stream',
    idempotencyKey: idempotencyKey(entry.invocationId),
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
    ...(entry.thinking ? { thinking: entry.thinking } : {}),
    ...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
    extra: {
      stream: { invocationId: entry.invocationId, turnInvocationId: entry.invocationId },
      recovery: {
        kind: 'f254_withheld_message',
        invocationId: entry.invocationId,
        manifestSha256: manifest.manifestSha256,
        contentSha256: entry.contentSha256,
        cvoDecisionRef: manifest.cvoDecisionRef,
        recoveredAt,
        sourceProof: { ...entry.sourceProof },
      },
    },
  };
}

function assertMatchingRecoveredMessage(message: StoredMessage, entry: RecoveryManifestEntry): void {
  const marker = message.extra?.recovery;
  if (
    marker?.kind !== 'f254_withheld_message' ||
    marker.invocationId !== entry.invocationId ||
    marker.contentSha256 !== entry.contentSha256 ||
    sha256Text(message.content) !== entry.contentSha256
  ) {
    throw new Error(`idempotency conflict for recovery invocation ${entry.invocationId}`);
  }
}

export async function applyRecoveryEntries(input: {
  manifest: ValidatedRecoveryManifest;
  entries: readonly RecoveryManifestEntry[];
  messageStore: RecoveryMessageStore;
  recoveredAt: number;
}): Promise<RecoveryApplyJournal> {
  if (!Number.isSafeInteger(input.recoveredAt) || input.recoveredAt <= 0) {
    throw new Error('recoveredAt must be a positive integer');
  }
  const created: StoredMessage[] = [];
  const alreadyPresent: StoredMessage[] = [];
  for (const entry of input.entries) {
    const existing = await input.messageStore.getByIdempotencyKey(
      entry.userId,
      entry.threadId,
      idempotencyKey(entry.invocationId),
    );
    if (existing) {
      assertMatchingRecoveredMessage(existing, entry);
      alreadyPresent.push(existing);
      continue;
    }
    const stored = await input.messageStore.append(toRecoveryAppendInput(entry, input.manifest, input.recoveredAt));
    assertMatchingRecoveredMessage(stored, entry);
    if (stored.extra?.recovery?.recoveredAt === input.recoveredAt) created.push(stored);
    else alreadyPresent.push(stored);
  }
  return {
    manifestSha256: input.manifest.manifestSha256,
    cvoDecisionRef: input.manifest.cvoDecisionRef,
    recoveredAt: input.recoveredAt,
    created,
    alreadyPresent,
  };
}

export function assertRecoveryWriteAllowed(
  redisUrl: string,
  manifest: ValidatedRecoveryManifest,
  authorization:
    | { mode: 'preview' }
    | {
        mode: 'production';
        approvalRef?: string;
        expectedManifestSha256?: string;
        confirmation?: string;
      },
): void {
  const parsed = new URL(redisUrl);
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 6379;
  if (port === 6398) {
    if (authorization.mode !== 'preview') {
      throw new Error('production authorization cannot target preview Redis 6398');
    }
    return;
  }
  if (port !== 6399) {
    throw new Error(`recovery writes are restricted to preview Redis 6398 or production Redis 6399, got ${port}`);
  }
  if (authorization.mode !== 'production') {
    throw new Error('production Redis 6399 write refused without production authorization');
  }
  requireNonEmpty(authorization.approvalRef, 'production approvalRef');
  if (authorization.expectedManifestSha256 !== manifest.manifestSha256) {
    throw new Error('production recovery manifest hash does not match the approved hash');
  }
  if (authorization.confirmation !== PRODUCTION_CONFIRMATION) {
    throw new Error(`production recovery confirmation must equal ${PRODUCTION_CONFIRMATION}`);
  }
}
