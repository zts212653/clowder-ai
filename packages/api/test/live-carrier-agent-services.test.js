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
    assert.equal((await sdkInput.next()).value.message.content[0].text, 'append body');
    assert.equal(interruptCount, 0);

    const steered = await registration.dispatcher.dispatch(
      { text: 'steer body' },
      { expectedInvocationId: registration.invocationId, force: true },
    );
    assert.equal(steered.accepted, true);
    assert.equal(interruptCount, 1);
    assert.equal((await sdkInput.next()).value.message.content[0].text, 'steer body');

    events.push({
      type: 'stream_event',
      session_id: 'sdk-session-1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } },
    });
    assert.equal((await output.next()).value.content, 'done');
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

  it('Claude SDK closes a streaming-input query when the provider emits its result terminal', async () => {
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: () => ({
        interrupt: async () => {},
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

  it('Claude SDK consumes the response for an Append accepted before the current result terminal', async () => {
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

    assert.deepEqual(
      await registration.dispatcher.dispatch(
        { text: 'accepted follow-up' },
        { expectedInvocationId: registration.invocationId, force: false },
      ),
      {
        accepted: true,
        handle: {
          provider: 'anthropic',
          carrier: 'claude_agent_sdk',
          threadId: 'sdk-append-result-race',
          turnId: registration.dispatcher.handle.turnId,
        },
      },
    );
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
    assert.equal((await output.next()).value.type, 'done');
  });
});
