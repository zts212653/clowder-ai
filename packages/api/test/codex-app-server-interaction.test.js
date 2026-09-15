import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerClient } from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';
import { createCodexSubexecutionTracker } from '../dist/domains/cats/services/agents/providers/CodexSubexecutionTracker.js';
import { safeParseMetadata } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function waitFor(predicate, timeoutMs = 1_000) {
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

class InteractionWire {
  constructor(threadRecords = {}) {
    this.inbox = new AsyncInbox();
    this.writes = [];
    this.threadRecords = threadRecords;
  }

  read() {
    return this.inbox;
  }

  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') this.inbox.push({ id: message.id, result: {} });
    if (message.method === 'thread/start') {
      this.inbox.push({ id: message.id, result: { thread: { id: 'provider-thread' } } });
    }
    if (message.method === 'thread/resume') {
      this.inbox.push({ id: message.id, result: { thread: { id: message.params.threadId } } });
    }
    if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: 'provider-turn', status: 'inProgress' } } });
    }
    if (message.method === 'thread/read') {
      const thread = this.threadRecords[message.params.threadId];
      this.inbox.push(
        thread
          ? { id: message.id, result: { thread } }
          : { id: message.id, error: { code: -32602, message: 'Unknown provider thread' } },
      );
    }
  }

  async terminate() {
    this.inbox.close();
  }

  async close() {
    this.inbox.close();
  }
}

const owner = {
  userId: 'user-1',
  threadId: 'cat-thread-1',
  catId: 'codex-sol',
  invocationId: 'invocation-1',
};

test('F306 sends command, file, question, and elicitation through one invocation-bound port', async () => {
  const wire = new InteractionWire();
  const requests = [];
  const client = new CodexAppServerClient({ wire });
  const run = collect(
    client.run({
      prompt: { kind: 'frozen', prompt: 'exercise runtime interactions' },
      thread: { kind: 'start' },
      approvalsReviewer: 'user',
      runtimeInteraction: {
        owner,
        createInteractionId: () => `interaction-${requests.length + 1}`,
        port: {
          request: async (request) => {
            requests.push(request);
            if (request.kind === 'question') {
              return { kind: 'answers', answers: { environment: ['Alpha'] } };
            }
            if (request.kind === 'elicitation') {
              return { kind: 'decision', decisionId: 'accept', content: { region: 'us-west' } };
            }
            return { kind: 'decision', decisionId: 'accept' };
          },
        },
      },
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  wire.inbox.push({
    id: 101,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'command-item',
      startedAtMs: 1,
      command: 'pnpm test',
    },
  });
  wire.inbox.push({
    id: 102,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'file-item',
      startedAtMs: 2,
    },
  });
  wire.inbox.push({
    id: 103,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'question-item',
      isBlocking: true,
      questions: [{ id: 'environment', header: 'Environment', question: 'Where?' }],
    },
  });
  wire.inbox.push({
    id: 104,
    method: 'mcpServer/elicitation/request',
    params: {
      serverName: 'deployment-mcp',
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      mode: 'form',
      message: 'Choose region',
      requestedSchema: {
        type: 'object',
        properties: { region: { type: 'string' } },
        required: ['region'],
        additionalProperties: false,
      },
    },
  });

  await waitFor(() => requests.length === 4);
  await waitFor(() => [101, 102, 103, 104].every((id) => wire.writes.some((message) => message.id === id)));
  assert.deepEqual(
    requests.map((request) => request.kind),
    ['approval', 'approval', 'question', 'elicitation'],
  );
  assert.ok(requests.every((request) => request.owner === owner));
  assert.deepEqual(
    requests.map((request) => request.provider.requestId),
    [101, 102, 103, 104],
  );

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
});

