import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { normalizeOpenCodeEvent } from '@clowder-ai/agent-access/runtime/opencode-event-parser';
import {
  buildOpenCodeLaunchArguments,
  buildOpenCodeNoToolFinalizerArguments,
} from '@clowder-ai/agent-access/runtime/opencode-launch-arguments';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';

/**
 * When the package cannot plan the recovery run, the turn must still end the way it
 * did before the cutover: with the post-tool fallback text, not an error.
 *
 * The planner is reached from inside the finalizer path, which already has a graceful
 * boundary-failure exit. Letting a planning refusal escape as an exception would turn
 * "this package is a bit old" into "your answer is lost", which is worse than the
 * baseline and would only show up on CLI builds that reach the finalizer at all.
 */
function toolOnlyProcess() {
  const stdout = new PassThroughLike();
  const stderr = new PassThroughLike();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') process.nextTick(() => originalEmit('close', ...args));
    return emitted;
  };
  process.nextTick(() => {
    // The finalizer is only reached when text arrived FIRST and a tool call followed
    // it — `textEventCount > 0 && lastToolEventIndex > lastTextEventIndex`. Without
    // the leading text this fixture would never touch the finalizer at all, and a
    // "no error" assertion would pass while testing nothing.
    stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'ses_tool_only', timestamp: 1 }) + '\n');
    stdout.write(
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_tool_only',
        part: { type: 'text', text: 'let me look' },
        timestamp: 2,
      }) + '\n',
    );
    stdout.write(
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'ses_tool_only',
        part: { tool: 'bash', state: { status: 'completed', input: { cmd: 'ls' }, output: 'a\n' } },
        timestamp: 3,
      }) + '\n',
    );
    stdout.write(
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_tool_only',
        part: { reason: 'tool-calls' },
        timestamp: 4,
      }) + '\n',
    );
    stdout.end();
    process.nextTick(() => emitter.emit('exit', 0, null));
  });
  return {
    stdout,
    stderr,
    pid: 111,
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

/** Minimal PassThrough stand-in: the service only writes to it in this scenario. */
class PassThroughLike extends Readable {
  constructor() {
    super({ read() {} });
    this.chunks = [];
  }
  write(chunk) {
    this.push(chunk);
    return true;
  }
  end() {
    this.push(null);
  }
}

async function collect(iterable) {
  const out = [];
  for await (const message of iterable) out.push(message);
  return out;
}

describe('finalizer planning refusal degrades gracefully', () => {
  test('an unavailable package still produces fallback text, not an error', async () => {
    const proc = toolOnlyProcess();
    const spawnFn = mock.fn(() => proc);
    const planLaunch = async () => ({
      args: ['run', '--format', 'json', '--', 'p'],
      managedArgvFlags: [],
      assertCurrent: async () => {},
    });
    let planned = 0;
    const planFinalizer = async () => {
      planned++;
      throw new Error('session_implementation_unavailable');
    };

    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'm',
      planLaunch,
      planFinalizer,
    });

    const messages = await collect(service.invoke('p'));

    assert.equal(planned, 1, 'the fixture must actually reach the finalizer, or this test proves nothing');
    assert.ok(
      !messages.some((message) => message.type === 'error'),
      'a planning refusal must not surface as a turn error',
    );
    assert.ok(
      messages.some((message) => message.type === 'done'),
      'the turn must still terminate cleanly',
    );
  });
});

describe('the recovery run is rechecked against package generation', () => {
  /**
   * The finalizer plans from the same package activation as the main run. Between
   * planning and the Host handing the process owner over, a package can be replaced —
   * so the recovery run must recheck the generation immediately before spawn, exactly
   * like the main run does. Otherwise a turn could finish on a package the Host has
   * already stopped trusting.
   */
  test('a replaced package stops the finalizer before spawn', async () => {
    // Each spawn gets its own process: the finalizer launches a second CLI run, and a
    // single shared fixture would leave that run waiting on a stream nobody ends.
    const spawnFn = mock.fn(() => toolOnlyProcess());
    let assertCalls = 0;
    const planLaunch = async () => ({
      args: ['run', '--format', 'json', '--', 'p'],
      managedArgvFlags: [],
      assertCurrent: async () => {
        assertCalls++;
        if (assertCalls === 2) throw new Error('package_replaced');
      },
    });
    const planFinalizer = async ({ prompt, finalizerAgent, transportArgs = [], sessionId, model }) => ({
      args: [
        'run',
        ...transportArgs,
        '--agent',
        finalizerAgent,
        '--session',
        sessionId,
        '-m',
        model,
        '--format',
        'json',
        '--',
        prompt,
      ],
      managedArgvFlags: ['--agent'],
    });

    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'm',
      planLaunch,
      planFinalizer,
    });

    await collect(service.invoke('p'));

    assert.equal(assertCalls, 2, 'both main and recovery runs must recheck the generation');
    assert.equal(spawnFn.mock.callCount(), 1, 'the replaced generation cannot start the recovery process');
  });
});

test('native session, tool and error evidence survives an incomplete plugin projection', async () => {
  for (const native of ['tool_use', 'error']) {
    let launches = 0;
    const session = { type: 'step_start', sessionID: 'ses_native' };
    const normalized = (event) =>
      event.type === 'step_start'
        ? { kind: 'session_init', sessionId: 'ses_unrelated' }
        : event.fixtureHidden
          ? { kind: 'ignored' }
          : normalizeOpenCodeEvent(event);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      model: 'm',
      autoApproveProbeFn: async () => ({ standalone: false, pure: false }),
      planLaunch: async (input) => ({ ...buildOpenCodeLaunchArguments(input), normalizeEvent: normalized }),
      planFinalizer: async (input) => buildOpenCodeNoToolFinalizerArguments(input),
    });
    const messages = await collect(
      service.invoke('p', {
        async *spawnCliOverride() {
          yield session;
          if (launches++ === 0) {
            yield { type: 'text', part: { text: 'Inspecting' } };
            yield { type: 'tool_use', part: { tool: 'read' }, fixtureHidden: true };
          } else {
            yield { type: 'text', part: { text: 'Untrusted recovery text' } };
            yield { type: native, fixtureHidden: true };
          }
        },
      }),
    );
    assert.equal(launches, 2, 'the recovery process was exercised');
    assert.equal(messages.find((message) => message.type === 'session_init')?.sessionId, 'ses_native');
    assert.ok(!messages.some((message) => message.content === 'Untrusted recovery text'));
  }
});
