import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createAgentAccessCodexExecLaunchPlanner } from '../dist/domains/plugin/agent-access/codex.js';

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

function harness(options = {}) {
  const readCurrentAuthority = async () => ('authority' in options ? options.authority : authority());
  const invoke = async (_instanceId, operation, payload) => {
    assert.equal(operation, 'planCodexExec');
    options.onPlan?.(payload);
    return options.invokeResult ?? { args: ['exec', '--', '-'], managedArgvFlags: [] };
  };
  return createAgentAccessCodexExecLaunchPlanner({ readCurrentAuthority }, { invoke });
}

const launch = {
  readOnly: false,
  groups: {
    beforeSandbox: '__CAT_CAFE_CODEX_GROUP_beforeSandbox__',
    sandbox: '__CAT_CAFE_CODEX_GROUP_sandbox__',
  },
};

describe('Codex exec launch planner over the public protocol', () => {
  test('plans through the active package and exposes a current-authority check', async () => {
    let seen;
    const plan = harness({ onPlan: (payload) => (seen = payload) });

    const result = await plan(launch);

    assert.deepEqual(result.args, ['exec', '--', '-']);
    assert.equal(typeof result.assertCurrent, 'function');
    assert.deepEqual(seen, { operation: 'plan_native_launch', client: 'codex', launch });
  });

  test('refuses to plan when no package instance is active', async () => {
    const plan = harness({ authority: undefined });

    await assert.rejects(() => plan(launch), /session_implementation_unavailable/);
  });

  test('pins the active package display fields while accepting older plans', async () => {
    const output = { delta: 'text', message: 'content', reasoningParts: 'parts', reasoningText: ['content', 'text'] };
    const oldPlan = await harness()(launch);
    const newPlan = await harness({ invokeResult: { args: oldPlan.args, managedArgvFlags: [], output } })(launch);
    assert.equal(oldPlan.output, undefined);
    assert.deepEqual(newPlan.output, output);
    const badPlan = harness({
      invokeResult: { args: oldPlan.args, managedArgvFlags: [], output: { ...output, delta: 'thread_id' } },
    });
    await assert.rejects(() => badPlan(launch), /invalid/i);
  });

  test('assertCurrent refuses a replaced package generation', async () => {
    let current = authority();
    const plan = createAgentAccessCodexExecLaunchPlanner(
      { readCurrentAuthority: async () => current },
      { invoke: async () => ({ args: ['exec', '--', '-'], managedArgvFlags: [] }) },
    );
    const result = await plan(launch);
    current = authority({ lifecycleRevision: 4 });

    await assert.rejects(() => result.assertCurrent(), /session_implementation_unavailable/);
  });
});
