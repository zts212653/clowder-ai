import type { BallCustodyEvent, BallEventKind, BallState } from '@cat-cafe/shared';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import { handedEventSourceId } from './ball-custody-events.js';
import {
  ballStateOf,
  type CodeField,
  codeOf,
  eventKindOf,
  identifierOf,
  payloadOf,
  timeOf,
} from './custody-event-field-guards.js';

export const CUSTODY_INSPECT_DEFAULT_LIMIT = 20;
export const CUSTODY_INSPECT_MAX_LIMIT = 50;

/**
 * One ledger event as the inspector reports it: identifiers, codes and times only. Nothing here can carry a
 * message body, a command or any free text, whatever the stored payload holds: every value is checked, not just
 * every key (see custody-event-field-guards.ts). A stored value that is not what its field must hold is withheld
 * and the field is named in `unrecognizedFields`, so "withheld" is never read as "absent" or defaulted.
 */
export interface InspectedCustodyEvent {
  readonly sequence: number;
  /** `unrecognized` when the stored kind is not one this reader knows (a newer writer, or a damaged record). */
  readonly kind: BallEventKind | 'unrecognized';
  /** `null` when the stored time is not a number. */
  readonly at: number | null;
  /** The cat the event is about (the holder at that moment), when it names one. */
  readonly catId?: string;
  readonly fromCatId?: string;
  readonly toCatId?: string;
  readonly invocationId?: string;
  readonly sourceMessageId?: string;
  readonly taskId?: string;
  readonly disposition?: string;
  /** Adoption is reported as a fact; its read evidence is not. */
  readonly adopted?: true;
  readonly retired?: true;
  readonly retiredReason?: string;
  /** Who wrote a dispatch terminal: the holder's own completion or a consumed coordination terminal. */
  readonly via?: string;
  /** Present fields whose stored value was withheld (not a code of this kind, not identifier-shaped). Names only. */
  readonly unrecognizedFields?: readonly string[];
}

export type InspectedProjection =
  | {
      readonly status: 'ok';
      readonly state: BallState;
      readonly holderCatId: string | null;
      readonly lastStateChangeAt: number;
      readonly lastRejectedEvent: {
        readonly kind: BallEventKind;
        readonly sequence: number | null;
        readonly at: number;
      } | null;
    }
  /** No projection has been written for this subject. It is not an `ok` with invented values. */
  | { readonly status: 'not_found' }
  /** The store failed, or the stored projection holds a value that is not a state / holder / time / kind. */
  | { readonly status: 'unavailable'; readonly reason: 'projection_read_failed' | 'projection_malformed' };

export type CustodyEventInspection =
  | {
      readonly status: 'ok';
      readonly threadId: string;
      readonly sourceMessageId: string;
      readonly limit: number;
      /** False means no event in this thread's ledger references the source. It is not an error. */
      readonly found: boolean;
      readonly anchorSequence?: number;
      readonly events: readonly InspectedCustodyEvent[];
      /** More events follow the last one returned. */
      readonly truncated: boolean;
      readonly subjectEventCount: number;
      readonly projection: InspectedProjection;
    }
  /** The ledger could not be read. Never an empty list standing in for "nothing happened". */
  | { readonly status: 'unavailable'; readonly reason: 'event_log_read_failed' };

