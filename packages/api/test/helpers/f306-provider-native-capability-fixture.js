import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServerClient } from '../../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';

export const PROVIDER_THREAD = 'provider-thread';
export const PROVIDER_TURN = 'provider-turn';
export const BUNDLED_PLUGIN = 'unified-computer-use@openai-bundled';

export const owner = {
  userId: 'user-1',
  threadId: 'cat-thread-1',
  catId: 'codex-sol',
  invocationId: 'invocation-1',
};

export async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

export async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout');
    await delay(1);
  }
}

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export class ConsentWire {
  constructor() {
    this.inbox = new AsyncInbox();
    this.writes = [];
  }

  read() {
    return this.inbox;
  }

  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') this.inbox.push({ id: message.id, result: {} });
    if (message.method === 'thread/start') {
      this.inbox.push({ id: message.id, result: { thread: { id: PROVIDER_THREAD } } });
    }
    if (message.method === 'thread/resume') {
      this.inbox.push({ id: message.id, result: { thread: { id: message.params.threadId } } });
    }
    if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: PROVIDER_TURN, status: 'inProgress' } } });
    }
  }

  async terminate() {
    this.inbox.close();
  }

  async close() {
    this.inbox.close();
  }
}

export function itemStarted(callId, overrides = {}) {
  return {
    method: 'item/started',
    params: {
      threadId: PROVIDER_THREAD,
      turnId: PROVIDER_TURN,
      item: {
        id: callId,
        type: 'mcpToolCall',
        status: 'inProgress',
        server: 'cua_repl',
        tool: 'js',
        pluginId: BUNDLED_PLUGIN,
        ...overrides,
      },
    },
  };
}

export function reviewStarted(callId, overrides = {}) {
  return reviewEvent('item/autoApprovalReview/started', callId, {
    review: { status: 'inProgress' },
    ...overrides,
  });
}

export function reviewCompleted(callId, overrides = {}) {
  return reviewEvent('item/autoApprovalReview/completed', callId, {
    review: { status: 'approved' },
    ...overrides,
  });
}

function reviewEvent(method, callId, overrides) {
  return {
    method,
    params: {
      threadId: PROVIDER_THREAD,
      turnId: PROVIDER_TURN,
      targetItemId: callId,
      reviewId: `review-${callId}`,
      action: { type: 'mcpToolCall', server: 'cua_repl', toolName: 'js' },
      ...overrides,
    },
  };
}

export function itemCompleted(callId) {
  return {
    method: 'item/completed',
    params: {
      threadId: PROVIDER_THREAD,
      turnId: PROVIDER_TURN,
      item: { id: callId, type: 'mcpToolCall', status: 'failed' },
    },
  };
}

export function consentRequest(id, callId, overrides = {}) {
  const meta = {
    callId,
    codex_approval_kind: 'mcp_tool_call',
    connector_id: 'computer-use',
    tool_name: 'get_app_state',
    tool_params: { app: 'com.google.Chrome' },
    ...(overrides.meta ?? {}),
  };
  return {
    id,
    method: 'mcpServer/elicitation/request',
    params: {
      serverName: 'cua_repl',
      threadId: PROVIDER_THREAD,
      turnId: PROVIDER_TURN,
      mode: 'form',
      message: 'presentation text is not authority',
      requestedSchema: { type: 'object', properties: {}, additionalProperties: false },
      _meta: meta,
      ...overrides.params,
    },
  };
}

export function approvedCallEvents(callId) {
  return [itemStarted(callId), reviewStarted(callId), reviewCompleted(callId)];
}

export async function exercise({ thread = { kind: 'start' }, events = [], request = consentRequest(41, 'call-1') }) {
  const wire = new ConsentWire();
  const humanRequests = [];
  const client = new CodexAppServerClient({ wire });
  const run = collect(
    client.run({
      prompt: { kind: 'frozen', prompt: 'exercise provider-native consent' },
      thread,
      approvalsReviewer: 'auto_review',
      runtimeInteraction: {
        owner,
        declaredMcpServerNames: [],
        port: {
          request: async (interaction) => {
            humanRequests.push(interaction);
            return { kind: 'decision', decisionId: 'decline' };
          },
        },
      },
    }),
  );
  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  for (const event of events) wire.inbox.push(event);
  wire.inbox.push(request);
  await waitFor(() => wire.writes.some((message) => message.id === request.id));
  const response = wire.writes.find((message) => message.id === request.id);
  wire.inbox.push(turnCompleted());
  await run;
  return { response, humanRequests };
}

export function turnCompleted(turnId = PROVIDER_TURN) {
  return {
    method: 'turn/completed',
    params: { threadId: PROVIDER_THREAD, turn: { id: turnId, status: 'completed' } },
  };
}
