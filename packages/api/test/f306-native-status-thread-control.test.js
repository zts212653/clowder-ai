import assert from 'node:assert/strict';
import { test } from 'node:test';

const controlModule = import('../dist/domains/cats/services/agents/providers/CodexAppServerStatusControl.js');

class Inbox {
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

function nativeWire({ rateLimitFailure = false } = {}) {
  const inbox = new Inbox();
  const writes = [];
  return {
    writes,
    wire: {
      read: () => inbox,
      write: async (message) => {
        writes.push(message);
        if (message.method === 'initialize') inbox.push({ id: message.id, result: {} });
        if (message.method === 'thread/resume') {
          inbox.push({
            id: message.id,
            result: {
              thread: { id: 'native-source', status: { type: 'idle' }, canAcceptDirectInput: true },
              activePermissionProfile: { id: ':danger-full-access' },
            },
          });
        }
        if (message.method === 'thread/read') {
          inbox.push({
            id: message.id,
            result: { thread: { id: 'native-source', status: { type: 'idle' }, canAcceptDirectInput: true } },
          });
        }
        if (message.method === 'modelProvider/capabilities/read') {
          inbox.push({ id: message.id, result: { imageGeneration: true, namespaceTools: false, webSearch: true } });
        }
        if (message.method === 'permissionProfile/list') {
          inbox.push({
            id: message.id,
            result: {
              data: [
                { id: ':workspace', allowed: true },
                { id: ':danger-full-access', allowed: true },
              ],
            },
          });
        }
        if (message.method === 'account/read') {
          inbox.push({
            id: message.id,
            result: {
              account: { type: 'chatgpt', email: 'must-not-leak@example.com', planType: 'pro' },
              requiresOpenaiAuth: true,
            },
          });
        }
        if (message.method === 'account/rateLimits/read') {
          inbox.push(
            rateLimitFailure
              ? { id: message.id, error: { code: -32000, message: 'rate backend unavailable' } }
              : {
                  id: message.id,
                  result: {
                    rateLimits: {
                      primary: { usedPercent: 17, resetsAt: 200 },
                      secondary: null,
                      rateLimitReachedType: null,
                    },
                  },
                },
          );
        }
        if (message.method === 'thread/list') {
          inbox.push({
            id: message.id,
            result: {
              data: [{ id: 'native-source' }, { id: 'provider-only-history' }],
              nextCursor: 'opaque-cursor',
            },
          });
        }
        if (message.method === 'thread/fork') {
          inbox.push({
            id: message.id,
            result: {
              thread: { id: 'native-fork', forkedFromId: 'native-source' },
              activePermissionProfile: { id: ':danger-full-access' },
            },
          });
        }
      },
      close: async () => inbox.close(),
      terminate: async () => inbox.close(),
    },
  };
}

test('status reads authoritative groups independently and keeps provider list diagnostic-only', async () => {
  const { requestCodexAppServerStatus } = await controlModule;
  const fixture = nativeWire({ rateLimitFailure: true });
  const result = await requestCodexAppServerStatus({
    wire: fixture.wire,
    threadId: 'native-source',
    timeoutMs: 1_000,
    cwd: '/tmp/project',
    observedAt: 123_456,
  });

  assert.equal(result.source, 'codex_app_server');
  assert.equal(result.observedAt, 123_456);
  assert.deepEqual(result.thread, { availability: 'available', status: 'idle', canAcceptDirectInput: true });
  assert.deepEqual(result.capabilities, {
    availability: 'available',
    imageGeneration: true,
    namespaceTools: false,
    webSearch: true,
  });
  assert.deepEqual(result.permissionProfiles, {
    availability: 'available',
    activeId: ':danger-full-access',
    profiles: [
      { id: ':workspace', allowed: true },
      { id: ':danger-full-access', allowed: true },
    ],
  });
  assert.deepEqual(result.account, { availability: 'available', authenticated: true, kind: 'chatgpt', plan: 'pro' });
  assert.deepEqual(result.rateLimits, { availability: 'unavailable', reason: 'provider_request_failed' });
  assert.deepEqual(result.nativeThreadList, {
    availability: 'available',
    count: 2,
    boundThreadPresent: true,
    hasMore: true,
  });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('native fork returns binding evidence only and cannot select an ambient provider thread', async () => {
  const { requestCodexAppServerFork } = await controlModule;
  const fixture = nativeWire();
  const result = await requestCodexAppServerFork({
    wire: fixture.wire,
    threadId: 'native-source',
    timeoutMs: 1_000,
    observedAt: 123_456,
  });

  assert.deepEqual(result, {
    sourceRuntimeSessionId: 'native-source',
    forkedRuntimeSessionId: 'native-fork',
    observedAt: 123_456,
    source: 'codex_app_server',
  });
  const fork = fixture.writes.find((message) => message.method === 'thread/fork');
  assert.deepEqual(fork.params, {
    threadId: 'native-source',
    excludeTurns: true,
    deferGoalContinuation: true,
  });
});
