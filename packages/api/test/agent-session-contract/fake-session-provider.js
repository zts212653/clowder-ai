import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export class Inbox {
  values = [];
  waiters = [];
  closed = false;
  push(event) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.values.push(event);
  }
  end() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true });
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  async next() {
    if (this.values.length) return { value: this.values.shift(), done: false };
    if (this.closed) return { done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  async return() {
    this.end();
    return { done: true };
  }
}
export const turn = (type, fields = {}) => ({
  scope: 'turn',
  sessionId: 'host',
  seq: 1,
  turn: { invocationId: 'inv', nativeTurnId: 'native-turn' },
  type,
  ...fields,
});
export const session = (type, fields = {}) => ({ scope: 'session', sessionId: 'host', seq: 1, type, ...fields });
export async function* stream(events) {
  yield* events;
}
export const options = (extra = {}) => ({ invocationId: 'inv', ...extra });
export const collect = async (iterable) => Array.fromAsync(iterable);

export class FakeSessionProvider {
  calls = { open: [], start: [], input: [], inspect: [], cancel: [], release: [], capabilities: [] };
  bytes = [];
  bufferedCompactions = [];
  support = {
    input: 'unsupported',
    inputReadReceipt: 'unsupported',
    inspectInput: 'unsupported',
    cancelTurn: 'supported',
    compact: 'unsupported',
    observesCompaction: true,
    continuityEvidence: 'none',
  };
  binding = { state: 'bound', nativeSessionId: 'native' };
  evidence = { kind: 'started', runtimeSessionId: 'native' };
  events = [turn('done', { outcome: 'completed' })];
  capabilities(id) {
    this.calls.capabilities.push(id);
    return this.supportFor?.(id) ?? this.support;
  }
  async openSession(input, signal) {
    this.calls.open.push({ input, signal });
    await this.openGate?.promise;
    if (this.openError) throw this.openError;
    return this.openResult ?? { ok: true, binding: { ...this.binding } };
  }
  async startTurn(id, input, signal) {
    this.calls.start.push({ id, input, signal });
    if (this.beforeVerdictError) throw this.beforeVerdictError;
    if (this.startResult) return this.startResult;
    let text;
    if (input.prompt.kind === 'deferred') {
      const facts = { evidence: this.evidence, compactions: this.bufferedCompactions.splice(0) };
      this.lastFacts = facts;
      const result = await input.prompt.settle(facts);
      if (this.secondVerdict) await input.prompt.settle(facts);
      text = result.prompt;
    } else text = input.prompt.text;
    if (!signal.aborted) this.bytes.push({ id: this.evidence.runtimeSessionId, text });
    return {
      ok: true,
      turn: {
        invocationId: input.invocation.invocationId,
        ...(this.omitNativeTurn ? {} : { nativeTurnId: 'native-turn' }),
      },
      events: this.inbox ?? stream(this.events),
    };
  }
  async input(id, expected, message) {
    this.calls.input.push({ id, expected, message });
    if (this.inputError) throw this.inputError;
    return this.inputResult ?? { status: 'accepted' };
  }
  async inspectInput(id, expected, deliveryId) {
    this.calls.inspect.push({ id, expected, deliveryId });
    return 'accepted';
  }
  async cancelTurn(id, expected, reason) {
    this.calls.cancel.push({ id, expected, reason });
    return { ok: true };
  }
  async release(id, reason) {
    this.calls.release.push({ id, reason });
    if (this.releaseError) throw this.releaseError;
    return this.releaseResult ?? { ok: true };
  }
}
export function fixture(extra = {}) {
  const provider = new FakeSessionProvider();
  const warnings = [];
  const logs = [];
  const bridge = new AgentSessionBridgeService({
    catId: 'codex',
    provider,
    resolveHostSession: (opts) => ({ sessionId: opts.hostId ?? 'host', resumeNativeSessionId: opts.sessionId }),
    log: { warn: (...args) => warnings.push(args), info: (...args) => logs.push(args) },
    ...extra,
  });
  return { provider, bridge, warnings, logs };
}
export async function liveFixture(extra = {}, config = {}, setup = () => {}) {
  const f = fixture(config);
  f.provider.support.input = 'supported';
  f.provider.support.inputReadReceipt = 'supported';
  f.provider.inbox = new Inbox();
  setup(f.provider);
  f.provider.inbox.push(turn('status', { phase: 'running' }));
  const dispatchers = [];
  let releases = 0;
  const iterator = f.bridge
    .invoke(
      'prompt',
      options({
        ...extra,
        activeRunDispatch: {
          invocationId: 'inv',
          register: (dispatcher) => {
            dispatchers.push(dispatcher);
            return () => {
              releases++;
            };
          },
        },
      }),
    )
    [Symbol.asyncIterator]();
  await iterator.next();
  return {
    ...f,
    iterator,
    dispatcher: dispatchers[0],
    get releases() {
      return releases;
    },
    finish: async () => {
      f.provider.inbox.push(turn('done', { outcome: 'completed' }));
      return collect(iterator);
    },
  };
}
