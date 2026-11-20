// F336 Phase C U2 (plan §D): the Host's write-behind for the living cat's scene. The pending
// state lives in electron main; the API is the archive; the body page only reports.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createSceneWriter } = require('./scene-writer.cjs');

const body = (generation) => ({ role: 'body', generation });
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};
const scene = (fields) => ({ schemaVersion: 1, ...fields });

/** An archive with the U1 store's rules: tri-state read, CAS on revision, no clearing. */
function archive({ catId = 'opus', revision = 0, snapshot } = {}) {
  const state = { catId, revision, snapshot, readError: undefined, hold: undefined, beforeWrite: undefined };
  const writes = [];
  const reads = [];
  const current = () =>
    state.revision === 0
      ? { status: 'not_found' }
      : { status: 'found', revision: state.revision, updatedAt: 1, snapshot: state.snapshot };
  const request = async (command) => {
    if (command.kind === 'scene.read') {
      reads.push(command);
      if (state.readError) return state.readError;
      return { kind: 'scene', catId: state.catId, ...current() };
    }
    assert.equal(command.kind, 'scene.write');
    writes.push(structuredClone(command));
    if (state.hold) await state.hold;
    state.beforeWrite?.();
    if (command.baseRevision !== state.revision) return { kind: 'scene-put', status: 'conflict', current: current() };
    state.revision++;
    state.snapshot = command.snapshot;
    return { kind: 'scene-put', status: 'ok', revision: state.revision };
  };
  return { state, writes, reads, request };
}

function writer(t, api, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const logs = [];
  const asks = [];
  const w = createSceneWriter({ request: api.request, log: (line) => logs.push(line), ...options });
  t.after(() => w.close());
  const attach = (generation, answer) =>
    w.attach(generation, () => {
      asks.push(generation);
      answer?.();
    });
  return { w, logs, asks, attach };
}

test('a read error never turns into a write, not even a default write-back on flush', async (t) => {
  const api = archive({ revision: 3, snapshot: scene({ hat: { askew: true } }) });
  api.state.readError = { kind: 'scene', catId: 'opus', status: 'error', reason: 'corrupt' };
  const { w, attach } = writer(t, api);
  attach(1);
  assert.deepEqual(await w.request(body(1), { kind: 'scene.get' }), {
    kind: 'scene',
    status: 'error',
    reason: 'corrupt',
  });
  const report = { kind: 'scene.report', snapshot: scene({ hat: { askew: false } }), dirty: ['hat'] };
  assert.deepEqual(await w.request(body(1), report), { kind: 'error', code: 'session_required' });
  api.state.readError = { kind: 'error', code: 'unavailable' }; // the pipe itself failed
  assert.deepEqual(await w.request(body(1), { kind: 'scene.get' }), {
    kind: 'scene',
    status: 'error',
    reason: 'unavailable',
  });
  assert.deepEqual(await w.flush('quit'), { saved: false, answered: false });
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(api.writes, [], 'nothing was ever written over the unread archive');
});

test('not_found seeds the scene: the first report creates it at baseRevision 0 with the whole snapshot', async (t) => {
  const api = archive();
  const { w, attach } = writer(t, api);
  attach(1);
  assert.deepEqual(await w.request(body(1), { kind: 'scene.get' }), { kind: 'scene', status: 'not_found' });
  const seeded = scene({ pose: { name: 'LOAF', facing: 1 }, ball: { x: 0.4, h: 0, ceil: false } });
  assert.deepEqual(await w.request(body(1), { kind: 'scene.report', snapshot: seeded, dirty: ['pose', 'ball'] }), {
    kind: 'ok',
  });
  await settle();
  assert.deepEqual(api.writes, [{ kind: 'scene.write', catId: 'opus', baseRevision: 0, snapshot: seeded }]);
  assert.equal(api.state.revision, 1);
  assert.equal(w.idle(), false, 'a body is attached');
});

