import type { F255PendingCueReceipt, F255PendingCueSink } from '../auto-dream/private-seed-contract.js';
import { formatEventsChat } from '../cats/services/session/TranscriptFormatter.js';
import type { TranscriptEvent, TranscriptReader } from '../cats/services/session/TranscriptReader.js';
import {
  buildReflectionSourceKey,
  isEarlierReflectionSource,
  type MemoryReflectionStore,
} from './MemoryReflectionStore.js';
import { DEFAULT_REFLECTION_CANDIDATE_BUDGET, extractReflectionDeltas } from './reflection-extractor.js';
import type {
  ExtractedReflectionDelta,
  ReflectionOutputRecord,
  ReflectionTranscriptEntry,
} from './reflection-types.js';

export interface ReflectionSessionSource {
  sessionId: string;
  ownerUserId: string;
  catId: string;
  threadId: string;
  sealReason: string;
}

export type SessionReflectionSealEvent = ReflectionSessionSource;

export interface SessionReflectionProducerDeps {
  transcriptReader: {
    readAllEvents(
      sessionId: string,
      threadId: string,
      catId: string,
      signal?: AbortSignal,
    ): ReturnType<TranscriptReader['readAllEvents']>;
  };
  reflectionStore: MemoryReflectionStore;
  cueSink?: F255PendingCueSink;
  now?: () => number;
  getHouseholdTimeZone?: () => string | undefined;
  budget?: number;
}

export interface SessionReflectionRunResult {
  householdLocalDate: string;
  extracted: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  cuesDelivered: number;
  outputs: ReflectionOutputRecord[];
}

export interface SessionReflectionBatchOptions {
  sourceLocalDate?: string;
  signal?: AbortSignal;
}

export class SessionReflectionProducer {
  private readonly now: () => number;
  private readonly budget: number;

  constructor(private readonly deps: SessionReflectionProducerDeps) {
    this.now = deps.now ?? Date.now;
    this.budget = deps.budget ?? DEFAULT_REFLECTION_CANDIDATE_BUDGET;
  }

  async onSessionSealed(event: SessionReflectionSealEvent): Promise<SessionReflectionRunResult> {
    return this.reflectSessions([event]);
  }

  async reflectSessions(
    events: readonly ReflectionSessionSource[],
    options: SessionReflectionBatchOptions = {},
  ): Promise<SessionReflectionRunResult> {
    const scope = validateBatchScope(events);
    const nowMs = this.now();
    const createdAt = new Date(nowMs).toISOString();
    const timeZone = this.deps.getHouseholdTimeZone?.();
    const householdLocalDate = householdDateKey(nowMs, timeZone);
    const extractedBySession: ExtractedReflectionDelta[][] = [];
    for (const event of events) {
      throwIfAborted(options.signal);
      const transcriptEvents = await this.deps.transcriptReader.readAllEvents(
        event.sessionId,
        event.threadId,
        event.catId,
        options.signal,
      );
      throwIfAborted(options.signal);
      const sourceEvents = options.sourceLocalDate
        ? transcriptEvents.filter(
            (transcriptEvent) => householdDateKey(transcriptEvent.t, timeZone) === options.sourceLocalDate,
          )
        : transcriptEvents;
      extractedBySession.push(
        extractReflectionDeltas({
          catId: event.catId,
          entries: toReflectionEntries(sourceEvents, event),
        }),
      );
    }
    const extracted = extractedBySession.flat();
    const outputs = mergeReflectionDeltas(extracted);
    throwIfAborted(options.signal);
    const accepted = await this.deps.reflectionStore.acceptBatch({
      ownerUserId: scope.ownerUserId,
      catId: scope.catId,
      householdLocalDate,
      createdAt,
      budget: this.budget,
      outputs,
      sourceEventTimes: indexSourceEventTimes(extracted),
    });
    throwIfAborted(options.signal);
    const cuesDelivered = await this.reconcilePendingCues(
      { ownerUserId: scope.ownerUserId, catId: scope.catId },
      createdAt,
      options.signal,
    );

    return {
      householdLocalDate,
      extracted: outputs.length,
      accepted: accepted.accepted.length,
      duplicates: accepted.duplicates.length,
      rejected: accepted.rejected.length,
      cuesDelivered,
      outputs: accepted.accepted,
    };
  }

