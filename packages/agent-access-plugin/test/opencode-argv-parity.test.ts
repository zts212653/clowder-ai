import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildOpenCodeLaunchArguments,
  buildOpenCodeNoToolFinalizerArguments,
} from '../src/runtime/opencode-launch-arguments.ts';

/**
 * Where this package agrees with the Host's `buildArgs` / `buildNoToolFinalizerArgs`,
 * and the one place it deliberately does not.
 *
 * Those Host methods are private, so their contract is restated here as input/output
 * pairs. Everything below must match the Host exactly — except `--pure`, which the
 * Host injected unconditionally and which this package only sends when the Host's
 * `run --help` probe found it. That single difference is intentional and pinned by
 * `opencode-pure-probe.test.ts`; if any *other* difference appears here, the move
 * changed behaviour and this test is what says so.
 */
const READ_ONLY_AGENT = 'cat-cafe-read-only';
const FINALIZER_AGENT = 'cat-cafe-no-tool-finalizer';

describe('OpenCode argv against the Host contract (same, except --pure)', () => {
  test('plain run is unchanged', () => {
    const { args } = buildOpenCodeLaunchArguments({ prompt: 'p', readOnlyAgent: READ_ONLY_AGENT });

    assert.deepEqual(args, ['run', '--format', 'json', '--', 'p']);
  });

  test('read-only run keeps the Host order when the probe supports --pure', () => {
    const { args } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnly: true,
      readOnlyAgent: READ_ONLY_AGENT,
      sessionId: 's',
      model: 'm',
      approvalFlag: '--auto',
      pureSupported: true,
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

  test('read-only run differs from the Host only by the absent --pure', () => {
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

  test('finalizer argv matches the Host shape when --pure is supported', () => {
    const withSession = buildOpenCodeNoToolFinalizerArguments({
      prompt: 'q',
      model: 'm',
      finalizerAgent: FINALIZER_AGENT,
      sessionId: 's',
      transportArgs: ['--standalone'],
      pureSupported: true,
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

    const bare = buildOpenCodeNoToolFinalizerArguments({
      prompt: 'q',
      model: 'm',
      finalizerAgent: FINALIZER_AGENT,
      pureSupported: true,
    });
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

  test('finalizer differs from the Host only by the absent --pure', () => {
    const { args } = buildOpenCodeNoToolFinalizerArguments({
      prompt: 'q',
      model: 'm',
      finalizerAgent: FINALIZER_AGENT,
      sessionId: 's',
    });

    assert.deepEqual(args, [
      'run',
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
  });
});
