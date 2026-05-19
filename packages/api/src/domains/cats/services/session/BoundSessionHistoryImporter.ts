import type { CatId, SessionRecord } from '@cat-cafe/shared';
import type { AppendMessageInput, IMessageStore } from '../stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../stores/ports/SessionChainStore.js';
import type { TranscriptEvent, TranscriptReader } from './TranscriptReader.js';

export interface HistoryImportResult {
  status: 'ok' | 'skipped' | 'failed';
  importedCount: number;
  reason?:
    | 'history_import_unavailable'
    | 'no_transcript_found'
    | 'no_importable_messages'
    | 'no_new_messages'
    | 'import_failed';
}

interface BackfillBoundSessionHistoryOptions {
  sessionChainStore?: ISessionChainStore | undefined;
  transcriptReader?: TranscriptReader | undefined;
  messageStore?: IMessageStore | undefined;
  threadId: string;
  catId: CatId;
  userId: string;
}

const IMPORTABLE_TYPES = new Set(['assistant', 'text', 'user']);

export async function backfillBoundSessionHistory(
  opts: BackfillBoundSessionHistoryOptions,
): Promise<HistoryImportResult> {
  const { sessionChainStore, transcriptReader, messageStore, threadId, catId, userId } = opts;

  if (!sessionChainStore || !transcriptReader || !messageStore) {
    return {
      status: 'skipped',
      importedCount: 0,
      reason: 'history_import_unavailable',
    };
  }

  try {
    const chain = await sessionChainStore.getChain(catId, threadId);
    const sealedSessions = chain.filter((session) => session.status === 'sealed');
    const countMessages = async (): Promise<number> => (await messageStore.getByThread(threadId, 10000)).length;

    let foundTranscript = false;
    let sawImportableMessage = false;
    const beforeCount = await countMessages();

    for (const session of sealedSessions) {
      const hasTranscript = await transcriptReader.hasTranscript(session.id, threadId, session.catId);
      if (!hasTranscript) continue;
      foundTranscript = true;

      const events = await transcriptReader.readAllEvents(session.id, threadId, session.catId);
      for (const evt of events) {
        const appendInput = mapTranscriptEventToMessage(evt, session, userId);
        if (!appendInput) continue;
        sawImportableMessage = true;
        // V1 dedup scope: only transcript-event idempotency.
        // If the same logical content already entered messageStore via a different
        // path (for example, live streaming), we intentionally do not attempt
        // content-level dedup in this first slice.
        await messageStore.append(appendInput);
      }
    }

    const importedCount = Math.max(0, (await countMessages()) - beforeCount);

    if (!foundTranscript) {
      return { status: 'skipped', importedCount: 0, reason: 'no_transcript_found' };
    }
    if (!sawImportableMessage) {
      return { status: 'skipped', importedCount: 0, reason: 'no_importable_messages' };
    }
    if (importedCount === 0) {
      return { status: 'skipped', importedCount: 0, reason: 'no_new_messages' };
    }
    return { status: 'ok', importedCount };
  } catch {
    return { status: 'failed', importedCount: 0, reason: 'import_failed' };
  }
}

function mapTranscriptEventToMessage(
  evt: TranscriptEvent,
  session: SessionRecord,
  userId: string,
): AppendMessageInput | null {
  const evtType = typeof evt.event.type === 'string' ? evt.event.type : undefined;
  if (!evtType || !IMPORTABLE_TYPES.has(evtType)) return null;

  const content = extractTextContent(evt.event);
  if (!content) return null;

  const base: AppendMessageInput = {
    userId,
    threadId: session.threadId,
    catId: evtType === 'user' ? null : session.catId,
    content,
    mentions: [],
    timestamp: evt.t,
    idempotencyKey: `history-import:${session.id}:${evt.eventNo}`,
  };

  if (evtType !== 'user' && evt.invocationId) {
    // F194 Phase Z9 AC-Z25 (KD-28): always stamp turnInvocationId for assistant
    // raw records. History imports have only one identity (evt.invocationId), so
    // both parent and turn point to it — but stamping turn explicitly keeps the
    // frontend bubble identity contract (turn-priority) consistent.
    return {
      ...base,
      extra: {
        stream: { invocationId: evt.invocationId, turnInvocationId: evt.invocationId },
      },
    };
  }

  return base;
}

function extractTextContent(event: Record<string, unknown>): string | undefined {
  const content = event.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const type = (item as Record<string, unknown>).type;
    const text = (item as Record<string, unknown>).text;
    if (type === 'text' && typeof text === 'string' && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export const __test__ = {
  mapTranscriptEventToMessage,
  extractTextContent,
};
