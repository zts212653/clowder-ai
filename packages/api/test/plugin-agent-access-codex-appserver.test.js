import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
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
