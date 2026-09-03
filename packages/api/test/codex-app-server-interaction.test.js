import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerClient } from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';
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
      this.inbox.push({ id: message.id, result: { thread: { id: 'provider-thread' } } });
    }
    if (message.method === 'thread/resume') {
      this.inbox.push({ id: message.id, result: { thread: { id: message.params.threadId } } });
    }
    if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: 'provider-turn', status: 'inProgress' } } });
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
