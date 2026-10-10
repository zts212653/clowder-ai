import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ClaudeSdkAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function activeRunRegistration() {
  return {
    invocationId: 'inv-live-carrier',
    dispatcher: undefined,
    released: false,
    register(dispatcher) {
      this.dispatcher = dispatcher;
      return () => {
        this.released = true;
      };
    },
  };
}

describe('live member carriers', () => {
  it('Claude SDK streams append into the active query and interrupts only for explicit steer', async () => {
    let sdkOptions;
    let sdkInput;
    let interruptCount = 0;
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt, options }) => {
        sdkOptions = options;
        sdkInput = prompt[Symbol.asyncIterator]();
        return {
          interrupt: async () => {
            interruptCount += 1;
          },
          [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
        };
      },
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        systemPrompt: 'route identity',
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const firstPending = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    const initialInput = await sdkInput.next();
    assert.equal(initialInput.value.message.content[0].text, 'initial body');
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1' });
    const first = await firstPending;
    assert.equal(first.value.type, 'session_init');
    assert.equal(registration.dispatcher.capabilities.append, true);
    assert.equal(registration.dispatcher.capabilities.steer, true);
    assert.match(sdkOptions.systemPrompt, /compiled L0/);
    assert.match(sdkOptions.systemPrompt, /route identity/);
    assert.equal(sdkOptions.permissionMode, 'plan');
    assert.equal(sdkOptions.extraArgs, undefined, 'the SDK carrier must not synthesize unsupported Claude CLI flags');
    assert.equal(sdkOptions.effort, 'max');
    assert.equal(
      sdkOptions.env.CLAUDE_CODE_EFFORT_LEVEL,
      undefined,
      'the current Agent SDK must receive effort through its typed option, not a process-wide environment side channel',
    );

    const appended = await registration.dispatcher.dispatch(
      { text: 'append body' },
      { expectedInvocationId: registration.invocationId, force: false },
    );
    assert.equal(appended.accepted, true);
    const appendedInput = (await sdkInput.next()).value;
    assert.equal(appendedInput.message.content[0].text, 'append body');
    assert.equal(interruptCount, 0);

    const steered = await registration.dispatcher.dispatch(
      { text: 'steer body' },
      { expectedInvocationId: registration.invocationId, force: true },
    );
    assert.equal(steered.accepted, true);
    assert.equal(interruptCount, 1);
    const steeredInput = (await sdkInput.next()).value;
    assert.equal(steeredInput.message.content[0].text, 'steer body');

    events.push({
      type: 'stream_event',
      session_id: 'sdk-session-1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } },
    });
    assert.equal((await output.next()).value.content, 'done');
    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-session-1',
      user_message_uuids: [initialInput.value.uuid, appendedInput.uuid, steeredInput.uuid],
    });
    events.close();
    assert.equal((await output.next()).value.type, 'done');
    assert.equal(registration.released, true);
  });

  it('Claude SDK surfaces sanitized stderr instead of replacing it with a generic process-exit message', async () => {
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ options }) => ({
        interrupt: async () => {},
        async *[Symbol.asyncIterator]() {
          options.stderr?.('error: provider initialization failed\n');
          throw new Error('Claude Code process exited with code 1');
        },
      }),
    });

    const messages = [];
    for await (const message of service.invoke('initial body')) messages.push(message);

    const failure = messages.find((message) => message.type === 'error');
    assert.equal(failure.error, 'error: provider initialization failed');
  });

  it('Claude SDK sanitizes secrets before truncating the stderr window', async () => {
    const secretBody = 'a'.repeat(30);
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ options }) => ({
        interrupt: async () => {},
        async *[Symbol.asyncIterator]() {
          options.stderr?.(`sk-${secretBody}${'x'.repeat(3967)}`);
          options.stderr?.('yy');
          throw new Error('Claude Code process exited with code 1');
        },
      }),
    });

    const messages = [];
    for await (const message of service.invoke('initial body')) messages.push(message);

    const failure = messages.find((message) => message.type === 'error');
    assert.ok(failure);
    assert.doesNotMatch(failure.error, new RegExp(secretBody));
    assert.match(failure.error, /REDACTED/);
  });

  it('Claude SDK closes a streaming-input query when the provider emits its result terminal', async () => {
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    let sdkInput;
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt }) => {
        sdkInput = prompt[Symbol.asyncIterator]();
        return {
          interrupt: async () => {},
          [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
        };
      },
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const firstPending = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    await sdkInput.next();
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-result-terminal' });
    assert.equal((await firstPending).value.type, 'session_init');

    const terminal = output.next();
    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-result-terminal',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const settled = await Promise.race([
      terminal,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SDK result did not close the invocation')), 500)),
    ]);

    assert.equal(settled.value.type, 'done');
    assert.equal(registration.released, true);
  });

  it('Claude SDK does not let a provider-internal turn result settle the user input (task notification)', async () => {
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    let sdkInput;
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt }) => {
        sdkInput = prompt[Symbol.asyncIterator]();
        return {
          interrupt: async () => {},
          [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
        };
      },
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const initialized = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    const sent = (await sdkInput.next()).value;
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-task-notification' });
    assert.equal((await initialized).value.type, 'session_init');

    // Recorded from SDK 0.3.280 (f117-notes/phase2b-sdk-task-notification): when the previous query's
    // exit killed a background task, the resumed session first delivers the task's notification as a
    // zero-turn result of its own, with no input identity, and only then runs the user's input.
    events.push({
      type: 'system',
      subtype: 'task_notification',
      status: 'stopped',
      task_id: 'task-killed-at-exit',
      session_id: 'sdk-task-notification',
    });
    events.push({
      type: 'result',
      subtype: 'success',
      origin: { kind: 'task-notification' },
      queued_turn_count: 0,
      num_turns: 0,
      is_error: false,
      result: '',
      session_id: 'sdk-task-notification',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    events.push({
      type: 'assistant',
      session_id: 'sdk-task-notification',
      user_message_uuids: [sent.uuid],
      message: { id: 'answer', content: [{ type: 'text', text: 'PONG' }] },
    });
    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-task-notification',
      user_message_uuid: sent.uuid,
      user_message_uuids: [sent.uuid],
      queued_turn_count: 0,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    const rest = [];
    for (;;) {
      const next = await Promise.race([
        output.next(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('invocation did not finish')), 1000)),
      ]);
      if (next.done) break;
      rest.push(next.value);
    }
    assert.deepEqual(
      rest.filter((message) => message.type === 'text').map((message) => message.content),
      ['PONG'],
      'the user input is answered, not swallowed by the notification turn',
    );
    assert.equal(rest.at(-1).type, 'done');
    assert.equal(registration.released, true);
  });

  it('Claude SDK runs the compaction hooks it is handed in-process, and none otherwise (F117 K2)', async () => {
    const sdkOptions = [];
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ options }) => {
        sdkOptions.push(options);
        const events = new AsyncInbox();
        events.push({ type: 'result', subtype: 'success', session_id: 'sdk-hooks', usage: {} });
        events.close();
        return { interrupt: async () => {}, [Symbol.asyncIterator]: () => events[Symbol.asyncIterator]() };
      },
    });
    const calls = [];
    let failPreCompact = false;
    const claudeCompactionHooks = {
      async preCompact(input) {
        calls.push(['preCompact', input]);
        if (failPreCompact) throw new Error('seal store down');
      },
      async postCompactContext(input) {
        calls.push(['postCompactContext', input]);
        return 'COLD PACKET';
      },
    };
    const drain = async (options) => {
      for await (const _ of service.invoke('body', options)) {
        // drain
      }
    };
    await drain({ claudeCompactionHooks, toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] } });
    await drain({ toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] } });

    assert.equal(sdkOptions[1].hooks, undefined, 'no hooks unless the invocation hands them over');
    const { PreCompact, SessionStart } = sdkOptions[0].hooks;
    const signal = new AbortController().signal;
    const base = { session_id: 'claude-session-1', transcript_path: '/tmp/t.jsonl', cwd: '/tmp' };
    const preCompact = PreCompact[0].hooks[0];
    const sessionStart = SessionStart[0].hooks[0];

    assert.deepEqual(
      await preCompact(
        { ...base, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null },
        undefined,
        {
          signal,
        },
      ),
      {},
    );
    assert.deepEqual(
      await sessionStart({ ...base, hook_event_name: 'SessionStart', source: 'compact' }, undefined, { signal }),
      { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'COLD PACKET' } },
    );
    assert.deepEqual(
      await sessionStart({ ...base, hook_event_name: 'SessionStart', source: 'startup' }, undefined, { signal }),
      {},
    );
    failPreCompact = true;
    assert.deepEqual(
      await preCompact(
        { ...base, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null },
        undefined,
        {
          signal,
        },
      ),
      {},
      'a failed seal never blocks the compaction',
    );
    assert.deepEqual(calls, [
      ['preCompact', { cliSessionId: 'claude-session-1', trigger: 'auto' }],
      ['postCompactContext', { cliSessionId: 'claude-session-1' }],
      ['preCompact', { cliSessionId: 'claude-session-1', trigger: 'manual' }],
    ]);
  });

  it('Claude SDK keeps the response open for an Append accepted before the current result terminal', async () => {
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    let sdkInput;
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt }) => {
        sdkInput = prompt[Symbol.asyncIterator]();
        return {
          interrupt: async () => {},
          [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
        };
      },
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const initialized = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    const initialInput = (await sdkInput.next()).value;
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-append-result-race' });
    assert.equal((await initialized).value.type, 'session_init');

    const accepted = await registration.dispatcher.dispatch(
      { text: 'accepted follow-up' },
      { expectedInvocationId: registration.invocationId, force: false },
    );
    assert.deepEqual(accepted, {
      accepted: true,
      handle: {
        provider: 'anthropic',
        carrier: 'claude_agent_sdk',
        threadId: 'sdk-append-result-race',
        turnId: registration.dispatcher.handle.turnId,
      },
    });
    const appendedInput = (await sdkInput.next()).value;

    const secondTurnOutput = output.next();
    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-append-result-race',
      user_message_uuid: initialInput.uuid,
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    events.push({
      type: 'assistant',
      session_id: 'sdk-append-result-race',
      message: { id: 'second-turn', content: [{ type: 'text', text: 'follow-up response' }] },
    });
    const secondTurn = await secondTurnOutput;
    assert.equal(secondTurn.value.type, 'text');
    assert.equal(secondTurn.value.content, 'follow-up response');

    const terminal = output.next();
    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-append-result-race',
      user_message_uuid: appendedInput.uuid,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    assert.equal((await terminal).value.type, 'done');
    assert.equal(registration.released, true);
  });

  it('Claude SDK does not apply an older result queue snapshot to a locally buffered Append', async () => {
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    let sdkInput;
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt }) => {
        sdkInput = prompt[Symbol.asyncIterator]();
        return {
          interrupt: async () => {},
          [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
        };
      },
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const initialized = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    const initialInput = (await sdkInput.next()).value;
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-buffered-append' });
    assert.equal((await initialized).value.type, 'session_init');

    // The provider produced this snapshot before the local Append was accepted,
    // but the service has not consumed the result event yet.
    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-buffered-append',
      user_message_uuid: initialInput.uuid,
      user_message_uuids: [initialInput.uuid],
      queued_turn_count: 0,
    });
    assert.equal(
      (
        await registration.dispatcher.dispatch(
          { text: 'accepted but not yet dequeued' },
          { expectedInvocationId: registration.invocationId, force: false },
        )
      ).accepted,
      true,
    );

    const pendingOutput = output.next();
    const appendedInput = await sdkInput.next();
    assert.equal(appendedInput.done, false);
    assert.equal(appendedInput.value.message.content[0].text, 'accepted but not yet dequeued');
    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-buffered-append',
      user_message_uuid: appendedInput.value.uuid,
      queued_turn_count: 0,
    });
    assert.equal((await pendingOutput).value.type, 'done');
    assert.equal(registration.released, true);
  });

  it('Claude SDK does not apply an older result queue snapshot to a newer provider-dequeued Append', async () => {
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    let sdkInput;
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt }) => {
        sdkInput = prompt[Symbol.asyncIterator]();
        return {
          interrupt: async () => {},
          [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
        };
      },
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const initialized = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    const initialInput = (await sdkInput.next()).value;
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-dequeued-append' });
    assert.equal((await initialized).value.type, 'session_init');

    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-dequeued-append',
      user_message_uuid: initialInput.uuid,
      queued_turn_count: 0,
    });
    assert.equal(
      (
        await registration.dispatcher.dispatch(
          { text: 'accepted and already dequeued' },
          { expectedInvocationId: registration.invocationId, force: false },
        )
      ).accepted,
      true,
    );
    const appendedInput = (await sdkInput.next()).value;
    const pendingOutput = output.next();
    let settled = false;
    void pendingOutput.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false, 'the older result must not terminalize a newer dequeued input');

    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-dequeued-append',
      user_message_uuid: appendedInput.uuid,
      queued_turn_count: 0,
    });
    assert.equal((await pendingOutput).value.type, 'done');
    assert.equal(registration.released, true);
  });

  it('Claude SDK settles coalesced accepted inputs from one result identity set', async () => {
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    let sdkInput;
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt }) => {
        sdkInput = prompt[Symbol.asyncIterator]();
        return {
          interrupt: async () => ({ still_queued: [] }),
          [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
        };
      },
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const initialized = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    const initialInput = (await sdkInput.next()).value;
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-coalesced-inputs' });
    assert.equal((await initialized).value.type, 'session_init');

    assert.equal(
      (
        await registration.dispatcher.dispatch(
          { text: 'first accepted follow-up' },
          { expectedInvocationId: registration.invocationId, force: false },
        )
      ).accepted,
      true,
    );
    assert.equal(
      (
        await registration.dispatcher.dispatch(
          { text: 'second accepted follow-up' },
          { expectedInvocationId: registration.invocationId, force: false },
        )
      ).accepted,
      true,
    );
    const firstAppend = (await sdkInput.next()).value;
    const secondAppend = (await sdkInput.next()).value;

    const terminal = output.next();
    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-coalesced-inputs',
      user_message_uuid: secondAppend.uuid,
      user_message_uuids: [initialInput.uuid, firstAppend.uuid, secondAppend.uuid],
      usage: { input_tokens: 14, output_tokens: 3 },
    });
    assert.equal((await terminal).value.type, 'done');
    assert.equal(registration.released, true);
  });

  it('Claude SDK keeps the stream open while an explicit Steer is awaiting its interrupt receipt', async () => {
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    let sdkInput;
    let interruptStarted;
    const started = new Promise((resolve) => {
      interruptStarted = resolve;
    });
    let releaseInterrupt;
    const interrupted = new Promise((resolve) => {
      releaseInterrupt = resolve;
    });
    let resultObserved;
    const observed = new Promise((resolve) => {
      resultObserved = resolve;
    });
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt }) => {
        sdkInput = prompt[Symbol.asyncIterator]();
        return {
          interrupt: async () => {
            interruptStarted();
            await interrupted;
            return { still_queued: [] };
          },
          [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
        };
      },
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const initialized = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    const initialInput = (await sdkInput.next()).value;
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-steer-result-race' });
    assert.equal((await initialized).value.type, 'session_init');

    const dispatch = registration.dispatcher.dispatch(
      { text: 'interrupt and follow up' },
      { expectedInvocationId: registration.invocationId, force: true },
    );
    await started;
    const secondTurnOutput = output.next();
    events.push({
      get type() {
        resultObserved();
        return 'result';
      },
      subtype: 'success',
      session_id: 'sdk-steer-result-race',
      user_message_uuid: initialInput.uuid,
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    await observed;
    releaseInterrupt();
    assert.equal((await dispatch).accepted, true);
    const steeredInput = (await sdkInput.next()).value;

    events.push({
      type: 'assistant',
      session_id: 'sdk-steer-result-race',
      message: { id: 'steered-turn', content: [{ type: 'text', text: 'steered response' }] },
    });
    assert.equal((await secondTurnOutput).value.content, 'steered response');

    const terminal = output.next();
    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-steer-result-race',
      user_message_uuid: steeredInput.uuid,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    assert.equal((await terminal).value.type, 'done');
    assert.equal(registration.released, true);
  });

  it('Claude SDK closes a forced Steer from the provider queue snapshot without requiring an interrupted result', async () => {
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    let sdkInput;
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt }) => {
        sdkInput = prompt[Symbol.asyncIterator]();
        return {
          interrupt: async () => ({ still_queued: [] }),
          [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
        };
      },
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const initialized = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    await sdkInput.next();
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-steer-queue-snapshot' });
    assert.equal((await initialized).value.type, 'session_init');

    assert.equal(
      (
        await registration.dispatcher.dispatch(
          { text: 'replacement turn' },
          { expectedInvocationId: registration.invocationId, force: true },
        )
      ).accepted,
      true,
    );
    const steeredInput = (await sdkInput.next()).value;

    const terminal = output.next();
    events.push({
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-steer-queue-snapshot',
      user_message_uuid: steeredInput.uuid,
      queued_turn_count: 0,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    assert.equal((await terminal).value.type, 'done');
    assert.equal(registration.released, true);
  });

  it('Claude SDK injects the invocation MCP map through the native SDK option', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-cafe-claude-sdk-mcp-'));
    mkdirSync(join(root, '.cat-cafe'));
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'user-tool': { command: 'user-tool', args: ['serve'] } } }),
    );
    let sdkOptions;
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      mcpServerPath: join(root, 'missing-dist', 'index.js'),
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ options }) => {
        sdkOptions = options;
        return {
          interrupt: async () => {},
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'sdk-session-mcp' };
          },
        };
      },
    });

    for await (const _message of service.invoke('initial body', {
      workingDirectory: root,
      callbackEnv: { CAT_CAFE_CAT_ID: 'opus', CAT_CAFE_INVOCATION_ID: 'inv-sdk-mcp' },
    })) {
      // Drain the injected query.
    }

    assert.equal(sdkOptions.strictMcpConfig, true);
    assert.deepEqual(sdkOptions.mcpServers['user-tool'], { command: 'user-tool', args: ['serve'] });
  });

  it('Claude SDK rejects a steer whose provider interrupt never acknowledges', async () => {
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      activeRunControlTimeoutMs: 5,
      l0CompilerFn: async () => 'compiled L0',
      queryFn: () => ({
        interrupt: async () => await new Promise(() => {}),
        [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
      }),
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const firstPending = output.next();
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-timeout' });
    assert.equal((await firstPending).value.type, 'session_init');

    const rejected = await registration.dispatcher.dispatch(
      { text: 'must not be appended after an unacknowledged interrupt' },
      { expectedInvocationId: registration.invocationId, force: true },
    );
    assert.deepEqual(rejected, { accepted: false, reason: 'provider_rejected' });

    events.close();
    const failure = await output.next();
    assert.equal(failure.value.type, 'error');
    assert.equal(failure.value.error, 'claude_sdk_stream_ended_without_result');
    assert.equal((await output.next()).value.type, 'done');
  });
});
