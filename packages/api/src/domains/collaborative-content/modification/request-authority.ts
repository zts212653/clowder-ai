import { createHash } from 'node:crypto';
import { contentModificationOutcome } from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import { EntrustedWorkLifecycleError } from '../../growing/EntrustedWorkLifecycleService.js';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { PublicationTaskGrantPort } from '../../video-studio/content-owner/published-media-access.js';
import { assertDirectAdmissionSourceCustody } from './entrusted-work-source-custody.js';
import {
  type ContentModificationJournal,
  type ContentModificationRecord,
  modificationOperationKeys,
} from './journal.js';

/** Revalidate the actual human source. A durable journal never substitutes for current source custody. */
export async function assertModificationSourceAuthority(
  messages: Pick<IMessageStore, 'getById'>,
  record: ContentModificationRecord,
) {
  if (!record.progress.sourceMessageId) throw new MediaOwnerError('access_denied');
  const source = await assertDirectAdmissionSourceCustody(
    messages,
    { userId: record.ownerUserId, threadId: record.payload.threadId },
    {
      basis: 'explicit_entrustment',
      idempotencyKey: modificationOperationKeys(record.requestId).admit,
      sourceRefs: [`message:${record.progress.sourceMessageId}`],
      intendedOutcome: contentModificationOutcome(record.payload.intent),
    },
  ).catch((error) => {
    if (error instanceof EntrustedWorkLifecycleError) throw new MediaOwnerError('access_denied');
    throw error;
  });
  const accepted = source?.extra?.contentModificationRequestV1;
  if (
    !source ||
    !accepted ||
    accepted.requestId !== record.requestId ||
    accepted.targetCatId !== record.payload.targetCatId ||
    source.content !== contentModificationOutcome(record.payload.intent) ||
    accepted.requestFingerprint !==
      `sha256:${createHash('sha256').update(JSON.stringify(record.payload)).digest('hex')}`
  )
    throw new MediaOwnerError('access_denied');
  return accepted;
}

export class ModificationPublicationGrants implements PublicationTaskGrantPort {
  constructor(
    private readonly journal: ContentModificationJournal,
    private readonly messages: Pick<IMessageStore, 'getById'>,
  ) {}

  async hasGrant(input: {
    ownerUserId: string;
    taskId: string;
    contentRef: string;
    targetCatId: string;
    threadId: string;
  }) {
    const bindings = this.journal.publicationTaskBindings(input.ownerUserId, input.taskId, input.contentRef);
    for (const record of bindings) {
      if (record.payload.targetCatId !== input.targetCatId || record.payload.threadId !== input.threadId) continue;
      try {
        await assertModificationSourceAuthority(this.messages, record);
        return true;
      } catch (error) {
        // A revoked binding cannot authorize. Another independently confirmed request may still do so.
        if (!(error instanceof MediaOwnerError)) throw error;
      }
    }
    return false;
  }
}