test('writes are at most once per second and the trailing change is always written', async (t) => {
  const api = archive({ revision: 1, snapshot: scene({ hat: { askew: false }, paper: { x: 0.1 } }) });
  const { w, attach } = writer(t, api);
  attach(1);
  await w.request(body(1), { kind: 'scene.get' });
  const report = (fields, dirty) => w.request(body(1), { kind: 'scene.report', snapshot: scene(fields), dirty });
  await report({ hat: { askew: true }, paper: { x: 0.1 } }, ['hat']);
  await settle();
  assert.equal(api.writes.length, 1, 'the first change goes out at once');
  t.mock.timers.tick(100);
  await report({ hat: { askew: true }, paper: { x: 0.5 } }, ['paper']);
  t.mock.timers.tick(300);
  await report({ hat: { askew: false }, paper: { x: 0.7 } }, ['hat', 'paper']);
  await settle();
  assert.equal(api.writes.length, 1, 'held by the 1 s throttle');
  t.mock.timers.tick(599);
  await settle();
  assert.equal(api.writes.length, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(api.writes.length, 2);
  assert.deepEqual(api.writes[1], {
    kind: 'scene.write',
    catId: 'opus',
    baseRevision: 2,
    snapshot: scene({ hat: { askew: false }, paper: { x: 0.7 } }),
  });
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(api.writes.length, 2, 'nothing left to write once acknowledged');
});

test('a body destroyed after reporting loses nothing: the Host still writes what it reported', async (t) => {
  const api = archive({ revision: 4, snapshot: scene({ hat: { askew: false } }) });
  const { w, attach } = writer(t, api);
  attach(1);
  await w.request(body(1), { kind: 'scene.get' });
  await w.request(body(1), { kind: 'scene.report', snapshot: scene({ hat: { askew: true } }), dirty: ['hat'] });
  await settle();
  await w.request(body(1), { kind: 'scene.report', snapshot: scene({ hat: { askew: false } }), dirty: ['hat'] });
  w.detach(1); // crash, swap or destroy
  assert.deepEqual(
    await w.request(body(1), { kind: 'scene.report', snapshot: scene({ hat: { askew: true } }), dirty: ['hat'] }),
    { kind: 'error', code: 'permission_required' },
    'a gone body cannot report any more',
  );
  t.mock.timers.tick(1_000);
  await settle();
  assert.deepEqual(api.state.snapshot, scene({ hat: { askew: false } }));
  assert.equal(api.state.revision, 6);
});

test('a conflict overlays only the dirty fields onto the stored scene; a second conflict drops and adopts', async (t) => {
  const api = archive({ revision: 1, snapshot: scene({ hat: { askew: false }, ball: { x: 0.2 } }) });
  const { w, logs, attach } = writer(t, api);
  attach(1);
  await w.request(body(1), { kind: 'scene.get' });
  // Another writer moved the ball and dropped paper meanwhile.
  api.state.revision = 2;
  api.state.snapshot = scene({ hat: { askew: false }, ball: { x: 0.9 }, paper: { x: 0.3 } });
  await w.request(body(1), {
    kind: 'scene.report',
    snapshot: scene({ hat: { askew: true }, ball: { x: 0.2 } }),
    dirty: ['hat'],
  });
  await settle();
  assert.deepEqual(
    api.writes.map((write) => [write.baseRevision, write.snapshot]),
    [
      [1, scene({ hat: { askew: true }, ball: { x: 0.2 } })],
      [2, scene({ hat: { askew: true }, ball: { x: 0.9 }, paper: { x: 0.3 } })],
    ],
    'the stale ball is never replayed; only the hat is laid over the stored scene',
  );
  assert.equal(api.state.revision, 3);

  // Now every write races another writer: retry once, then give up and keep the archive.
  api.state.beforeWrite = () => {
    api.state.revision++;
    api.state.snapshot = scene({ ...api.state.snapshot, lastSolo: `other-${api.state.revision}` });
  };
  t.mock.timers.tick(1_000);
  await w.request(body(1), {
    kind: 'scene.report',
    snapshot: scene({ hat: { askew: false }, ball: { x: 0.2 } }),
    dirty: ['hat'],
  });
  await settle();
  assert.equal(api.writes.length, 4, 'one write and exactly one overlay retry');
  assert.match(logs.join('\n'), /dropped after a second conflict; adopted revision 5/);
  api.state.beforeWrite = undefined;
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(api.writes.length, 4, 'the dropped write is not retried');
  assert.equal(api.state.snapshot.lastSolo, 'other-5');
  // The adopted scene is the new base: the next change still only overlays its own field.
  await w.request(body(1), {
    kind: 'scene.report',
    snapshot: scene({ hat: { askew: false }, ball: { x: 0.25 } }),
    dirty: ['ball'],
  });
  await settle();
  assert.deepEqual(api.writes.at(-1), {
    kind: 'scene.write',
    catId: 'opus',
    baseRevision: 5,
    snapshot: scene({ hat: { askew: true }, ball: { x: 0.25 }, paper: { x: 0.3 }, lastSolo: 'other-5' }),
  });
});

test('flush asks the body, then writes at once past the throttle and waits for the ACK', async (t) => {
  const api = archive({ revision: 1, snapshot: scene({ paper: { x: 0 } }) });
  let w;
  const answer = () =>
    queueMicrotask(() =>
      w.request(body(1), { kind: 'scene.report', snapshot: scene({ paper: { x: 0.8 } }), dirty: ['paper'] }),
    );
  const f = writer(t, api);
  w = f.w;
  f.attach(1, answer);
  await w.request(body(1), { kind: 'scene.get' });
  await w.request(body(1), { kind: 'scene.report', snapshot: scene({ paper: { x: 0.3 } }), dirty: ['paper'] });
  await settle();
  assert.equal(api.writes.length, 1);
  t.mock.timers.tick(10);
  const flushed = w.flush('swap');
  await settle();
  assert.deepEqual(f.asks, [1], 'the body was asked for its latest snapshot');
  assert.deepEqual(await flushed, { saved: true, answered: true });
  assert.equal(api.writes.length, 2, 'written 10 ms after the previous write, bypassing the throttle');
  assert.deepEqual(api.state.snapshot, scene({ paper: { x: 0.8 } }));
});

test('a body silent for 300 ms: its last reported state is written, and that is not "saved"', async (t) => {
  const api = archive({ revision: 1, snapshot: scene({ hat: { askew: false } }) });
  const { w, logs, asks, attach } = writer(t, api);
  attach(1); // never answers
  await w.request(body(1), { kind: 'scene.get' });
  await w.request(body(1), { kind: 'scene.report', snapshot: scene({ hat: { askew: true } }), dirty: ['hat'] });
  await settle();
  await w.request(body(1), { kind: 'scene.report', snapshot: scene({ hat: { askew: false } }), dirty: ['hat'] });
  const flushed = w.flush('hide');
  await settle();
  assert.deepEqual(asks, [1]);
  t.mock.timers.tick(299);
  await settle();
  assert.equal(api.writes.length, 1, 'still waiting for the body');
  t.mock.timers.tick(1);
  assert.deepEqual(await flushed, { saved: false, answered: false });
  assert.equal(api.writes.length, 2);
  assert.deepEqual(api.state.snapshot, scene({ hat: { askew: false } }), 'the last reported state went out');
  assert.match(logs.join('\n'), /did not answer the hide flush within 300 ms/);
});

test('quit waits at most 2 s for the ACK and logs the unsaved scene with a digest', async (t) => {
  const api = archive({ revision: 2, snapshot: scene({ hat: { askew: false } }) });
  const { w, logs, attach } = writer(t, api);
  attach(1);
  await w.request(body(1), { kind: 'scene.get' });
  api.state.hold = new Promise(() => {}); // the API never answers
  await w.request(body(1), { kind: 'scene.report', snapshot: scene({ hat: { askew: true } }), dirty: ['hat'] });
  w.detach(1);
  let done = false;
  const flushed = w.flush('quit').then((value) => {
    done = true;
    return value;
  });
  t.mock.timers.tick(1_999);
  await settle();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await flushed, { saved: false, answered: true });
  w.close();
  assert.match(logs.join('\n'), /scene not saved: cat=opus base=2 dirty=hat sha=[0-9a-f]{12}/);
});

