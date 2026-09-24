import type { CatId, ConnectorSource } from '@cat-cafe/shared';

import type {
  ConnectorDeliveryDeps,
  ConnectorDeliveryInput,
  ConnectorDeliveryResult,
} from '../../infrastructure/email/deliver-connector-message.js';
import type { LimbTranscriptDelivery } from './LimbObservationRouter.js';

export interface LimbTranscriptCatDeliveryOptions {
  readonly isKnownCat: (catId: string) => boolean;
  /**
   * The one seam that owns atomic Message + Queue admission. Injected rather than imported so the
   * delivery port stays a composition decision, exactly as the other connector producers have it.
   */
  readonly deliverFn: (deps: ConnectorDeliveryDeps, input: ConnectorDeliveryInput) => Promise<ConnectorDeliveryResult>;
  readonly deliveryDeps: ConnectorDeliveryDeps;
}

const STACKCHAN_SOURCE: ConnectorSource = {
  connector: 'physical-limb.stackchan',
  label: 'StackChan',
  icon: 'robot',
};

/**
 * A spoken transcript from a physical limb is an ordinary external input, so it takes the ordinary
 * path: one atomic Message + Queue admission keyed by the observation.
 *
 * It used to append a `deliveryStatus:'queued'` message and then call a separate invoke trigger to
 * enqueue it. Those are two writes, and the window between them is not theoretical for this
 * producer: `LimbObservationRouter` releases the ingress claim only when `deliverTranscript`
 * *throws*, so a crash after the append left a queued message that no Queue row referenced and no
 * retry would ever re-deliver — the utterance was captured, shown as pending, and silently dropped.
 */
export class LimbTranscriptCatDelivery implements LimbTranscriptDelivery {
  constructor(private readonly options: LimbTranscriptCatDeliveryOptions) {}

  async deliverTranscript(
    input: Parameters<LimbTranscriptDelivery['deliverTranscript']>[0],
  ): Promise<{ readonly messageId: string }> {
    if (!this.options.isKnownCat(input.binding.catId)) {
      throw new Error(`unknown bound cat: ${input.binding.catId}`);
    }

    const catId = input.binding.catId as CatId;
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

    const result = await this.options.deliverFn(this.options.deliveryDeps, {
      threadId: input.binding.threadId,
      userId: input.binding.userId,
      catId,
      content: input.observation.payload.text,
      source,
      // Same key the append used, so an observation already admitted replays instead of speaking twice.
      idempotencyKey: `limb:${input.observation.nodeId}:${input.observation.observationId}`,
      // The device captured the utterance at this instant; admission is merely when we caught up.
      timestamp: Date.parse(input.observation.occurredAt),
    });

    // The router releases the ingress claim on a throw and only on a throw. Returning a messageId
    // for an envelope that never reached the Queue would burn the claim on work nobody will run.
    if (!result.admitted) {
      throw new Error(`limb transcript was not admitted to the queue: ${input.observation.observationId}`);
    }
    return { messageId: result.messageId };
  }
}
