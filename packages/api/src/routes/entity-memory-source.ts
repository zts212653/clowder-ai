import type { MemoryOwnerSourceCoordinate, MemoryOwnerSourceResponse } from '@cat-cafe/shared';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveThreadMessageVisibility } from '../domains/cats/services/stores/visibility.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import type { StoredEntityRecord } from '../domains/memory/EntityRegistry.js';
import type { EntityProvenance } from '../domains/memory/interfaces.js';

export interface EntityMemorySourceReaders {
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  messageStore: Pick<IMessageStore, 'getById'>;
}

export async function readEntityMemorySource(
  entity: StoredEntityRecord,
  ownerUserId: string,
  readers: EntityMemorySourceReaders,
): Promise<MemoryOwnerSourceResponse> {
  if (entity.provenance.length === 0) return { status: 'not_recorded', sources: [] };
  const sources: MemoryOwnerSourceCoordinate[] = [];
  for (const provenance of entity.provenance) {
    const source = await projectProvenance(provenance, ownerUserId, readers);
    if (source) sources.push(source);
  }
  return sources.length > 0 ? { status: 'ready', sources } : { status: 'unavailable', sources: [] };
}

async function projectProvenance(
  provenance: EntityProvenance,
  ownerUserId: string,
  readers: EntityMemorySourceReaders,
): Promise<MemoryOwnerSourceCoordinate | null> {
  if (!provenance.threadId || !provenance.messageId) {
    return {
      label: provenanceLabel(provenance),
      occurredAt: parseDate(provenance.date),
      canOpen: false,
    };
  }
  const thread = await readers.threadStore.get(provenance.threadId);
  if (!thread || thread.deletedAt || !(await canReadThread(thread, ownerUserId, readers.threadStore))) return null;
  const message = await readers.messageStore.getById(provenance.messageId);
  if (!message || message.threadId !== thread.id || message.deletedAt) return null;
  if (!resolveThreadMessageVisibility({ includeQueuedUserMessages: true }, ownerUserId)(message)) return null;
  return {
    label: thread.title?.trim() || provenanceLabel(provenance),
    occurredAt: message.timestamp,
    canOpen: true,
    threadId: thread.id,
    messageId: message.id,
  };
}

async function canReadThread(
  thread: Awaited<ReturnType<IThreadStore['get']>> & {},
  ownerUserId: string,
  store: Pick<IThreadStore, 'list'>,
): Promise<boolean> {
  if (canAccessThread(thread, ownerUserId)) return true;
  return thread.createdBy === 'system' && (await store.list(ownerUserId)).some((item) => item.id === thread.id);
}

function provenanceLabel(provenance: EntityProvenance): string {
  return provenance.sourcePath ?? provenance.anchor ?? provenance.source;
}

function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
