import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { ElectronDesktopWindowExecutor } from '../src/domains/plugin/desktop-window-runtime/electron-executor.js';

const url = `http://companion-${'a'.repeat(32)}.localhost:4187/packages/fixture/assets/renderer/index.html`;
const presentation = {
  width: 320,
  height: 350,
  transparent: true as const,
  frame: false as const,
  alwaysOnTop: true,
  skipTaskbar: true,
};

async function executorFixture(
  t: TestContext,
  behavior = 'normal',
  onFailure?: (failure: { phase: string; reason: string; lastStage: string | null }) => void,
  onStage?: (stage: string) => void,
) {
  const root = await mkdtemp(join(tmpdir(), 'f317-window-executor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entrypoint = join(root, 'kernel.mjs');
  await writeFile(
    entrypoint,
    `
    import { createInterface } from 'node:readline';
    const input = createInterface({ input: process.stdin });
    let opened = false;
    let releasePoll;
    input.on('line', async line => {
      const message = JSON.parse(line);
      if (${JSON.stringify(behavior)} === 'stalled-after-contract') {
        process.stderr.write('[desktop-stage] contract-ready\\n');
        return;
      }
      if (${JSON.stringify(behavior)} === 'fragmented-stage') {
        process.stderr.write('[desktop-stage] con');
        setTimeout(() => process.stderr.write('tract-ready\\n'), 15);
        return;
      }
      if (${JSON.stringify(behavior)} === 'silent') return;
      if (${JSON.stringify(behavior)} === 'bridge-during-poll' && message.type === 'companion') {
        if (message.id === '00000000-0000-4000-8000-000000000001') {
          process.stderr.write('[desktop-stage] bridge-replied\\n');
          process.stdout.write(JSON.stringify({
            v: 1,
            type: 'companion',
            id: '00000000-0000-4000-8000-000000000002',
            command: { kind: 'conversation.read' },
          }) + '\\n');
        } else if (message.id === '00000000-0000-4000-8000-000000000002') releasePoll?.();
        return;
      }
      if (['delayed', 'slow-open'].includes(${JSON.stringify(behavior)}) && message.method === 'open') {
        await new Promise(resolve => setTimeout(resolve, ${behavior === 'slow-open' ? 140 : 400}));
      }
      let value = null;
      if (message.method === 'open') {
        if (opened || !['presentation,url', 'presentation,publicCompanionV2,url'].includes(Object.keys(message.params).sort().join(','))) process.exit(3);
        if (${JSON.stringify(behavior)} === 'expect-public-companion-v2' && message.params.publicCompanionV2 !== true) process.exit(3);
        if (process.env.CAT_CAFE_CALLBACK_TOKEN || process.env.OPENAI_API_KEY || process.env.ELECTRON_RUN_AS_NODE) process.exit(4);
        opened = true;
      } else if (message.method === 'poll') {
        if (${JSON.stringify(behavior)} === 'bridge-during-poll') {
          await new Promise(resolve => {
            releasePoll = resolve;
            process.stdout.write(JSON.stringify({
              v: 1,
              type: 'companion',
              id: '00000000-0000-4000-8000-000000000001',
              command: { kind: 'conversation.read' },
            }) + '\\n');
          });
        }
        value = 'visible';
      }
      if (${JSON.stringify(behavior)} === 'oversized') { process.stdout.write('X'.repeat(1_600_001)); return; }
      process.stdout.write(JSON.stringify({ v: 1, id: message.id, ok: true, value }) + '\\n');
      if (${JSON.stringify(behavior)} === 'renderer-gone' && message.method === 'open') {
        setTimeout(() => {
          process.stderr.write('[desktop-runtime] renderer-');
          setTimeout(() => {
            process.stderr.write('gone\\n');
            process.exit(17);
          }, 15);
        }, 30);
      }
      if (message.method === 'close') process.exit(0);
    });
    input.on('close', () => process.exit(0));
  `,
  );
  return new ElectronDesktopWindowExecutor({
    executable: process.execPath,
    entrypoint,
    ...(behavior === 'silent' ? { timeoutMs: 200 } : {}),
    // A child process can start slowly under the full gate's concurrent load.
    // Bound this fixture's first open without racing its stage output at 100 ms.
    ...(['stalled-after-contract', 'fragmented-stage'].includes(behavior) ? { openTimeoutMs: 2_000 } : {}),
    ...(behavior === 'slow-open' ? { timeoutMs: 50, openTimeoutMs: 300 } : {}),
    ...(onFailure ? { onFailure } : {}),
    ...(onStage ? { onStage } : {}),
  });
}

test('Host executor carries no credentials or identity and tears down its own child on abort', async (t) => {
  const executor = await executorFixture(t);
  const controller = new AbortController();
  let closed = 0;
  let closedFailure: unknown = 'not-called';
  const window = await executor.open({
    url,
    presentation,
    signal: controller.signal,
    onClosed: (failure) => {
      closed++;
      closedFailure = failure;
    },
  });
  t.after(() => window.close());
  assert.equal(await window.poll(), 'visible');
  await window.show();
  await window.revokeMedia!();
  assert.equal(await window.poll(), 'visible', 'media revocation must leave the visible window alive');
  controller.abort();
  await window.close();
  await assert.rejects(window.poll(), /closed|ended/i);
  assert.equal(closed, 1);
  assert.equal(closedFailure, undefined, 'executor abort reenters Host without a failure cause');
});

test('Host executor carries exact published package admission to the fixed native child', async (t) => {
  const executor = await executorFixture(t, 'expect-public-companion-v2');
  const window = await executor.open({
    url,
    presentation,
    publicCompanionV2: true,
    signal: new AbortController().signal,
    onClosed: () => {},
  });
  t.after(() => window.close());
  assert.equal(await window.poll(), 'visible');
});

test('a bridge reply can arrive while the independent child poll is still pending', async (t) => {
  let bridgeReplied!: () => void;
  const stage = new Promise<void>((resolve) => {
    bridgeReplied = resolve;
  });
  let secondRequested!: () => void;
  const second = new Promise<void>((resolve) => {
    secondRequested = resolve;
  });
  let release!: (reply: { kind: 'error'; code: 'unavailable' }) => void;
  const executor = await executorFixture(t, 'bridge-during-poll', undefined, (value) => {
    if (value === 'bridge-replied') bridgeReplied();
  });
  let bridgeCalls = 0;
  const window = await executor.open({
    url,
    presentation,
    signal: new AbortController().signal,
    onClosed: () => {},
    request: async () => {
      bridgeCalls++;
      if (bridgeCalls === 2) {
        secondRequested();
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return { kind: 'error', code: 'unavailable' };
    },
  });
  t.after(() => window.close());
  let pollSettled = false;
  const poll = window.poll().then((value) => {
    pollSettled = true;
    return value;
  });
  await Promise.race([
    Promise.all([stage, second]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no bridge reply')), 2_000)),
  ]);
  assert.equal(bridgeCalls, 2);
  assert.equal(pollSettled, false, 'bridge activity does not certify the control poll');
  release({ kind: 'error', code: 'unavailable' });
  assert.equal(await poll, 'visible');
});

test('a responding child may start beyond the short silent-child test deadline', async (t) => {
  const executor = await executorFixture(t, 'delayed');
  const window = await executor.open({ url, presentation, signal: new AbortController().signal, onClosed: () => {} });
  t.after(() => window.close());
  assert.equal(await window.poll(), 'visible');
});

test('a first window load may exceed the regular IPC deadline without failing startup', async (t) => {
  const executor = await executorFixture(t, 'slow-open');
  const window = await executor.open({ url, presentation, signal: new AbortController().signal, onClosed: () => {} });
  t.after(() => window.close());
  assert.equal(await window.poll(), 'visible');
});

test('a failed first load reports its bounded phase and last native stage', async (t) => {
  const failures: Array<{ phase: string; reason: string; lastStage: string | null }> = [];
  const executor = await executorFixture(t, 'stalled-after-contract', (failure) => failures.push(failure));
  await assert.rejects(
    executor.open({ url, presentation, signal: new AbortController().signal, onClosed: () => {} }),
    /desktop request timeout/,
  );
  assert.deepEqual(failures, [{ phase: 'open', reason: 'timeout', lastStage: 'contract-ready' }]);
});

test('a native stage split across stderr chunks remains available at failure', async (t) => {
  const failures: Array<{ phase: string; reason: string; lastStage: string | null }> = [];
  const controller = new AbortController();
  const executor = await executorFixture(
    t,
    'fragmented-stage',
    (failure) => failures.push(failure),
    (stage) => {
      if (stage === 'contract-ready') controller.abort();
    },
  );
  await assert.rejects(
    executor.open({ url, presentation, signal: controller.signal, onClosed: () => {} }),
    /desktop window ended/,
  );
  assert.deepEqual(failures, [{ phase: 'open', reason: 'closed', lastStage: 'contract-ready' }]);
});

test('running child preserves the first renderer failure and process exit instead of a generic close', async (t) => {
  const executor = await executorFixture(t, 'renderer-gone');
  let resolveClosed!: (failure: unknown) => void;
  const closed = new Promise<unknown>((resolve) => {
    resolveClosed = resolve;
  });
  const window = await executor.open({
    url,
    presentation,
    signal: new AbortController().signal,
    onClosed: (...args: unknown[]) => resolveClosed(args[0]),
  });
  t.after(() => window.close());
  const failure = await closed;
  assert.match(JSON.stringify(failure), /renderer-gone/);
  assert.match(JSON.stringify(failure), /17/);
});

for (const behavior of ['silent', 'oversized'])
  test(`executor rejects ${behavior} child output for its specific failure`, async (t) => {
    const executor = await executorFixture(t, behavior);
    await assert.rejects(
      executor.open({ url, presentation, signal: new AbortController().signal, onClosed: () => {} }),
      behavior === 'silent' ? /desktop request timeout/ : /desktop protocol frame budget exceeded/,
    );
  });

test('arbitrary origins and pre-aborted requests cannot launch a desktop child', async (t) => {
  const executor = await executorFixture(t);
  for (const bad of ['https://example.com/', 'file:///private/etc/passwd', 'http://127.0.0.1:3003/']) {
    await assert.rejects(
      executor.open({ url: bad, presentation, signal: new AbortController().signal, onClosed: () => {} }),
      /surface|origin/i,
    );
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executor.open({ url, presentation, signal: controller.signal, onClosed: () => {} }), /abort/i);
});