  async reconcilePendingCues(
    scope: Pick<SessionReflectionSealEvent, 'ownerUserId' | 'catId'>,
    deliveredAt = new Date(this.now()).toISOString(),
    signal?: AbortSignal,
  ): Promise<number> {
    throwIfAborted(signal);
    if (!this.deps.cueSink) return 0;
    const pending = await this.deps.reflectionStore.listPendingCues(scope.ownerUserId, scope.catId);
    let delivered = 0;
    const failures: unknown[] = [];
    for (const output of pending) {
      throwIfAborted(signal);
      try {
        if (output.kind !== 'desire_cue')
          throw new Error(`non-desire output entered F255 cue outbox: ${output.outputId}`);
        const rawReceipt: unknown = await this.deps.cueSink.ingestPendingCue({
          outputId: output.outputId,
          ownerUserId: output.ownerUserId,
          catId: output.catId,
          kind: output.kind,
          normalizedClaim: output.normalizedClaim,
          reason: output.reason,
          sourceRef: toPrivateCueSourceRef(output.sourceRef),
          producer: output.producer,
          createdAt: output.createdAt,
        });
        const receipt = validateCueReceipt(rawReceipt);
        throwIfAborted(signal);
        await this.deps.reflectionStore.markCueDelivered(
          output.outputId,
          scope.ownerUserId,
          scope.catId,
          receipt.cueId,
          deliveredAt,
        );
        delivered += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
    return delivered;
  }
}

export function householdDateKey(epochMs: number, configuredTimeZone?: string): string {
  const timeZone = resolveHouseholdTimeZone(configuredTimeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(epochMs);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

export function previousHouseholdDateKey(epochMs: number, configuredTimeZone?: string): string {
  const current = householdDateKey(epochMs, configuredTimeZone);
  const [year, month, day] = current.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1, 12)).toISOString().slice(0, 10);
}

export function resolveHouseholdTimeZone(timeZone: string | undefined): string {
  if (!timeZone?.trim()) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function validateBatchScope(
  events: readonly ReflectionSessionSource[],
): Pick<ReflectionSessionSource, 'ownerUserId' | 'catId'> {
  const first = events[0];
  if (!first) throw new Error('at least one reflection session is required');
  for (const event of events) {
    if (event.ownerUserId !== first.ownerUserId || event.catId !== first.catId) {
      throw new Error('reflection batch must stay within one owner and cat scope');
    }
  }
  return { ownerUserId: first.ownerUserId, catId: first.catId };
}

function mergeReflectionDeltas(outputs: readonly ExtractedReflectionDelta[]): ExtractedReflectionDelta[] {
  const merged = new Map<string, ExtractedReflectionDelta>();
  for (const output of outputs) {
    const key = [output.destination, output.kind, output.normalizedClaim, output.targetCatId ?? ''].join('\0');
    const existing = merged.get(key);
    if (!existing || isEarlierReflectionSource(output.sourceRef, existing.sourceRef)) merged.set(key, output);
  }
  return [...merged.values()];
}

function indexSourceEventTimes(outputs: readonly ExtractedReflectionDelta[]): Record<string, number> {
  const eventTimes: Record<string, number> = {};
  for (const output of outputs) {
    const eventAt = output.sourceRef.eventAt;
    if (!Number.isFinite(eventAt)) continue;
    const key = buildReflectionSourceKey(output.sourceRef);
    const existing = eventTimes[key];
    if (existing !== undefined && existing !== eventAt) {
      throw new Error(`reflection source event time changed within one scan: ${key}`);
    }
    eventTimes[key] = eventAt as number;
  }
  return eventTimes;
}

function toReflectionEntries(
  events: TranscriptEvent[],
  seal: Pick<ReflectionSessionSource, 'threadId' | 'sessionId'>,
): ReflectionTranscriptEntry[] {
  const entries: ReflectionTranscriptEntry[] = [];
  for (const transcriptEvent of events) {
    const [message] = formatEventsChat([transcriptEvent]);
    if (!message || !isReflectionRole(message.role)) continue;
    entries.push({
      role: message.role,
      content: message.content,
      sourceRef: {
        threadId: seal.threadId,
        sessionId: seal.sessionId,
        eventNo: transcriptEvent.eventNo,
        ...(transcriptEvent.invocationId ? { invocationId: transcriptEvent.invocationId } : {}),
        eventAt: transcriptEvent.t,
      },
    });
  }
  return entries;
}

function isReflectionRole(role: string): role is ReflectionTranscriptEntry['role'] {
  return role === 'user' || role === 'assistant' || role === 'system';
}

function validateCueReceipt(value: unknown): F255PendingCueReceipt {
  if (typeof value !== 'object' || value == null) throw new Error('F255 cue sink returned an invalid receipt');
  const receipt = value as Record<string, unknown>;
  if ('ownedSeedId' in receipt || 'ownedSeed' in receipt || receipt.state === 'owned_seed') {
    throw new Error('F271 cue sink must not create or return an owned seed');
  }
  if (typeof receipt.cueId !== 'string' || !receipt.cueId.trim()) {
    throw new Error('F255 cue sink receipt must include cueId');
  }
  return { cueId: receipt.cueId };
}

function toPrivateCueSourceRef(source: ExtractedReflectionDelta['sourceRef']): {
  threadId: string;
  messageId?: string;
  sessionId?: string;
  eventNo?: number;
  invocationId?: string;
} {
  return {
    threadId: source.threadId,
    ...(source.messageId ? { messageId: source.messageId } : {}),
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    ...(source.eventNo != null ? { eventNo: source.eventNo } : {}),
    ...(source.invocationId ? { invocationId: source.invocationId } : {}),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
