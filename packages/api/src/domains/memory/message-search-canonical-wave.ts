import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore, Thread } from '../cats/services/stores/ports/ThreadStore.js';
import type { MessagePassageCandidate } from './message-passage-search-types.js';
import type { MessageSearchDiagnostics } from './message-search-diagnostics.js';

export interface CanonicalWaveSources {
  messages: ReadonlyMap<string, StoredMessage | null>;
  threads: ReadonlyMap<string, Thread | null>;
}

/** Transport coalescing only: fresh full objects, same <=8-source wave, no cross-wave cache.
 * Exact thread coordinates are already visibility-filtered, but these reads grant nothing.
 * Per-source owner/visibility/body/revision admission still runs after both reads finish. */
export async function readCanonicalSearchWave(
  candidates: readonly MessagePassageCandidate[],
  messageStore: Pick<IMessageStore, 'getById' | 'getByIds'>,
  threadStore: Pick<IThreadStore, 'get' | 'getMany'>,
  diagnostics?: MessageSearchDiagnostics,
): Promise<CanonicalWaveSources | undefined> {
  const getMessages = messageStore.getByIds?.bind(messageStore);
  const getThreads = threadStore.getMany?.bind(threadStore);
  if (!getMessages || !getThreads) return;
  if (candidates.length > 8) throw new Error('Canonical source wave exceeds its existing bound');
  const messageIds = [...new Set(candidates.map((row) => row.messageId))];
  const threadIds = [...new Set(candidates.map((row) => row.threadId))];
  if (!candidates.length) return { messages: new Map(), threads: new Map() };
  const readMessages = () => getMessages(messageIds);
  const readThreads = () => getThreads(threadIds, { recoverMissing: false });
  const [messages, threads] = await Promise.all([
    diagnostics ? diagnostics.measure('source', readMessages) : readMessages(),
    diagnostics ? diagnostics.measure('thread', readThreads) : readThreads(),
  ]);
  // An omitted reply is unavailable, never authoritative absence.
  for (const id of messageIds)
    if (!messages.has(id) || messages.get(id) === undefined) throw new Error('Canonical message batch incomplete');
  for (const id of threadIds)
    if (!threads.has(id) || threads.get(id) === undefined) throw new Error('Canonical thread batch incomplete');
  return { messages, threads };
}
