// Scripted collaborators for plugin declaration, registration, settings,
// service selection and ACP adapter acceptance tests.
// These tests verify session behavior without starting a transport process.

/** Push-based async iterable used when a test needs to interleave with the code under test. */
export class AsyncInbox {
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
        if (this.#values.length > 0) return Promise.resolve({ value: this.#values.shift(), done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export async function collect(iterable) {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
}

export async function waitFor(predicate, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${description}`);
}

export function createLogSpy() {
  const info = [];
  const warn = [];
  return {
    info: (...args) => info.push(args),
    warn: (...args) => warn.push(args),
    calls: { info, warn },
  };
}

function toAsyncIterable(value) {
  if (value && typeof value[Symbol.asyncIterator] === 'function') return value;
  const items = value ?? [];
  return (async function* () {
    for (const item of items) yield item;
  })();
}

/** An `AgentMessage` with the envelope every adapter output must carry. */
export function agentMessage(type, fields = {}, metadata = {}) {
  return {
    type,
    catId: 'cat-1',
    timestamp: 1,
    metadata: { provider: 'fake-provider', model: 'fake-model', ...metadata },
    ...fields,
  };
}

/**
 * Scripted 1a-shaped `AgentSessionProvider`, for the bridge and the
 * lazily-resolving service.
 *
 * @param {object} [config]
 * @param {'none'|'pre_send'} [config.continuityEvidence]
 * @param {{ state: 'bound', nativeSessionId: string } | { state: 'pending_first_input' }} [config.binding]
 * @param {Promise<unknown>} [config.openGate] awaited inside `openSession`
 * @param {object | ((input: object, callIndex: number) => object | Promise<object>)} [config.openResult]
 * @param {(ctx: object) => unknown} [config.events]
 * @param {string|null} [config.nativeTurnId]
 */
export function createFakeSessionProvider(config = {}) {
  const calls = { openSession: [], startTurn: [], release: [], capabilities: [] };

  const provider = {
    async openSession(input) {
      calls.openSession.push(input);
      if (config.openGate) await config.openGate;
      if (typeof config.openResult === 'function') {
        return config.openResult(input, calls.openSession.length);
      }
      if (config.openResult) return config.openResult;
      return { ok: true, binding: config.binding ?? { state: 'bound', nativeSessionId: 'native-1' } };
    },

    async startTurn(sessionId, input, signal) {
      calls.startTurn.push({ sessionId, input, signal });
      const turn = { invocationId: input.invocation?.invocationId ?? 'inv-1' };
      if (config.nativeTurnId !== null) turn.nativeTurnId = config.nativeTurnId ?? 'turn-1';
      const events =
        typeof config.events === 'function'
          ? config.events({ sessionId, input, turn, calls })
          : (config.events ?? [
              { scope: 'turn', sessionId, turn, seq: 1, type: 'output', text: 'ok', textMode: 'append' },
              { scope: 'turn', sessionId, turn, seq: 2, type: 'done', outcome: 'completed' },
            ]);
      return { ok: true, turn, events: toAsyncIterable(events) };
    },

    async release(sessionId, reason) {
      calls.release.push({ sessionId, reason });
      return { ok: true };
    },

    capabilities(sessionId) {
      calls.capabilities.push(sessionId);
      return {
        input: 'unsupported',
        inputReadReceipt: 'unsupported',
        inspectInput: 'unsupported',
        cancelTurn: 'supported',
        compact: 'unsupported',
        observesCompaction: false,
        continuityEvidence: config.continuityEvidence ?? 'none',
      };
    },
  };

  return { provider, calls };
}

/**
 * Scripted `AgentService` handed to `AcpSessionProvider`.
 *
 * @param {object} [config]
 * @param {(prompt: string, options: object) => unknown} [config.invoke] custom stream
 * @param {(nativeSessionId: string) => Promise<void>} [config.releaseSession] omit to model a service without it
 */
export function createFakeAgentService(config = {}) {
  const calls = { invoke: [], releaseSession: [] };
  const service = {
    invoke(prompt, options) {
      calls.invoke.push({ prompt, options });
      if (config.invoke) return toAsyncIterable(config.invoke(prompt, options));
      return toAsyncIterable([agentMessage('text', { content: 'reply' }), agentMessage('done')]);
    },
  };
  if (config.withReleaseSession !== false) {
    service.releaseSession = async (nativeSessionId) => {
      calls.releaseSession.push(nativeSessionId);
      if (config.releaseSessionThrows) throw new Error('releaseSession exploded');
    };
  }
  return { service, calls };
}

/** A `TurnInput` for directly driving an `AgentSessionProvider`. */
export function turnInput({
  invocationId = 'inv-1',
  callbackEnv = { CAT_CAFE_CALLBACK_TOKEN: 'token-1' },
  text = 'hello',
  hostOptions,
} = {}) {
  const input = {
    invocation: { invocationId, callbackEnv },
    prompt: { kind: 'frozen', text },
  };
  if (hostOptions !== undefined) input.hostOptions = hostOptions;
  return input;
}
