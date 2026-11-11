import { randomUUID } from 'node:crypto';
import { createModuleLogger } from '../../../../../../../infrastructure/logger.js';
import type { AgentClientActiveRunHandle, AgentClientDispatchInput, AgentServiceOptions } from '../../../../types.js';
import type { AcpClient } from '../AcpClient.js';

type TurnClient = Pick<AcpClient, 'steerTurn' | 'inspectTurnInput' | 'onTurnBridgeEvent'>;
type TurnEvent = Parameters<Parameters<TurnClient['onTurnBridgeEvent']>[0]>[0];
type Delivery = {
  input: AgentClientDispatchInput;
  signature: string;
  read: boolean;
  completed: boolean;
  accepted?: boolean;
};
const log = createModuleLogger('dsh-turn-input');

/** Per-prompt live bindings only. Queue/History and the native inbox own durable input state. */
export class DshTurnInput {
  private readonly deliveries = new Map<string, Delivery>();
  private nativeTurnId: number | undefined;
  private release?: () => void;
  private readonly unsubscribe: () => void;
  private closed = false;
  private settlement = Promise.resolve();
  private resolveInitialRead!: (at: number) => void;
  private readonly initialInputRead = new Promise<number>((resolve) => {
    this.resolveInitialRead = resolve;
  });

  constructor(
    private readonly client: TurnClient,
    private readonly sessionId: string,
    private readonly options: AgentServiceOptions,
  ) {
    this.unsubscribe = client.onTurnBridgeEvent((event) => this.observe(event));
  }

  private observe(event: TurnEvent): void {
    if (event.sessionId !== this.sessionId || this.closed) return;
    const registration = this.options.activeRunDispatch;
    if (event.type === 'turn_started') {
      if (!registration || this.nativeTurnId !== undefined || this.options.signal?.aborted) return;
      const nativeTurnId = event.nativeTurnId;
      this.nativeTurnId = nativeTurnId;
      const handle: AgentClientActiveRunHandle = {
        provider: 'other',
        carrier: 'acp',
        threadId: this.sessionId,
        turnId: String(this.nativeTurnId),
      };
      this.release =
        registration.register({
          invocationId: registration.invocationId,
          handle,
          capabilities: { append: true, steer: false, inputReadReceipt: true, inputCompletionReceipt: true },
          initialInputRead: this.initialInputRead,
          dispatch: async (input, control) => {
            if (control.expectedInvocationId !== registration.invocationId)
              return { accepted: false, reason: 'active_run_mismatch', acceptance: 'not_accepted' };
            if (this.closed || this.options.signal?.aborted)
              return { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' };
            if (control.force || input.imagePaths?.length)
              return { accepted: false, reason: 'provider_rejected', acceptance: 'not_accepted' };
            if (!input.text.trim()) return { accepted: false, reason: 'invalid_input', acceptance: 'not_accepted' };
            const deliveryId = input.deliveryId ?? randomUUID();
            const signature = JSON.stringify([input.text, input.messageIds]);
            const previous = this.deliveries.get(deliveryId);
            if (previous) {
              if (previous.signature !== signature)
                return { accepted: false, reason: 'invalid_input', acceptance: 'not_accepted' };
              return previous.accepted
                ? { accepted: true, handle }
                : { accepted: false, reason: 'exception', acceptance: 'unknown' };
            }
            const delivery: Delivery = { input, signature, read: false, completed: false };
            this.deliveries.set(deliveryId, delivery);
            try {
              const result = await this.client.steerTurn({
                sessionId: this.sessionId,
                deliveryId,
                text: input.text,
                expectedTurn: nativeTurnId,
              });
              if (!result.accepted) {
                this.deliveries.delete(deliveryId);
                return { accepted: false, reason: 'provider_rejected', acceptance: 'not_accepted' };
              }
              delivery.accepted = true;
              return { accepted: true, handle };
            } catch {
              // Bytes may have reached the native inbox; retain completion custody and never retry here.
              return { accepted: false, reason: 'exception', acceptance: 'unknown' };
            }
          },
          inspectInput: async (deliveryId) => {
            if (this.closed) return 'unknown';
            const result = await this.client.inspectTurnInput(this.sessionId, deliveryId);
            return result.state === 'read' ? 'accepted' : result.state;
          },
        }) ?? undefined;
      return;
    }
    if (event.nativeTurnId !== this.nativeTurnId) return;
    if (event.type === 'input_read') {
      const delivery = this.deliveries.get(event.deliveryId);
      if (!delivery) {
        this.resolveInitialRead(Date.now());
        return;
      }
      if (delivery.read) return;
      delivery.read = true;
      // Native consumption is already known; persistence is a nonblocking observer.
      void Promise.resolve()
        .then(() => delivery.input.onInputRead?.())
        .catch((error: unknown) => {
          log.warn(
            { error, sessionId: this.sessionId, deliveryId: event.deliveryId },
            'DSH native read receipt failed',
          );
        });
    }
    if (event.type === 'turn_ended') {
      this.stop();
      this.settlement = this.settle(event.reason === 'completed');
    }
  }

  private stop(): void {
    this.closed = true;
    this.unsubscribe();
    this.release?.();
    this.release = undefined;
  }

  private async settle(successful: boolean): Promise<void> {
    const results = await Promise.allSettled(
      [...this.deliveries.values()]
        .filter((delivery) => !delivery.completed)
        .map(async (delivery) => {
          delivery.completed = true;
          await delivery.input.onInputCompleted?.(successful && delivery.read);
        }),
    );
    results
      .filter((result) => result.status === 'rejected')
      .forEach((result) => {
        log.warn({ error: result.reason, sessionId: this.sessionId }, 'DSH input completion receipt failed');
      });
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.settlement;
    await this.settle(false);
  }
}
