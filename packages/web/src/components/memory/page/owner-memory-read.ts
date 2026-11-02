import {
  type EntityMemoryOwnerBrowse,
  type EntityMemoryOwnerDetail,
  type EntityMemoryOwnerEntry,
  type EventMemoryCorrectionProposalView,
  type EventMemoryOwnerLifecycleProjection,
  isEventMemoryRecord,
  type MemoryOwnerSourceResponse,
  memoryOwnerRevisionSchema,
  type ProfileMemoryOwnerBrowse,
  type ProfileMemoryOwnerEntry,
  type StoredEventMemory,
} from '@cat-cafe/shared';
import { hasValidEventCorrections } from './event-correction-read';
import { hasValidOriginalProposals, isEntityProposal, isProfileProposal } from './original-proposal-read';

export type ProfileMemoryRead = Omit<ProfileMemoryOwnerEntry, 'proposals'> & {
  proposals?: ProfileMemoryOwnerEntry['proposals'];
};
export type ProfileMemoryBrowseRead = Omit<ProfileMemoryOwnerBrowse, 'entries'> & { entries: ProfileMemoryRead[] };
export type EntityMemoryDetailRead = Omit<EntityMemoryOwnerDetail, 'proposals'> & {
  proposals?: EntityMemoryOwnerDetail['proposals'];
};

export const memoryObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string';
const texts = (value: unknown) => Array.isArray(value) && value.every(text);
const revision = (value: unknown) => memoryOwnerRevisionSchema.safeParse(value).success;
const status = (value: unknown) => value === 'active' || value === 'retired';
export function isOwnerSource(value: unknown): value is MemoryOwnerSourceResponse {
  return (
    memoryObject(value) &&
    ['ready', 'not_recorded', 'unavailable'].includes(String(value.status)) &&
    Array.isArray(value.sources) &&
    value.sources.every(
      (source) =>
        memoryObject(source) &&
        text(source.label) &&
        (source.occurredAt === null || typeof source.occurredAt === 'number') &&
        typeof source.canOpen === 'boolean' &&
        (!source.canOpen || (text(source.threadId) && text(source.messageId))),
    )
  );
}
export function isProfileEntry(value: unknown): value is ProfileMemoryRead {
  return (
    memoryObject(value) &&
    value.type === 'profile' &&
    value.status === 'active' &&
    ['primer', 'corpus', 'capsule'].includes(String(value.layer)) &&
    ['id', 'uri', 'title', 'content'].every((key) => text(value[key])) &&
    revision(value.revision) &&
    (value.relationshipKey === null || text(value.relationshipKey)) &&
    hasValidOriginalProposals(value, isProfileProposal)
  );
}
export function isProfileBrowse(value: unknown): value is ProfileMemoryBrowseRead {
  return (
    memoryObject(value) &&
    value.readStatus === 'ready' &&
    Array.isArray(value.entries) &&
    value.entries.every(isProfileEntry) &&
    (value.capsuleSetup === undefined ||
      (memoryObject(value.capsuleSetup) &&
        revision(value.capsuleSetup.revision) &&
        Array.isArray(value.capsuleSetup.proposals) &&
        value.capsuleSetup.proposals.every(isProfileProposal)))
  );
}
export function isEntityEntry(value: unknown): value is EntityMemoryOwnerEntry {
  return (
    memoryObject(value) &&
    value.type === 'entity' &&
    ['id', 'canonicalName', 'stance', 'visibilityScope', 'updatedAt'].every((key) => text(value[key])) &&
    ['person', 'cat', 'feature', 'concept', 'external'].includes(String(value.entityType)) &&
    texts(value.aliases) &&
    revision(value.revision) &&
    status(value.status) &&
    typeof value.provenanceCount === 'number' &&
    Number.isSafeInteger(value.provenanceCount) &&
    value.provenanceCount >= 0
  );
}
export function isEntityDetail(value: unknown): value is EntityMemoryDetailRead {
  return (
    isEntityEntry(value) &&
    memoryObject(value) &&
    Array.isArray(value.provenance) &&
    value.provenance.every((item) => memoryObject(item) && text(item.source)) &&
    hasValidOriginalProposals(value, isEntityProposal)
  );
}
export function isEntityBrowse(value: unknown): value is EntityMemoryOwnerBrowse {
  return (
    memoryObject(value) &&
    value.readStatus === 'ready' &&
    Array.isArray(value.entries) &&
    value.entries.every(isEntityEntry)
  );
}
export type MemoryEvent = StoredEventMemory &
  Omit<EventMemoryOwnerLifecycleProjection, 'pendingCorrectionCount'> & {
    summaryTruncated?: boolean;
    pendingCorrectionCount?: number;
    correctionProposals?: EventMemoryCorrectionProposalView[];
  };
export interface MemoryEventPage {
  events: MemoryEvent[];
  meta: { count: number; offset: number; hasMore: boolean; nextOffset?: number };
}
export function isMemoryEvent(value: unknown): value is MemoryEvent {
  return (
    isEventMemoryRecord(value) &&
    memoryObject(value) &&
    text(value.eventId) &&
    text(value.ownerUserId) &&
    revision(value.revision) &&
    status(value.status) &&
    hasValidEventCorrections(value)
  );
}
export function isMemoryEventPage(value: unknown): value is MemoryEventPage {
  if (
    !memoryObject(value) ||
    !Array.isArray(value.events) ||
    !value.events.every(isMemoryEvent) ||
    !memoryObject(value.meta)
  )
    return false;
  const meta = value.meta;
  return (
    meta.count === value.events.length &&
    typeof meta.offset === 'number' &&
    Number.isSafeInteger(meta.offset) &&
    meta.offset >= 0 &&
    typeof meta.hasMore === 'boolean' &&
    (!meta.hasMore ||
      (typeof meta.nextOffset === 'number' && Number.isSafeInteger(meta.nextOffset) && meta.nextOffset > meta.offset))
  );
}
