import type { AgentCarrierSession } from '../../src/domains/cats/services/types.js';

/** Credential-free protocol fixture; business controls deliberately stop at their first RPC. */
export class F320AccountWire implements AgentCarrierSession {
  readonly writes: Record<string, unknown>[] = [];
  closed = false;
  private values: unknown[] = [];
  private wake?: () => void;
  constructor(
    private readonly config: Record<string, unknown>,
    private readonly stopControls = false,
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
  private push(value: unknown) {
    this.values.push(value);
    this.wake?.();
  }
  async write(message: Record<string, unknown>) {
    this.writes.push(message);
    if (message.id === undefined) return;
    const method = String(message.method);
    if (
      this.stopControls &&
      !['initialize', 'config/read', 'configRequirements/read', 'account/read', 'thread/resume'].includes(method)
    ) {
      this.push({ id: message.id, error: { code: -32000, message: 'fixture_business_reached' } });
      return;
    }
    let result: unknown = {};
    if (method === 'config/read') result = { config: this.config };
    if (method === 'configRequirements/read') result = { requirements: null };
    if (method === 'account/read') result = { account: { type: 'chatgpt' } };
    if (method === 'thread/turns/list') result = { data: [], nextCursor: null };
    if (method === 'thread/start' || method === 'thread/resume')
      result = { thread: { id: 'fixture-thread', turns: [] } };
    if (method === 'turn/start') result = { turn: { id: 'fixture-turn', status: 'inProgress', items: [] } };
    if (
      ['skills/list', 'app/list', 'app/installed', 'plugin/list', 'plugin/installed', 'mcpServerStatus/list'].includes(
        method,
      )
    )
      result = { data: [], apps: [], marketplaces: [] };
    this.push({ id: message.id, result });
    if (method === 'turn/start')
      this.push({
        method: 'turn/completed',
        params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed', items: [] } },
      });
  }
  async close() {
    this.closed = true;
    this.wake?.();
  }
}
