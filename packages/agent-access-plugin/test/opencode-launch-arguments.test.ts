import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildOpenCodeLaunchArguments } from '../src/runtime/opencode-launch-arguments.ts';

/**
 * The OpenCode launch plan moved out of the Host service and into the active
 * Agent Access package. These assertions pin the argument shape the native CLI
 * already relied on, so the move is a relocation, not a behaviour change:
 *
 *  - `run` first, then the probe-supplied transport args (their own boundary);
 *  - the read-only agent pair only when the Host asked for read-only;
 *  - user `cliConfigArgs` win over system-injected flags of the same name,
 *    except accumulative ones;
 *  - `--` always terminates option parsing immediately before the prompt, so a
 *    dash-prefixed prompt is never read as a flag.
 */
describe('OpenCode launch arguments', () => {
  const readOnlyAgent = 'cat-cafe-read-only';

  test('places run first and always terminates options before the prompt', () => {
    const { args } = buildOpenCodeLaunchArguments({ prompt: 'hello world', readOnlyAgent: 'agent' });

    assert.equal(args[0], 'run');
    assert.deepEqual(args.slice(-2), ['--', 'hello world']);
  });

  test('keeps a dash-prefixed prompt positional', () => {
    const prompt = '--not-a-flag please treat me as text';
    const { args } = buildOpenCodeLaunchArguments({ prompt, readOnlyAgent: 'agent' });

    assert.deepEqual(args.slice(-2), ['--', prompt]);
  });

  test('adds the read-only agent pair only when asked', () => {
    const writable = buildOpenCodeLaunchArguments({ prompt: 'p', readOnlyAgent });
    const readOnly = buildOpenCodeLaunchArguments({ prompt: 'p', readOnly: true, readOnlyAgent });

    assert.ok(!writable.args.includes('--pure'), 'a writable run must not force --pure');
    assert.deepEqual(readOnly.args.slice(0, 4), ['run', '--pure', '--agent', readOnlyAgent]);
  });

  test('carries the session, model, json format and the probe-supplied approval flag', () => {
    const { args } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnlyAgent: 'agent',
      sessionId: 'ses_abc',
      model: 'maas/glm-5',
      approvalFlag: '--auto',
    });

    assert.equal(args[args.indexOf('--session') + 1], 'ses_abc');
    assert.equal(args[args.indexOf('-m') + 1], 'maas/glm-5');
    assert.equal(args[args.indexOf('--format') + 1], 'json');
    assert.ok(args.includes('--auto'), 'the Host-probed approval flag is honoured');
  });

  test('keeps transport args in their own boundary after run', () => {
    const { args } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnlyAgent: 'agent',
      transportArgs: ['--standalone'],
    });

    assert.deepEqual(args.slice(0, 2), ['run', '--standalone']);
  });

  test('lets a user flag replace the system-injected flag of the same name', () => {
    const { args } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnlyAgent: 'agent',
      model: 'system-model',
      cliConfigArgs: ['-m user-model'],
    });

    assert.equal(args.filter((part) => part === '-m').length, 1, 'the user value must not coexist with the system one');
    assert.equal(args[args.indexOf('-m') + 1], 'user-model');
    assert.ok(!args.includes('system-model'), 'the replaced system value is gone, not orphaned');
  });

  test('keeps user args ahead of the terminator so they stay parseable', () => {
    const { args } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnlyAgent: 'agent',
      cliConfigArgs: ['--title my title'],
    });

    assert.ok(args.indexOf('--title') >= 0 && args.indexOf('--title') < args.indexOf('--'));
  });

  test('reports the managed flags it injected', () => {
    const { managedArgvFlags } = buildOpenCodeLaunchArguments({
      prompt: 'p',
      readOnly: true,
      readOnlyAgent,
    });

    assert.ok(managedArgvFlags.includes('--pure'), 'a host-managed flag must be declared for diagnostics');
  });
});
