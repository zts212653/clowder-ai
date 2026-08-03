import type { CatId, ConnectorSource } from '@cat-cafe/shared';

import type { LimbTranscriptDelivery } from './LimbObservationRouter.js';

type TriggerOutcome = 'dispatched' | 'enqueued' | 'full';

export interface LimbTranscriptCatDeliveryOptions {
  readonly isKnownCat: (catId: string) => boolean;
  readonly messageStore: {
    append(input: {
      readonly threadId: string;
      readonly userId: string;
      readonly catId: null;
      readonly content: string;
      readonly source: ConnectorSource;
      readonly mentions: readonly CatId[];
      readonly timestamp: number;
      readonly idempotencyKey: string;
    }): Promise<{ readonly id: string }> | { readonly id: string };
  };
  readonly invokeTriggerProvider: {
    get():
      | {
          trigger(
            threadId: string,
            catId: CatId,
            userId: string,
            message: string,
            messageId: string,
          ): Promise<TriggerOutcome>;
        }
      | undefined;
  };
  readonly socketManager?: {
    broadcastToRoom(room: string, event: string, data: unknown): void;
  };
}

const STACKCHAN_SOURCE: ConnectorSource = {
  connector: 'physical-limb.stackchan',
  label: 'StackChan',
  icon: 'robot',
};

export class LimbTranscriptCatDelivery implements LimbTranscriptDelivery {
  constructor(private readonly options: LimbTranscriptCatDeliveryOptions) {}

  async deliverTranscript(
    input: Parameters<LimbTranscriptDelivery['deliverTranscript']>[0],
  ): Promise<{ readonly messageId: string }> {
    if (!this.options.isKnownCat(input.binding.catId)) {
      throw new Error(`unknown bound cat: ${input.binding.catId}`);
    }
    const trigger = this.options.invokeTriggerProvider.get();
    if (!trigger) {
      throw new Error('cat invocation runtime is not ready');
    }

    const catId = input.binding.catId as CatId;
    const timestamp = Date.parse(input.observation.occurredAt);
    const source: ConnectorSource = {
      ...STACKCHAN_SOURCE,
      meta: {
        nodeId: input.observation.nodeId,
        observationId: input.observation.observationId,
        interactionId: input.observation.payload.interactionId,
        sessionId: input.observation.sessionId,
        language: input.observation.payload.language,
        captureDurationMs: input.observation.payload.captureDurationMs,
        rawMediaTransferred: false,
      },
    };
    const stored = await this.options.messageStore.append({
      threadId: input.binding.threadId,
      userId: input.binding.userId,
      catId: null,
      content: input.observation.payload.text,
      source,
      mentions: [catId],
      timestamp,
      idempotencyKey: `limb:${input.observation.nodeId}:${input.observation.observationId}`,
    });

    this.options.socketManager?.broadcastToRoom(`thread:${input.binding.threadId}`, 'connector_message', {
      threadId: input.binding.threadId,
      message: {
        id: stored.id,
        type: 'connector',
        content: input.observation.payload.text,
        source,
        timestamp,
      },
    });

    const outcome = await trigger.trigger(
      input.binding.threadId,
      catId,
      input.binding.userId,
      input.observation.payload.text,
      stored.id,
    );
    if (outcome === 'full') {
      throw new Error('cat invocation queue is full');
    }
    return { messageId: stored.id };
  }
}