test('F306 resolves typed Computer Use capability consent before publication on fresh and resumed carriers', async () => {
  for (const thread of [{ kind: 'start' }, { kind: 'resume', threadId: 'provider-thread' }]) {
    const wire = new InteractionWire();
    const requests = [];
    const client = new CodexAppServerClient({ wire });
    const run = collect(
      client.run({
        prompt: { kind: 'frozen', prompt: 'use Pencil without a raw permission card' },
        thread,
        runtimeInteraction: {
          owner,
          declaredMcpServerNames: ['pencil'],
          port: {
            request: async (request) => {
              requests.push(request);
              return { kind: 'decision', decisionId: 'decline' };
            },
          },
        },
      }),
    );

    await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
    wire.inbox.push({
      id: 105,
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'cua_repl',
        threadId: 'provider-thread',
        turnId: 'provider-turn',
        mode: 'form',
        message: 'Allow Computer Use to use "Pencil"?',
        requestedSchema: { type: 'object', properties: {}, additionalProperties: false },
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          connector_id: 'computer-use',
          connector_name: 'Computer Use',
          persist: ['session', 'always'],
          riskLevel: 'low',
          tool_name: 'snapshot',
          tool_params: { app: 'dev.pencil.desktop' },
          tool_params_display: [{ name: 'app', display_name: 'App', value: 'Pencil' }],
        },
      },
    });

    await waitFor(() => wire.writes.some((message) => message.id === 105));
    assert.equal(requests.length, 0, thread.kind);
    assert.deepEqual(wire.writes.find((message) => message.id === 105)?.result, {
      action: 'accept',
      content: { source: 'computer-use-persisted-state', scope: 'session' },
      _meta: {
        source: 'cat-cafe-capability-lifecycle',
        persist: 'session',
        capabilityId: 'pencil',
      },
    });

    wire.inbox.push({
      method: 'turn/completed',
      params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
    });
    await run;
  }
});

test('F306 never downgrades machine-reviewed or unspecified permissions into human cards', async () => {
  for (const approvalsReviewer of ['auto_review', 'guardian_subagent', undefined]) {
    const wire = new InteractionWire();
    const requests = [];
    const client = new CodexAppServerClient({ wire });
    const run = collect(
      client.run({
        prompt: { kind: 'frozen', prompt: 'keep provider permissions off the human surface' },
        thread: { kind: 'start' },
        ...(approvalsReviewer ? { approvalsReviewer } : {}),
        runtimeInteraction: {
          owner,
          port: {
            request: async (request) => {
              requests.push(request);
              return { kind: 'decision', decisionId: 'accept' };
            },
          },
        },
      }),
    );

    await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
    wire.inbox.push({
      id: 111,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'provider-thread',
        turnId: 'provider-turn',
        itemId: 'command-item',
        startedAtMs: 1,
        command: 'pnpm test',
      },
    });
    await waitFor(() => wire.writes.some((message) => message.id === 111));
    assert.equal(requests.length, 0, String(approvalsReviewer));
    assert.deepEqual(wire.writes.find((message) => message.id === 111).result, { decision: 'decline' });

    wire.inbox.push({
      method: 'turn/completed',
      params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
    });
    await run;
  }
});

