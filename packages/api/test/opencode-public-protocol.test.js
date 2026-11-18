import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { OpenCodeAgentService } from '../src/domains/cats/services/agents/providers/OpenCodeAgentService.js';

/**
 * The native role-construction path must go through the public protocol.
 *
 * These tests inject the Host-side planner and assert the service actually asks it
 * for argv, rather than quietly falling back to its own builder. That fallback is
 * the whole risk of this cutover: it would keep every test green while production
 * ran a second, drifting copy of the CLI surface.
 */
function createMockProcess(exitCode = 0) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') process.nextTick(() => originalEmit('close', ...args));
    return emitted;
  };
  const proc = {
    stdout,
    stderr,
    pid: 54321,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', exitCode, null);
      });
    }),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  };
  process.nextTick(() => {
    stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'ses_1', timestamp: 1 }) + '\n');
    stdout.write(
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'hi' }, timestamp: 2 }) + '\n',
    );
    stdout.end();
    process.nextTick(() => emitter.emit('exit', exitCode, null));
  });
  return proc;
}

async function collect(iterable) {
  const out = [];
  for await (const message of iterable) out.push(message);
  return out;
}

describe('OpenCode native path over the public protocol', () => {
  test('uses the package-planned argv instead of building its own', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const planLaunch = mock.fn(async () => ({
      args: ['run', '--format', 'json', '--', 'package-built'],
      managedArgvFlags: ['--package-flag'],
      assertCurrent: async () => {},
    }));

    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'm', planLaunch });
    await collect(service.invoke('host prompt'));

    assert.equal(planLaunch.mock.calls.length, 1, 'the service must ask the package for argv');
    const sentArgs = spawnFn.mock.calls[0].arguments[1];
    assert.deepEqual(sentArgs, ['run', '--format', 'json', '--', 'package-built']);

    const input = planLaunch.mock.calls[0].arguments[0];
    assert.equal(input.prompt, 'host prompt');
    assert.equal(input.readOnlyAgent, 'cat-cafe-read-only', 'the Host owns the read-only agent name');
  });

  test('passes the Host-probed approval flag and transport args into the plan', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const planLaunch = mock.fn(async () => ({
      args: ['run', '--', 'p'],
      managedArgvFlags: [],
      assertCurrent: async () => {},
    }));

    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'm',
      planLaunch,
      autoApproveProbeFn: async () => ({ approvalFlag: '--auto', standalone: true }),
    });
    await collect(service.invoke('p'));

    const input = planLaunch.mock.calls[0].arguments[0];
    assert.equal(input.approvalFlag, '--auto', 'the probe result is an input to the plan, not a package lookup');
    assert.deepEqual(input.transportArgs, ['--standalone']);
  });

  test('surfaces a planning refusal instead of falling back to a local plan', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const planLaunch = async () => {
      throw new Error('session_implementation_unavailable');
    };

    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'm', planLaunch });
    const messages = await collect(service.invoke('p'));

    assert.equal(spawnFn.mock.calls.length, 0, 'no CLI may be spawned when the package cannot plan');
    assert.ok(
      messages.some((message) => message.type === 'error'),
      'the turn must surface an error rather than silently planning locally',
    );
  });

  test('routes output through the package event reader when one is supplied', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const seen = [];
    const planLaunch = async () => ({
      args: ['run', '--', 'p'],
      managedArgvFlags: [],
      assertCurrent: async () => {},
      normalizeEvent: async (event) => {
        seen.push(event);
        return { kind: 'text', text: 'from-package', timestamp: 2 };
      },
    });

    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'm', planLaunch });
    const messages = await collect(service.invoke('p'));

    assert.ok(seen.length > 0, 'every raw event must go through the package reader');
    const text = messages.filter((message) => message.type === 'text');
    assert.ok(
      text.some((message) => message.content === 'from-package'),
      'the Host must map the package wire event, not re-read the raw one',
    );
  });
});
