import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCodexNativeAccount } from '../src/config/codex-account-native-validation.js';
import { runCodexAppServerWithRecovery } from '../src/domains/cats/services/agents/providers/CodexAppServerRunner.js';
import { CodexAppServerRpcError } from '../src/domains/cats/services/agents/providers/codex-app-server-rpc-error.js';
import { buildCodexStartupDiagnostics } from '../src/domains/cats/services/agents/providers/codex-startup-diagnostics.js';
import { CodexStartupRecoveryBudget } from '../src/domains/cats/services/agents/providers/codex-startup-recovery.js';
import { CodexStartupWire } from './helpers/codex-startup-wire.js';

const discovery = { code: -32603, message: 'workspace routing discovery failed' };
const runInput = {
  thread: { kind: 'start' as const },
  prompt: { kind: 'frozen' as const, prompt: 'original task' },
  validateConfiguration: (request: (method: string, params: Record<string, unknown>) => Promise<unknown>) =>
    validateCodexNativeAccount(request, {
      authMode: 'auto',
      sqliteHome: '/tmp/f320-fixture-sqlite',
      cwd: process.cwd(),
    }),
};
async function execute(
  wires: CodexStartupWire[],
  onEvent?: (event: unknown) => void,
  signal?: AbortSignal,
  startupRecovery = { retryDelaysMs: [0, 0, 0, 0, 0], budgetMs: 500 },
) {
  let calls = 0;
  const events: unknown[] = [];
  let failure: unknown;
  try {
    for await (const event of runCodexAppServerWithRecovery({
      sessionFactory: async () => wires[calls++] ?? new CodexStartupWire(discovery),
      sessionOptions: { command: 'fixture', args: [], invocationId: 'startup-fixture' },
      runInput: { ...runInput, ...(signal ? { signal } : {}) },
      startupRecovery,
    })) {
      events.push(event);
      onEvent?.(event);
    }
  } catch (error) {
    failure = error;
  }
  return { events, failure, calls };
}

test('F320: two failed account probes recover the original task exactly once', async () => {
  const wires = [new CodexStartupWire(discovery), new CodexStartupWire(discovery), new CodexStartupWire()];
  const result = await execute(wires);
  assert.equal(result.failure, undefined, 'transient account discovery must recover beyond the legacy one retry');
  assert.equal(result.calls, 3);
  assert.deepEqual(
    wires.map((w) => w.writes.filter((m) => m.method === 'turn/start').length),
    [0, 0, 1],
  );
  const ready = result.events.find(
    (e: unknown) => (e as { startupRecovery?: { stage?: string } }).startupRecovery?.stage === 'ready',
  );
  assert.equal((ready as { startupRecovery: { attempt: number } })?.startupRecovery.attempt, 3);
});

test('F320: sustained discovery failure stops at six attempts with one final diagnostic', async () => {
  const result = await execute(Array.from({ length: 6 }, () => new CodexStartupWire(discovery)));
  assert.equal(result.calls, 6);
  const failed = result.events.filter(
    (e: unknown) => (e as { startupRecovery?: { stage?: string } }).startupRecovery?.stage === 'failed',
  );
  assert.equal(failed.length, 1);
  assert.match(String(result.failure), /discovery failed/);
});

test('F320: owner stop during retry wait cannot open another connection', async () => {
  const controller = new AbortController();
  const result = await execute(
    [new CodexStartupWire(discovery)],
    (event) => {
      if ((event as { startupRecovery?: { stage?: string } }).startupRecovery?.stage === 'retry_wait')
        controller.abort();
    },
    controller.signal,
  );
  assert.equal(result.calls, 1);
  assert.ok(
    result.events.some((e) => (e as { startupRecovery?: { stage?: string } }).startupRecovery?.stage === 'cancelled'),
  );
});

for (const error of [
  { ...discovery, data: { http_status: 401 } },
  { ...discovery, data: { http_status: 403 } },
  { code: -32603, message: 'invalid workspace routing configuration' },
  { code: -32603, message: 'unclassified provider refusal' },
])
  test(`F320: deterministic account refusal does not retry (${JSON.stringify(error)})`, async () => {
    const result = await execute([new CodexStartupWire(error)]);
    assert.equal(result.calls, 1);
    assert.ok(result.failure);
  });

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('F320: an unknown reconnect RPC verdict cannot be admitted as a carrier failure', () => {
  const budget = new CodexStartupRecoveryBudget('rpc-refusal');
  budget.begin();
  try {
    const error = new CodexAppServerRpcError({ method: 'initialize', code: -32603, message: 'provider refusal' });
    assert.equal(budget.retry(error, true), null);
  } finally {
    budget.dispose();
  }
});

