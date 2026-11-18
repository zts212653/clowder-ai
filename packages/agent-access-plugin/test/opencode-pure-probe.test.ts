import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildOpenCodeLaunchArguments,
  buildOpenCodeNoToolFinalizerArguments,
} from '../../agent-access-plugin/src/runtime/opencode-launch-arguments.ts';

/**
 * `--pure` must be opt-in from the Host's `run --help` probe, never assumed.
 *
 * On OpenCode v2.0.28 the flag is not advertised and passing it makes the CLI print
 * help and exit before sending any request — so an unconditional `--pure` turns a
 * working turn into a silent no-op. Where the flag *is* supported, it must still be
 * passed, because it is the flag that actually suppresses tool execution.
 */
const READ_ONLY_AGENT = 'cat-cafe-read-only';
const FINALIZER_AGENT = 'cat-cafe-no-tool-finalizer';

describe('--pure is probe-driven', () => {
  test('read-only run omits --pure when the probe says it is unsupported', () => {
    const { args } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnly: true,
      readOnlyAgent: READ_ONLY_AGENT,
      pureSupported: false,
    });

    assert.ok(!args.includes('--pure'), 'an unsupported flag must not be passed: v2.0.28 answers with help');
    assert.equal(args[args.indexOf('--agent') + 1], READ_ONLY_AGENT, 'the no-tool agent selection still applies');
  });

  test('read-only run keeps --pure when the probe says it is supported', () => {
    const { args } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnly: true,
      readOnlyAgent: READ_ONLY_AGENT,
      pureSupported: true,
    });

    assert.ok(args.includes('--pure'));
  });

  test('a read-only run with no probe answer does not send --pure', () => {
    const { args } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnly: true,
      readOnlyAgent: READ_ONLY_AGENT,
    });

    assert.ok(!args.includes('--pure'), 'unknown support is not support — the default must be safe');
  });

  test('the finalizer omits --pure when unsupported and keeps the agent pin', () => {
    const { args } = buildOpenCodeNoToolFinalizerArguments({
      prompt: 'p',
      model: 'm',
      finalizerAgent: FINALIZER_AGENT,
      pureSupported: false,
    });

    assert.ok(!args.includes('--pure'));
    assert.equal(args[args.indexOf('--agent') + 1], FINALIZER_AGENT);
    assert.ok(args.includes('--format'));
  });

  test('the finalizer keeps --pure when supported', () => {
    const { args } = buildOpenCodeNoToolFinalizerArguments({
      prompt: 'p',
      model: 'm',
      finalizerAgent: FINALIZER_AGENT,
      pureSupported: true,
    });

    assert.ok(args.includes('--pure'));
  });

  test('managed flags only claim what was actually injected', () => {
    const unsupported = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnly: true,
      readOnlyAgent: READ_ONLY_AGENT,
      pureSupported: false,
    });
    assert.ok(
      !unsupported.managedArgvFlags.includes('--pure'),
      'diagnostics must not claim a flag that was not sent',
    );

    const supported = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnly: true,
      readOnlyAgent: READ_ONLY_AGENT,
      pureSupported: true,
    });
    assert.ok(supported.managedArgvFlags.includes('--pure'));
  });
});
