import type { MessageSearchResult } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore, Thread } from '../cats/services/stores/ports/ThreadStore.js';
import type { MessageSearchPrincipal } from './MessageSearchService.js';
import type { CanonicalSearchCandidate } from './message-discovery-source.js';
import type { MessagePassageCandidate } from './message-passage-search-types.js';
import { type CanonicalWaveSources, readCanonicalSearchWave } from './message-search-canonical-wave.js';
import { buildSearchableMessageContent } from './message-search-content.js';
import { checkSearchExecution, type MessageSearchExecutionContext } from './message-search-lifetime.js';
import type { SelectedSourceReader } from './message-selected-quote.js';
import type { SelectedSourceReadFence, SelectedSourceReference } from './message-selected-read-fence.js';

export interface SelectedSourceSnapshot {
  wave: CanonicalWaveSources;
  authority: Pick<IThreadStore, 'list'>;
  visible: Thread[];
}

function snapshot(wave: CanonicalWaveSources, visible: Thread[]): SelectedSourceSnapshot {
  return {
    wave: {
      messages: new Map([...wave.messages].map(([id, row]) => [id, row ? structuredClone(row) : null])),
      threads: new Map([...wave.threads].map(([id, row]) => [id, row ? structuredClone(row) : null])),
    },
    authority: { list: () => visible },
    visible,
  };
}

function immediate<T>(value: T | Promise<T>): T | undefined {
  if (value && typeof value === 'object' && 'then' in value) {
    void Promise.resolve(value).catch(() => undefined);
    return undefined;
  }
  return value as T;
}

/** Pure synchronous ports have one event-loop read point. Async ports require
 * an explicit storage fence; Promise.all and batch method names prove nothing. */
function synchronousSnapshot(
  refs: SelectedSourceReference[],
  userId: string,
  messages: Pick<IMessageStore, 'getById'>,
  threads: Pick<IThreadStore, 'get' | 'list'>,
): SelectedSourceSnapshot | null {
  const rows = new Map<string, StoredMessage | null>();
  const parents = new Map<string, Thread | null>();
  for (const ref of refs) {
    const message = immediate(messages.getById(ref.messageId));
    const thread = immediate(threads.get(ref.threadId));
    if (message === undefined || thread === undefined) return null;
    rows.set(ref.messageId, message);
    parents.set(ref.threadId, thread);
  }
  const visible = immediate(threads.list(userId));
  return visible ? snapshot({ messages: rows, threads: parents }, structuredClone(visible)) : null;
}

async function asynchronousSnapshot(
  refs: SelectedSourceReference[],
  userId: string,
  messages: Pick<IMessageStore, 'getById' | 'getByIds'>,
  threads: Pick<IThreadStore, 'get' | 'getMany' | 'list'>,
  lifetime: MessageSearchExecutionContext,
): Promise<SelectedSourceSnapshot> {
  const messageRows = new Map<string, StoredMessage | null>();
  const threadRows = new Map<string, Thread | null>();
  for (let offset = 0; offset < refs.length; offset += 8) {
    checkSearchExecution(lifetime);
    const waveRefs = refs.slice(offset, offset + 8);
    const candidates: MessagePassageCandidate[] = waveRefs.map((ref) => ({
      ...ref,
      docAnchor: `thread-${ref.threadId}`,
      passageId: `msg-${ref.messageId}`,
      match: 'lexical',
      content: '',
    }));
    const batched = await readCanonicalSearchWave(candidates, messages, threads);
    checkSearchExecution(lifetime);
    const wave = batched ?? {
      messages: new Map(
        await Promise.all(waveRefs.map(async (ref) => [ref.messageId, await messages.getById(ref.messageId)] as const)),
      ),
      threads: new Map(
        await Promise.all(waveRefs.map(async (ref) => [ref.threadId, await threads.get(ref.threadId)] as const)),
      ),
    };
    for (const [id, row] of wave.messages) messageRows.set(id, row);
    for (const [id, row] of wave.threads) threadRows.set(id, row);
  }
  checkSearchExecution(lifetime);
  const visible = await threads.list(userId);
  checkSearchExecution(lifetime);
  return snapshot({ messages: messageRows, threads: threadRows }, structuredClone(visible));
}

