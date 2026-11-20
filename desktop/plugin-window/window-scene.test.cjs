// F336 Phase C U2 end to end through the real Host window: the body page reads and reports its
// scene over companion:request; the Host writer holds the pending state and flushes it on swap,
// hide, disable and quit; a stale body is never heard; the body follows the primary work area.
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, openWithCall } = require('./window-group-fixture.cjs');

const scene = (fields) => ({ schemaVersion: 1, ...fields });
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};
const flushEvents = (win) => win.sent.filter((row) => row.value?.kind === 'scene-flush').length;

/** The U1 archive's rules behind the private scene.read / scene.write pipe commands. */
function archive() {
  const state = { revision: 0, snapshot: undefined, hold: undefined };
  const writes = [];
  const api = async (command) => {
    const current =
      state.revision === 0
        ? { status: 'not_found' }
        : { status: 'found', revision: state.revision, updatedAt: 1, snapshot: state.snapshot };
    if (command.kind === 'scene.read') return { kind: 'scene', catId: 'opus', ...current };
    writes.push(structuredClone(command));
    if (state.hold) await state.hold;
    if (command.baseRevision !== state.revision) return { kind: 'scene-put', status: 'conflict', current };
    state.revision++;
    state.snapshot = command.snapshot;
    return { kind: 'scene-put', status: 'ok', revision: state.revision };
  };
  return { state, writes, api };
}
/** A body page that answers the Host's scene-flush ask with this report. */
function answers(f, body, report) {
  const send = body.webContents.send;
  body.webContents.send = (channel, value, ...rest) => {
    send(channel, value, ...rest);
    if (value?.kind === 'scene-flush') queueMicrotask(() => f.request(body, { kind: 'scene.report', ...report }));
  };
}

test('a body reads and seeds its scene; on swap it hands over its latest; the stale body is never heard', async (t) => {
  const store = archive();
  const f = fixture({ api: store.api });
  const managed = await openWithCall(f);
  t.after(() => managed.close());
  await managed.attachBody();
  const [first] = f.bodies;
  assert.deepEqual(await f.request(first, { kind: 'scene.get' }), { kind: 'scene', status: 'not_found' });
  const seeded = scene({ pose: { name: 'LOAF', facing: 1 }, hat: { askew: false } });
  assert.deepEqual(await f.request(first, { kind: 'scene.report', snapshot: seeded, dirty: ['pose', 'hat'] }), {
    kind: 'ok',
  });
  await settle();
  assert.deepEqual(store.writes, [{ kind: 'scene.write', catId: 'opus', baseRevision: 0, snapshot: seeded }]);
  const latest = scene({ pose: { name: 'LOAF', facing: 1 }, hat: { askew: true } });
  answers(f, first, { snapshot: latest, dirty: ['hat'] });
  assert.equal(await managed.attachBody(), 2);
  assert.equal(flushEvents(first), 1, 'the outgoing body was asked for its latest snapshot');
  assert.equal(store.writes.length, 2, 'written within the throttle second, before the swap completed');
  assert.deepEqual(store.state.snapshot, latest);
  assert.equal(first.destroyed, true);
  assert.deepEqual(
    await f.request(first, { kind: 'scene.report', snapshot: seeded, dirty: ['hat'] }),
    { kind: 'error', code: 'permission_required' },
    'a replaced body cannot report a stale state',
  );
  const [, second] = f.bodies;
  assert.deepEqual(await f.request(second, { kind: 'scene.get' }), {
    kind: 'scene',
    status: 'found',
    revision: 2,
    snapshot: latest,
  });
  await settle();
  assert.equal(store.writes.length, 2);
  assert.deepEqual(f.mediaStops(), [], 'the swap flush revoked nothing');
});

test('a crashed body loses nothing it reported: the Host still writes it after the whole cat closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const store = archive();
  const f = fixture({ api: store.api });
  const managed = await openWithCall(f);
  t.after(() => managed.close());
  await managed.attachBody();
  const [body] = f.bodies;
  await f.request(body, { kind: 'scene.get' });
  await f.request(body, { kind: 'scene.report', snapshot: scene({ hat: { askew: false } }), dirty: ['hat'] });
  await settle();
  await f.request(body, { kind: 'scene.report', snapshot: scene({ hat: { askew: true } }), dirty: ['hat'] });
  body.webContents.emit('render-process-gone');
  assert.equal(f.panel.destroyed, true, 'the whole cat closed');
  t.mock.timers.tick(1_000);
  await settle();
  assert.deepEqual(store.state.snapshot, scene({ hat: { askew: true } }));
  assert.equal(managed.sceneIdle(), true);
});

