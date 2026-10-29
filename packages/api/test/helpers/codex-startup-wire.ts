import type { AgentCarrierSession } from '../../src/domains/cats/services/types.js';

/** In-process protocol peer: errors are delivered on the actual account/read RPC. */
export class CodexStartupWire implements AgentCarrierSession {
  readonly writes: Record<string, unknown>[] = [];
  closeCalls = 0;
  private values: unknown[] = [];
  private wake?: () => void;
  private closed = false;

  constructor(
    readonly accountError?: { message: string; code?: number; data?: unknown } | 'pending',
    readonly config: Record<string, unknown> = {},
    readonly turnFailure?: string,
  ) {}

  async *read() {
    while (!this.closed || this.values.length) {
      if (this.values.length) yield this.values.shift();
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }

  push(value: unknown) {
    this.values.push(value);
    this.wake?.();
  }

  async write(message: Record<string, unknown>) {
    this.writes.push(message);
    if (message.id === undefined) return;
    if (message.method === 'account/read' && this.accountError) {
      if (this.accountError !== 'pending') this.push({ id: message.id, error: this.accountError });
      return;
    }
    const result =
      message.method === 'config/read'
        ? { config: this.config }
        : message.method === 'configRequirements/read'
          ? { requirements: null }
          : message.method === 'account/read'
            ? { account: { type: 'chatgpt' } }
            : message.method === 'thread/start' || message.method === 'thread/resume'
              ? { thread: { id: 'same-native-thread', turns: [] } }
              : message.method === 'thread/turns/list'
                ? { data: [], nextCursor: null }
                : message.method === 'turn/start'
                  ? { turn: { id: 'same-turn', status: 'inProgress' } }
                  : {};
    this.push({ id: message.id, result });
    if (message.method === 'turn/start' && !this.turnFailure)
      this.push({
        method: 'item/completed',
        params: {
          threadId: 'same-native-thread',
          turnId: 'same-turn',
          item: { id: 'answer', type: 'agentMessage', text: 'Original task completed.', phase: 'final_answer' },
        },
      });
    if (message.method === 'turn/start')
      this.push({
        method: 'turn/completed',
        params: {
          threadId: 'same-native-thread',
          turn: {
            id: 'same-turn',
            status: this.turnFailure ? 'failed' : 'completed',
            items: [],
            ...(this.turnFailure ? { error: { message: this.turnFailure } } : {}),
          },
        },
      });
  }

  async close() {
    this.closeCalls++;
    this.closed = true;
    this.wake?.();
  }
}