test('F320: a hung account RPC obeys the total window and late replies cannot send a task', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const wire = new CodexStartupWire('pending');
  const result = execute([wire]);
  await flush();
  assert.ok(wire.writes.some((m) => m.method === 'account/read'));
  t.mock.timers.tick(501);
  const completed = await result;
  assert.equal(completed.calls, 1);
  assert.ok(completed.failure);
  const request = wire.writes.find((m) => m.method === 'account/read');
  wire.push({ id: request?.id, result: { account: { type: 'chatgpt' } } });
  await flush();
  assert.equal(
    wire.writes.some((m) => m.method === 'turn/start'),
    false,
  );
  assert.ok(wire.closeCalls > 0);
});

test('F320: Stop cancels an in-flight account RPC and releases only its wire', async () => {
  const controller = new AbortController();
  const wire = new CodexStartupWire('pending');
  const sibling = new CodexStartupWire();
  const result = execute([wire, sibling], undefined, controller.signal);
  await flush();
  const stop = new Error('owner stopped startup');
  controller.abort(stop);
  const completed = await result;
  assert.equal(completed.failure, stop, 'owner cancellation is not reclassified as a carrier failure');
  assert.equal(completed.calls, 1);
  assert.equal(sibling.closeCalls, 0);
  assert.equal(
    wire.writes.some((m) => m.method === 'turn/start'),
    false,
  );
  assert.ok(
    completed.events.some(
      (e) => (e as { startupRecovery?: { stage?: string } }).startupRecovery?.stage === 'cancelled',
    ),
  );
});

test('F320: actual backoff timers use 2/5/10/20/30 seconds and never a seventh attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const starts: number[] = [];
  const result = execute(
    Array.from({ length: 6 }, () => new CodexStartupWire(discovery)),
    (e) => {
      const state = (e as { startupRecovery?: { stage?: string } }).startupRecovery;
      if (state?.stage === 'checking') starts.push(Date.now());
    },
    undefined,
    { retryDelaysMs: [2_000, 5_000, 10_000, 20_000, 30_000], budgetMs: 120_000 },
  );
  await flush();
  for (const ms of [2_000, 5_000, 10_000, 20_000, 30_000]) {
    t.mock.timers.tick(ms);
    await flush();
  }
  const completed = await result;
  assert.deepEqual(starts, [1_000, 3_000, 8_000, 18_000, 38_000, 68_000]);
  assert.equal(completed.calls, 6);
});

test('F320: capacity recovery never reopens startup replay eligibility after client lifecycle resets', async () => {
  const first = new CodexStartupWire(undefined, {}, 'Selected model is at capacity. Please try a different model.');
  const second = new CodexStartupWire(discovery);
  const third = new CodexStartupWire(discovery);
  let calls = 0;
  const events: unknown[] = [];
  await assert.rejects(async () => {
    for await (const e of runCodexAppServerWithRecovery({
      sessionFactory: async () => [first, second, third][calls++],
      sessionOptions: { command: 'fixture', args: [], invocationId: 'same-invocation' },
      runInput,
      modelCapacityRetryDelaysMs: [0],
      recoveryAnchor: { invocationId: 'same-invocation', threadId: 'same-chat', promptMessageIds: ['same-source'] },
      startupRecovery: { retryDelaysMs: [0, 0, 0, 0, 0] },
    }))
      events.push(e);
  }, /workspace routing discovery failed/);
  assert.equal(calls, 3, 'the existing one transport retry is separate from first-startup recovery');
  assert.equal(
    events.some((e) => (e as { startupRecovery?: { stage?: string } }).startupRecovery?.stage === 'retry_wait'),
    false,
  );
  assert.equal(
    [second, third].some((wire) => wire.writes.some((m) => m.method === 'turn/start')),
    false,
  );
});

for (const method of ['config/read', 'configRequirements/read', 'account/read', 'initialize'])
  test(`F320: transport loss during ${method} stays in the admitted startup budget`, async () => {
    const broken = new CodexStartupWire();
    const write = broken.write.bind(broken);
    broken.write = async (message) => {
      if (message.method === method) {
        broken.writes.push(message);
        await broken.close();
      } else await write(message);
    };
    const wires = [
      ...(method === 'initialize' ? [new CodexStartupWire(discovery)] : []),
      broken,
      new CodexStartupWire(),
    ];
    const result = await execute(wires);
    assert.equal(result.failure, undefined, 'a broken carrier is not a provider refusal');
    assert.equal(result.calls, wires.length);
    assert.equal(wires.flatMap((wire) => wire.writes).filter((m) => m.method === 'turn/start').length, 1);
  });