test('F306 keeps reading while a human response is pending and aborts it on transport loss', async () => {
  const wire = new InteractionWire();
  let observedSignal;
  const client = new CodexAppServerClient({ wire });
  const run = collect(
    client.run({
      prompt: { kind: 'frozen', prompt: 'wait for approval' },
      thread: { kind: 'start' },
      approvalsReviewer: 'user',
      runtimeInteraction: {
        owner,
        port: {
          request: (_request, options) => {
            observedSignal = options?.signal;
            return new Promise((_resolve, reject) => {
              observedSignal?.addEventListener('abort', () => reject(new Error('transport_lost')), { once: true });
            });
          },
        },
      },
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  wire.inbox.push({
    id: 201,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'file-item',
      startedAtMs: 3,
    },
  });
  await waitFor(() => observedSignal !== undefined);

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
  assert.equal(observedSignal.aborted, true);
  assert.equal(wire.writes.filter((message) => message.id === 201).length, 0);
});

test('F306 rejects foreign provider turn requests before publishing a human interaction', async () => {
  const wire = new InteractionWire();
  const requests = [];
  const client = new CodexAppServerClient({ wire });
  const run = collect(
    client.run({
      prompt: { kind: 'frozen', prompt: 'reject foreign interaction binding' },
      thread: { kind: 'start' },
      approvalsReviewer: 'user',
      runtimeInteraction: {
        owner,
        port: {
          request: async (request) => {
            requests.push(request);
            return { kind: 'decision', decisionId: 'accept' };
          },
        },
      },
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  for (const [id, threadId, turnId] of [
    [211, 'foreign-thread', 'provider-turn'],
    [212, 'provider-thread', 'foreign-turn'],
  ]) {
    wire.inbox.push({
      id,
      method: 'item/fileChange/requestApproval',
      params: { threadId, turnId, itemId: `file-${id}`, startedAtMs: id },
    });
  }
  await waitFor(() => [211, 212].every((id) => wire.writes.some((message) => message.id === id)));
  assert.equal(requests.length, 0);
  for (const id of [211, 212]) {
    const response = wire.writes.find((message) => message.id === id);
    assert.equal(response.error.code, -32602);
  }

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
});

test('F306 ignores a foreign turn terminal and keeps the root callback surface alive', async () => {
  const wire = new InteractionWire();
  const requests = [];
  const client = new CodexAppServerClient({ wire });
  const running = collect(
    client.run({
      prompt: { kind: 'frozen', prompt: 'keep the root turn alive' },
      thread: { kind: 'start' },
      approvalsReviewer: 'user',
      runtimeInteraction: {
        owner,
        port: {
          request: async (request) => {
            requests.push(request);
            return { kind: 'answers', answers: { choice: ['continue'] } };
          },
        },
      },
    }),
  );
  let settled = false;
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'foreign-thread', turn: { id: 'foreign-turn', status: 'completed' } },
  });
  await delay(20);
  assert.equal(settled, false, 'a foreign terminal must not end the active root run');

  wire.inbox.push({
    id: 213,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'root-question',
      isBlocking: true,
      questions: [{ id: 'choice', header: 'Choice', question: 'Continue?' }],
    },
  });
  await waitFor(() => wire.writes.some((message) => message.id === 213));
  assert.equal(requests.length, 1);

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await running;
});

test('F306 keeps child output typed and waits for the exact root terminal', async () => {
  const childThreadId = 'provider-child-thread';
  const childTurnId = 'provider-child-turn';
  const childPath = '/root/review_knowledge_delta';
  const wire = new InteractionWire({
    [childThreadId]: {
      id: childThreadId,
      parentThreadId: 'provider-thread',
      agentNickname: 'Bohr',
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: 'provider-thread',
            agent_path: childPath,
            agent_nickname: 'Bohr',
            agent_role: null,
            depth: 1,
          },
        },
      },
      turns: [],
    },
  });
  const requests = [];
  const invalidations = [];
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });
  const running = collect(
    service.invoke('delegate one bounded read-only check', {
      invocationId: owner.invocationId,
      auditContext: {
        invocationId: owner.invocationId,
        threadId: owner.threadId,
        userId: owner.userId,
        catId: owner.catId,
      },
      agentCarrierSessionFactory: async () => wire,
      runtimeInteractionPort: {
        request: async (request) => {
          requests.push(request);
          return { kind: 'answers', answers: { choice: ['continue'] } };
        },
        invalidateInvocation: async (invocationId, reasonCode) => {
          invalidations.push({ invocationId, reasonCode });
          return [];
        },
      },
    }),
  );
  let settled = false;
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  const activity = {
    type: 'subAgentActivity',
    id: 'call-subagent-1',
    kind: 'started',
    agentThreadId: childThreadId,
    agentPath: childPath,
  };
  wire.inbox.push({
    method: 'item/started',
    params: { threadId: 'provider-thread', turnId: 'provider-turn', item: activity },
    emittedAtMs: 100,
  });
  wire.inbox.push({
    method: 'item/completed',
    params: { threadId: 'provider-thread', turnId: 'provider-turn', item: activity },
    emittedAtMs: 100,
  });
  wire.inbox.push({
    method: 'item/started',
    params: { threadId: 'provider-thread', turnId: 'provider-turn', item: activity },
    emittedAtMs: 100,
  });
  wire.inbox.push({
    method: 'turn/started',
    params: { threadId: childThreadId, turn: { id: childTurnId, status: 'inProgress' } },
    emittedAtMs: 101,
  });
  for (const [id, text, phase, emittedAtMs] of [
    ['child-commentary', 'child progress must stay out of root text', 'commentary', 102],
    ['child-final', 'Approve from the child only', 'final_answer', 103],
  ]) {
    wire.inbox.push({
      method: 'item/completed',
      params: {
        threadId: childThreadId,
        turnId: childTurnId,
        item: { id, type: 'agentMessage', text, phase },
      },
      emittedAtMs,
    });
  }
  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: childThreadId, turn: { id: childTurnId, status: 'completed' } },
    emittedAtMs: 104,
  });

  await delay(20);
  assert.equal(settled, false, 'a linked child terminal must not end the root run');
  assert.deepEqual(wire.writes.find((message) => message.method === 'thread/read')?.params, {
    threadId: childThreadId,
    includeTurns: false,
  });
  assert.equal(
    wire.writes.filter((message) => message.method === 'thread/read').length,
    1,
    'replaying an identical activity must not rehydrate or re-register the child',
  );

  wire.inbox.push({
    id: 214,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'root-question-after-child',
      isBlocking: true,
      questions: [{ id: 'choice', header: 'Choice', question: 'Continue?' }],
    },
  });
  await waitFor(() => wire.writes.some((message) => message.id === 214));
  assert.equal(requests.length, 1, 'root interaction remains live after child completion');

  wire.inbox.push({
    method: 'item/completed',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      item: { id: 'root-final', type: 'agentMessage', text: 'root final survives', phase: 'final_answer' },
    },
    emittedAtMs: 105,
  });
  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
    emittedAtMs: 106,
  });

  const output = await running;
  const text = output
    .filter((message) => message.type === 'text')
    .map((message) => message.content)
    .join('');
  assert.match(text, /root final survives/);
  assert.doesNotMatch(text, /child progress|Approve from the child/);

  const childEvents = output.map((message) => message.semanticEvent).filter((event) => event?.kind === 'subexecution');
  assert.deepEqual(
    childEvents.map((event) => event.stage),
    ['started', 'message', 'message', 'completed'],
  );
  assert.ok(
    childEvents.every(
      (event) =>
        event.subexecutionId === childThreadId &&
        event.rootExecutionId === 'provider-thread' &&
        event.parentExecutionId === 'provider-thread' &&
        event.rootTurnId === 'provider-turn' &&
        event.parentTurnId === 'provider-turn' &&
        event.agentPath === childPath &&
        event.nickname === 'Bohr' &&
        event.depth === 1,
    ),
  );

  const finalMessage = output.find((message) => message.type === 'text' && message.content.includes('root final'));
  assert.ok(finalMessage);
  assert.deepEqual(finalMessage.metadata.subexecutionEvents, childEvents);
  assert.deepEqual(safeParseMetadata(JSON.stringify(finalMessage.metadata))?.subexecutionEvents, childEvents);
  assert.deepEqual(invalidations, [{ invocationId: owner.invocationId, reasonCode: 'provider_cancelled' }]);
});

