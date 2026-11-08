/**
 * What every response still streaming in this process has already broadcast (PR-3a2, contract §3.11.1).
 *
 * A page that joins a thread room mid-reply missed the events broadcast before its join, and the
 * History draft cannot fill that gap: drafts are throttled and share no coordinate with live events.
 * So the event stream of each open response R is kept here, appended in the same synchronous step
 * that broadcasts it, and handed to a joining connection before its join is acknowledged. Taking the
 * record and emitting it happen with no await in between, so the replay holds exactly the events
 * broadcast before it and every later broadcast reaches that connection after it.
 *
 * A record opens when R is admitted (before its route produces anything) and closes at R's terminal
 * commit or deletion. It proves only what this process broadcast since admission: a response this
 * process never admitted (one still running across a restart) has no record and is not complete.
 *
 * Memory is not bounded by truncation. Adjacent text deltas are joined, so a record is about the
 * reply body itself plus a small envelope per tool or block event — the same order as the route's
 * own accumulated text. The ceiling only stops a runaway stream; a response that hits it is marked
 * incomplete rather than replayed in part.
 */
import { isDeepStrictEqual } from 'node:util';
import type { StoredMessage } from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { AgentMessage } from '../../domains/cats/services/types.js';

/** Event types that write into a response's body on the page. Status, done and error do not. */
const RECORDED_TYPES = new Set<AgentMessage['type']>(['text', 'tool_use', 'tool_result', 'system_info']);

/** Hard ceiling per response; a normal reply never reaches it. */
export const RESPONSE_STREAM_RECORD_MAX_BYTES = 32 * 1024 * 1024;

/** Fields that may differ between two text deltas that are joined into one. */
const JOINABLE_TEXT_FIELDS = new Set(['content', 'timestamp', 'seq', 'seqEpoch']);
/** A replacing snapshot also supersedes an adjacent append. */
const SUPERSEDED_TEXT_FIELDS = new Set([...JOINABLE_TEXT_FIELDS, 'textMode']);

export interface ResponseStreamEntry {
  /** The response as admitted; its owner and visibility decide who may receive the replay. */
  readonly response: StoredMessage;
  /** Broadcast events in order, without transport sequence fields. Empty when incomplete. */
  readonly events: readonly AgentMessage[];
  /** False when this process cannot vouch for every event (the ceiling stopped the record). */
  readonly complete: boolean;
  /** How many broadcasts the record holds: the `streamIndex` the next live event will carry. */
  readonly nextIndex: number;
}

interface OpenRecord {
  response: StoredMessage;
  events: AgentMessage[];
  bytes: number;
  complete: boolean;
  /** Broadcasts recorded so far (joined text deltas still count one each). */
  broadcasts: number;
}

export interface ResponseStreamRecordsOptions {
  readonly maxBytes?: number;
  readonly onCeilingExceeded?: (info: { messageId: string; threadId: string; bytes: number }) => void;
}

function withoutTransportFields(message: AgentMessage): AgentMessage {
  const { seq: _seq, seqEpoch: _seqEpoch, streamIndex: _streamIndex, ...event } = message;
  return event;
}

function isAppendText(event: AgentMessage): boolean {
  return event.type === 'text' && (event.textMode ?? 'append') === 'append';
}

function sameExcept(a: AgentMessage, b: AgentMessage, ignored: ReadonlySet<string>): boolean {
  const strip = (event: AgentMessage) =>
    Object.fromEntries(Object.entries(event).filter(([key, value]) => !ignored.has(key) && value !== undefined));
  return isDeepStrictEqual(strip(a), strip(b));
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

export class ResponseStreamRecords {
  private readonly records = new Map<string, OpenRecord>();
  private readonly maxBytes: number;
  private readonly onCeilingExceeded: ResponseStreamRecordsOptions['onCeilingExceeded'];

  constructor(options: ResponseStreamRecordsOptions = {}) {
    this.maxBytes = options.maxBytes ?? RESPONSE_STREAM_RECORD_MAX_BYTES;
    this.onCeilingExceeded = options.onCeilingExceeded;
  }

  /** R was admitted. Admitting the same R again (retry, read-back) keeps what is already recorded. */
  open(response: StoredMessage): void {
    if (this.records.has(response.id)) return;
    this.records.set(response.id, { response, events: [], bytes: 0, complete: true, broadcasts: 0 });
  }

  /** R reached its terminal commit or was deleted: no later join replays it. */
  close(messageId: string): void {
    this.records.delete(messageId);
  }

  /**
   * Called with every broadcast; keeps the events that name an open response's body. Returns the
   * event's position in the response's stream (0 for its first broadcast since admission), or
   * undefined when no complete record holds it. A page that holds positions 0..n-1 holds the prefix.
   */
  record(message: AgentMessage, threadId: string): number | undefined {
    if (!message.messageId || !RECORDED_TYPES.has(message.type)) return undefined;
    if (message.type === 'text' && message.origin === 'callback') return undefined;
    const open = this.records.get(message.messageId);
    if (!open || !open.complete || open.response.threadId !== threadId) return undefined;

    const event = withoutTransportFields(message);
    if (!this.joinAdjacentText(open, event)) {
      open.events.push(event);
      this.grow(open, sizeOf(event));
    }
    if (!open.complete) return undefined;
    const index = open.broadcasts;
    open.broadcasts += 1;
    return index;
  }

  /**
   * Fold a text event into the adjacent text event when the page would show the same result.
   * The earlier timestamp stays: the first body event is what creates the record on a page.
   */
  private joinAdjacentText(open: OpenRecord, event: AgentMessage): boolean {
    const previous = open.events.at(-1);
    if (previous?.type !== 'text' || event.type !== 'text') return false;
    if (isAppendText(event) && isAppendText(previous) && sameExcept(previous, event, JOINABLE_TEXT_FIELDS)) {
      const content = event.content ?? '';
      open.events[open.events.length - 1] = { ...previous, content: (previous.content ?? '') + content };
      this.grow(open, Buffer.byteLength(content));
      return true;
    }
    if (event.textMode === 'replace' && sameExcept(previous, event, SUPERSEDED_TEXT_FIELDS)) {
      // A replacing snapshot sets the whole body; the adjacent text it replaces no longer shows.
      const replacing = { ...event, timestamp: previous.timestamp };
      open.events[open.events.length - 1] = replacing;
      this.grow(open, sizeOf(replacing) - sizeOf(previous));
      return true;
    }
    return false;
  }

  /** The open responses of one thread, in admission order. */
  forThread(threadId: string): ResponseStreamEntry[] {
    const entries: ResponseStreamEntry[] = [];
    for (const open of this.records.values()) {
      if (open.response.threadId !== threadId) continue;
      entries.push({
        response: open.response,
        events: [...open.events],
        complete: open.complete,
        nextIndex: open.broadcasts,
      });
    }
    return entries;
  }

  private grow(open: OpenRecord, bytes: number): void {
    open.bytes += bytes;
    if (open.bytes <= this.maxBytes) return;
    open.complete = false;
    open.events = [];
    this.onCeilingExceeded?.({ messageId: open.response.id, threadId: open.response.threadId, bytes: open.bytes });
  }
}
