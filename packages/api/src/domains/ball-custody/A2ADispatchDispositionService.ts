import { type BallCustodyEvent, isCrossThreadProvenance } from '@cat-cafe/shared';
import type { InvocationRecord } from '../cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import {
  type A2ADispatchHandoffInspection,
  type A2ADispatchHandoffSource,
  type A2ADispatchReplacement,
  resolveA2ADispatchHandoff,
} from './A2ADispatchReplacementResolver.js';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyFencedIngest } from './BallCustodyIngest.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import {
  type A2ADispatchDisposition,
  buildDispatchDispositionEvent,
  dispatchDispositionEventSourceId,
  handedEventSourceId,
} from './ball-custody-events.js';

export interface A2ADispatchDispositionResult {
  readonly outcome: 'applied' | 'replayed';
  readonly disposition: A2ADispatchDisposition;
  readonly invocationId: string;
  readonly sourceMessageId: string;
  readonly fromCatId: string;
  /** The exact dispatch ended without advancing an unrelated thread-level holder. */
  readonly retired: boolean;
}

export type { A2ADispatchHandoffInspection, A2ADispatchReplacement } from './A2ADispatchReplacementResolver.js';

export class A2ADispatchDispositionError extends Error {
  constructor(
    readonly code: string,
    readonly replacement?: A2ADispatchReplacement,
  ) {
    super(code);
    this.name = 'A2ADispatchDispositionError';
  }
}

interface A2ADispatchDispositionDeps {
  readonly registry: { isLatest(invocationId: string): Promise<boolean> };
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly ballCustodyEventLog: Pick<IBallCustodyEventLog, 'read'>;
  readonly ballCustodyProjectionStore: Pick<IBallCustodyProjectionStore, 'get'>;
  readonly ballCustody: IBallCustodyFencedIngest;
  readonly log?: { warn(obj: unknown, msg?: string): void };
  readonly repairProjection?: (subjectKey: string) => Promise<void>;
  readonly now?: () => number;
}

type A2ADispatchDispositionAuth = Pick<
  InvocationRecord,
  'invocationId' | 'catId' | 'threadId' | 'a2aTriggerMessageId' | 'originTriggerMessageId'
>;

type DispatchSource = A2ADispatchHandoffSource;

/** Invocation-bound terminal producer for one exact ordinary A2A dispatch. */
export class A2ADispatchDispositionService {
  private readonly now: () => number;

  constructor(private readonly deps: A2ADispatchDispositionDeps) {
    this.now = deps.now ?? Date.now;
  }

  async complete(
    auth: A2ADispatchDispositionAuth,
    disposition: A2ADispatchDisposition,
  ): Promise<A2ADispatchDispositionResult> {
    await this.assertLatestInvocation(auth.invocationId);
    const source = await this.resolveSource(auth);
    const subjectKey = `ball:thread:${auth.threadId}`;
    const events = await this.deps.ballCustodyEventLog.read(subjectKey);
    const eventSourceId = dispatchDispositionEventSourceId({
      invocationId: auth.invocationId,
      sourceMessageId: source.sourceMessageId,
    });
    const prior = events.find((event) => event.sourceEventId === eventSourceId);
    if (prior) {
      this.assertMatchingDispositionEvent(prior, auth, source, disposition);
      await this.repairProjectionIfNeeded(subjectKey, events, prior);
      return {
        outcome: 'replayed',
        disposition,
        invocationId: auth.invocationId,
        sourceMessageId: source.sourceMessageId,
        fromCatId: source.fromCatId,
        retired: prior.payload.retired === true,
      };
    }

    const inspection = await this.inspectResolvedHandoff(auth.threadId, auth.catId, source, events);
    if (inspection.outcome === 'replaced') {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_replaced', inspection.replacement);
    }
    const retired = await this.resolveRetired(subjectKey, auth.catId);
    await this.recordDisposition(auth, source, disposition, subjectKey, eventSourceId, events.length, retired);
    const committed = (await this.deps.ballCustodyEventLog.read(subjectKey)).find(
      (event) => event.sourceEventId === eventSourceId,
    );
    this.assertMatchingDispositionEvent(committed, auth, source, disposition);
    return {
      outcome: 'applied',
      disposition,
      invocationId: auth.invocationId,
      sourceMessageId: source.sourceMessageId,
      fromCatId: source.fromCatId,
      retired,
    };
  }

  /** Queue-start and callback completion share this exact source/event fence. */
  async inspectHandoff(input: {
    readonly threadId: string;
    readonly catId: string;
    readonly sourceMessageId: string;
  }): Promise<A2ADispatchHandoffInspection> {
    const source = await this.resolveSourceCoordinates(input);
    const events = await this.deps.ballCustodyEventLog.read(`ball:thread:${input.threadId}`);
    return this.inspectResolvedHandoff(input.threadId, input.catId, source, events);
  }

