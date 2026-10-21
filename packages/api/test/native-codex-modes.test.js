import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import {
  CodexAgentService,
  resolveCodexSchemaModelFamily,
} from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';

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
    if (message.method === 'config/read')
      this.inbox.push({
        id: message.id,
        result: { config: { model_provider: 'local-provider', sqlite_home: this.launchEnv.CODEX_SQLITE_HOME } },
      });
    if (message.method === 'configRequirements/read')
      this.inbox.push({ id: message.id, result: { requirements: null } });
    if (message.method === 'account/read') this.inbox.push({ id: message.id, result: { account: { type: 'apiKey' } } });
    if (message.method === 'thread/start') {
      this.inbox.push({
        id: message.id,
        result: { model: 'native-effective', reasoningEffort: 'high', thread: { id: 'provider-thread' } },
      });
    }
    if (message.method === 'thread/resume') {
      this.inbox.push({
        id: message.id,
        result: { model: 'native-effective', reasoningEffort: 'high', thread: { id: message.params.threadId } },
      });
    }
    if (message.method === 'turn/start') {
      setImmediate(() =>
        this.inbox.push({
          method: 'turn/completed',
          params: { threadId: message.params.threadId, turn: { id: 'provider-turn', status: 'completed' } },
        }),
      );
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

for (const model of ['', 'role-override']) {
  for (const resume of [false, true]) {
    test('native Codex collaboration preserves inherited settings: model=' + model + ', resume=' + resume, async () => {
      const id = 'native-mode-' + (model || 'inherit') + '-' + resume;
      catRegistry.register(id, {
        ...catRegistry.tryGet('codex').config,
        id,
        clientId: 'openai',
        carrier: 'app_server',
        configurationSource: 'native_tool',
        defaultModel: model,
        cli: { command: 'codex', outputFormat: 'json' },
      });
      const wire = new InteractionWire();
      const service = new CodexAgentService({
        catId: id,
        carrierMode: 'app_server',
        cliCommand: process.execPath,
        l0CompilerFn: async () => 'fixture L0',
      });
      const messages = [];
      for await (const message of service.invoke('fixture', {
        routeIntent: { intent: resume ? 'execute' : 'ideate', explicit: !resume },
        ...(resume ? { sessionId: 'provider-thread' } : {}),
        agentCarrierSessionFactory: async (options) => {
          wire.launchEnv = options.env;
          return wire;
        },
      }))
        messages.push(message);
      assert.equal(
        messages.some((message) => message.type === 'error'),
        false,
      );
      assert.equal(wire.launchEnv.CODEX_AUTH_MODE, 'auto', 'CLI-owned provider must not be forced to OAuth');
      const turn = wire.writes.find((message) => message.method === 'turn/start');
      assert.ok(turn?.params.collaborationMode);
      assert.equal(turn.params.collaborationMode.mode, resume ? 'default' : 'plan');
      assert.equal(turn.params.collaborationMode.settings.model, model || 'native-effective');
      assert.notEqual(turn.params.collaborationMode.settings.reasoning_effort, '');
      assert.equal(
        turn.params.collaborationMode.settings.reasoning_effort,
        'high',
        'use adopted thread effort, never an application default',
      );
      const thread = wire.writes.find((message) => message.method === (resume ? 'thread/resume' : 'thread/start'));
      if (!model) assert.equal(Object.hasOwn(thread.params, 'model'), false);
    });
  }
}

test('native collaboration stops before prompt when the adopted model is unavailable', async () => {
  const id = 'native-mode-unknown';
  catRegistry.register(id, {
    ...catRegistry.tryGet('codex').config,
    id,
    clientId: 'openai',
    carrier: 'app_server',
    configurationSource: 'native_tool',
    defaultModel: '',
    cli: { command: 'codex', outputFormat: 'json' },
  });
  const wire = new InteractionWire();
  const write = wire.write.bind(wire);
  wire.write = async (message) => {
    if (message.method !== 'thread/start') return write(message);
    wire.writes.push(message);
    wire.inbox.push({ id: message.id, result: { thread: { id: 'provider-thread' } } });
  };
  const service = new CodexAgentService({
    catId: id,
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: async () => 'fixture L0',
  });
  const messages = [];
  for await (const message of service.invoke('fixture', {
    routeIntent: { intent: 'ideate', explicit: true },
    agentCarrierSessionFactory: async (options) => {
      wire.launchEnv = options.env;
      return wire;
    },
  }))
    messages.push(message);
  assert.equal(
    wire.writes.some((message) => message.method === 'turn/start'),
    false,
  );
  assert.ok(
    wire.writes.some((message) => message.method === 'thread/start'),
    'exercise the adopted-model boundary',
  );
  assert.ok(messages.some((message) => message.type === 'error'));
});

test('native Codex projects inherited empty model to a valid schema capability family', () => {
  assert.equal(resolveCodexSchemaModelFamily(''), 'unknown');
  assert.equal(resolveCodexSchemaModelFamily('  '), 'unknown');
  assert.equal(resolveCodexSchemaModelFamily('gpt-5.6-sol'), 'gpt-5.6-sol');
});
