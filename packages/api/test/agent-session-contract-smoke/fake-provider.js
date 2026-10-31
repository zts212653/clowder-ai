// Scripted fake `AgentSessionProvider` for bridge and session contract acceptance tests.
//
// It records every call the bridge makes and lets each test script the events a
// turn emits. It never talks to a real runtime: the acceptance points under test
// are bridge/contract semantics, so a fake is the honest instrument here.
//
// Session lifecycle behavior:
//   * `capabilities()` is per session, and the bridge must not call it before a
//     session exists.
//   * `openSession` may be gated (to make two first calls overlap) or scripted
//     per call (to model "failure is not cached").

/** Push-based async iterable used when a test needs to interleave with the bridge. */
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

export async function collectIterator(iterator) {
  const out = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return out;
    out.push(next.value);
  }
}

export async function waitFor(predicate, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** A logger whose calls can be asserted on. */
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

/**
 * @param {object} [config]
 * @param {'none'|'pre_send'} [config.continuityEvidence]
 * @param {'supported'|'unsupported'} [config.inputSupport]
 * @param {'supported'|'unsupported'} [config.inputReadReceipt]
 * @param {boolean} [config.withInspectInput] set false to omit `inspectInput` entirely
 * @param {{ state: 'bound', nativeSessionId: string } | { state: 'pending_first_input' }} [config.binding]
 * @param {object | ((input: object, callIndex: number) => object)} [config.openSessionResult]
 * @param {Promise<unknown>} [config.openSessionGate] awaited before `openSession` returns
 * @param {string|null} [config.nativeTurnId] native turn id reported by `startTurn`
 * @param {object} [config.startTurnResult] overrides `StartTurnResult` (e.g. `{ ok: false, code }`)
 * @param {object} [config.evidence] `PreSendFacts.evidence` the fake provider declares
 * @param {readonly object[]} [config.compactions] `PreSendFacts.compactions` the fake provider drains
 * @param {boolean} [config.skipSettle] never call `settle` (models "failed before the verdict")
 * @param {(ctx: object) => unknown} [config.events] turn events (array or async iterable)
 * @param {object | Error | ((sessionId, expected, message) => object)} [config.inputResult]
 * @param {object | Error | ((sessionId, reason) => object)} [config.releaseResult]
 */
export function createFakeProvider(config = {}) {
  const calls = {
    openSession: [],
    startTurn: [],
    input: [],
    inspectInput: [],
    cancelTurn: [],
    release: [],
    capabilities: [],
  };
  /** Every prompt the fake provider actually put on the wire, in order. */
  const sent = [];

  const capabilities = {
    input: config.inputSupport ?? 'unsupported',
    inputReadReceipt: config.inputReadReceipt ?? 'supported',
    inspectInput: config.inputReadReceipt ?? 'supported',
    cancelTurn: 'supported',
    compact: 'unsupported',
    observesCompaction: false,
    continuityEvidence: config.continuityEvidence ?? 'none',
    ...config.capabilities,
  };

  const provider = {
    async openSession(input) {
      calls.openSession.push(input);
      if (config.openSessionGate) await config.openSessionGate;
      if (config.openSessionResult instanceof Error) throw config.openSessionResult;
      if (typeof config.openSessionResult === 'function') {
        return config.openSessionResult(input, calls.openSession.length);
      }
      if (config.openSessionResult) return config.openSessionResult;
      return { ok: true, binding: config.binding ?? { state: 'bound', nativeSessionId: 'native-1' } };
    },

    async startTurn(sessionId, input, signal) {
      calls.startTurn.push({ sessionId, input, signal });
      if (config.startTurnResult) return config.startTurnResult;

      const turn = { invocationId: input.invocation.invocationId };
      if (config.nativeTurnId !== null) turn.nativeTurnId = config.nativeTurnId ?? 'turn-1';

      let promptText;
      if (input.prompt?.kind === 'deferred') {
        if (!config.skipSettle) {
          const facts = { evidence: config.evidence ?? { kind: 'started', runtimeSessionId: 'native-1' } };
          if (config.compactions !== undefined) facts.compactions = config.compactions;
          const settled = await input.prompt.settle(facts);
          promptText = settled.prompt;
          sent.push(promptText);
        }
      } else {
        promptText = input.prompt.text;
        sent.push(promptText);
      }

      const ctx = { sessionId, input, turn, promptText, sent, calls };
      const events = typeof config.events === 'function' ? config.events(ctx) : config.events;
      return { ok: true, turn, events: toAsyncIterable(events) };
    },

    async input(sessionId, expected, message) {
      calls.input.push({ sessionId, expected, message });
      if (config.inputResult instanceof Error) throw config.inputResult;
      if (typeof config.inputResult === 'function') return config.inputResult(sessionId, expected, message);
      return config.inputResult ?? { status: 'accepted' };
    },

    async inspectInput(sessionId, expected, deliveryId) {
      calls.inspectInput.push({ sessionId, expected, deliveryId });
      return config.inspectInputResult ?? 'not_accepted';
    },

    async cancelTurn(sessionId, expected, reason) {
      calls.cancelTurn.push({ sessionId, expected, reason });
      return { ok: true };
    },

    async release(sessionId, reason) {
      calls.release.push({ sessionId, reason });
      if (config.releaseResult instanceof Error) throw config.releaseResult;
      if (typeof config.releaseResult === 'function') return config.releaseResult(sessionId, reason);
      return config.releaseResult ?? { ok: true };
    },

    capabilities(sessionId) {
      calls.capabilities.push(sessionId);
      return capabilities;
    },
  };

  if (config.withInspectInput === false) delete provider.inspectInput;

  return { provider, calls, sent };
}
