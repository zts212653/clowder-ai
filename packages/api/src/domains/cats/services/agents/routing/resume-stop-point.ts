/**
 * F332 / #1087 — “上次停点”: where this cat stopped in this thread.
 *
 * A canonical cold turn cannot prove the provider still holds working memory,
 * while ordinary own output is excluded from the unread delta to avoid replay.
 * When the user only says “接着做”, the cold packet therefore needs an exact
 * pointer back to the cat's own last terminal reply and that reply's sources.
 *
 * Authority stays with the original owners: the response message lifecycle
 * (targetId / status / inputMessageIds) is the record, and every coordinate
 * passes the same eligibility gate used for reply parents. The result is a
 * pointer, never a body, an instruction, or a claim about current work.
 */
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { isEligibleReplyParent, resolveVisibleReplyParent, type Viewer } from '../../stores/visibility.js';

export type ResumeStopPointStatus = 'completed' | 'failed' | 'canceled' | 'interrupted';

export interface ResumeStopPoint {
  readonly responseMessageId: string;
  readonly status: ResumeStopPointStatus;
  /** Lifecycle completion time (falls back to the message timestamp). */
  readonly at: number;
  /** Readable source coordinates, oldest first, at most MAX_LISTED_SOURCES. */
  readonly sourceMessageIds: readonly string[];
  /** Checked sources withheld because they are unreadable or internal-only. */
  readonly unreadableSourceCount: number;
}

export type ResumeStopPointLookup =
  | { readonly kind: 'found'; readonly stopPoint: ResumeStopPoint }
  /** The visible history was fully scanned and holds no terminal reply by this cat. */
  | { readonly kind: 'none' }
  /** No terminal reply within the bounded window; older history exists. */
  | { readonly kind: 'not_in_window'; readonly scannedCount: number }
  /** The record could not be read; callers must not infer it from recent speech. */
  | { readonly kind: 'unavailable' };

/**
 * Raw rows scanned backwards per cold turn. Always-cold carriers pay this on
 * every invocation, so the window stays small; beyond it the navigation says
 * “not within the last N” instead of guessing.
 */
export const RESUME_STOP_POINT_SCAN_LIMIT = 100;
/** Most recent lifecycle inputs checked for readability. */
const MAX_CHECKED_SOURCES = 6;
/** Readable inputs listed as coordinates. */
const MAX_LISTED_SOURCES = 3;

type ResponseLifecycle = Extract<NonNullable<StoredMessage['lifecycle']>, { kind: 'response' }>;
type TerminalResponseLifecycle = ResponseLifecycle & { readonly status: ResumeStopPointStatus };
type StopPointEligibility = { readonly threadId: string; readonly viewer: Viewer };

/** This cat's own finished reply that the viewer may still read; otherwise null. */
function terminalOwnResponse(
  message: StoredMessage,
  catId: string,
  eligibility: StopPointEligibility,
): TerminalResponseLifecycle | null {
  const lifecycle = message.lifecycle;
  if (lifecycle?.kind !== 'response' || lifecycle.targetId !== catId) return null;
  // The current invocation's own response is still processing; it is not a stop point.
  if (lifecycle.status === 'processing') return null;
  if (!isEligibleReplyParent(message, eligibility)) return null;
  return lifecycle as TerminalResponseLifecycle;
}

/** Gate each recent lifecycle input through the shared reply-parent resolver. */
async function readableSources(
  messageStore: Pick<IMessageStore, 'getById'>,
  inputMessageIds: readonly string[],
  eligibility: StopPointEligibility,
): Promise<{ readonly ids: readonly string[]; readonly withheld: number }> {
  const ids: string[] = [];
  let withheld = 0;
  for (const sourceId of inputMessageIds.slice(-MAX_CHECKED_SOURCES)) {
    const source = await resolveVisibleReplyParent(messageStore, sourceId, eligibility);
    if (source) ids.push(source.id);
    else withheld++;
  }
  return { ids: ids.slice(-MAX_LISTED_SOURCES), withheld };
}

export async function resolveResumeStopPoint(input: {
  readonly messageStore: Pick<IMessageStore, 'getByThreadBeforeBounded' | 'getById'>;
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly viewer: Viewer;
  readonly scanLimit?: number;
}): Promise<ResumeStopPointLookup> {
  const scanLimit = input.scanLimit ?? RESUME_STOP_POINT_SCAN_LIMIT;
  const eligibility: StopPointEligibility = { threadId: input.threadId, viewer: input.viewer };
  try {
    // Only lifecycle / identity / visibility / time are needed. The recipient
    // projection reads the thread's own timeline index in both stores (the
    // unprojected in-memory path windows the global log, so busy neighbouring
    // threads would evict a quiet thread's stop point) and, in Redis, HMGETs
    // MESSAGE_RECIPIENT_FIELDS instead of HGETALL: no content, contentBlocks,
    // thinking, metadata or toolEvents. `extra` and the dedicated authority
    // carriers stay whole serialized fields — that cost is the projection's.
    const page = await input.messageStore.getByThreadBeforeBounded(
      input.threadId,
      Number.MAX_SAFE_INTEGER,
      scanLimit,
      undefined,
      input.userId,
      scanLimit,
      { recipientProjection: true },
    );
    for (const message of [...page.messages].reverse()) {
      const lifecycle = terminalOwnResponse(message, input.catId, eligibility);
      if (!lifecycle) continue;
      const sources = await readableSources(input.messageStore, lifecycle.inputMessageIds, eligibility);
      return {
        kind: 'found',
        stopPoint: {
          responseMessageId: message.id,
          status: lifecycle.status,
          at: lifecycle.completedAt ?? message.timestamp,
          sourceMessageIds: sources.ids,
          unreadableSourceCount: sources.withheld,
        },
      };
    }
    return page.exhausted ? { kind: 'none' } : { kind: 'not_in_window', scannedCount: page.scannedCount };
  } catch {
    return { kind: 'unavailable' };
  }
}