test('a new body reads what the Host still holds unacknowledged, never an older archive state', async (t) => {
  const api = archive({ revision: 1, snapshot: scene({ hat: { askew: false }, paper: { x: 0.1 } }) });
  let down = true;
  const request = (command) =>
    down && command.kind === 'scene.write'
      ? Promise.resolve({ kind: 'error', code: 'unavailable' })
      : api.request(command);
  const { w, attach } = writer(t, { request });
  attach(1);
  await w.request(body(1), { kind: 'scene.get' });
  await w.request(body(1), {
    kind: 'scene.report',
    snapshot: scene({ hat: { askew: true }, paper: { x: 0.1 } }),
    dirty: ['hat'],
  });
  await settle();
  w.detach(1);
  attach(2);
  assert.deepEqual(await w.request(body(2), { kind: 'scene.get' }), {
    kind: 'scene',
    status: 'found',
    revision: 1,
    snapshot: scene({ hat: { askew: true }, paper: { x: 0.1 } }),
  });
  down = false;
  t.mock.timers.tick(30_000);
  await settle();
  assert.deepEqual(api.state.snapshot, scene({ hat: { askew: true }, paper: { x: 0.1 } }));
});

test('only the attached generation is heard; reports are bounded to the snapshot envelope', async (t) => {
  const api = archive();
  const { w, attach } = writer(t, api);
  attach(2);
  assert.deepEqual(await w.request(body(1), { kind: 'scene.get' }), { kind: 'error', code: 'permission_required' });
  assert.deepEqual(await w.request({ role: 'panel', generation: 2 }, { kind: 'scene.get' }), {
    kind: 'error',
    code: 'permission_required',
  });
  await w.request(body(2), { kind: 'scene.get' });
  for (const bad of [
    { kind: 'scene.report', snapshot: { schemaVersion: 2 }, dirty: [] },
    { kind: 'scene.report', snapshot: scene({ secret: 1 }), dirty: [] },
    { kind: 'scene.report', snapshot: scene({}), dirty: ['nope'] },
    { kind: 'scene.report', snapshot: scene({ lastSolo: 'x'.repeat(17_000) }), dirty: ['lastSolo'] },
    { kind: 'scene.report', snapshot: scene({}), dirty: [], extra: true },
    { kind: 'scene.clear' },
  ])
    assert.deepEqual(await w.request(body(2), bad), { kind: 'error', code: 'invalid_request' }, JSON.stringify(bad));
  await settle();
  assert.deepEqual(api.writes, []);
});