  private async assertLatestInvocation(invocationId: string): Promise<void> {
    if (!(await this.deps.registry.isLatest(invocationId))) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_stale_invocation');
    }
  }

  private async resolveSource(auth: A2ADispatchDispositionAuth): Promise<DispatchSource> {
    const sourceMessageId = auth.a2aTriggerMessageId;
    if (!sourceMessageId || auth.originTriggerMessageId !== sourceMessageId) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_source_missing');
    }
    return this.resolveSourceCoordinates({ threadId: auth.threadId, catId: auth.catId, sourceMessageId });
  }

  private async resolveSourceCoordinates(input: {
    readonly threadId: string;
    readonly catId: string;
    readonly sourceMessageId: string;
  }): Promise<DispatchSource> {
    const message = await this.deps.messageStore.getById(input.sourceMessageId);
    if (!this.isExactA2ASource(message, input)) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_source_mismatch');
    }
    const fromCatId = message.catId;
    return {
      sourceMessageId: input.sourceMessageId,
      fromCatId,
      handoffSourceEventId: handedEventSourceId(input.sourceMessageId, input.catId),
    };
  }

  private isExactA2ASource(
    message: StoredMessage | null,
    auth: { readonly threadId: string; readonly catId: string },
  ): message is StoredMessage & { catId: NonNullable<StoredMessage['catId']> } {
    return Boolean(
      message &&
        message.threadId === auth.threadId &&
        message.catId &&
        (message.catId !== auth.catId ||
          isCrossThreadProvenance(message.extra?.crossPost?.sourceThreadId, message.threadId)) &&
        (message.mentions.some((candidate) => candidate === auth.catId) ||
          message.extra?.targetCats?.includes(auth.catId)),
    );
  }

  private async resolveRetired(subjectKey: string, catId: string): Promise<boolean> {
    const projection = await this.deps.ballCustodyProjectionStore.get(subjectKey);
    if (projection?.state !== 'active' && projection?.state !== 'blocked') {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_holder_mismatch');
    }
    return projection.holder !== catId;
  }

  private async inspectResolvedHandoff(
    threadId: string,
    catId: string,
    source: DispatchSource,
    events: readonly BallCustodyEvent[],
  ): Promise<A2ADispatchHandoffInspection> {
    const inspection = await resolveA2ADispatchHandoff({
      threadId,
      catId,
      source,
      events,
      messageStore: this.deps.messageStore,
      ...(this.deps.log ? { log: this.deps.log } : {}),
    });
    if (inspection.outcome === 'missing') {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_handoff_missing');
    }
    return inspection;
  }

  private assertMatchingDispositionEvent(
    event: BallCustodyEvent | undefined,
    auth: A2ADispatchDispositionAuth,
    source: DispatchSource,
    disposition: A2ADispatchDisposition,
  ): void {
    if (
      !event ||
      event.kind !== 'ball.dispatch_dispositioned' ||
      event.payload.catId !== auth.catId ||
      event.payload.fromCatId !== source.fromCatId ||
      event.payload.invocationId !== auth.invocationId ||
      event.payload.sourceMessageId !== source.sourceMessageId ||
      event.payload.disposition !== disposition
    ) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_replay_mismatch');
    }
  }

  private async recordDisposition(
    auth: A2ADispatchDispositionAuth,
    source: DispatchSource,
    disposition: A2ADispatchDisposition,
    subjectKey: string,
    eventSourceId: string,
    expectedSequence: number,
    retired: boolean,
  ): Promise<void> {
    try {
      const result = await this.deps.ballCustody.recordFenced(
        buildDispatchDispositionEvent({
          threadId: auth.threadId,
          catId: auth.catId,
          fromCatId: source.fromCatId,
          invocationId: auth.invocationId,
          sourceMessageId: source.sourceMessageId,
          disposition,
          retired,
          at: this.now(),
        }),
        expectedSequence,
      );
      if (result.outcome === 'conflict') {
        throw new A2ADispatchDispositionError('a2a_dispatch_disposition_fence_conflict');
      }
    } catch (error) {
      const appended = (await this.deps.ballCustodyEventLog.read(subjectKey)).find(
        (event) => event.sourceEventId === eventSourceId,
      );
      if (!appended || !this.deps.repairProjection) throw error;
      await this.deps.repairProjection(subjectKey);
    }
  }

  private async repairProjectionIfNeeded(
    subjectKey: string,
    events: readonly BallCustodyEvent[],
    dispositionEvent: BallCustodyEvent,
  ): Promise<void> {
    if (!this.deps.repairProjection) return;
    const dispositionIndex = events.findIndex((event) => event.sourceEventId === dispositionEvent.sourceEventId);
    const reopenedAfterDisposition = events
      .slice(dispositionIndex + 1)
      .some((event) => event.kind === 'ball.handed' || event.kind === 'ball.held');
    const projection = await this.deps.ballCustodyProjectionStore.get(subjectKey);
    if (!reopenedAfterDisposition && projection?.state !== 'resolved') {
      await this.deps.repairProjection(subjectKey);
    }
  }
}
