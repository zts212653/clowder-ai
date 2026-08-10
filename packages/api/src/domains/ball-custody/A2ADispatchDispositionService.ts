import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { InvocationRecord } from '../cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyIngest } from './BallCustodyIngest.js';
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
}

export class A2ADispatchDispositionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'A2ADispatchDispositionError';
  }
}

interface A2ADispatchDispositionDeps {
  readonly registry: { isLatest(invocationId: string): Promise<boolean> };
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly ballCustodyEventLog: Pick<IBallCustodyEventLog, 'read'>;
  readonly ballCustodyProjectionStore: Pick<IBallCustodyProjectionStore, 'get'>;
  readonly ballCustody: IBallCustodyIngest;
  readonly repairProjection?: (subjectKey: string) => Promise<void>;
  readonly now?: () => number;
}

type A2ADispatchDispositionAuth = Pick<
  InvocationRecord,
  'invocationId' | 'catId' | 'threadId' | 'a2aTriggerMessageId' | 'originTriggerMessageId'
>;

interface DispatchSource {
  readonly sourceMessageId: string;
  readonly fromCatId: string;
  readonly handoffSourceEventId: string;
}

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
      };
    }

    await this.assertCurrentHolder(subjectKey, auth.catId);
    this.assertExactHandoffIsLive(events, auth.catId, source);
    await this.recordDisposition(auth, source, disposition, subjectKey, eventSourceId);
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
    };
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
    const message = await this.deps.messageStore.getById(sourceMessageId);
    if (!this.isExactA2ASource(message, auth)) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_source_mismatch');
    }
    const fromCatId = message.catId;
    return {
      sourceMessageId,
      fromCatId,
      handoffSourceEventId: handedEventSourceId(sourceMessageId, auth.catId),
    };
  }

  private isExactA2ASource(
    message: StoredMessage | null,
    auth: A2ADispatchDispositionAuth,
  ): message is StoredMessage & { catId: NonNullable<StoredMessage['catId']> } {
    return Boolean(
      message &&
        message.threadId === auth.threadId &&
        message.catId &&
        message.catId !== auth.catId &&
        (message.mentions.includes(auth.catId) || message.extra?.targetCats?.includes(auth.catId)),
    );
  }

  private async assertCurrentHolder(subjectKey: string, catId: string): Promise<void> {
    const projection = await this.deps.ballCustodyProjectionStore.get(subjectKey);
    if ((projection?.state !== 'active' && projection?.state !== 'blocked') || projection.holder !== catId) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_holder_mismatch');
    }
  }

  private assertExactHandoffIsLive(events: readonly BallCustodyEvent[], catId: string, source: DispatchSource): void {
    const exactHandoffIndex = events.findIndex(
      (event) =>
        event.kind === 'ball.handed' &&
        event.sourceEventId === source.handoffSourceEventId &&
        event.payload.fromCatId === source.fromCatId &&
        event.payload.toCatId === catId,
    );
    if (exactHandoffIndex === -1) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_handoff_missing');
    }
    const wasReplaced = events.slice(exactHandoffIndex + 1).some((event) => {
      if (event.kind === 'ball.held') return event.payload.catId === catId;
      if (event.kind === 'ball.handed') {
        return event.payload.fromCatId === catId || event.payload.toCatId === catId;
      }
      return event.kind === 'ball.handed_cvo' && event.payload.fromCatId === catId;
    });
    if (wasReplaced) throw new A2ADispatchDispositionError('a2a_dispatch_disposition_replaced');
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
  ): Promise<void> {
    try {
      await this.deps.ballCustody.record(
        buildDispatchDispositionEvent({
          threadId: auth.threadId,
          catId: auth.catId,
          fromCatId: source.fromCatId,
          invocationId: auth.invocationId,
          sourceMessageId: source.sourceMessageId,
          disposition,
          at: this.now(),
        }),
      );
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
