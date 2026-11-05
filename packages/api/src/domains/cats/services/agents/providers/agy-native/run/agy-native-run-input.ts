import { randomUUID } from 'node:crypto';
import { createModuleLogger } from '../../../../../../../infrastructure/logger.js';
import type { AgentClientActiveRunHandle, AgentClientDispatchInput, AgentServiceOptions } from '../../../../types.js';
import type { AgyStreamJsonEvent } from '../../agy-stream-json-parser.js';
import { encodeAgyStreamJsonUserMessage } from '../../agy-stream-json-parser.js';

const log = createModuleLogger('agy-native-input');

interface Supplement {
  readonly input: AgentClientDispatchInput;
  readonly signature: string;
  read: boolean;
  completed: boolean;
}

/** Live stream ownership only; durable delivery/unfinished-input recovery stays in Queue. */
export class AgyNativeRunInput {
  private writer: ((input: string) => void) | undefined;
  private accepting = false;
  private release: (() => void) | undefined;
  private readonly pending: Supplement[] = [];
  private readonly deliveries = new Map<string, Supplement>();
  private current: Supplement | undefined;
  private inputIndex: number | undefined;
  private readIndex: number | undefined;
  private initialRead = false;
  private resolveInitialRead!: (at: number) => void;
  readonly initialInputRead = new Promise<number>((resolve) => {
    this.resolveInitialRead = resolve;
  });

  constructor(
    private readonly options: AgentServiceOptions,
    private readonly closeStdin: () => void,
  ) {
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }

  private readonly abort = () => this.stop();

  onStdinReady(write: (input: string) => void): void {
    this.writer = write;
  }

  register(sessionId: string): void {
    const registration = this.options.activeRunDispatch;
    if (!registration || !this.writer || this.options.signal?.aborted) return;
    const handle: AgentClientActiveRunHandle = {
      provider: 'google',
      carrier: 'agy_stream_json',
      threadId: sessionId,
      turnId: randomUUID(),
    };
    this.accepting = true;
    this.release = registration.register({
      invocationId: registration.invocationId,
      capabilities: { append: true, steer: false, inputReadReceipt: true, inputCompletionReceipt: true },
      initialInputRead: this.initialInputRead,
      handle,
      dispatch: async (input, control) => {
        if (control.expectedInvocationId !== registration.invocationId)
          return { accepted: false, reason: 'active_run_mismatch', acceptance: 'not_accepted' };
        if (!this.accepting || this.options.signal?.aborted || !this.writer)
          return { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' };
        // Appended attachments require a fresh launch's access-directory policy.
        if (control.force || input.imagePaths?.length)
          return { accepted: false, reason: 'provider_rejected', acceptance: 'not_accepted' };
        if (!input.text.trim()) return { accepted: false, reason: 'invalid_input', acceptance: 'not_accepted' };
        const signature = JSON.stringify([input.text, input.messageIds]);
        const previous = input.deliveryId ? this.deliveries.get(input.deliveryId) : undefined;
        if (previous)
          return previous.signature === signature
            ? { accepted: true, handle }
            : { accepted: false, reason: 'invalid_input', acceptance: 'not_accepted' };
        const supplement: Supplement = { input, signature, read: false, completed: false };
        this.pending.push(supplement);
        if (input.deliveryId) this.deliveries.set(input.deliveryId, supplement);
        try {
          this.writer(`${encodeAgyStreamJsonUserMessage(input.text)}\n`);
          return { accepted: true, handle };
        } catch {
          // A failed write cannot establish whether the child received bytes.
          this.stop();
          return { accepted: false, reason: 'exception', acceptance: 'unknown' };
        }
      },
    });
  }

  async step(event: Extract<AgyStreamJsonEvent, { kind: 'step' }>): Promise<void> {
    if (event.stepType !== 'user_input') return;
    if (this.inputIndex !== undefined && event.stepIndex !== this.inputIndex)
      throw new Error('AGY native emitted multiple user inputs before a terminal result');
    this.inputIndex = event.stepIndex;
    if (event.state !== 'DONE' || this.readIndex === event.stepIndex) return;
    this.readIndex = event.stepIndex;
    if (!this.initialRead) {
      this.initialRead = true;
      this.resolveInitialRead(Date.now());
      return;
    }
    this.current ??= this.pending[0];
    if (!this.current) throw new Error('AGY native read an input not accepted by this run');
    if (!this.current.read) {
      this.current.read = true;
      // This observer is best effort. Exact-ref/CAS fences keep a late write
      // from restoring a compensated binding; delivery and Stop never await it.
      try {
        void this.current.input
          .onInputRead?.()
          .catch((error: unknown) => log.warn({ error }, 'Native read receipt failed'));
      } catch (error) {
        log.warn({ error }, 'Native read receipt failed');
      }
    }
  }

  /** Called synchronously on the raw result, before archive writes or other awaits. */
  resultBoundary(): void {
    const waiting = this.pending.length - (this.current ? 1 : 0);
    if (waiting === 0) this.stop();
  }

  async result(successful: boolean): Promise<void> {
    if (this.current) {
      const current = this.current;
      await current.input.onInputCompleted?.(successful);
      current.completed = true;
      this.pending.shift();
      this.current = undefined;
    }
    this.inputIndex = undefined;
    if (!successful) this.stop();
  }

  get hasUnfinishedInput(): boolean {
    return this.pending.length > 0;
  }

  stop(): void {
    this.accepting = false;
    this.options.signal?.removeEventListener('abort', this.abort);
    this.closeStdin();
    this.release?.();
    this.release = undefined;
  }

  async dispose(): Promise<void> {
    this.stop();
    let failure: unknown;
    for (const supplement of this.pending) {
      try {
        if (!supplement.completed) await supplement.input.onInputCompleted?.(false);
      } catch (error) {
        failure ??= error;
      }
    }
    this.pending.length = 0;
    if (failure) throw failure;
  }
}
