import assert from 'node:assert/strict';
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

describe('SDK correlation does not invent optional model-read evidence', () => {
  for (const scenario of [
    ['delivery-error', false],
    ['synthetic-api-error', false],
    ['heartbeat', false],
    ['local-command', false],
    ['real-assistant-single', true],
    ['consumed-error-result', true],
  ]) {
    it(scenario[0], async () => {
      const [kind, consumed] = scenario;
      const events = new AsyncInbox();
      const controller = new AbortController();
      let input;
      let dispatcher;
      const reads = [];
      const service = new ClaudeSdkAgentService({
        catId: 'opus',
        model: 'claude-test',
        l0CompilerFn: async () => 'L0',
        queryFn: ({ prompt, options }) => {
          input = prompt[Symbol.asyncIterator]();
          options.abortController.signal.addEventListener('abort', () => events.close(), { once: true });
          return {
            close: () => events.close(),
            interrupt: async () => {},
            [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
          };
        },
      });
      const output = service
        .invoke('initial', {
          invocationId: 'read-proof',
          signal: controller.signal,
          activeRunDispatch: {
            invocationId: 'read-proof',
            register(value) {
              dispatcher = value;
              return () => {};
            },
          },
          toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
        })
        [Symbol.asyncIterator]();
      const initialized = output.next();
      while (!input) await new Promise((resolve) => setImmediate(resolve));
      await input.next();
      events.push({ type: 'system', subtype: 'init', session_id: 'read-proof-session' });
      await initialized;
      await dispatcher.dispatch(
        { text: 'append', messageIds: ['exact-source'], onInputRead: async () => reads.push('exact-source') },
        { expectedInvocationId: 'read-proof', force: false },
      );
      const send = (await input.next()).value;
      const pending = output.next();
      const echo = { user_message_uuid: send.uuid, parent_tool_use_id: null, session_id: 'read-proof-session' };
      switch (kind) {
        case 'delivery-error':
          events.push({
            ...echo,
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            num_turns: 0,
            errors: ['delivery failed'],
            usage: { input_tokens: 0, output_tokens: 0 },
            modelUsage: {},
          });
          break;
        case 'synthetic-api-error':
          events.push({
            ...echo,
            type: 'assistant',
            error: 'authentication_failed',
            message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] },
          });
          break;
        case 'heartbeat':
          events.push({ ...echo, type: 'stream_event', user_message_uuids: [send.uuid], event: { type: 'ping' } });
          break;
        case 'local-command':
          events.push({
            ...echo,
            type: 'result',
            subtype: 'success',
            local_command: '/help',
            user_message_uuids: [send.uuid],
            result: 'help',
            usage: {},
            modelUsage: {},
          });
          break;
        case 'real-assistant-single':
          events.push({
            ...echo,
            type: 'assistant',
            message: { model: 'claude-test', content: [{ type: 'text', text: 'reply' }] },
          });
          break;
        case 'consumed-error-result':
          events.push({
            ...echo,
            type: 'result',
            subtype: 'error_max_turns',
            user_message_uuids: [send.uuid],
            is_error: true,
            num_turns: 1,
            errors: ['turn limit'],
            usage: { input_tokens: 10, output_tokens: 1 },
            modelUsage: {},
          });
          break;
      }
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      events.close();
      await pending.catch(() => {});
      await output.return();
      assert.deepEqual(
        reads,
        consumed ? ['exact-source'] : [],
        'correlation-only feedback is not consumption evidence',
      );
    });
  }
});

describe('accepted SDK input does not delay exact Stop', () => {
  it('observes only exact main-query input UUIDs without waiting for presentation persistence', async () => {
    const events = new AsyncInbox();
    const controller = new AbortController();
    let dispatcher;
    let sdkInput;
    let releaseRead;
    const reads = [];
    const delayedRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt, options }) => {
        sdkInput = prompt[Symbol.asyncIterator]();
        options.abortController.signal.addEventListener('abort', () => events.close(), { once: true });
        return { close() {}, interrupt: async () => {}, [Symbol.asyncIterator]: () => events[Symbol.asyncIterator]() };
      },
    });
    const output = service
      .invoke('initial', {
        invocationId: 'inv-read',
        signal: controller.signal,
        activeRunDispatch: {
          invocationId: 'inv-read',
          register(value) {
            dispatcher = value;
            return () => {};
          },
        },
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const initialized = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    await sdkInput.next();
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-read' });
    await initialized;
    assert.equal(dispatcher.capabilities.inputReadReceipt, true);
    for (const id of ['first', 'second']) {
      assert.equal(
        (
          await dispatcher.dispatch(
            {
              text: id,
              messageIds: [id],
              onInputRead: async () => {
                reads.push(id);
                if (id === 'second') await delayedRead;
              },
            },
            { expectedInvocationId: 'inv-read', force: false },
          )
        ).accepted,
        true,
      );
    }
    const first = (await sdkInput.next()).value;
    const second = (await sdkInput.next()).value;
    assert.deepEqual(reads, [], 'client iterator dequeue is not model input evidence');
    const pendingOutput = output.next();
    events.push({
      type: 'assistant',
      parent_tool_use_id: 'subagent',
      user_message_uuid: first.uuid,
      message: { content: [] },
    });
    events.push({ type: 'stream_event', user_message_uuid: 'unknown', event: { type: 'ping' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reads, []);
    events.push({
      type: 'stream_event',
      user_message_uuids: [second.uuid, second.uuid],
      event: { type: 'message_start', message: { content: [] } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reads, ['second'], 'folded UUID is exact and duplicate proof is idempotent');
    controller.abort('user_stop');
    const terminal = await Promise.race([
      pendingOutput,
      new Promise((_, reject) => setTimeout(() => reject(new Error('read persistence blocked Stop')), 1000)),
    ]);
    assert.equal(terminal.value.type, 'done');
    releaseRead();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reads, ['second']);
  });
  it('closes the query on abort even before its engine dequeues an accepted input', async () => {
    const events = new AsyncInbox();
    const controller = new AbortController();
    const registration = {
      invocationId: 'inv-sdk-abort',
      dispatcher: undefined,
      register(dispatcher) {
        this.dispatcher = dispatcher;
        return () => {};
      },
    };
    let sdkInput;
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt, options }) => {
        sdkInput = prompt[Symbol.asyncIterator]();
        // The real query ends when its abort controller fires; so does this one.
        options.abortController.signal.addEventListener('abort', () => events.close(), { once: true });
        return { close() {}, interrupt: async () => {}, [Symbol.asyncIterator]: () => events[Symbol.asyncIterator]() };
      },
    });
    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        signal: controller.signal,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const initialized = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    await sdkInput.next();
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-abort' });
    assert.equal((await initialized).value.type, 'session_init');

    const appended = await registration.dispatcher.dispatch(
      { text: 'append before Stop', messageIds: ['msg-stop'] },
      { expectedInvocationId: registration.invocationId, force: false },
    );
    assert.equal(appended.accepted, true);
    const drain = output.next();
    controller.abort('user_stop');

    const terminal = await Promise.race([
      drain,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the query waited instead of closing')), 1_000)),
    ]);
    assert.equal(terminal.value.type, 'done');
    assert.equal('consumption' in appended, false);
  });
});
