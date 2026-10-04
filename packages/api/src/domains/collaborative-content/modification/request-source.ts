import { createHash } from 'node:crypto';
import {
  type ContentModificationCompletionRule,
  type ContentModificationSourceMessageV1,
  contentModificationOutcome,
  contentModificationSourceMessageV1Schema,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { assertDirectAdmissionSourceCustody } from './entrusted-work-source-custody.js';
import {
  ContentModificationJournalError,
  type ContentModificationRecord,
  modificationOperationKeys,
} from './journal.js';

export interface ModificationLabels {
  title: string;
  targetName: string;
  threadTitle: string;
  completionRule: ContentModificationCompletionRule;
}

export async function persistModificationSource(
  messages: IMessageStore,
  record: ContentModificationRecord,
  labels: ModificationLabels,
  now = Date.now(),
): Promise<StoredMessage> {
  const keys = modificationOperationKeys(record.requestId);
  const intendedOutcome = contentModificationOutcome(record.payload.intent);
  const extra: ContentModificationSourceMessageV1 = contentModificationSourceMessageV1Schema.parse({
    v: 1,
    requestId: record.requestId,
    requestFingerprint: `sha256:${createHash('sha256').update(JSON.stringify(record.payload)).digest('hex')}`,
    contentTitle: labels.title,
    targetCatId: record.payload.targetCatId,
    targetName: labels.targetName,
    executionThreadTitle: labels.threadTitle,
    completionRule: labels.completionRule,
  });
  // The bubble header is rendered from extra; titles must not become false deadline evidence.
  const content = intendedOutcome;
  let source = await messages.getByIdempotencyKey(record.ownerUserId, record.payload.threadId, keys.source);
  if (!source)
    source = (
      await messages.appendIdempotent({
        userId: record.ownerUserId,
        threadId: record.payload.threadId,
        catId: null,
        mentions: [],
        timestamp: now,
        content,
        idempotencyKey: keys.source,
        extra: { contentModificationRequestV1: extra },
      })
    ).message;
  const accepted = source.extra?.contentModificationRequestV1;
  if (
    !accepted ||
    accepted.v !== 1 ||
    accepted.requestId !== extra.requestId ||
    accepted.requestFingerprint !== extra.requestFingerprint ||
    accepted.targetCatId !== extra.targetCatId ||
    accepted.completionRule !== extra.completionRule ||
    source.content !== intendedOutcome
  )
    throw new ContentModificationJournalError('operation_reused');
  await assertDirectAdmissionSourceCustody(
    messages,
    { userId: record.ownerUserId, threadId: record.payload.threadId },
    {
      basis: 'explicit_entrustment',
      idempotencyKey: keys.admit,
      sourceRefs: [`message:${source.id}`],
      intendedOutcome,
    },
  );
  return source;
}
