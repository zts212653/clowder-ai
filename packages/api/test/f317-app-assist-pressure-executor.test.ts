import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ElectronDesktopWindowExecutor } from '../src/domains/plugin/desktop-window-runtime/electron-executor.js';
import type { DesktopWindowFailure } from '../src/domains/plugin/desktop-window-runtime/types.js';

test(
  'the real executor handles owner backpressure without falling through to protocol failure',
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f317-app-assist-pressure-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const entrypoint = join(root, 'kernel.cjs');
    const pipe = fileURLToPath(new URL('../../../desktop/plugin-window/app-assist-pipe.cjs', import.meta.url));
    await writeFile(
      entrypoint,
      `
    const { createInterface } = require('node:readline');
    const { createAppAssistOwnerPipe } = require(${JSON.stringify(pipe)});
    const setTimer = global.setTimeout, clearTimer = global.clearTimeout;
    const deadlines = [];
    global.setTimeout = (callback, delay, ...args) => {
      if (delay !== 3000) return setTimer(callback, delay, ...args);
      const timer = { callback, cleared: false, unref() {} };
      deadlines.push(timer);
      return timer;
    };
    global.clearTimeout = timer => {
      if (deadlines.includes(timer)) timer.cleared = true;
      else clearTimer(timer);
    };
    const send = (value, done) => process.stdout.write(JSON.stringify(value) + '\\n', done);
    const native = createAppAssistOwnerPipe((frame, done) => process.stdout.write(frame, done));
    let filled = false, retired = false;
    createInterface({ input: process.stdin }).on('line', async line => {
      const message = JSON.parse(line);
      if (message.type === 'app_assist') { native.accept(message); return; }
      if (message.method === 'poll' && !filled) {
        filled = true;
        for (let i = 0; i < 4; i++) native.read().catch(() => {});
      }
      if (message.method === 'show') {
        const atCapacity = !retired;
        if (!retired) {
          retired = true;
          for (const timer of deadlines) if (!timer.cleared) timer.callback();
        }
        const result = await native.read();
        if (atCapacity ? result !== 'unavailable' : result?.status !== 'off') process.exit(2);
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
      appAssist: {
        watch: async () => async () => {},
        request: async () => {
          effects++;
          if (effects === 4) filled();
          if (stalled) await new Promise<void>((resolve) => releases.push(resolve));
          return { status: 'off' };
        },
      },
    });
    t.after(async () => {
      for (const release of releases) release();
      await window.close();
    });
    assert.equal(await window.poll(), 'visible');
    await admitted;
    await window.show();
    assert.equal(effects, 4, 'a surplus owner read must not start another Host effect');
    assert.deepEqual(closed, [], 'a handled busy frame must not fall through to protocol parsing');
    stalled = false;
    for (const release of releases) release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await window.show();
    assert.equal(effects, 5, 'drained capacity accepts the next genuine owner read');
    assert.equal(await window.poll(), 'visible');
    assert.deepEqual(closed, []);
  },
);
