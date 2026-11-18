import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  agentAccessKimiLaunchRequestSchema,
  agentAccessNativeEventRequestSchema,
  agentAccessNativeLaunchRequestSchema,
} from '../../agent-contract/src/index.ts';

/**
 * The package serves more than one native client through one public protocol.
 * Both must parse through the same request envelope, and the OpenCode request
 * must carry what its planner needs (including the Host-probed values).
 */
describe('native launch request envelope', () => {
  test('still parses the Kimi shape unchanged', () => {
    const parsed = agentAccessNativeLaunchRequestSchema.parse({
      operation: 'plan_native_launch',
      client: 'kimi',
      launch: { prompt: 'p', imageAccessDirs: [] },
    });

    assert.equal(parsed.client, 'kimi');
    assert.equal(parsed.launch.prompt, 'p');
  });

  test('parses an OpenCode request with probe-derived inputs', () => {
    const parsed = agentAccessNativeLaunchRequestSchema.parse({
      operation: 'plan_native_launch',
      client: 'opencode',
      launch: {
        prompt: 'p',
        readOnly: true,
        approvalFlag: '--auto',
        transportArgs: ['--standalone'],
        readOnlyAgent: 'cat-cafe-read-only',
      },
    });

    assert.equal(parsed.client, 'opencode');
    assert.equal(parsed.launch.readOnly, true);
    assert.equal(parsed.launch.approvalFlag, '--auto');
    assert.deepEqual(parsed.launch.transportArgs, ['--standalone']);
  });

  test('rejects an OpenCode request missing the read-only agent name', () => {
    const result = agentAccessNativeLaunchRequestSchema.safeParse({
      operation: 'plan_native_launch',
      client: 'opencode',
      launch: { prompt: 'p' },
    });

    assert.equal(result.success, false, 'the planning contract must not invent the agent constant');
  });

  test('rejects an unknown client rather than guessing a planner', () => {
    const result = agentAccessNativeLaunchRequestSchema.safeParse({
      operation: 'plan_native_launch',
      client: 'not-a-client',
      launch: { prompt: 'p' },
    });

    assert.equal(result.success, false);
  });

  test('the Kimi-specific schema still exists for the Host that already imports it', () => {
    assert.equal(typeof agentAccessKimiLaunchRequestSchema.parse, 'function');
  });
});

describe('native event request envelope', () => {
  test('routes a Kimi event to the Kimi branch', () => {
    const parsed = agentAccessNativeEventRequestSchema.parse({
      client: 'kimi',
      event: { role: 'assistant', content: 'hi' },
    });

    assert.equal(parsed.client, 'kimi');
  });

  test('routes an OpenCode event to the OpenCode branch', () => {
    const parsed = agentAccessNativeEventRequestSchema.parse({
      client: 'opencode',
      event: { type: 'text', part: { text: 'hi' } },
    });

    assert.equal(parsed.client, 'opencode');
  });
});
