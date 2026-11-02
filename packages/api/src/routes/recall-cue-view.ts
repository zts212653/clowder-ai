import type { RecallResolverFamily, RecallScopeV1 } from '@cat-cafe/shared';
import { CURRENT_CORPUS_PROFILE_URI, CURRENT_RELATIONSHIP_PROFILE_URI } from '@cat-cafe/shared/profile-contract';
import type { MemoryCueSourceReader } from '../domains/memory/cue/MemoryCueSourceReader.js';
import type { RecallCandidateView, RecallSourceReaders } from './recall-candidate-view.js';
import { type RecallOwnerMessageSources, readOwnerMessageView } from './recall-owner-message-view.js';
import { readOwnerProfileView } from './recall-owner-profile-view.js';

export interface RecallCueCoordinate {
  invocation_id: string;
  cue_id: string;
  resolver_family: RecallResolverFamily;
  source_anchor: string;
  source_revision: string;
  consumer_cat_id: string;
}
export interface RecallSourceView extends RecallCandidateView {
  anchor: string;
  invocationId?: string;
  cueId?: string;
  sourceRevision?: string;
}
const FAMILIES: Record<RecallResolverFamily, Parameters<MemoryCueSourceReader['read']>[0]['family']> = {
  person_entity: 'person_memory',
  operational_precedent: 'evidence',
  taste: 'taste',
  profile: 'profile',
  event: 'event',
  decision: 'evidence',
  project_knowledge: 'evidence',
  cat_owned_seed: 'owned_seed',
  thread_overview: 'thread_overview',
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function title(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : undefined;
}
function tasteTitle(payload: Record<string, unknown>): string | undefined {
  // Canonical explicit vignette, task-bundle item and dimension bundle are distinct payload contracts.
  if (Array.isArray(payload.vignettes)) {
    const names = payload.vignettes.map((item) => title(record(record(item).payload).when)).filter(Boolean);
    return names.length ? title(names.join('；')) : undefined;
  }
  const vignette = record(payload.vignette);
  return title(vignette.when) ?? title(record(vignette.payload).when);
}
function payloadTitle(family: RecallResolverFamily, payload: unknown): string | undefined {
  const data = record(payload);
  switch (family) {
    case 'taste':
      return tasteTitle(data);
    case 'profile':
      return data.profileUri === CURRENT_RELATIONSHIP_PROFILE_URI
        ? '主人关系画像'
        : data.profileUri === CURRENT_CORPUS_PROFILE_URI
          ? '主人共享画像'
          : undefined;
    case 'thread_overview':
      return title(data.title);
    case 'event':
      return title(data.summary);
    default:
      return undefined;
  }
}

function openingProfileMetadata(cue: RecallCueCoordinate): RecallCandidateView | null {
  // This names a recorded delivery, not a fresh drill or a claim that the old body is current.
  // The profile lane owns the owner-facing current read/correction, including forgotten entries.
  if (cue.resolver_family === 'profile' && cue.source_anchor === 'profile:opening-capsule') {
    return { kind: 'profile', title: '开场递送 · 开场简介', href: null, profileMemoryId: 'capsule' };
  }
  if (cue.resolver_family === 'profile' && cue.source_anchor.startsWith('profile:opening-primer:')) {
    const coordinate = /^profile:opening-primer:([^:]+):([^:]+)$/.exec(cue.source_anchor);
    const [, relationshipKey, consumerCatId] = coordinate ?? [];
    try {
      if (relationshipKey && consumerCatId && decodeURIComponent(consumerCatId) === cue.consumer_cat_id) {
        return {
          kind: 'profile',
          title: '开场递送 · 关系参考',
          href: null,
          profileMemoryId: `primer:${decodeURIComponent(relationshipKey)}`,
        };
      }
    } catch {
      /* Malformed history does not acquire a profile target. */
    }
    return { kind: 'profile', titleStatus: 'unavailable', href: null };
  }
  return null;
}

/** Pure metadata projection: reuse canonical owner/revision readers, never the consumption/drill writer. */
async function readCueMetadata(
  cue: RecallCueCoordinate,
  scope: Omit<RecallScopeV1, 'invocationId'>,
  readCandidate: (anchor: string) => Promise<RecallCandidateView>,
  sourceReader?: MemoryCueSourceReader,
  profileMemoryStore?: RecallSourceReaders['profileMemoryStore'],
  ownerMessages: RecallOwnerMessageSources = {},
): Promise<RecallCandidateView> {
  const ownerProfile = readOwnerProfileView(cue, scope.ownerUserId, scope.threadId, profileMemoryStore);
  if (ownerProfile) return ownerProfile;
  const opening = openingProfileMetadata(cue);
  if (opening) return opening;
  const ownerMessage = await readOwnerMessageView(cue, scope, readCandidate, sourceReader, ownerMessages);
  if (ownerMessage) return ownerMessage;
  // A human-facing metadata read must not impersonate the producing cat to drill its private hypothesis.
  // Its delivery is already owner-readable in A1; retain that observation without opening the seed body.
  if (cue.resolver_family === 'cat_owned_seed') {
    return { kind: 'cat_owned_seed', href: null, title: '猫的私有种子（正文仅该猫可读）' };
  }
  // Evidence remains gated by the shared index's collection/world/kind filters.
  if (FAMILIES[cue.resolver_family] === 'evidence') {
    return readCandidate(cue.source_anchor);
  }
  const unavailable: RecallCandidateView = {
    kind: cue.resolver_family,
    href: null,
    titleStatus: 'unavailable',
  };
  if (!sourceReader) return unavailable;
  try {
    const read = await sourceReader.read({
      family: FAMILIES[cue.resolver_family],
      anchor: cue.source_anchor,
      expectedRevision: cue.source_revision,
      scope: { ...scope, invocationId: cue.invocation_id },
      consumerCatId: cue.consumer_cat_id,
    });
    if (read.status !== 'ok') return unavailable;
    const name = payloadTitle(cue.resolver_family, read.payload);
    const threadId = record(read.payload).threadId;
    const href =
      cue.resolver_family === 'thread_overview' &&
      typeof threadId === 'string' &&
      cue.source_anchor === `thread-overview:${threadId}`
        ? `/thread/${encodeURIComponent(threadId)}`
        : null;
    return { kind: cue.resolver_family, href, ...(name ? { title: name } : {}) };
  } catch {
    return unavailable;
  }
}

/** One owner/thread request. Cache only immutable source metadata, never the per-cue delivery coordinate. */
export function recallCueViewReader(
  scope: Omit<RecallScopeV1, 'invocationId'>,
  readCandidate: (anchor: string) => Promise<RecallCandidateView>,
  sourceReader?: MemoryCueSourceReader,
  profileMemoryStore?: RecallSourceReaders['profileMemoryStore'],
  ownerMessages: RecallOwnerMessageSources = {},
) {
  const cache = new Map<string, Promise<RecallCandidateView>>();
  return async (cue: RecallCueCoordinate): Promise<RecallSourceView> => {
    const key = JSON.stringify([cue.resolver_family, cue.source_anchor, cue.source_revision, cue.consumer_cat_id]);
    let pending = cache.get(key);
    if (!pending) {
      pending = readCueMetadata(cue, scope, readCandidate, sourceReader, profileMemoryStore, ownerMessages);
      cache.set(key, pending);
    }
    return {
      ...(await pending),
      anchor: cue.source_anchor,
      invocationId: cue.invocation_id,
      cueId: cue.cue_id,
      sourceRevision: cue.source_revision,
    };
  };
}
