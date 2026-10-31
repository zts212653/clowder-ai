import type { RecallScopeV1 } from '@cat-cafe/shared';
import type { MemoryCueSourceReader } from '../domains/memory/cue/MemoryCueSourceReader.js';
import { eventMemoryRevision, type IEventMemoryStore } from '../domains/memory/EventMemoryStore.js';
import type { TasteMemoryLifecycleStore } from '../domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryReader } from '../domains/memory/taste/TasteMemoryReader.js';
import { sourcePathFromTasteAnchor } from '../domains/memory/taste/taste-memory-identity.js';
import type { TasteRepository } from '../domains/taste/services/TasteRepository.js';
import { type EventMemorySourceReaders, readEventMemorySource } from './event-memory-source.js';
import type { RecallCandidateView } from './recall-candidate-view.js';
import type { RecallCueCoordinate } from './recall-cue-view.js';
import { readTasteSource, type TasteSourceReaders } from './taste-browse-source.js';

export interface RecallOwnerMessageSources {
  tasteSources?: {
    ownerUserId: string;
    repository: TasteRepository;
    lifecycle?: Pick<TasteMemoryLifecycleStore, 'isReadable'>;
    sourceReaders: TasteSourceReaders;
  };
  eventSources?: {
    store: Pick<IEventMemoryStore, 'getEvent'>;
    sourceReaders: EventMemorySourceReaders;
  };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
type CandidateReader = (anchor: string) => Promise<RecallCandidateView>;

async function personMessageHref(payload: Record<string, unknown>, readCandidate: CandidateReader) {
  const refs = Array.isArray(payload.provenanceRefs) ? payload.provenanceRefs : [];
  for (const item of refs) {
    const ref = record(item);
    if (typeof ref.threadId !== 'string' || typeof ref.messageId !== 'string' || !ref.messageId) continue;
    // The canonical person reader checked the message; the browser reader also fences its thread.
    if ((await readCandidate(`thread-${ref.threadId}`)).href) return messageHref(ref.threadId, ref.messageId);
  }
  return null;
}
async function readPersonView(
  cue: RecallCueCoordinate,
  scope: Scope,
  readCandidate: CandidateReader,
  sourceReader: MemoryCueSourceReader | undefined,
): Promise<RecallCandidateView> {
  if (!sourceReader) return unavailable(cue);
  const read = await sourceReader.read({
    family: 'person_memory',
    anchor: cue.source_anchor,
    expectedRevision: cue.source_revision,
    scope: { ...scope, invocationId: cue.invocation_id },
    consumerCatId: cue.consumer_cat_id,
  });
  if (read.status !== 'ok') {
    const reason = read.invalidationReason;
    return unavailable(
      cue,
      reason === 'source_corrected' || reason === 'source_forgotten' || reason === 'scope_revoked' ? reason : undefined,
    );
  }
  const payload = record(read.payload);
  const title = name(payload.displayName);
  return { kind: 'person_entity', href: await personMessageHref(payload, readCandidate), ...(title ? { title } : {}) };
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
  if (!memory) return unavailable(cue);
  if (memory.revision !== cue.source_revision) return unavailable(cue, 'source_corrected');
  const source = await readTasteSource(memory, scope.ownerUserId, sourceReaders);
  return {
    kind: 'taste',
    title: memory.payload.when,
    href: source.canOpen && 'threadId' in source ? messageHref(source.threadId, source.messageId) : null,
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
  if (!first?.threadId || !first.messageId) return unavailable(cue);
  return { kind: 'event', title: name(event.summary), href: messageHref(first.threadId, first.messageId) };
}

/** Read native owner provenance, never consume a cue or renew a model's short-lived grant. */
export async function readOwnerMessageView(
  cue: RecallCueCoordinate,
  scope: Scope,
  readCandidate: CandidateReader,
  sourceReader: MemoryCueSourceReader | undefined,
  sources: RecallOwnerMessageSources,
): Promise<RecallCandidateView | null> {
  try {
    if (cue.resolver_family === 'person_entity') return await readPersonView(cue, scope, readCandidate, sourceReader);
    if (cue.resolver_family === 'taste' && sources.tasteSources)
      return await readTasteView(cue, scope, sources.tasteSources);
    if (cue.resolver_family === 'event' && sources.eventSources)
      return await readEventView(cue, scope, sources.eventSources);
    return null;
  } catch {
    return unavailable(cue);
  }
}