test('F320: a pre-turn transport loss after capacity recovery still resumes the same checkpoint', async () => {
  const first = new CodexStartupWire(undefined, {}, 'Selected model is at capacity. Please try a different model.');
  const last = new CodexStartupWire();
  let calls = 0;
  const reasons: unknown[] = [];
  for await (const event of runCodexAppServerWithRecovery({
    sessionFactory: async () => {
      calls++;
      if (calls === 2) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      return calls === 1 ? first : last;
    },
    sessionOptions: { command: 'fixture', args: [], invocationId: 'capacity-transport' },
    runInput,
    retryBudget: 1,
    modelCapacityRetryDelaysMs: [0],
    recoveryAnchor: { invocationId: 'capacity-transport', threadId: 'same-chat', promptMessageIds: ['same-source'] },
  }))
    reasons.push((event as { reason?: string }).reason);
  assert.equal(calls, 3);
  assert.deepEqual(reasons.filter(Boolean), ['model_capacity', 'pre_turn_transport']);
  assert.ok(last.writes.some((m) => m.method === 'thread/resume'));
  assert.equal(last.writes.filter((m) => m.method === 'turn/start').length, 1);
  const resumed = last.writes.find((m) => m.method === 'turn/start')?.params as Record<string, unknown>;
  assert.deepEqual(resumed.input, [], 'capacity continuation must not resend the original prompt');
  assert.match(JSON.stringify(resumed.additionalContext), /Continue only the interrupted turn/);
});

test('F320: same-request evidence is bounded and redacted, JSON-RPC never becomes HTTP', () => {
  const diagnostics = buildCodexStartupDiagnostics(
    new CodexAppServerRpcError({
      method: 'account/read',
      code: -32603,
      message: 'HTTP 503: token=private-token Cookie: session=secret /home/user/home/file',
      data: {
        http_status: 503,
        cause: { code: 'ECONNRESET', message: 'proxy connection reset token=do-not-copy /home/user/home/file' },
        request_id: '4a5684af-a06b-4dd8-9b17-6b6e1dd3597e',
        irrelevant: { token: 'do-not-copy' },
      },
    }),
    'current-invocation',
    3,
    21_000,
  );
  assert.equal(diagnostics.accountCheck?.httpStatus, 503);
  assert.equal(diagnostics.accountCheck?.rpcCode, -32603);
  assert.equal(diagnostics.accountCheck?.causeCode, 'ECONNRESET');
  assert.match(diagnostics.accountCheck?.causeMessage ?? '', /proxy connection reset/);
  assert.equal(diagnostics.debugRef.upstreamRequestId, '4a5684af-a06b-4dd8-9b17-6b6e1dd3597e');
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-token|session=secret|private\/home|do-not-copy/);
  const unknown = buildCodexStartupDiagnostics(
    new CodexAppServerRpcError({ ...discovery, method: 'account/read' }),
    'this-invocation',
    6,
    120_000,
  );
  assert.equal(unknown.accountCheck?.httpStatus, undefined);
  assert.equal(unknown.accountCheck?.causeProvided, false);
  assert.match(unknown.publicHint, /没有返回更具体/);
});

test('F320: a transport network code is bound to account/read before retrying', async () => {
  const first = new CodexStartupWire();
  const write = first.write.bind(first);
  first.write = async (message) => {
    if (message.method === 'account/read') throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    return write(message);
  };
  const result = await execute([first, new CodexStartupWire()]);
  assert.equal(result.failure, undefined);
  assert.equal(result.calls, 2);
});

test('F320: a failed startup lease release never terminates another host consumer', async () => {
  const first = new CodexStartupWire(discovery);
  const close = first.close.bind(first);
  let hostTerminations = 0;
  Object.assign(first, {
    terminate: async () => {
      hostTerminations++;
    },
  });
  first.close = async () => {
    await close();
    throw new Error('lease release failed');
  };
  const result = await execute([first, new CodexStartupWire()]);
  assert.equal(result.failure, undefined);
  assert.equal(hostTerminations, 0, 'startup recovery may only release its connection lease');
});

test('F320: deadline details name the attempt that returned the retained evidence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const result = execute([
    new CodexStartupWire({ ...discovery, data: { http_status: 503 } }),
    new CodexStartupWire('pending'),
  ]);
  await flush();
  t.mock.timers.tick(501);
  const completed = await result;
  const failed = completed.events.find(
    (e) => (e as { startupRecovery?: { stage?: string } }).startupRecovery?.stage === 'failed',
  ) as {
    startupRecovery: {
      attempt: number;
      diagnostics: { accountCheck: { evidenceAttempt: number; httpStatus: number } };
    };
  };
  assert.equal(failed.startupRecovery.attempt, 2);
  assert.equal(failed.startupRecovery.diagnostics.accountCheck.evidenceAttempt, 1);
  assert.equal(failed.startupRecovery.diagnostics.accountCheck.httpStatus, 503);
});
