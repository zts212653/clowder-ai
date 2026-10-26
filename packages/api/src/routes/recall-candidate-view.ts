import { type PersonIdentity, type ProfileMemoryOwnerEntry, RECALL_DISPLAY_DOC_KINDS } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import type { MemoryCueSourceReader } from '../domains/memory/cue/MemoryCueSourceReader.js';
import { type RecallCueCoordinate, type RecallSourceView, recallCueViewReader } from './recall-cue-view.js';
import type { RecallOwnerMessageSources } from './recall-owner-message-view.js';

export interface RecallSourceReaders extends RecallOwnerMessageSources {
  cueSourceReader?: MemoryCueSourceReader;
  profileMemoryStore?: {
    get(
      ownerUserId: string,
      memoryId: string,
    ): Pick<ProfileMemoryOwnerEntry, 'id' | 'revision' | 'title' | 'status'> | null;
  };
  threadStore?: {
    get(
      id: string,
    ):
      | Pick<Thread, 'id' | 'createdBy' | 'title' | 'deletedAt'>
      | null
      | Promise<Pick<Thread, 'id' | 'createdBy' | 'title' | 'deletedAt'> | null>;
    list(userId: string): Array<{ id: string }> | Promise<Array<{ id: string }>>;
  };
  personMemoryStore?: {
    getPerson(
      ownerUserId: string,
      personId: string,
    ): Promise<Pick<PersonIdentity, 'ownerUserId' | 'displayName' | 'status'> | null>;
  };
}
export interface RecallCandidateView {
  profileMemoryId?: string;
  sourceUnavailableReason?: 'source_corrected' | 'source_forgotten' | 'scope_revoked';
  title?: string;
  titleStatus?: 'unavailable';
  kind?: string;
  href: string | null;
}

/** Display metadata only. Private names go through the existing owner-scoped reader. */
export function recallCandidateViewReader(db: Database.Database, userId: string, readers: RecallSourceReaders = {}) {
  const statement = db.prepare(`SELECT title, kind FROM evidence_docs WHERE anchor = ?
    AND collection_id IS NULL AND world_id IS NULL
    AND kind IN (${RECALL_DISPLAY_DOC_KINDS.map(() => '?').join(',')})`);
  const cache = new Map<string, Promise<RecallCandidateView>>();
  let visibleThreads: Promise<Set<string>> | undefined;
  const readThread = async (id: string): Promise<RecallCandidateView> => {
    const unavailable = { kind: 'thread', href: null };
    const thread = await readers.threadStore?.get(id);
    if (!thread || thread.deletedAt) return unavailable;
    if (!canAccessThread(thread, userId)) {
      if (thread.createdBy !== 'system' || !readers.threadStore) return unavailable;
      visibleThreads ??= Promise.resolve(readers.threadStore.list(userId)).then(
        (threads) => new Set(threads.map((item) => item.id)),
      );
      if (!(await visibleThreads).has(id)) return unavailable;
    }
    return {
      ...(thread.title?.trim() ? { title: thread.title.trim() } : {}),
      kind: 'thread',
      href: `/thread/${encodeURIComponent(id)}`,
    };
  };
  const readPerson = async (id: string): Promise<RecallCandidateView> => {
    const unavailable = { kind: 'person_entity', href: null };
    if (!/^person_[A-Za-z0-9_-]+$/.test(id)) return unavailable;
    const person = await readers.personMemoryStore?.getPerson(userId, id);
    if (!person || person.ownerUserId !== userId || person.status !== 'active') return unavailable;
    // Search results have no delivered-card revision or provenance; a current name alone is not a source link.
    return { title: person.displayName, kind: 'person_entity', href: null };
  };
  const resolve = async (anchor: string): Promise<RecallCandidateView> => {
    if (anchor.startsWith('thread-')) return readThread(anchor.slice(7));
    if (anchor.startsWith('person-memory:')) return readPerson(anchor.slice('person-memory:'.length));
    const doc = statement.get(anchor, ...RECALL_DISPLAY_DOC_KINDS) as { title: string; kind: string } | undefined;
    return doc?.title.trim() ? { ...doc, href: `/memory/search?q=${encodeURIComponent(anchor)}` } : { href: null };
  };
  return (anchor: string) => {
    let pending = cache.get(anchor);
    if (!pending) {
      pending = resolve(anchor).catch(() => ({
        href: null,
        titleStatus: 'unavailable' as const,
        ...(anchor.startsWith('thread-')
          ? { kind: 'thread' }
          : anchor.startsWith('person-memory:')
            ? { kind: 'person_entity' }
            : {}),
      }));
      cache.set(anchor, pending);
    }
    return pending;
  };
}

export async function readRecallSourceViews(
  db: Database.Database,
  userId: string,
  threadId: string,
  rows: Array<{ candidates_json: string | null }>,
  cueInvocationIds: string[],
  readers: RecallSourceReaders,
) {
  const anchors = new Set(
    rows.flatMap((row) =>
      (JSON.parse(row.candidates_json || '[]') as Array<{ anchor: string }>).map((item) => item.anchor),
    ),
  );
  const read = recallCandidateViewReader(db, userId, readers);
  const views: RecallSourceView[] = [];
  const unique = [...anchors];
  for (let offset = 0; offset < unique.length; offset += 4) {
    views.push(
      ...(await Promise.all(
        unique.slice(offset, offset + 4).map(async (anchor) => ({ anchor, ...(await read(anchor)) })),
      )),
    );
  }
  if (cueInvocationIds.length) {
    const cues = db
      .prepare(`SELECT invocation_id, cue_id, resolver_family, source_anchor,
      source_revision, consumer_cat_id FROM memory_cue_events
      WHERE owner_user_id = ? AND thread_id = ? AND invocation_id IN (${cueInvocationIds.map(() => '?').join(',')})
      GROUP BY invocation_id, cue_id, resolver_family, source_anchor, source_revision, consumer_cat_id
      ORDER BY MAX(occurred_at) DESC, invocation_id DESC, cue_id DESC LIMIT 200`)
      .all(userId, threadId, ...cueInvocationIds) as RecallCueCoordinate[];
    const readCue = recallCueViewReader(
      { ownerUserId: userId, threadId },
      read,
      readers.cueSourceReader,
      readers.profileMemoryStore,
      readers,
    );
    for (let offset = 0; offset < cues.length; offset += 4) {
      views.push(...(await Promise.all(cues.slice(offset, offset + 4).map(readCue))));
    }
  }
  return views;
}