export interface CustodyEventInspectorDeps {
  readonly ballCustodyEventLog: Pick<IBallCustodyEventLog, 'read'>;
  readonly ballCustodyProjectionStore: Pick<IBallCustodyProjectionStore, 'get'>;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** An event is about a source message when its payload names it, or it is the handoff of that very message. */
function referencesMessage(event: BallCustodyEvent, sourceMessageId: string): boolean {
  const payload = payloadOf(event);
  if (payload.sourceMessageId === sourceMessageId) return true;
  const toCatId = stringField(payload, 'toCatId');
  return (
    event.kind === 'ball.handed' &&
    toCatId !== undefined &&
    event.sourceEventId === handedEventSourceId(sourceMessageId, toCatId)
  );
}

const IDENTIFIER_FIELDS = ['catId', 'fromCatId', 'toCatId', 'invocationId', 'sourceMessageId', 'taskId'] as const;
const CODE_FIELDS: readonly CodeField[] = ['disposition', 'retiredReason', 'via'];

function inspectedEvent(event: BallCustodyEvent, sequence: number): InspectedCustodyEvent {
  const payload = payloadOf(event);
  const kind = eventKindOf(event.kind);
  const accepted: Record<string, string | true> = {};
  const withheld: string[] = [];
  const take = (field: string, stored: unknown, value: string | true | undefined) => {
    if (stored === undefined || stored === null) return;
    if (value === undefined) withheld.push(field);
    else accepted[field] = value;
  };

  for (const field of IDENTIFIER_FIELDS) take(field, payload[field], identifierOf(payload[field]));
  for (const field of CODE_FIELDS) take(field, payload[field], codeOf(kind, field, payload[field]));
  // Adoption and retirement are reported as facts; the read evidence behind adoption is not.
  take('adopted', payload.adopted, typeof payload.adopted === 'object' ? true : undefined);
  if (payload.retired !== false) take('retired', payload.retired, payload.retired === true ? true : undefined);

  return {
    sequence,
    kind: kind ?? 'unrecognized',
    at: timeOf(event.at),
    ...accepted,
    ...(withheld.length > 0 ? { unrecognizedFields: withheld.sort() } : {}),
  };
}

/**
 * Read-only view of the ball ledger for one thread. The thread is always the caller's own: it is an argument of
 * the method, supplied by the route from the authenticated invocation, and no request parameter reaches it.
 */
export class CustodyEventInspector {
  constructor(private readonly deps: CustodyEventInspectorDeps) {}

  async inspect(input: { threadId: string; sourceMessageId: string; limit?: number }): Promise<CustodyEventInspection> {
    const limit = input.limit ?? CUSTODY_INSPECT_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > CUSTODY_INSPECT_MAX_LIMIT) {
      throw new RangeError(`limit must be an integer from 1 to ${CUSTODY_INSPECT_MAX_LIMIT}`);
    }
    const subjectKey = `ball:thread:${input.threadId}`;

    let events: readonly BallCustodyEvent[];
    try {
      events = await this.deps.ballCustodyEventLog.read(subjectKey);
    } catch {
      return { status: 'unavailable', reason: 'event_log_read_failed' };
    }

    const projection = await this.readProjection(subjectKey, events);
    const anchor = events.findIndex((event) => referencesMessage(event, input.sourceMessageId));
    const base = {
      status: 'ok' as const,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      limit,
      subjectEventCount: events.length,
      projection,
    };
    if (anchor < 0) return { ...base, found: false, events: [], truncated: false };

    const window = events.slice(anchor, anchor + limit);
    return {
      ...base,
      found: true,
      anchorSequence: anchor,
      events: window.map((event, index) => inspectedEvent(event, anchor + index)),
      truncated: anchor + limit < events.length,
    };
  }

  private async readProjection(subjectKey: string, events: readonly BallCustodyEvent[]): Promise<InspectedProjection> {
    let projection: Awaited<ReturnType<IBallCustodyProjectionStore['get']>>;
    try {
      projection = await this.deps.ballCustodyProjectionStore.get(subjectKey);
    } catch {
      return { status: 'unavailable', reason: 'projection_read_failed' };
    }
    if (!projection) return { status: 'not_found' };

    const state = ballStateOf(projection.state);
    const holderCatId = projection.holder === null ? null : identifierOf(projection.holder);
    const lastStateChangeAt = timeOf(projection.lastStateChangeAt);
    const rejected = projection.lastRejectedEvent;
    const rejectedKind = rejected ? eventKindOf(rejected.kind) : undefined;
    const rejectedAt = rejected ? timeOf(rejected.at) : null;
    const rejectedUsable = !rejected || (rejectedKind !== undefined && rejectedAt !== null);
    if (!state || holderCatId === undefined || lastStateChangeAt === null || !rejectedUsable) {
      return { status: 'unavailable', reason: 'projection_malformed' };
    }

    const sequence = rejected ? events.findIndex((event) => event.sourceEventId === rejected.sourceEventId) : -1;
    return {
      status: 'ok',
      state,
      holderCatId,
      lastStateChangeAt,
      lastRejectedEvent:
        rejected && rejectedKind && rejectedAt !== null
          ? { kind: rejectedKind, sequence: sequence < 0 ? null : sequence, at: rejectedAt }
          : null,
    };
  }
}
