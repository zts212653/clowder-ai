import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildOpenCodeNoToolFinalizerArguments } from '../src/runtime/opencode-launch-arguments.ts';

/**
 * The no-tool finalizer is a second OpenCode run - the one that asks the model for
 * a final answer after the CLI stopped on a tool call. Its argv is narrower than
 * the main run (no approval/session-model defaults beyond what it passes), and a
 * wrong shape here is silent: the finalizer just returns nothing and the turn ends
 * without text.
 */
describe('OpenCode no-tool finalizer arguments', () => {
  test('pins the pure agent pair and the json format', () => {
    const { args } = buildOpenCodeNoToolFinalizerArguments({
      prompt: 'summarise',
      model: 'maas/glm-5',
      finalizerAgent: 'cat-cafe-no-tool-finalizer',
    });

    assert.deepEqual(args.slice(0, 3), ['run', '--pure', '--agent']);
    assert.equal(args[args.indexOf('--agent') + 1], 'cat-cafe-no-tool-finalizer');
    assert.equal(args[args.indexOf('--format') + 1], 'json');
  });

  test('resumes the same session when one is known', () => {
    const { args } = buildOpenCodeNoToolFinalizerArguments({
      prompt: 'p',
      model: 'm',
      finalizerAgent: 'a',
      sessionId: 'ses_1',
    });

    assert.equal(args[args.indexOf('--session') + 1], 'ses_1');
  });

  test('omits the session flag entirely when there is none', () => {
    const { args } = buildOpenCodeNoToolFinalizerArguments({ prompt: 'p', model: 'm', finalizerAgent: 'a' });

    assert.ok(!args.includes('--session'), 'an absent session must not become an empty --session');
  });

  test('keeps transport args right after run, ahead of the pure agent pair', () => {
    const { args } = buildOpenCodeNoToolFinalizerArguments({
      prompt: 'p',
      model: 'm',
      finalizerAgent: 'a',
      transportArgs: ['--standalone'],
    });

    assert.deepEqual(args.slice(0, 4), ['run', '--standalone', '--pure', '--agent']);
  });

  test('always terminates options immediately before the prompt', () => {
    const { args } = buildOpenCodeNoToolFinalizerArguments({
      prompt: '--dash prompt',
      model: 'm',
      finalizerAgent: 'a',
    });

    assert.deepEqual(args.slice(-2), ['--', '--dash prompt']);
  });

  test('reports the managed flags it injected', () => {
    const { managedArgvFlags } = buildOpenCodeNoToolFinalizerArguments({
      prompt: 'p',
      model: 'm',
      finalizerAgent: 'a',
    });

    assert.ok(managedArgvFlags.includes('--pure'));
    assert.ok(managedArgvFlags.includes('--agent'));
  });
});
