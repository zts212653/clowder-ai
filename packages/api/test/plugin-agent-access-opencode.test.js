import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createAgentAccessOpenCodeLaunchPlanner } from '../src/domains/plugin/agent-access-opencode.js';

/**
 * The Host no longer builds OpenCode argv itself: the active package planes it, and
 * this planner is the seam the native role-construction path calls. Two properties
 * matter beyond "it returns args":
 *
 *  - it refuses to plan when no healthy package is active, because planning against
 *    a stale or missing package is how a turn silently runs a different CLI surface;
 *  - it re-checks the same instance digest/revision before each step it hands back,
 *    so a package replaced mid-turn cannot keep serving that turn.
 */
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
  const invoke = async (_instanceId, _operation, payload) => {
    options.onPlan?.(payload);
    return options.invokeResult ?? { args: ['run', '--', 'p'], managedArgvFlags: [] };
  };
  return createAgentAccessOpenCodeLaunchPlanner({ readCurrentAuthority }, { invoke });
}

describe('OpenCode launch planner over the public protocol', () => {
  test('plans through the active package and exposes a current-authority check', async () => {
    let seen;
    const plan = harness({ onPlan: (payload) => (seen = payload) });

    const result = await plan({ prompt: 'p', readOnlyAgent: 'cat-cafe-read-only' });

    assert.deepEqual(result.args, ['run', '--', 'p']);
    assert.equal(typeof result.assertCurrent, 'function');
    assert.deepEqual(seen, {
      operation: 'plan_native_launch',
      client: 'opencode',
      launch: { prompt: 'p', readOnlyAgent: 'cat-cafe-read-only' },
    });
  });

  test('refuses to plan when no package instance is active', async () => {
    const plan = harness({ authority: undefined });

    await assert.rejects(
      () => plan({ prompt: 'p', readOnlyAgent: 'a' }),
      /session_implementation_unavailable/,
      'planning with no active package must fail loudly, not fall back to Host argv',
    );
  });

  test('refuses to plan against a package that is not enabled and healthy', async () => {
    const plan = harness({ authority: authority({ runtimeState: 'failed' }) });

    await assert.rejects(() => plan({ prompt: 'p', readOnlyAgent: 'a' }), /session_implementation_unavailable/);
  });

  test('a later step fails once the package instance was replaced', async () => {
    let current = authority();
    const plan = createAgentAccessOpenCodeLaunchPlanner(
      { readCurrentAuthority: async () => current },
      { invoke: async () => ({ args: [], managedArgvFlags: [] }) },
    );

    const result = await plan({ prompt: 'p', readOnlyAgent: 'a' });
    current = authority({ lifecycleRevision: 4 });

    await assert.rejects(() => result.assertCurrent(), /session_implementation_unavailable/);
  });

  test('a later step passes while the same instance is still current', async () => {
    const plan = harness({});
    const result = await plan({ prompt: 'p', readOnlyAgent: 'a' });

    await assert.doesNotReject(() => result.assertCurrent());
  });

  test('normalises the package answer through the shared argv contract', async () => {
    const plan = harness({ invokeResult: { args: [1, 2], managedArgvFlags: 'nope' } });

    await assert.rejects(
      () => plan({ prompt: 'p', readOnlyAgent: 'a' }),
      'a malformed package answer must not reach the CLI',
    );
  });
});
