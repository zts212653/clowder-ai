import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  validateHostCompanionCommand,
  validateHostCompanionReply,
} from '../src/domains/plugin/desktop-window-runtime/companion-private-wire.js';
import { ElectronDesktopWindowExecutor } from '../src/domains/plugin/desktop-window-runtime/electron-executor.js';
import { modernCompanionInstallFixture as fixture } from './helpers/f317-companion-install-fixture.js';

// F336 Phase C U2: the kernel's scene writer reaches the U1 archive over the existing companion
// pipe with two Host-private commands; the Bridge resolves the duty cat itself.
const snapshot = { schemaVersion: 1, hat: { askew: true }, ball: { x: 0.4, h: 0, ceil: false } };
const duty = 'composition-selected';
const LIVING = '0.3.3-candidate.3';

test('the private wire carries scene.read / scene.write and their replies, bounded like the archive', () => {
  const write = { kind: 'scene.write', catId: 'opus', baseRevision: 0, snapshot };
  assert.equal(validateHostCompanionCommand({ kind: 'scene.read' }, LIVING), true);
  assert.equal(validateHostCompanionCommand(write, LIVING), true);
  // F336 U8: only a livingBody line has a scene; the body's own public commands never cross this pipe.
  for (const contract of ['0.1.0-beta.21', '0.1.0-beta.23', '0.3.3-candidate.0'] as const) {
    assert.equal(validateHostCompanionCommand({ kind: 'scene.read' }, contract), false, contract);
    assert.equal(validateHostCompanionCommand(write, contract), false, contract);
  }
  for (const contract of ['0.3.3-candidate.0', LIVING] as const)
    for (const command of [
      { kind: 'scene.get' },
      { kind: 'scene.report', snapshot, dirty: ['hat'] },
      { kind: 'body.hit', rects: [] },
      { kind: 'body.hit.renew' },
      { kind: 'body.anchor', rect: { x: 0, y: 0, width: 1, height: 1 } },
      { kind: 'body.menu' },
    ])
      assert.equal(validateHostCompanionCommand(command, contract), false, `${contract} ${command.kind}`);
  for (const bad of [
    { kind: 'scene.read', catId: 'opus' },
    { kind: 'scene.write', catId: 'opus', baseRevision: -1, snapshot },
    { kind: 'scene.write', catId: 'a:b', baseRevision: 0, snapshot },
    { kind: 'scene.write', catId: 'opus', baseRevision: 0, snapshot: { schemaVersion: 1, secret: 1 } },
    { kind: 'scene.write', catId: 'opus', baseRevision: 0, snapshot, extra: true },
    { kind: 'scene.clear' },
  ])
    assert.equal(validateHostCompanionCommand(bad, LIVING), false, JSON.stringify(bad));
  const found = { status: 'found', revision: 2, updatedAt: 1000, snapshot };
  for (const reply of [
    { kind: 'scene', catId: 'opus', ...found },
    { kind: 'scene', catId: 'opus', status: 'not_found' },
    { kind: 'scene', catId: 'opus', status: 'error', reason: 'corrupt' },
    { kind: 'scene-put', status: 'ok', revision: 3 },
    { kind: 'scene-put', status: 'conflict', current: found },
    { kind: 'scene-put', status: 'conflict', current: { status: 'error', reason: 'corrupt' } },
    { kind: 'scene-put', status: 'error', reason: 'unavailable' },
  ])
    assert.equal(validateHostCompanionReply(reply), true, JSON.stringify(reply));
  for (const reply of [
    { kind: 'scene', status: 'not_found' },
    { kind: 'scene', catId: 'opus', ...found, revision: 0 },
    { kind: 'scene-put', status: 'ok', revision: 0 },
    { kind: 'scene-put', status: 'conflict', current: { status: 'found', revision: 1 } },
  ])
    assert.equal(validateHostCompanionReply(reply), false, JSON.stringify(reply));
});

test('a line without livingBody has no scene through installation, Broker and Bridge', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.14');
  assert.deepEqual(await f.launch.request!({ kind: 'scene.read' }), { kind: 'error', code: 'invalid_request' });
  assert.equal(f.launch.bodyUrl, undefined, 'and no body page');
});

