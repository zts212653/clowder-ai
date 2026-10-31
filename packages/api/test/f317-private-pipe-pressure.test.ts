import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAppAssistPipe } from '../src/domains/plugin/desktop-window-runtime/app-assist-pipe.js';
import { ElectronDesktopWindowExecutor } from '../src/domains/plugin/desktop-window-runtime/electron-executor.js';
import type { DesktopWindowFailure } from '../src/domains/plugin/desktop-window-runtime/types.js';

interface NativeOwnerPipe {
  read(): Promise<unknown>;
  accept(frame: unknown): void;
  close(): void;
}
const require = createRequire(import.meta.url);
const { createAppAssistOwnerPipe } = require('../../../desktop/plugin-window/app-assist-pipe.cjs') as {
  createAppAssistOwnerPipe(write: (frame: string) => void): NativeOwnerPipe;
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('expired native owner reads receive backpressure while four original Host reads still drain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let effects = 0;
  let stalled = true;
  const releases: Array<() => void> = [];
  let native!: NativeOwnerPipe;
  const host = createAppAssistPipe(
    {
      watch: async () => async () => {},
      request: async () => {
        effects++;
        if (stalled) await new Promise<void>((resolve) => releases.push(resolve));
        return { status: 'off' };
      },
    },
    (line) => native.accept(JSON.parse(line)),
  );
  native = createAppAssistOwnerPipe((line) => host.accept(JSON.parse(line)));
  t.after(() => {
    native.close();
    host.close();
    for (const release of releases) release();
  });
  const retired = Promise.allSettled(Array.from({ length: 4 }, () => native.read()));
  assert.equal(effects, 4);
  t.mock.timers.tick(3_000); // Actual native pipe deadlines; Host work has not finished.
  assert.ok((await retired).every((result) => result.status === 'rejected'));
  assert.equal(await native.read(), 'unavailable');
  assert.equal(effects, 4, 'the overflow request must not start another Host effect');
  stalled = false;
  for (const release of releases) release();
  await turn();
  assert.deepEqual(await native.read(), { status: 'off' });
  assert.equal(effects, 5, 'capacity returns after the original requests finish');
});

test('duplicate owner request ids still fail at capacity and missing or closed owners remain denied', () => {
  const input = { v: 1, type: 'app_assist', id: randomUUID(), command: { kind: 'read' } };
  const host = createAppAssistPipe(
    { watch: async () => async () => {}, request: async () => new Promise(() => {}) },
    () => {},
  );
  try {
    host.accept(input);
    for (let i = 0; i < 3; i++) host.accept({ ...input, id: randomUUID() });
    assert.throws(() => host.accept(input), /Invalid app-assist pipe/);
  } finally {
    host.close();
  }
  assert.throws(() => host.accept({ ...input, id: randomUUID() }), /Invalid app-assist pipe/);
  assert.throws(() => createAppAssistPipe(undefined, () => {}).accept(input), /Invalid app-assist pipe/);
});

for (const attack of ['none', 'duplicate', 'malformed'] as const) {
  test(
    `the real executor distinguishes expired-request pressure from ${attack} companion input`,
    { timeout: 15_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'f317-private-pipe-pressure-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const entrypoint = join(root, 'kernel.cjs');
      const pipe = fileURLToPath(new URL('../../../desktop/plugin-window/companion-pipe.cjs', import.meta.url));
      await writeFile(
        entrypoint,
        `
    const { createInterface } = require('node:readline');
    const { createCompanionPipe } = require(${JSON.stringify(pipe)});
    const setTimer = global.setTimeout, clearTimer = global.clearTimeout;
    const deadlines = [];
    global.setTimeout = (callback, delay, ...args) => {
      if (delay !== 70000) return setTimer(callback, delay, ...args);
      const timer = { callback, cleared: false, unref() {} };
      deadlines.push(timer);
      return timer;
    };
    global.clearTimeout = timer => {
      if (deadlines.includes(timer)) timer.cleared = true;
      else clearTimer(timer);
    };
    const send = (value, done) => process.stdout.write(JSON.stringify(value) + '\\n', done);
    let firstFrame;
    const native = createCompanionPipe((frame, done) => {
      firstFrame ??= frame;
      return process.stdout.write(frame, done);
    });
    let filled = false, retired = false;
    createInterface({ input: process.stdin }).on('line', async line => {
      const message = JSON.parse(line);
      if (message.type === 'companion') { native.accept(message); return; }
      if (message.method === 'poll' && !filled) {
        filled = true;
        for (let i = 0; i < 16; i++) void native.request({ kind: 'state' });
      }
      if (message.method === 'show') {
        if (${JSON.stringify(attack)} !== 'none') {
          process.stdout.write(${JSON.stringify(attack)} === 'duplicate'
            ? firstFrame
            : JSON.stringify({ v: 1, type: 'companion', id: 'invalid-id', command: { kind: 'state' } }) + '\\n');
          send({ v: 1, id: message.id, ok: true, value: null });
          return;
        }
        if (!retired) {
          retired = true;
          for (const timer of deadlines) if (!timer.cleared) timer.callback();
        }
        const result = await native.request({ kind: 'state' });
        if (result.kind !== 'error' || result.code !== 'unavailable') process.exit(2);
      }
      send({ v: 1, id: message.id, ok: true, value: message.method === 'poll' ? 'visible' : null }, () => {
        if (message.method === 'close') { native.close(); process.exit(0); }
      });
    });
  `,
      );
      let effects = 0;
      let stalled = true;
      let filled!: () => void;
      const admitted = new Promise<void>((resolve) => {
        filled = resolve;
      });
      const releases: Array<() => void> = [];
      const closed: Array<DesktopWindowFailure | undefined> = [];
      const executor = new ElectronDesktopWindowExecutor({ executable: process.execPath, entrypoint });
      const window = await executor.open({
        url: `http://companion-${'a'.repeat(32)}.localhost:4187/packages/fixture/renderer/index.html`,
        presentation: {
          width: 320,
          height: 350,
          transparent: true,
          frame: false,
          alwaysOnTop: true,
          skipTaskbar: true,
        },
        signal: new AbortController().signal,
        onClosed: (failure) => closed.push(failure),
        request: async () => {
          effects++;
          if (effects === 16) filled();
          if (stalled) await new Promise<void>((resolve) => releases.push(resolve));
          return { kind: 'error', code: 'unavailable' };
        },
      });
      t.after(async () => {
        for (const release of releases) release();
        await window.close();
      });
      assert.equal(await window.poll(), 'visible');
      await admitted;
      if (attack !== 'none') {
        await assert.rejects(window.show(), /desktop protocol violation/);
        assert.equal(effects, 16);
        assert.equal(closed.length, 1);
        assert.equal(closed[0]?.reason, 'protocol-violation');
        return;
      }
      await window.show();
      assert.equal(effects, 16, 'the surplus frame must get backpressure without a new authority call');
      assert.deepEqual(closed, [], 'valid overload must not become a terminal protocol violation');
      stalled = false;
      for (const release of releases) release();
      await turn();
      await window.show();
      assert.equal(effects, 17, 'drained capacity accepts the next genuine call');
      assert.equal(await window.poll(), 'visible');
      assert.deepEqual(closed, []);
    },
  );
}
