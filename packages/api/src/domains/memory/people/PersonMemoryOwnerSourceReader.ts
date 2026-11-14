import type {
  MaterializationAuthority,
  PersonIdentity,
  PersonMemorySourceRef,
  ResolvedPersonMemorySource,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { canAccessThread } from '../../guides/guide-state-access.js';
import { memorySourceSpeaker } from '../memory-source-speaker.js';
import { verifyOwnerMemoryActionEvidence } from './OwnerMemoryActionEvidenceIssuer.js';
import type { OwnerPrivateArtifactResolver } from './PersonMemorySourceBundleResolver.js';
import { eligibleOwnerMessage, PersonMemorySourceBundleResolver } from './PersonMemorySourceBundleResolver.js';
import { canonicalSourceRejectionReason, ownerMessageRejectionReason } from './person-memory-source-diagnostics.js';

export type PersonMemoryOwnerSourceItem = Pick<PersonIdentity, 'ownerUserId' | 'sourceRefs' | 'typedProvenance'> & {
  materializedBy?: MaterializationAuthority;
  personId?: string;
  claimId?: string;
  eventId?: string;
  supersedesClaimId?: string;
  amendsEventId?: string;
};

export interface PersonMemoryOwnerSourceReaderDeps {
  messageStore: Pick<IMessageStore, 'getById'>;
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  ownerPrivateArtifactResolver?: OwnerPrivateArtifactResolver;
}

function sourceRefOf(source: ResolvedPersonMemorySource): PersonMemorySourceRef {
  return source.kind === 'message_text' || source.kind === 'message_attachment'
    ? source.sourceRef
    : source.confirmationSourceRef;
}

function uniqueSourceRefs(refs: readonly PersonMemorySourceRef[]): PersonMemorySourceRef[] {
  const unique = new Map<string, PersonMemorySourceRef>();
  for (const ref of refs) unique.set(`${ref.threadId}\0${ref.messageId}`, ref);
  return [...unique.values()];
}

export class PersonMemoryOwnerSourceReader {
  constructor(private readonly deps: PersonMemoryOwnerSourceReaderDeps) {}

  async read(ownerUserId: string, item: PersonMemoryOwnerSourceItem, onUnavailable?: (reason: string) => void) {
    const ownerAction = this.ownerActionSource(ownerUserId, item);
    if (ownerAction) {
      if (ownerAction.status === 'unavailable') onUnavailable?.('owner_action_unverified');
      return ownerAction;
    }
    const refs = await this.revalidateSourceRefs(ownerUserId, item, onUnavailable);
    if (!refs) return { status: 'unavailable' as const };
    const sources = [];
    for (const ref of refs) {
      const thread = await this.visibleThread(ownerUserId, ref.threadId);
      if (!thread) {
        onUnavailable?.('thread_unavailable');
        return { status: 'unavailable' as const };
      }
      const message = await this.deps.messageStore.getById(ref.messageId);
      if (!eligibleOwnerMessage(message, { ownerUserId }) || message.threadId !== ref.threadId) {
        onUnavailable?.(
          eligibleOwnerMessage(message, { ownerUserId })
            ? 'message_thread_changed'
            : ownerMessageRejectionReason(message, ownerUserId),
        );
        return { status: 'unavailable' as const };
      }
      sources.push({
        kind: 'message' as const,
        threadId: ref.threadId,
        messageId: ref.messageId,
        title: thread.title?.trim() || null,
        occurredAt: message.timestamp,
        speaker: memorySourceSpeaker(message),
        canOpen: true as const,
      });
    }
    return { status: 'ready' as const, sources };
  }

  private ownerActionSource(ownerUserId: string, item: PersonMemoryOwnerSourceItem) {
    const evidence = item.materializedBy;
    if (evidence?.kind !== 'owner_memory_action') return null;
    if (!verifyOwnerMemoryActionEvidence({ evidence, ownerUserId })) {
      return { status: 'unavailable' as const };
    }
    const expectedItemId =
      item.supersedesClaimId ?? item.amendsEventId ?? item.claimId ?? item.eventId ?? item.personId;
    if (!expectedItemId || evidence.target.itemId !== expectedItemId) {
      return { status: 'unavailable' as const };
    }
    return {
      status: 'ready' as const,
      sources: [
        {
          kind: 'owner_action' as const,
          label: '你在记忆页修改',
          occurredAt: evidence.issuedAt,
          canOpen: false as const,
        },
      ],
    };
  }

  private async revalidateSourceRefs(
    ownerUserId: string,
    item: PersonMemoryOwnerSourceItem,
    onUnavailable?: (reason: string) => void,
  ): Promise<PersonMemorySourceRef[] | null> {
    const reject = (reason: string) => {
      onUnavailable?.(reason);
      return null;
    };
    if (item.ownerUserId !== ownerUserId) {
      return reject('item_owner_mismatch');
    }
    if (item.typedProvenance) {
      // The observer belongs to one read, including when requests overlap on this reader.
      let messageReason: string | undefined;
      const resolver = new PersonMemorySourceBundleResolver({
        ...this.deps,
        onMessageRejected: (reason) => {
          messageReason = reason;
        },
      });
      const current = await resolver.revalidateResolvedBundle(item.typedProvenance, { ownerUserId });
      if (current.status === 'invalid') {
        return reject(messageReason ?? canonicalSourceRejectionReason(current.error));
      }
      const refs = uniqueSourceRefs(current.bundle.sources.map(sourceRefOf));
      return refs.length > 0 ? refs : reject('source_refs_missing');
    }
    const refs = uniqueSourceRefs(item.sourceRefs);
    for (const ref of refs) {
      const message = await this.deps.messageStore.getById(ref.messageId);
      if (!eligibleOwnerMessage(message, { ownerUserId }))
        return reject(ownerMessageRejectionReason(message, ownerUserId));
      if (message.threadId !== ref.threadId) return reject('message_thread_changed');
    }
    return refs.length > 0 ? refs : reject('source_refs_missing');
  }

  private async visibleThread(ownerUserId: string, threadId: string) {
    const thread = await this.deps.threadStore.get(threadId);
    if (!thread || thread.deletedAt) return null;
    if (canAccessThread(thread, ownerUserId)) return thread;
    if (thread.createdBy !== 'system') return null;
    return (await this.deps.threadStore.list(ownerUserId)).some((item) => item.id === thread.id) ? thread : null;
  }
}
