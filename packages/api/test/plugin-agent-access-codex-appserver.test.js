import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createAgentAccessCodexAppServerNotificationProjection,
  createAgentAccessCodexAppServerThreadPlanner,
  createAgentAccessCodexAppServerTurnPlanner,
} from '../dist/domains/plugin/agent-access/codex-appserver.js';

function authority(overrides = {}) {
  return {
    instance: {
      pluginInstanceId: 'inst-1',
      packageDigest: 'digest-1',
      lifecycleRevision: 3,
      activationState: 'enabled',
      runtimeState: 'healthy',
      ...overrides,
    },
  };
}

function harness(action, options = {}) {
  return (
    action === 'planCodexAppServerThread'
      ? createAgentAccessCodexAppServerThreadPlanner
      : createAgentAccessCodexAppServerTurnPlanner
  )(
    { readCurrentAuthority: async () => ('authority' in options ? options.authority : authority()) },
    {
      invoke: async (_id, name, payload) => {
        options.onPlan?.(name, payload);
        return options.result;
      },
    },
  );
}

const threadRequest = {
  operation: 'plan_app_server_thread',
  client: 'codex',
  kind: 'start',
  groups: { model: '__CAT_CAFE_CODEX_AS_model__' },
  options: { sandbox: 'read-only' },
};
const turnRequest = {
  operation: 'plan_app_server_turn',
  client: 'codex',
  groups: { threadId: '__CAT_CAFE_CODEX_AS_thread__' },
};

describe('Codex app-server planners over the public protocol', () => {
  test('thread plans through the active package and exposes generation check', async () => {
    let seen;
    const plan = harness('planCodexAppServerThread', {
      result: { params: { model: threadRequest.groups.model }, startParams: undefined },
      onPlan: (name, payload) => (seen = { name, payload }),
    });
    const result = await plan(threadRequest);
    assert.deepEqual(seen, { name: 'planCodexAppServerThread', payload: threadRequest });
    assert.equal(result.params.model, threadRequest.groups.model);
    assert.equal(typeof result.assertCurrent, 'function');
  });

  test('turn plans through the active package', async () => {
    let seen;
    const plan = harness('planCodexAppServerTurn', {
      result: { params: { threadId: turnRequest.groups.threadId, input: [] } },
      onPlan: (name, payload) => (seen = { name, payload }),
    });
    const result = await plan(turnRequest);
    assert.deepEqual(seen, { name: 'planCodexAppServerTurn', payload: turnRequest });
    assert.equal(result.params.threadId, turnRequest.groups.threadId);
  });

  test('refuses when no active package and rejects a replaced generation', async () => {
    const missing = harness('planCodexAppServerThread', { authority: undefined });
    await assert.rejects(() => missing(threadRequest), /session_implementation_unavailable/);

    let current = authority();
    const plan = createAgentAccessCodexAppServerThreadPlanner(
      { readCurrentAuthority: async () => current },
      { invoke: async () => ({ params: { model: threadRequest.groups.model } }) },
    );
    const result = await plan(threadRequest);
    current = authority({ lifecycleRevision: 4 });
    await assert.rejects(() => result.assertCurrent(), /session_implementation_unavailable/);
  });
});

describe('Codex app-server static notification projection', () => {
  const table = {
    version: 1,
    methods: ['item/agentMessage/delta', 'turn/completed'],
    ignoredMethods: ['thread/started'],
    aliases: { 'item/agent_message_delta': 'item/agentMessage/delta' },
  };

  test('loads once per activation and reloads after replacement', async () => {
    let current = authority();
    let invokes = 0;
    const load = createAgentAccessCodexAppServerNotificationProjection(
      { readCurrentAuthority: async () => current },
      {
        exposesAction: async () => true,
        invoke: async () => {
          invokes++;
          return table;
        },
      },
    );
    const first = await load();
    await load();
    assert.equal(invokes, 1);
    assert.equal(first.aliases.get('item/agent_message_delta'), 'item/agentMessage/delta');
    assert.equal(first.ignoredMethods.has('thread/started'), true);

    current = authority({ lifecycleRevision: 4 });
    await assert.rejects(() => first.assertCurrent(), /session_implementation_unavailable/);
    await load();
    assert.equal(invokes, 2);
  });

  test('returns undefined for an older package without the action', async () => {
    const load = createAgentAccessCodexAppServerNotificationProjection(
      { readCurrentAuthority: async () => authority() },
      { exposesAction: async () => false, invoke: async () => table },
    );
    assert.equal(await load(), undefined);
  });

  test('display aliases cannot produce native terminal, goal or error events', async () => {
    for (const target of ['turn/completed', 'thread/goal/updated', 'thread/goal/cleared', 'error']) {
      const load = createAgentAccessCodexAppServerNotificationProjection(
        { readCurrentAuthority: async () => authority() },
        {
          exposesAction: async () => true,
          invoke: async () => ({
            ...table,
            methods: [...new Set([...table.methods, target])],
            aliases: { 'provider/notification': target },
          }),
        },
      );
      await assert.rejects(() => load(), /codex_notification_alias_.*forbidden/, target);
    }
  });
});