test('a user hide asks the body and writes past the throttle; a silent body is written from its last report', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const store = archive();
  const f = fixture({ api: store.api });
  const managed = await openWithCall(f);
  t.after(() => managed.close());
  await managed.attachBody();
  const [body] = f.bodies;
  await f.request(body, { kind: 'scene.get' });
  await f.request(body, { kind: 'scene.report', snapshot: scene({ paper: { x: 0.2 } }), dirty: ['paper'] });
  await settle();
  await f.request(body, { kind: 'scene.report', snapshot: scene({ paper: { x: 0.6 } }), dirty: ['paper'] });
  assert.equal((await f.request(f.panel, { kind: 'view.hide' }, true)).kind, 'ok');
  assert.equal(flushEvents(body), 1);
  t.mock.timers.tick(300); // the body never answers
  await settle();
  assert.equal(store.writes.length, 2, 'written 300 ms after the hide, not at the throttle second');
  assert.deepEqual(store.state.snapshot, scene({ paper: { x: 0.6 } }));
  assert.match(f.sceneLogs.join('\n'), /did not answer the hidden flush within 300 ms/);
});

test('a confirmed disable writes the scene before the API is asked to disable', async (t) => {
  const store = archive();
  const f = fixture({ api: store.api });
  const managed = await openWithCall(f);
  t.after(() => managed.close());
  await managed.attachBody();
  const [body] = f.bodies;
  await f.request(body, { kind: 'scene.get' });
  await f.request(body, { kind: 'scene.report', snapshot: scene({ hat: { askew: false } }), dirty: ['hat'] });
  await settle();
  answers(f, body, { snapshot: scene({ hat: { askew: true } }), dirty: ['hat'] });
  await f.request(f.panel, { kind: 'companion.disable' }, true);
  const commands = f.apiCommands;
  assert.ok(commands.lastIndexOf('scene.write') < commands.indexOf('companion.disable'), commands.join());
  assert.deepEqual(store.state.snapshot, scene({ hat: { askew: true } }));
});

test('quit waits at most 2 s for the ACK, then the close logs the scene that was not saved', async () => {
  const store = archive();
  const f = fixture({ api: store.api });
  const managed = await openWithCall(f);
  await managed.attachBody();
  const [body] = f.bodies;
  await f.request(body, { kind: 'scene.get' });
  store.state.hold = new Promise(() => {});
  await f.request(body, { kind: 'scene.report', snapshot: scene({ hat: { askew: true } }), dirty: ['hat'] });
  assert.equal(managed.sceneIdle(), false);
  const started = Date.now();
  assert.deepEqual(await managed.flushScene('quit'), { saved: false, answered: false });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2_200 && elapsed < 2_600, `asked 300 ms, then waited 2 s for the ACK (${elapsed} ms)`);
  managed.close();
  assert.match(f.sceneLogs.join('\n'), /scene not saved: cat=opus base=0 dirty=hat sha=[0-9a-f]{12}/);
});

test('view.reset only moves the cat: no scene command reaches the archive and nothing is cleared', async (t) => {
  const store = archive();
  const f = fixture({ api: store.api });
  const managed = await openWithCall(f);
  t.after(() => managed.close());
  await managed.attachBody();
  const [body] = f.bodies;
  await f.request(body, { kind: 'scene.get' });
  await f.request(body, { kind: 'scene.report', snapshot: scene({ ball: { x: 0.4 } }), dirty: ['ball'] });
  await settle();
  const before = [...f.apiCommands];
  assert.deepEqual(await f.request(f.panel, { kind: 'view.reset' }, true), { kind: 'ok' });
  await settle();
  assert.deepEqual(
    f.apiCommands.slice(before.length).filter((kind) => kind.startsWith('scene.')),
    [],
  );
  assert.deepEqual(await f.request(body, { kind: 'scene.get' }), {
    kind: 'scene',
    status: 'found',
    revision: 1,
    snapshot: scene({ ball: { x: 0.4 } }),
  });
});

test('the body follows the primary work area and tells its page the new size', async (t) => {
  const f = fixture();
  const managed = await f.open();
  t.after(() => managed.close());
  await managed.attachBody();
  const [body] = f.bodies;
  body.setBounds({ ...f.area });
  Object.assign(f.area, { y: 0, height: 690 }); // the Dock appeared
  f.screen.emit('display-metrics-changed');
  assert.deepEqual(body.getBounds(), { x: 0, y: 0, width: 1280, height: 690 });
  assert.deepEqual(body.sent.at(-1), {
    channel: 'companion:event',
    value: { kind: 'body-area', width: 1280, height: 690, standHeight: 150 },
  });
  const events = body.sent.length;
  f.screen.emit('display-added');
  assert.equal(body.sent.length, events, 'an unchanged work area is not re-announced');
  await managed.detachBody();
  Object.assign(f.area, { height: 720 });
  f.screen.emit('display-removed');
  assert.equal(f.screen.listenerCount('display-metrics-changed'), 0, 'a detached body stops listening');
});