test('F306 bounds optional child identity hydration without stalling the root turn', async () => {
  const wire = new InteractionWire();
  const originalWrite = wire.write.bind(wire);
  wire.write = async (message) => {
    if (message.method === 'thread/read') {
      wire.writes.push(message);
      return;
    }
    await originalWrite(message);
  };
  const client = new CodexAppServerClient({ wire });
  const startedAt = Date.now();
  const running = collect(
    client.run({
      prompt: { kind: 'frozen', prompt: 'do not let optional identity reads own liveness' },
      thread: { kind: 'start' },
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  wire.inbox.push({
    method: 'item/started',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      item: {
        type: 'subAgentActivity',
        id: 'call-slow-hydration',
        kind: 'started',
        agentThreadId: 'slow-child',
        agentPath: '/root/slow_child',
      },
    },
  });
  wire.inbox.push({
    method: 'turn/started',
    params: { threadId: 'slow-child', turn: { id: 'slow-child-turn', status: 'inProgress' } },
  });
  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'slow-child', turn: { id: 'slow-child-turn', status: 'completed' } },
  });
  wire.inbox.push({
    method: 'item/completed',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      item: { id: 'root-final-after-slow-read', type: 'agentMessage', text: 'root still completes' },
    },
  });
  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });

  const output = await running;
  assert.ok(Date.now() - startedAt < 1_000, 'metadata hydration is bounded and cannot own root liveness');
  assert.equal(output.filter((event) => event.type === 'turn.completed').length, 1);
  const childStart = output.find((event) => event.type === 'app_server.subexecution');
  assert.equal(childStart?.nickname, undefined);
  assert.equal(childStart?.depth, 1);
});

