import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

async function logRows(folder, prefix) {
  const files = (await readdir(folder)).filter((name) => name.startsWith(prefix) && name.endsWith('.ndjson'));
  return (await Promise.all(files.map((name) => readFile(join(folder, name), 'utf8')))).flatMap((text) =>
    text.trim().split('\n').filter(Boolean).map(JSON.parse),
  );
}

for (const [fault, teardown] of [
  ['start-error', 'hold'],
  ['stop-error', 'hold'],
  ['stop-error', 'reject'],
])
  test(
    `${fault}: observe after Inspector failure, fence foreground until cleanup ${teardown}`,
    { timeout: 15000 },
    async (t) => {
      const folder = await mkdtemp(join(tmpdir(), 'owned-tripwire-fault-'));
      const child = fork(
        new URL('./helpers/tripwire-inspector-fault-api.mjs', import.meta.url),
        [fault, teardown, folder],
        { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      );
      const events = [];
      let stderr = '';
      child.on('message', (m) => events.push(m));
      child.stderr.on('data', (b) => {
        stderr += b;
      });
      const exited = once(child, 'exit');
      t.after(async () => {
        if (child.connected) child.send({ type: 'close' });
        let timer;
        const state = await Promise.race([
          exited,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve('late'), 1500);
          }),
        ]);
        clearTimeout(timer);
        if (state === 'late') {
          child.kill('SIGKILL');
          await exited;
        }
        await rm(folder, { recursive: true, force: true });
      });
      async function wait(predicate, ms = 5000) {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          const event = events.find(predicate);
          if (event) return event;
          if (child.exitCode !== null) assert.fail(`fixture exited ${child.exitCode}: ${stderr}`);
          await delay(15);
        }
        assert.fail(`missing event: ${JSON.stringify(events)} ${stderr}`);
      }
      assert.equal((await wait((m) => m.type === 'ready')).ready, true);
      await wait((m) => m.type === 'test-control' && m.stage === 'fault-injected');
      child.send({ type: 'block' });
      await wait((m) => m.type === 'entered');
      let resource;
      const until = performance.now() + 1800;
      while (performance.now() < until && !resource) {
        resource = (await logRows(folder, 'event-loop-resources.')).find((row) => row.phase === 'ongoing');
        if (!resource) await delay(15);
      }
      assert.ok(resource, 'Inspector error must not terminate the independent long-stall observer');
      await wait((m) => m.type === 'block-done');
      assert.equal(
        events.some((m) => m.type === 'observer-exit'),
        false,
        'observer must remain alive after profiler failure',
      );
      await wait((m) => m.type === 'log' && m.entry.attribution === 'unknown' && m.entry.reason === 'profiler_failed');
      const code = await logRows(folder, 'event-loop-tripwire.');
      assert.ok(code.some((row) => row.attribution === 'unknown' && row.reason === 'profiler_failed'));
      child.send({ type: 'foreground', id: 'during-cleanup' });
      await wait((m) => m.type === 'foreground-pending');
      if (teardown === 'hold') {
        await wait((m) => m.type === 'test-control' && m.stage === 'disable-held');
        await delay(100);
        assert.equal(
          events.some((m) => m.type === 'foreground-result'),
          false,
          'unconfirmed cleanup cannot grant foreground',
        );
        child.send({ type: 'release-disable' });
        const result = await wait((m) => m.type === 'foreground-result');
        assert.equal(result.admitted, true);
        assert.equal(result.status, 'sampled');
      } else {
        const result = await wait((m) => m.type === 'foreground-result');
        assert.equal(result.admitted, false);
        child.send({ type: 'close-observer' });
        await wait((m) => m.type === 'observer-closed');
        child.send({ type: 'foreground', id: 'after-unproven-exit' });
        assert.equal(
          (await wait((m) => m.type === 'foreground-result' && m.id === 'after-unproven-exit')).admitted,
          false,
          'an observer exit without profiler unload proof must not clear the fence',
        );
      }
    },
  );

test(
  'the native backend loads from an actual encoded installation directory',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'owned-witness-path-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ['ordinary', 'Install Folder 你好 #100%']) {
      const base = join(root, name);
      const cpu = join(base, 'dist/infrastructure/telemetry/cpu');
      await mkdir(cpu, { recursive: true });
      await mkdir(join(base, 'dist/native'), { recursive: true });
      await writeFile(join(base, 'package.json'), ' {"type":"module"}');
      await copyFile(
        new URL('../dist/infrastructure/telemetry/cpu/process-witness.js', import.meta.url),
        join(cpu, 'process-witness.js'),
      );
      await copyFile(
        new URL('../dist/native/process-witness.node', import.meta.url),
        join(base, 'dist/native/process-witness.node'),
      );
      const native = createRequire(import.meta.url)(join(base, 'dist/native/process-witness.node'));
      const wrapper = await import(pathToFileURL(join(cpu, 'process-witness.js')).href);
      assert.equal(
        wrapper.mainThreadIdentity(),
        native.currentThreadId(),
        `wrapper must use a decoded filesystem path: ${name}`,
      );
    }
  },
);
