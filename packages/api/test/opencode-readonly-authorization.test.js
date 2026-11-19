import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';

/**
 * The package owns argv shape, but the Host owns the authorization decision that made
 * this run read-only. A plan must therefore consume the Host's protected facts — the
 * read-only agent name, the resolved transport, the permission-bearing flags — rather
 * than choose its own. Without this check a package could silently upgrade a read-only
 * turn to a writable agent, or point the run at a server the Host never approved.
 */
function createMockProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') process.nextTick(() => originalEmit('close', ...args));
    return emitted;
  };
  process.nextTick(() => {
    stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'ses_1', timestamp: 1 }) + '\n');
    stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'hi' }, timestamp: 2 }) + '\n');
    stdout.end();
    process.nextTick(() => emitter.emit('exit', 0, null));
  });
  return {
    stdout,
    stderr,
    pid: 999,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', 0, null);
      });
    }),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  };
}

async function collect(iterable) {
  const out = [];
  for await (const message of iterable) out.push(message);
  return out;
}

/** A read-only run whose package returns `planArgs`, so the Host must judge them. */
function runReadOnly(planArgs) {
  const proc = createMockProcess();
  const spawnFn = mock.fn(() => proc);
  const service = new OpenCodeAgentService({
    catId: 'opencode',
    spawnFn,
    model: 'm',
    autoApproveProbeFn: async () => ({ standalone: false, cacheable: true }),
    planLaunch: async () => ({
      args: [...planArgs.slice(0, 1), ...planArgs.slice(1, -4), '-m', 'm', ...planArgs.slice(-4)],
      managedArgvFlags: [],
      assertCurrent: async () => {},
    }),
  });
  return collect(service.invoke('p', { toolExecutionPolicy: { mode: 'read_only' } })).then((messages) => ({
    messages,
    spawnFn,
  }));
}

describe('the Host holds the read-only authorization, not the plan', () => {
  const READ_ONLY_AGENT = 'cat-cafe-read-only';

  test('a plan that substitutes a writable agent is refused before spawn', async () => {
    const { messages, spawnFn } = await runReadOnly(['run', '--agent', 'build', '--format', 'json', '--', 'p']);

    assert.equal(spawnFn.mock.calls.length, 0, 'an unauthorized agent must never reach spawn');
    assert.ok(
      messages.some((message) => message.type === 'error'),
      'the refusal must be visible as a turn error, not a silent success',
    );
  });

  test('a plan that drops the read-only agent is refused before spawn', async () => {
    const { messages, spawnFn } = await runReadOnly(['run', '--format', 'json', '--', 'p']);

    assert.equal(spawnFn.mock.calls.length, 0, 'a read-only run without its agent must not start');
    assert.ok(messages.some((message) => message.type === 'error'));
  });

  test('a plan may not inject a server the Host never approved', async () => {
    const { messages, spawnFn } = await runReadOnly([
      'run',
      '--server',
      'http://0.0.0.0:9999',
      '--agent',
      READ_ONLY_AGENT,
      '--format',
      'json',
      '--',
      'p',
    ]);

    assert.equal(spawnFn.mock.calls.length, 0, 'an unapproved server must never reach spawn');
    assert.ok(messages.some((message) => message.type === 'error'));
  });

  test('the approved plan still starts, so the check is not a blanket refusal', async () => {
    const { spawnFn } = await runReadOnly(['run', '--agent', READ_ONLY_AGENT, '--format', 'json', '--', 'p']);

    assert.equal(spawnFn.mock.calls.length, 1, 'a conforming read-only plan must still spawn');
  });

  test('the Host refuses duplicate agents and changed transport or approval options', async () => {
    for (const extra of [
      ['--agent=build'],
      ['--no-standalone'],
      ['--auto'],
      ['--session', 'different-session'],
      ['--continue'],
      ['--file', 'unapproved.txt'],
    ]) {
      const { messages, spawnFn } = await runReadOnly([
        'run',
        '--agent',
        READ_ONLY_AGENT,
        ...extra,
        '--format',
        'json',
        '--',
        'p',
      ]);
      assert.equal(spawnFn.mock.calls.length, 0);
      assert.ok(messages.some((message) => message.type === 'error'));
    }
  });
});