/** An archive that answers a corrupt conflict for the cats listed in `corrupt` (PR #7292 R1 P1-1). */
function twoCats(t, corrupt) {
  const scenes = {
    'cat-a': { revision: 1, snapshot: scene({ hat: { askew: false }, paper: { x: 0.2 } }) },
    'cat-b': { revision: 1, snapshot: scene({ hat: { askew: false }, paper: { x: 0.8 } }) },
  };
  const api = { selected: 'cat-a', writes: [] };
  api.request = async (command) => {
    if (command.kind === 'scene.read') {
      const { revision, snapshot } = scenes[api.selected];
      return { kind: 'scene', status: 'found', catId: api.selected, revision, updatedAt: 1, snapshot };
    }
    api.writes.push(structuredClone(command));
    if (command.catId !== api.selected) return { kind: 'error', code: 'selection_changed' };
    if (corrupt.has(command.catId))
      return { kind: 'scene-put', status: 'conflict', current: { status: 'error', reason: 'corrupt' } };
    const stored = scenes[command.catId];
    if (command.baseRevision !== stored.revision)
      return { kind: 'scene-put', status: 'conflict', current: { status: 'found', ...stored, updatedAt: 1 } };
    scenes[command.catId] = { revision: stored.revision + 1, snapshot: command.snapshot };
    return { kind: 'scene-put', status: 'ok', revision: stored.revision + 1 };
  };
  return { api, scenes, ...writer(t, api) };
}

test('a corrupt conflict keeps the pending scene bound to its cat: another cat is only read, never written', async (t) => {
  const { api, scenes, w, logs, attach } = twoCats(t, new Set(['cat-a']));
  attach(1);
  await w.request(body(1), { kind: 'scene.get' });
  await w.request(body(1), {
    kind: 'scene.report',
    dirty: ['hat'],
    snapshot: scene({ hat: { askew: true }, paper: { x: 0.2 } }),
  });
  await settle();
  assert.equal(api.writes.length, 1, 'the write met the corrupt archive');
  api.selected = 'cat-b';
  w.detach(1);
  attach(2); // another companion is chosen and the body reopens
  const restored = await w.request(body(2), { kind: 'scene.get' });
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(restored.snapshot, scenes['cat-b'].snapshot, "cat B's own scene, not cat A's beret");
  assert.equal(api.writes.filter((command) => command.catId === 'cat-b').length, 0, 'cat B was only read');
  assert.ok(logs.some((line) => /previous cat's unsaved scene is dropped/.test(line)));
});

test('after a corrupt conflict the same cat, once readable again, gets its pending change', async (t) => {
  const corrupt = new Set(['cat-a']);
  const { api, scenes, w, attach } = twoCats(t, corrupt);
  attach(1);
  await w.request(body(1), { kind: 'scene.get' });
  await w.request(body(1), {
    kind: 'scene.report',
    dirty: ['hat'],
    snapshot: scene({ hat: { askew: true }, paper: { x: 0.2 } }),
  });
  await settle();
  corrupt.delete('cat-a'); // the archive was repaired
  w.detach(1);
  attach(2);
  const restored = await w.request(body(2), { kind: 'scene.get' });
  assert.equal(restored.snapshot.hat.askew, true, 'the reopened body sees the change the Host still holds');
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(api.writes.at(-1), {
    kind: 'scene.write',
    catId: 'cat-a',
    baseRevision: 1,
    snapshot: scene({ hat: { askew: true }, paper: { x: 0.2 } }),
  });
  assert.equal(scenes['cat-a'].snapshot.hat.askew, true);
});