test('F306 keeps semantic event ids collision-safe for opaque provider coordinates', async () => {
  const paths = new Map([
    ['a:b', '/root/first_child'],
    ['a', '/root/second_child'],
  ]);
  const tracker = createCodexSubexecutionTracker({
    binding: { threadId: 'root', turnId: 'root-turn' },
    readThread: async (threadId) => ({
      thread: {
        id: threadId,
        parentThreadId: 'root',
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: 'root',
              agent_path: paths.get(threadId),
              depth: 1,
            },
          },
        },
      },
    }),
  });
  const messageIds = [];
  for (const child of [
    { threadId: 'a:b', turnId: 'c', path: '/root/first_child', activityId: 'activity-1' },
    { threadId: 'a', turnId: 'b:c', path: '/root/second_child', activityId: 'activity-2' },
  ]) {
    await tracker.observe({
      method: 'item/started',
      params: {
        threadId: 'root',
        turnId: 'root-turn',
        item: {
          id: child.activityId,
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: child.threadId,
          agentPath: child.path,
        },
      },
    });
    await tracker.observe({
      method: 'turn/started',
      params: { threadId: child.threadId, turn: { id: child.turnId, status: 'inProgress' } },
    });
    const observation = await tracker.observe({
      method: 'item/completed',
      params: {
        threadId: child.threadId,
        turnId: child.turnId,
        item: { id: 'd', type: 'agentMessage', text: 'child result', phase: 'final_answer' },
      },
    });
    messageIds.push(observation.event?.event_id);
  }

  assert.ok(
    messageIds.every((id) => typeof id === 'string'),
    `both linked child messages must become typed events: ${JSON.stringify(messageIds)}`,
  );
  assert.equal(new Set(messageIds).size, 2, 'opaque coordinate delimiters must not collapse distinct child events');
});

