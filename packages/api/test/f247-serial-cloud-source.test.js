import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const humanContent = '你身为布偶猫怎么看缅因猫？';
const catContent = '@gpt-pro\n我是本地布偶猫，请收到后回一声喵。';

async function dispatch({
  initialProvenance = false,
  missingCatSource = false,
  catSourceOverrides,
  directCloud = false,
} = {}) {
  const messageStore = new MessageStore();
  const source = messageStore.append({
    userId: 'alice',
    catId: null,
    threadId: 'serial-cloud',
    content: humanContent,
    mentions: ['opus'],
    timestamp: Date.now(),
  });
  const lookup = messageStore.getById.bind(messageStore);
  messageStore.getById = (id) => {
    const value = lookup(id);
    if (value?.catId !== 'opus') return value;
    return missingCatSource ? null : { ...value, ...catSourceOverrides };
  };
  const calls = [];
  const grants = [];
  let invocationSeq = 0;
  const service = {
    async *invoke() {
      yield { type: 'text', catId: 'opus', content: catContent, timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };
  const deps = {
    services: { opus: service, 'gpt-pro': { usesChainKeyResume: () => false } },
    messageStore,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `token-${invocationSeq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:0',
      cloudReturnGrantStore: {
        issue: async (grant) => {
          grants.push(grant);
          return { ok: true };
        },
      },
      cloudInvokeBridge: {
        dispatch: async (params) => {
          calls.push(params);
          return {
            kind: 'sent',
            transport: 'host',
            hostMessageId: 'host-source',
            capturedUrl: 'https://chatgpt.com/c/test',
          };
        },
      },
    },
  };
  const options = {
    currentUserMessageId: source.id,
    ownerAuthProvenance: 'strict',
    invocationController: new AbortController(),
    trackA2ASlot: () => true,
    completeA2ASlots() {},
    ...(initialProvenance
      ? {
          cloudDispatchProvenance: {
            sourceMessageId: source.id,
            sourceSender: { kind: 'user', id: 'alice' },
            calledByCatId: 'alice',
            intent: humanContent,
          },
        }
      : {}),
  };
  for await (const _event of routeSerial(
    deps,
    [directCloud ? 'gpt-pro' : 'opus'],
    humanContent,
    'alice',
    'serial-cloud',
    options,
  )) {
    /* drain */
  }
  return {
    calls,
    grants,
    humanSource: source,
    catSource: messageStore.getByThread('serial-cloud').find((m) => m.catId === 'opus'),
  };
}

for (const initialProvenance of [false, true]) {
  test(`serial cat-to-cloud handoff uses the cat's exact body/sender/source (initial provenance=${initialProvenance})`, async () => {
    const { calls, grants, catSource } = await dispatch({ initialProvenance });
    assert.ok(catSource);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sourceMessageId, catSource.id);
    assert.equal(calls[0].calledBy, 'opus');
    assert.equal(calls[0].intent, catContent);
    assert.equal(grants[0].sourceMessageId, catSource.id);
  });
}

test('a missing persisted cat source never falls back to the prior human body', async () => {
  const { calls, grants } = await dispatch({ missingCatSource: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(grants, []);
});

for (const catSourceOverrides of [
  { deletedAt: 1 },
  { _tombstone: true },
  { threadId: 'foreign' },
  { userId: 'other-owner' },
  { catId: 'codex' },
]) {
  test(`an invalid cat handoff cannot mint a cloud return grant: ${JSON.stringify(catSourceOverrides)}`, async () => {
    const { calls, grants } = await dispatch({ catSourceOverrides });
    assert.deepEqual(calls, []);
    assert.deepEqual(grants, []);
  });
}

for (const initialProvenance of [false, true]) {
  test(`direct human-to-cloud dispatch retains its own source (initial provenance=${initialProvenance})`, async () => {
    const { calls, grants, humanSource } = await dispatch({ directCloud: true, initialProvenance });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].calledBy, 'alice');
    assert.equal(calls[0].intent, humanContent);
    assert.equal(calls[0].sourceMessageId, humanSource.id);
    assert.equal(grants[0].sourceMessageId, humanSource.id);
  });
}