test('through installation, Broker and Bridge the scene round-trips the U1 archive at the duty cat', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.38');
  const request = f.launch.request;
  assert.ok(request);
  assert.deepEqual(await request({ kind: 'scene.read' }), { kind: 'scene', catId: duty, status: 'not_found' });
  assert.deepEqual(await request({ kind: 'scene.write', catId: duty, baseRevision: 0, snapshot }), {
    kind: 'scene-put',
    status: 'ok',
    revision: 1,
  });
  const found = { status: 'found', revision: 1, updatedAt: 1000, snapshot };
  assert.deepEqual(await request({ kind: 'scene.read' }), { kind: 'scene', catId: duty, ...found });
  assert.deepEqual(
    await request({ kind: 'scene.write', catId: duty, baseRevision: 0, snapshot: { schemaVersion: 1 } }),
    { kind: 'scene-put', status: 'conflict', current: found },
    'a stale base never overwrites',
  );
  assert.deepEqual(
    await request({ kind: 'scene.write', catId: 'another-cat', baseRevision: 1, snapshot }),
    { kind: 'error', code: 'selection_changed' },
    'a write lands only on the duty cat it was read for',
  );
  assert.deepEqual(
    await request({ kind: 'scene.write', catId: duty, baseRevision: 1, snapshot: { schemaVersion: 1, x: 1 } }),
    { kind: 'error', code: 'invalid_request' },
  );
  assert.deepEqual(await request({ kind: 'scene.read' }), { kind: 'scene', catId: duty, ...found });
});

test('the actual child pipe carries the scene commands both ways through the executor validators', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f336-scene-executor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entrypoint = join(root, 'kernel.mjs');
  await writeFile(
    entrypoint,
    `
    import { randomUUID } from 'node:crypto';
    import { createInterface } from 'node:readline';
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    const waiting = new Map();
    const ask = (command) => new Promise((resolve) => {
      const id = randomUUID();
      waiting.set(id, resolve);
      send({ v: 1, type: 'companion', id, command });
    });
    let verdict = 'hidden';
    let finish;
    const settled = new Promise((resolve) => { finish = resolve; });
    createInterface({ input: process.stdin }).on('line', async (line) => {
      const message = JSON.parse(line);
      if (message.type === 'companion') return waiting.get(message.id)?.(message.reply);
      if (message.method === 'open') {
        send({ v: 1, id: message.id, ok: true, value: null });
        const snapshot = ${JSON.stringify(snapshot)};
        const read = await ask({ kind: 'scene.read' });
        const write = await ask({ kind: 'scene.write', catId: read.catId, baseRevision: 0, snapshot });
        const refused = await ask({ kind: 'scene.write', catId: 'opus', baseRevision: 0, snapshot: { schemaVersion: 1, secret: 1 } });
        const malformed = await ask({ kind: 'scene.read' });
        const ok = read.status === 'not_found' && write.status === 'ok' && write.revision === 1 &&
          refused.code === 'invalid_request' && malformed.kind === 'error' && malformed.code === 'unavailable';
        verdict = ok ? 'visible' : 'hidden';
        finish();
        return;
      }
      if (message.method === 'poll') await settled;
      send({ v: 1, id: message.id, ok: true, value: message.method === 'poll' ? verdict : null });
    });
  `,
  );
  const received: unknown[] = [];
  const executor = new ElectronDesktopWindowExecutor({ executable: process.execPath, entrypoint });
  const window = await executor.open({
    url: `http://companion-${'c'.repeat(32)}.localhost:4187/packages/fixture/renderer/index.html`,
    presentation: { width: 320, height: 350, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true },
    publicCompanionV2: true,
    companionContract: LIVING,
    signal: new AbortController().signal,
    onClosed() {},
    request: async (command) => {
      received.push(command);
      if ((command as { kind: string }).kind === 'scene.write') return { kind: 'scene-put', status: 'ok', revision: 1 };
      // The second read answers with an address the wire refuses; the child sees only unavailable.
      return received.length === 1
        ? { kind: 'scene', catId: 'opus', status: 'not_found' }
        : ({ kind: 'scene', catId: 'not:a-cat', status: 'not_found' } as never);
    },
  });
  t.after(() => window.close());
  assert.equal(await window.poll(), 'visible');
  assert.deepEqual(received, [
    { kind: 'scene.read' },
    { kind: 'scene.write', catId: 'opus', baseRevision: 0, snapshot },
    { kind: 'scene.read' },
  ]);
});
