import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';

/**
 * The Host owns the `run --help` probe, so it is the only layer that can tell the
 * package whether this installed CLI supports `--pure`. These tests pin that the
 * probe answer is actually forwarded into the plan — a plan that never learns it
 * would keep sending an unsupported flag, which on v2.0.28 makes the CLI print help
 * and send nothing.
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

function runWithProbe(probeResult) {
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
    autoApproveProbeFn: async () => probeResult,
  });
  return { service, planLaunch };
}

describe('the Host forwards the --pure capability into the plan', () => {
  test('reports pure as supported when the installed CLI advertises it', async () => {
    const { service, planLaunch } = runWithProbe({ approvalFlag: '--auto', standalone: true, pure: true });

    await collect(service.invoke('p'));

    assert.equal(planLaunch.mock.calls[0].arguments[0].pureSupported, true);
  });

  test('reports pure as unsupported when the CLI does not advertise it', async () => {
    const { service, planLaunch } = runWithProbe({ approvalFlag: '--auto', standalone: true, pure: false });

    await collect(service.invoke('p'));

    assert.equal(
      planLaunch.mock.calls[0].arguments[0].pureSupported,
      false,
      'v2.0.28 answers --pure with help, so the plan must know it is absent',
    );
  });

  test('a probe that never answered leaves pure unset rather than assumed', async () => {
    const { service, planLaunch } = runWithProbe({ standalone: true });

    await collect(service.invoke('p'));

    assert.equal(planLaunch.mock.calls[0].arguments[0].pureSupported, undefined);
  });

  test('a failed probe does not claim support', async () => {
    // A failed probe reports a warning and no flags — it never returns undefined.
    const { service, planLaunch } = runWithProbe({ warning: 'probe failed', cacheable: false });

    await collect(service.invoke('p'));

    assert.ok(
      planLaunch.mock.calls[0].arguments[0].pureSupported !== true,
      'an unproven capability must never be reported as supported',
    );
  });
});