/** The fence covers the entire consumer, including ledger and final source auth.
 * The existing projection alone decides access; SQLite index-current is separate. */
export async function withSelectedSourceSnapshot<T>(
  results: MessageSearchResult[],
  principal: MessageSearchPrincipal,
  messages: Pick<IMessageStore, 'getById' | 'getByIds'>,
  threads: Pick<IThreadStore, 'get' | 'getMany' | 'list'>,
  read: (snapshot: SelectedSourceSnapshot) => Promise<T>,
  lifetime: MessageSearchExecutionContext,
  fence?: SelectedSourceReadFence,
  additionalReferences: readonly SelectedSourceReference[] = [],
): Promise<T | null> {
  checkSearchExecution(lifetime);
  const coordinates: SelectedSourceReference[] = results.flatMap((row) => [
    row,
    ...(row.selection?.quotation?.origin ? [row.selection.quotation.origin] : []),
  ]);
  if (principal.source) coordinates.push(principal.source);
  coordinates.push(...additionalReferences);
  const refs = [
    ...new Map(
      coordinates.map((ref) => [
        JSON.stringify([ref.threadId, ref.messageId]),
        { threadId: ref.threadId, messageId: ref.messageId },
      ]),
    ).values(),
  ];
  if (fence)
    return fence(
      refs,
      principal.userId,
      async () => read(await asynchronousSnapshot(refs, principal.userId, messages, threads, lifetime)),
      lifetime,
    );
  const before = synchronousSnapshot(refs, principal.userId, messages, threads);
  if (!before) return null;
  const value = await read(before);
  checkSearchExecution(lifetime);
  const after = synchronousSnapshot(refs, principal.userId, messages, threads);
  if (!after) return null;
  const state = (s: SelectedSourceSnapshot) => JSON.stringify([[...s.wave.messages], [...s.wave.threads], s.visible]);
  return state(before) === state(after) ? value : null;
}

/** Assemble a stable read; permission and index-current authority stay in the service's existing projection. */
export function createSelectedSourceReader(
  principal: MessageSearchPrincipal,
  ops: {
    readable: (
      ref: { threadId: string; messageId: string },
      messages?: CanonicalWaveSources['messages'],
    ) => Promise<StoredMessage | null>;
    thread: (id: string) => Promise<Thread | null>;
    project: (
      candidate: MessagePassageCandidate,
      wave: CanonicalWaveSources,
      authority?: Pick<IThreadStore, 'list'>,
    ) => Promise<CanonicalSearchCandidate | null>;
  },
  snapshot?: SelectedSourceSnapshot,
): SelectedSourceReader {
  return async (ref) => {
    if (principal.source?.threadId === ref.threadId && principal.source.messageId === ref.messageId) return null;
    const live = await ops.readable(ref, snapshot?.wave.messages);
    if (!live) return null;
    const message = structuredClone(live);
    const liveThread = snapshot ? snapshot.wave.threads.get(ref.threadId) : await ops.thread(ref.threadId);
    if (!liveThread) return null;
    const thread = structuredClone(liveThread);
    const candidate: MessagePassageCandidate = {
      ...ref,
      docAnchor: `thread-${ref.threadId}`,
      passageId: `msg-${ref.messageId}`,
      match: 'lexical',
      content: buildSearchableMessageContent({
        content: message.content,
        contentBlocks: message.contentBlocks,
        richBlocks: message.extra?.rich?.blocks,
      }),
    };
    const projected = await ops.project(
      candidate,
      {
        messages: new Map([[message.id, message]]),
        threads: new Map([[thread.id, thread]]),
      },
      snapshot?.authority,
    );
    return projected ? { message, result: projected.result } : null;
  };
}