test('F306 preserves the fail-closed MCP approval compatibility response', async () => {
  const wire = new InteractionWire();
  const requests = [];
  const client = new CodexAppServerClient({ wire });
  const run = collect(
    client.run({
      prompt: { kind: 'frozen', prompt: 'preserve MCP approval compatibility' },
      thread: { kind: 'start' },
      approvalsReviewer: 'user',
      runtimeInteraction: {
        owner,
        port: {
          request: async (request) => {
            requests.push(request);
            return { kind: 'answers', answers: {} };
          },
        },
      },
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  wire.inbox.push({
    id: 221,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'compat-approval',
      questions: [
        {
          id: 'mcp_tool_call_approval_1',
          header: 'MCP approval',
          question: 'Allow tool?',
          options: [],
        },
      ],
    },
  });
  await waitFor(() => wire.writes.some((message) => message.id === 221));
  assert.equal(requests.length, 0);
  assert.deepEqual(wire.writes.find((message) => message.id === 221).result, {
    answers: { mcp_tool_call_approval_1: { answers: ['__codex_mcp_decline__'] } },
  });

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
});

test('F306 skips unknown notifications with bounded metadata-only observability', async () => {
  const wire = new InteractionWire();
  const observed = [];
  const client = new CodexAppServerClient({
    wire,
    onUnsupportedNotification: async (observation) => observed.push(observation),
  });
  const run = collect(
    client.run({
      prompt: { kind: 'frozen', prompt: 'ignore future notifications safely' },
      thread: { kind: 'start' },
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  for (let index = 0; index < 10; index++) {
    wire.inbox.push({
      method: `future/notification/${index}/${'x'.repeat(80)}`,
      params: { secret: `must-not-be-observed-${index}` },
    });
  }
  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;

  assert.equal(observed.length, 8);
  assert.ok(observed.every((entry) => entry.method.length <= 64));
  assert.doesNotMatch(JSON.stringify(observed), /must-not-be-observed/);
});

test('F306 rejects an unknown server request without publishing a human interaction', async () => {
  const wire = new InteractionWire();
  const requests = [];
  const client = new CodexAppServerClient({ wire });
  const run = collect(
    client.run({
      prompt: { kind: 'frozen', prompt: 'reject unsupported requests' },
      thread: { kind: 'start' },
      runtimeInteraction: {
        owner,
        port: {
          request: async (request) => {
            requests.push(request);
            return { kind: 'decision', decisionId: 'accept' };
          },
        },
      },
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  wire.inbox.push({ id: 231, method: 'future/safety/requestApproval', params: {} });
  await waitFor(() => wire.writes.some((message) => message.id === 231));

  assert.equal(requests.length, 0);
  assert.deepEqual(wire.writes.find((message) => message.id === 231).error, {
    code: -32601,
    message: 'Unsupported app-server request: future/safety/requestApproval',
  });

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
});

test('F306 production invocation keeps routine approvals in machine review and binds human questions to the exact owner', async () => {
  const wire = new InteractionWire();
  const requests = [];
  const invalidations = [];
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });
  const run = collect(
    service.invoke('exercise production interaction wiring', {
      invocationId: owner.invocationId,
      auditContext: {
        invocationId: owner.invocationId,
        threadId: owner.threadId,
        userId: owner.userId,
        catId: owner.catId,
      },
      agentCarrierSessionFactory: async () => wire,
      runtimeInteractionPort: {
        request: async (request) => {
          requests.push(request);
          return request.kind === 'question'
            ? { kind: 'answers', answers: { environment: ['Alpha'] } }
            : { kind: 'decision', decisionId: 'accept' };
        },
        invalidateInvocation: async (invocationId, reasonCode) => {
          invalidations.push({ invocationId, reasonCode });
          return [];
        },
      },
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  const threadStart = wire.writes.find((message) => message.method === 'thread/start');
  assert.equal(threadStart.params.approvalsReviewer, 'auto_review');
  assert.doesNotMatch(threadStart.params.developerInstructions, /confirmation_unavailable/);

  for (const request of [
    {
      id: 300,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'provider-thread',
        turnId: 'provider-turn',
        itemId: 'command-item',
        startedAtMs: 3,
        command: 'pnpm test',
      },
    },
    {
      id: 301,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'provider-thread',
        turnId: 'provider-turn',
        itemId: 'file-item',
        startedAtMs: 4,
      },
    },
  ]) {
    wire.inbox.push(request);
  }
  await waitFor(() => [300, 301].every((id) => wire.writes.some((message) => message.id === id)));
  assert.equal(requests.length, 0);
  for (const id of [300, 301]) {
    assert.deepEqual(wire.writes.find((message) => message.id === id).result, { decision: 'decline' });
  }

  wire.inbox.push({
    id: 303,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'question-item',
      isBlocking: true,
      questions: [{ id: 'environment', header: 'Environment', question: 'Where?' }],
    },
  });
  await waitFor(() => requests.length === 1);
  assert.equal(requests[0].kind, 'question');
  assert.deepEqual(requests[0].owner, owner);
  await waitFor(() => wire.writes.some((message) => message.id === 303));

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
  assert.deepEqual(invalidations.at(-1), {
    invocationId: owner.invocationId,
    reasonCode: 'provider_cancelled',
  });
});

test('F306 production invocation reports confirmation_unavailable when no live interaction port exists', async () => {
  const wire = new InteractionWire();
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });
  const run = collect(
    service.invoke('exercise unavailable interaction wiring', {
      invocationId: owner.invocationId,
      auditContext: {
        invocationId: owner.invocationId,
        threadId: owner.threadId,
        userId: owner.userId,
        catId: owner.catId,
      },
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  const threadStart = wire.writes.find((message) => message.method === 'thread/start');
  assert.equal(threadStart.params.approvalsReviewer, 'auto_review');
  assert.match(threadStart.params.developerInstructions, /confirmation_unavailable/);

  wire.inbox.push({
    id: 302,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'question-item',
      isBlocking: true,
      questions: [{ id: 'environment', header: 'Environment', question: 'Where?' }],
    },
  });
  await waitFor(() => wire.writes.some((message) => message.id === 302));
  assert.deepEqual(
    wire.writes.find((message) => message.id === 302),
    {
      id: 302,
      error: {
        code: -32001,
        message: 'Runtime interaction unavailable',
        data: { reasonCode: 'confirmation_unavailable' },
      },
    },
  );

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
});

test('F306 production invocation derives Pencil consent from the existing resolved capability lifecycle', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'f306-cua-capability-'));
  const pencilBinary = join(projectDir, 'pencil-mcp-server');
  const previousPencilBinary = process.env.PENCIL_MCP_BIN;
  const previousPencilApp = process.env.PENCIL_MCP_APP;
  mkdirSync(join(projectDir, '.cat-cafe'), { recursive: true });
  writeFileSync(pencilBinary, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(pencilBinary, 0o755);
  writeFileSync(
    join(projectDir, '.cat-cafe', 'capabilities.json'),
    JSON.stringify({
      version: 1,
      capabilities: [
        {
          id: 'pencil',
          type: 'mcp',
          globalEnabled: true,
          source: 'cat-cafe',
          mcpServer: { resolver: 'pencil', command: '', args: [] },
        },
      ],
    }),
    'utf8',
  );
  process.env.PENCIL_MCP_BIN = pencilBinary;
  process.env.PENCIL_MCP_APP = 'vscode';

  try {
    const wire = new InteractionWire();
    const requests = [];
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      cliCommand: process.execPath,
      l0CompilerFn: fakeL0Compiler,
      model: 'gpt-5.6-sol',
    });
    const run = collect(
      service.invoke('exercise canonical Pencil capability consent', {
        workingDirectory: projectDir,
        invocationId: owner.invocationId,
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
          CAT_CAFE_INVOCATION_ID: owner.invocationId,
          CAT_CAFE_CALLBACK_TOKEN: 'callback-token',
          CAT_CAFE_CAT_ID: 'codex',
        },
        auditContext: {
          invocationId: owner.invocationId,
          threadId: owner.threadId,
          userId: owner.userId,
          catId: owner.catId,
        },
        runtimeInteractionPort: {
          request: async (request) => {
            requests.push(request);
            return { kind: 'decision', decisionId: 'decline' };
          },
          invalidateInvocation: async () => [],
        },
        agentCarrierSessionFactory: async () => wire,
      }),
    );

    await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
    wire.inbox.push({
      id: 304,
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'cua_repl',
        threadId: 'provider-thread',
        turnId: 'provider-turn',
        mode: 'form',
        message: 'Allow Computer Use to use "Pencil"?',
        requestedSchema: { type: 'object', properties: {}, additionalProperties: false },
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          connector_id: 'computer-use',
          tool_name: 'snapshot',
          tool_params: { app: 'dev.pencil.desktop' },
        },
      },
    });

    await waitFor(() => wire.writes.some((message) => message.id === 304));
    assert.equal(requests.length, 0);
    assert.equal(wire.writes.find((message) => message.id === 304)?.result?.action, 'accept');
    wire.inbox.push({
      method: 'turn/completed',
      params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
    });
    await run;
  } finally {
    if (previousPencilBinary === undefined) delete process.env.PENCIL_MCP_BIN;
    else process.env.PENCIL_MCP_BIN = previousPencilBinary;
    if (previousPencilApp === undefined) delete process.env.PENCIL_MCP_APP;
    else process.env.PENCIL_MCP_APP = previousPencilApp;
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('F306 maps an explicit ideate route to a current-turn Codex Plan collaboration mode', async () => {
  const wire = new InteractionWire();
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });
  const run = collect(
    service.invoke('ask before proceeding', {
      routeIntent: { intent: 'ideate', explicit: true },
      reasoningEffortOverride: 'medium',
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  const initialize = wire.writes.find((message) => message.method === 'initialize');
  const threadStart = wire.writes.find((message) => message.method === 'thread/start');
  const turnStart = wire.writes.find((message) => message.method === 'turn/start');
  assert.deepEqual(initialize.params.capabilities, { experimentalApi: true });
  assert.deepEqual(turnStart.params.collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-5.6-sol',
      reasoning_effort: 'medium',
      developer_instructions: threadStart.params.developerInstructions,
    },
  });

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
});

test('F306 omits a collaboration override for a fresh execute provider thread', async () => {
  const wire = new InteractionWire();
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });
  const run = collect(
    service.invoke('execute normally', {
      routeIntent: { intent: 'execute', explicit: false },
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  const initialize = wire.writes.find((message) => message.method === 'initialize');
  const turnStart = wire.writes.find((message) => message.method === 'turn/start');
  assert.deepEqual(initialize.params.capabilities, {});
  assert.equal(Object.hasOwn(turnStart.params, 'collaborationMode'), false);

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
});

test('F306 explicitly restores Default when execute resumes a provider thread after ideate', async () => {
  const wire = new InteractionWire();
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });
  const run = collect(
    service.invoke('execute after ideate', {
      routeIntent: { intent: 'execute', explicit: false },
      sessionId: 'provider-thread',
      reasoningEffortOverride: 'medium',
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  const initialize = wire.writes.find((message) => message.method === 'initialize');
  const threadResume = wire.writes.find((message) => message.method === 'thread/resume');
  const turnStart = wire.writes.find((message) => message.method === 'turn/start');
  assert.deepEqual(initialize.params.capabilities, { experimentalApi: true });
  assert.equal(threadResume.params.threadId, 'provider-thread');
  assert.deepEqual(turnStart.params.collaborationMode, {
    mode: 'default',
    settings: {
      model: 'gpt-5.6-sol',
      reasoning_effort: 'medium',
      developer_instructions: threadResume.params.developerInstructions,
    },
  });

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
});

test('F306 keeps an automatic multi-cat ideate route in Default on a fresh provider thread', async () => {
  const wire = new InteractionWire();
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });
  const run = collect(
    service.invoke('work independently with another cat', {
      routeIntent: { intent: 'ideate', explicit: false },
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  const initialize = wire.writes.find((message) => message.method === 'initialize');
  const turnStart = wire.writes.find((message) => message.method === 'turn/start');
  assert.deepEqual(initialize.params.capabilities, {});
  assert.equal(Object.hasOwn(turnStart.params, 'collaborationMode'), false);

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
});

test('F306 restores Default when an automatic multi-cat ideate route resumes a provider thread', async () => {
  const wire = new InteractionWire();
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });
  const run = collect(
    service.invoke('work independently after an explicit ideate turn', {
      routeIntent: { intent: 'ideate', explicit: false },
      sessionId: 'provider-thread',
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  const initialize = wire.writes.find((message) => message.method === 'initialize');
  const turnStart = wire.writes.find((message) => message.method === 'turn/start');
  assert.deepEqual(initialize.params.capabilities, { experimentalApi: true });
  assert.equal(turnStart.params.collaborationMode.mode, 'default');

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } },
  });
  await run;
});
