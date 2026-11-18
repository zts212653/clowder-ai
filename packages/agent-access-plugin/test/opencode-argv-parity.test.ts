import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildOpenCodeLaunchArguments,
  buildOpenCodeNoToolFinalizerArguments,
} from '../src/runtime/opencode-launch-arguments.ts';

/**
 * The Host's `buildArgs` / `buildNoToolFinalizerArgs` are private methods, so they
 * cannot be called directly for comparison. Their documented contract is instead
 * restated here as input/output pairs taken from the Host source, and the package
 * must reproduce each one exactly. Any drift in the move shows up as a failure
 * here rather than as a different argv reaching a real CLI.
 */
const READ_ONLY_AGENT = 'cat-cafe-read-only';
const FINALIZER_AGENT = 'cat-cafe-no-tool-finalizer';

describe('OpenCode argv parity with the Host contract', () => {
  test('plain run', () => {
    const { args } = buildOpenCodeLaunchArguments({ prompt: 'p', readOnlyAgent: READ_ONLY_AGENT });

    assert.deepEqual(args, ['run', '--format', 'json', '--', 'p']);
  });

  test('read-only run puts the agent pair before session/model', () => {
    const { args } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnly: true,
      readOnlyAgent: READ_ONLY_AGENT,
      sessionId: 's',
      model: 'm',
      approvalFlag: '--auto',
    });

    assert.deepEqual(args, [
      'run',
      '--pure',
      '--agent',
      READ_ONLY_AGENT,
      '--session',
      's',
      '-m',
      'm',
      '--format',
      'json',
      '--auto',
      '--',
      'p',
    ]);
  });

  test('transport args sit directly after run', () => {
    const { args } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnlyAgent: READ_ONLY_AGENT,
      transportArgs: ['--standalone'],
    });

    assert.deepEqual(args, ['run', '--standalone', '--format', 'json', '--', 'p']);
  });

  test('user approval flag suppresses the probe-supplied one', () => {
    const { args } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnlyAgent: READ_ONLY_AGENT,
      approvalFlag: '--auto',
      cliConfigArgs: ['--yolo'],
    });

    assert.ok(!args.includes('--auto'), 'the system approval flag must yield to the user choice');
    assert.ok(args.includes('--yolo'));
  });

  test('finalizer argv matches the Host shape exactly', () => {
    const withSession = buildOpenCodeNoToolFinalizerArguments({
      prompt: 'q',
      model: 'm',
      finalizerAgent: FINALIZER_AGENT,
      sessionId: 's',
      transportArgs: ['--standalone'],
    });

    assert.deepEqual(withSession.args, [
      'run',
      '--standalone',
      '--pure',
      '--agent',
      FINALIZER_AGENT,
      '--session',
      's',
      '-m',
      'm',
      '--format',
      'json',
      '--',
      'q',
    ]);

    const bare = buildOpenCodeNoToolFinalizerArguments({ prompt: 'q', model: 'm', finalizerAgent: FINALIZER_AGENT });
    assert.deepEqual(bare.args, [
      'run',
      '--pure',
      '--agent',
      FINALIZER_AGENT,
      '-m',
      'm',
      '--format',
      'json',
      '--',
      'q',
    ]);
  });
});
