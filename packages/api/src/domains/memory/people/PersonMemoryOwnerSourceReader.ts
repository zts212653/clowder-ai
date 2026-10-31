import type {
  MaterializationAuthority,
  PersonIdentity,
  PersonMemorySourceRef,
  ResolvedPersonMemorySource,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { canAccessThread } from '../../guides/guide-state-access.js';
import { ownerActionDisplayVerb, verifyOwnerMemoryActionEvidence } from './OwnerMemoryActionEvidenceIssuer.js';
import type { OwnerPrivateArtifactResolver } from './PersonMemorySourceBundleResolver.js';
import { eligibleOwnerMessage, PersonMemorySourceBundleResolver } from './PersonMemorySourceBundleResolver.js';

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
  private readonly resolver: PersonMemorySourceBundleResolver;

  constructor(private readonly deps: PersonMemoryOwnerSourceReaderDeps) {
    this.resolver = new PersonMemorySourceBundleResolver({
      messageStore: deps.messageStore,
      ...(deps.ownerPrivateArtifactResolver ? { ownerPrivateArtifactResolver: deps.ownerPrivateArtifactResolver } : {}),
    });
  }

  async read(ownerUserId: string, item: PersonMemoryOwnerSourceItem) {
    const ownerAction = this.ownerActionSource(ownerUserId, item);
    if (ownerAction) return ownerAction;
    const refs = await this.revalidateSourceRefs(ownerUserId, item);
    if (!refs) return { status: 'unavailable' as const };
    const sources = [];
    for (const ref of refs) {
      const thread = await this.visibleThread(ownerUserId, ref.threadId);
      if (!thread) return { status: 'unavailable' as const };
      sources.push({
        kind: 'message' as const,
        threadId: ref.threadId,
        messageId: ref.messageId,
        title: thread.title?.trim() || null,
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
    const verb = ownerActionDisplayVerb(evidence.action);
    return {
      status: 'ready' as const,
      sources: [
        {
          kind: 'owner_action' as const,
          label: `主人在记忆页操作 · ${verb} · ${new Date(evidence.issuedAt).toISOString()}`,
          occurredAt: evidence.issuedAt,
          canOpen: false as const,
        },
      ],
    };
  }

  private async revalidateSourceRefs(
    ownerUserId: string,
    item: PersonMemoryOwnerSourceItem,
  ): Promise<PersonMemorySourceRef[] | null> {
    if (item.ownerUserId !== ownerUserId) return null;
    if (item.typedProvenance) {
      const current = await this.resolver.revalidateResolvedBundle(item.typedProvenance, { ownerUserId });
      if (current.status === 'invalid') return null;
      const refs = uniqueSourceRefs(current.bundle.sources.map(sourceRefOf));
      return refs.length > 0 ? refs : null;
    }
    const refs = uniqueSourceRefs(item.sourceRefs);
    for (const ref of refs) {
      const message = await this.deps.messageStore.getById(ref.messageId);
      if (!eligibleOwnerMessage(message, { ownerUserId }) || message.threadId !== ref.threadId) return null;
    }
    return refs.length > 0 ? refs : null;
  }

  private async visibleThread(ownerUserId: string, threadId: string) {
    const thread = await this.deps.threadStore.get(threadId);
    if (!thread || thread.deletedAt) return null;
    if (canAccessThread(thread, ownerUserId)) return thread;
    if (thread.createdBy !== 'system') return null;
    return (await this.deps.threadStore.list(ownerUserId)).some((item) => item.id === thread.id) ? thread : null;
  }
}
