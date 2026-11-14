import type { RecallScopeV1 } from '@cat-cafe/shared';
import { eventMemoryRevision, type IEventMemoryStore } from '../domains/memory/EventMemoryStore.js';
import type { PersonMemoryOwnerReadService } from '../domains/memory/people/PersonMemoryOwnerReadService.js';
import type { TasteMemoryLifecycleStore } from '../domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryReader } from '../domains/memory/taste/TasteMemoryReader.js';
import { sourcePathFromTasteAnchor } from '../domains/memory/taste/taste-memory-identity.js';
import type { TasteRepository } from '../domains/taste/services/TasteRepository.js';
import { type EventMemorySourceReaders, readEventMemorySource } from './event-memory-source.js';
import type { RecallCandidateView } from './recall-candidate-view.js';
import type { RecallCueCoordinate } from './recall-cue-view.js';
import { recallMemoryHref } from './recall-memory-href.js';
import { tasteMemoryId } from './taste-browse-model.js';
import { readTasteSource, type TasteSourceReaders } from './taste-browse-source.js';

export interface RecallOwnerMessageSources {
  personDeliveryReader?: PersonMemoryOwnerReadService['readDelivery'];
  tasteSources?: {
    ownerUserId: string;
    repository: TasteRepository;
    lifecycle?: Pick<TasteMemoryLifecycleStore, 'isReadable'> &
      Partial<Pick<TasteMemoryLifecycleStore, 'sourceDisposition'>>;
    sourceReaders: TasteSourceReaders;
  };
  eventSources?: {
    store: Pick<IEventMemoryStore, 'getEvent'>;
    sourceReaders: EventMemorySourceReaders;
  };
}
function name(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : undefined;
}
function messageHref(threadId: string, messageId: string): string {
  return `/thread/${encodeURIComponent(threadId)}?message=${encodeURIComponent(messageId)}`;
}
function unavailable(
  cue: RecallCueCoordinate,
  reason?: RecallCandidateView['sourceUnavailableReason'],
): RecallCandidateView {
  return {
    kind: cue.resolver_family,
    href: null,
    titleStatus: 'unavailable',
    ...(reason ? { sourceUnavailableReason: reason } : {}),
  };
}

type Scope = Omit<RecallScopeV1, 'invocationId'>;
async function readPersonView(
  cue: RecallCueCoordinate,
  scope: Scope,
  readDelivery: RecallOwnerMessageSources['personDeliveryReader'],
): Promise<RecallCandidateView> {
  if (!readDelivery || !cue.source_anchor.startsWith('person-memory:')) return unavailable(cue);
  const personId = cue.source_anchor.slice('person-memory:'.length);
  const read = await readDelivery(scope.ownerUserId, personId, cue.source_revision);
  if (read.status !== 'ready')
    return unavailable(cue, read.status === 'version_changed' ? 'source_corrected' : undefined);
  const href = read.message ? messageHref(read.message.threadId, read.message.messageId) : null;
  return {
    kind: 'person_entity',
    title: name(read.displayName),
    href,
    messageHref: href,
    memoryHref: recallMemoryHref('person', personId, cue.source_revision, scope.threadId),
  };
}
async function readTasteView(
  cue: RecallCueCoordinate,
  scope: Scope,
  sources: NonNullable<RecallOwnerMessageSources['tasteSources']>,
): Promise<RecallCandidateView | null> {
  const sourcePath = sourcePathFromTasteAnchor(cue.source_anchor);
  if (!sourcePath) return null; // A dimension bundle is not one vignette's provenance.
  const { ownerUserId, repository, lifecycle, sourceReaders } = sources;
  if (scope.ownerUserId !== ownerUserId) return unavailable(cue, 'scope_revoked');
  const reader = new TasteMemoryReader(repository, ownerUserId, { lifecycle });
  const memory = await reader.read({ ownerUserId: scope.ownerUserId, sourcePath });
  if (!memory) {
    const status = lifecycle?.sourceDisposition?.(scope.ownerUserId, sourcePath);
    return unavailable(
      cue,
      status === 'forgotten' ? 'source_forgotten' : status === 'retired' ? 'source_corrected' : undefined,
    );
  }
  if (memory.revision !== cue.source_revision) return unavailable(cue, 'source_corrected');
  const source = await readTasteSource(memory, scope.ownerUserId, sourceReaders);
  return {
    kind: 'taste',
    title: name(memory.payload.takeaway) ?? name(memory.payload.quotes?.[0]) ?? name(memory.payload.when),
    href: source.canOpen && 'threadId' in source ? messageHref(source.threadId, source.messageId) : null,
    messageHref: source.canOpen && 'threadId' in source ? messageHref(source.threadId, source.messageId) : null,
    memoryHref: recallMemoryHref('taste', tasteMemoryId(sourcePath), cue.source_revision, scope.threadId),
  };
}
async function readEventView(
  cue: RecallCueCoordinate,
  scope: Scope,
  sources: NonNullable<RecallOwnerMessageSources['eventSources']>,
): Promise<RecallCandidateView> {
  if (!cue.source_anchor.startsWith('event-memory:')) return unavailable(cue);
  const { store, sourceReaders } = sources;
  const event = store.getEvent(cue.source_anchor.slice('event-memory:'.length));
  if (!event) return unavailable(cue, 'source_forgotten');
  if (event.ownerUserId !== scope.ownerUserId || event.threadId !== scope.threadId)
    return unavailable(cue, 'scope_revoked');
  if (event.status !== 'active' || eventMemoryRevision(event) !== cue.source_revision)
    return unavailable(cue, 'source_corrected');
  const source = await readEventMemorySource(event, scope.ownerUserId, sourceReaders);
  const first = source.status === 'ready' ? source.sources.find((item) => item.canOpen) : undefined;
  const href = first?.threadId && first.messageId ? messageHref(first.threadId, first.messageId) : null;
  return {
    kind: 'event',
    title: name(event.summary),
    href,
    messageHref: href,
    memoryHref: recallMemoryHref('event', event.eventId, cue.source_revision, scope.threadId),
  };
}

/** Read native owner provenance, never consume a cue or renew a model's short-lived grant. */
export async function readOwnerMessageView(
  cue: RecallCueCoordinate,
  scope: Scope,
  sources: RecallOwnerMessageSources,
): Promise<RecallCandidateView | null> {
  try {
    if (cue.resolver_family === 'person_entity') return await readPersonView(cue, scope, sources.personDeliveryReader);
    if (cue.resolver_family === 'taste' && sources.tasteSources)
      return await readTasteView(cue, scope, sources.tasteSources);
    if (cue.resolver_family === 'event' && sources.eventSources)
      return await readEventView(cue, scope, sources.eventSources);
    return null;
  } catch {
    return unavailable(cue);
  }
}
