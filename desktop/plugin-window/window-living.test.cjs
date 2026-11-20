// F336 Phase C U8 (Host side) through the real Host window: the body opens only from the verified page
// of a livingBody line while the owner's saved skin is the living cat; it is told its area, stand height
// and behaviorEnabled; a context click on him opens the panel's own menu beside him; the panel's pending
// badge stays clickable over him.
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, input, bodyUrl } = require('./window-group-fixture.cjs');
const { placePanelForBody } = require('./pet-placement.cjs');
const { standHeight } = require('./living-mode.cjs');
const { validateLaunch } = require('./window-launch.cjs');

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve));
};
const events = (win, kind) => win.sent.filter((row) => row.value?.kind === kind).map((row) => row.value);
const state = (skin, behaviorEnabled = true) => ({ kind: 'state', phase: 'idle', skin, behaviorEnabled });
const settings = (values) => ({
  kind: 'settings',
  status: 'available',
  values: { ballSize: 72, behaviorEnabled: true, proactivePolicy: 'quiet-badge', ...values },
});
/** The Host's trusted replies, changed by the test between panel requests. */
function api(initial) {
  const owner = { state: state('xianxian-codex'), settings: settings({ skin: 'xianxian-codex' }), ...initial };
  const replies = (command) =>
    command.kind === 'state' ? owner.state : command.kind === 'settings.read' ? owner.settings : owner[command.kind];
  return { owner, replies };
}

test('the body opens only for the saved living skin, from the verified page, and swapping back revokes nothing', async (t) => {
  const { owner, replies } = api();
  const f = fixture({ replies });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  await settle();
  assert.equal(f.bodies.length, 0, 'a ball skin keeps the ball');
  owner.state = state('xianxian-living');
  await f.request(f.panel, { kind: 'state' });
  await f.request(f.panel, { kind: 'state' });
  await settle();
  assert.equal(f.bodies.length, 1, 'one body, however often the same choice is read');
  assert.equal(f.bodies[0].url, bodyUrl, 'the verified page of the launch, never a page-named one');
  assert.equal(f.bodies[0].visible, true);
  owner.settings = settings({ skin: 'yarn-ball' });
  await f.request(f.panel, { kind: 'settings.read' });
  await settle();
  assert.equal(f.bodies[0].destroyed, true, 'another skin swaps the body out');
  assert.deepEqual(f.mediaStops(), [], 'neither swap is a hide or a revocation');
  owner.state = state('xianxian-living');
  await f.request(f.panel, { kind: 'state' });
  await settle();
  assert.equal(f.bodies.length, 2, 'choosing him again brings him back');
});

test('a reply that began before one already observed cannot swap the body', async (t) => {
  const { owner, replies } = api();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({ replies: (command) => (command.kind === 'state' ? held : replies(command)) });
  const managed = await f.open();
  t.after(() => managed.close());
  const early = f.request(f.panel, { kind: 'state' }); // began first, answers last with the old choice
  owner.settings = settings({ skin: 'xianxian-living' });
  await f.request(f.panel, { kind: 'settings.read' });
  await settle();
  assert.equal(f.bodies.length, 1);
  release(state('xianxian-codex'));
  await early;
  await settle();
  assert.equal(f.bodies[0].destroyed, false, 'the older read is not observed after the newer one');
});

test('an old line, or a launch without the verified page, never opens a body', async (t) => {
  const { owner, replies } = api({ state: state('xianxian-living') });
  const { bodyUrl: _page, ...withoutPage } = input;
  const f = fixture({ replies, launch: { ...withoutPage, companionContract: '0.3.3-candidate.0' } });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  owner.settings = settings({ skin: 'xianxian-living' });
  await f.request(f.panel, { kind: 'settings.read' });
  await settle();
  assert.equal(f.bodies.length, 0);
  await assert.rejects(managed.attachBody(), /No verified living body/);
  for (const launch of [
    { ...input, companionContract: '0.3.3-candidate.0' },
    { ...input, bodyUrl: input.url },
    { ...input, bodyUrl: input.url.replace('/body/index.html', '/elsewhere/body.html') },
    { ...input, bodyUrl: input.url.replace('a'.repeat(32), 'b'.repeat(32)).replace('index.html', 'body.html') },
  ])
    assert.throws(() => validateLaunch(launch), /Invalid body page/, JSON.stringify(launch.bodyUrl));
  // Old Host + new package: a contract line this kernel's table does not list is refused outright.
  assert.throws(() => validateLaunch({ ...input, companionContract: '0.3.3-candidate.4' }), /Invalid companion/);
});

test('a body that failed to open is not retried until the skin is chosen again', async (t) => {
  const { owner, replies } = api({ state: state('xianxian-living') });
  const f = fixture({ replies, failBody: true });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  await settle();
  await f.request(f.panel, { kind: 'state' });
  await settle();
  assert.equal(f.bodyLogs.length, 1, 'one attempt, logged, then the ball stays');
  owner.state = state('xianxian-codex');
  await f.request(f.panel, { kind: 'state' });
  owner.state = state('xianxian-living');
  await f.request(f.panel, { kind: 'state' });
  await settle();
  assert.equal(f.bodyLogs.length, 2);
});

test('until his body is on screen the panel is told the ball it draws, in state and settings alike', async (t) => {
  // PR #7292 R1 P1-3: alpha.38 hides the ball for xianxian-living, so a body that never opened left no cat at all.
  const { replies } = api({ state: state('xianxian-living'), settings: settings({ skin: 'xianxian-living' }) });
  let broken = true;
  const f = fixture({ replies, failBody: () => broken });
  const managed = await f.open();
  t.after(() => managed.close());
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-codex', 'not on screen yet: the ball');
  await settle();
  assert.equal(f.bodies.length, 0);
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-codex', 'failed: the ball stays drawn');
  assert.equal((await f.request(f.panel, { kind: 'settings.read' })).values.skin, 'xianxian-codex');
  assert.equal(f.apiCommands.includes('settings.update'), false, "the owner's saved choice is never rewritten");
  // Choosing the living cat again in the panel is the owner asking once more: the Host retries.
  broken = false;
  await f.request(f.panel, { kind: 'settings.update', field: 'skin', value: 'xianxian-living' }, true);
  await settle();
  assert.equal(f.bodies.length, 1, 'an explicit choice retries a body that failed');
  const him = { x: 10, y: 10, width: 100, height: 100 };
  await f.request(f.bodies[0], { kind: 'body.anchor', rect: him });
  await f.request(f.bodies[0], { kind: 'body.hit', rects: [him] }); // drawn
  assert.equal(
    (await f.request(f.panel, { kind: 'state' })).skin,
    'xianxian-living',
    'on screen: the panel lets the ball go',
  );
  assert.equal((await f.request(f.panel, { kind: 'settings.read' })).values.skin, 'xianxian-living');
});

test('a body that loaded but never drew (its atlas failed) leaves the ball drawn, placed and clickable', async (t) => {
  // PR #7292 R1 P1-3 readiness: alpha.38 reports an anchor with no atlas, but a region only for drawn frames.
  const { replies } = api({ state: state('xianxian-living'), settings: settings({ skin: 'xianxian-living' }) });
  const f = fixture({ replies });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  await settle();
  const [body] = f.bodies;
  assert.ok(body, 'the page loaded');
  await f.request(body, { kind: 'body.anchor', rect: { x: 485, y: 556, width: 109, height: 160 } });
  await f.request(body, { kind: 'body.hit', rects: [] });
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-codex', 'nothing drawn: the ball stays');
  // 守望猫's case: restored side-sit with atlas 1 failed draws only the paper ball (atlas 0)
  assert.deepEqual(await f.request(body, { kind: 'body.hit', rects: [{ x: 900, y: 600, width: 46, height: 46 }] }), {
    kind: 'ok',
  });
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-codex', 'only the ball drawn: not him');
  assert.equal((await f.request(f.panel, { kind: 'settings.read' })).values.skin, 'xianxian-codex');
  const ball = await f.request(f.panel, { kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  assert.equal(ball.kind, 'layout');
  assert.notDeepEqual(
    f.panel.getBounds(),
    placePanelForBody({ x: 485, y: 556 + f.area.y, width: 109, height: 160 }, null, f.area, f.cursor, {
      width: 120,
      height: 130,
    }).bounds,
    'the panel keeps the ball where it was, not the empty body anchor box',
  );
  // drawn once (the cat and the paper ball): the ball goes; hiding in the box later does not bring it back
  const ballPlaced = f.panel.getBounds();
  await f.request(body, { kind: 'body.hit', rects: [{ x: 485, y: 556, width: 109, height: 160 }] });
  assert.deepEqual(f.panel.getBounds(), ballPlaced, 'drawn, panel not told yet: the ball is not carried onto him');
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-living');
  assert.notDeepEqual(f.panel.getBounds(), ballPlaced, 'told: the panel window becomes his anchor box');
  await f.request(body, { kind: 'body.hit', rects: [] });
  assert.equal(
    (await f.request(f.panel, { kind: 'state' })).skin,
    'xianxian-living',
    'an empty region later is not a failure',
  );
});

test('choosing the living cat again replaces a body that loaded but never drew; polling and a drawn body are left alone', async (t) => {
  // PR #7292 R1 (codex61-sol P2): alpha.38 never retries a failed atlas, so only a new body can.
  const { replies } = api({ state: state('xianxian-living'), settings: settings({ skin: 'xianxian-living' }) });
  const f = fixture({ replies });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  await settle();
  const [stuck] = f.bodies;
  const him = { x: 485, y: 556, width: 109, height: 160 };
  await f.request(stuck, { kind: 'body.anchor', rect: him });
  await f.request(stuck, { kind: 'body.hit', rects: [] }); // its atlas failed
  await f.request(f.panel, { kind: 'state' });
  await f.request(f.panel, { kind: 'settings.read' });
  await settle();
  assert.equal(f.bodies.length, 1, 'ordinary reads never reload a body');
  await f.request(f.panel, { kind: 'settings.update', field: 'skin', value: 'xianxian-living' }, true);
  await settle();
  assert.equal(f.bodies.length, 2, 'the owner asked again: a new body');
  assert.equal(stuck.destroyed, true, 'the stuck one is gone');
  assert.deepEqual(await f.request(stuck, { kind: 'body.hit', rects: [him] }), {
    kind: 'error',
    code: 'permission_required',
  });
  const fresh = f.bodies[1];
  await f.request(fresh, { kind: 'body.anchor', rect: him });
  await f.request(fresh, { kind: 'body.hit', rects: [him] });
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-living');
  await f.request(f.panel, { kind: 'settings.update', field: 'skin', value: 'xianxian-living' }, true);
  await settle();
  assert.equal(f.bodies.length, 2, 'a drawn body is not reloaded by choosing it again');
});

test('one cat at all times: the body is invisible until the panel lets the ball go, and invisible before it is flushed out', async (t) => {
  // #7292 R1 (F317 one body at a time; 守望猫 1067, codex61-sol): no overlap whatever the reply timing.
  const { owner, replies } = api({ state: state('xianxian-living') });
  const f = fixture({ replies });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  await settle();
  const [body] = f.bodies;
  assert.equal(body.opacity, 0, 'loaded, not drawn: only the ball shows');
  const him = { x: 485, y: 556, width: 109, height: 160 };
  await f.request(body, { kind: 'body.anchor', rect: him });
  await f.request(body, { kind: 'body.hit', rects: [him] });
  assert.equal(body.opacity, 0, 'drawn, but the panel still draws the ball: he waits unseen');
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-living');
  assert.equal(body.opacity, 1, 'the same reply that hides the ball shows him');
  const living = f.panel.getBounds();
  owner.state = state('xianxian-codex');
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-codex');
  assert.equal(body.opacity, 0, 'the reply that brings the ball back hides him before his scene is flushed');
  assert.notDeepEqual(f.panel.getBounds(), living, 'the panel window is the ball again at once');
  await settle();
  assert.equal(body.destroyed, true);
});

test('a body that draws while its replacement loads is kept; the replacement is dropped', async (t) => {
  // 守望猫 1073: an explicit retry must not destroy a body that became healthy meanwhile.
  const { replies } = api({ state: state('xianxian-living'), settings: settings({ skin: 'xianxian-living' }) });
  let release;
  let gated = false;
  const f = fixture({ replies, bodyGate: () => (gated ? new Promise((resolve) => (release = resolve)) : undefined) });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  await settle();
  const [first] = f.bodies;
  const him = { x: 485, y: 556, width: 109, height: 160 };
  await f.request(first, { kind: 'body.anchor', rect: him });
  await f.request(first, { kind: 'body.hit', rects: [] }); // slow, not drawn yet
  gated = true;
  await f.request(f.panel, { kind: 'settings.update', field: 'skin', value: 'xianxian-living' }, true);
  await settle();
  assert.equal(f.bodies.length, 2, 'the replacement is loading');
  await f.request(first, { kind: 'body.hit', rects: [him] }); // the first one draws after all
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-living');
  release();
  await settle();
  assert.equal(first.destroyed, false, 'the healthy body stays');
  assert.equal(f.bodies[1].destroyed, true, 'the replacement is dropped');
  assert.equal(first.opacity, 1);
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-living');
});

/** codex61-sol's R1c race probes (review-9be2379184.md), ported: a scene archive, and the flush asks sent to a body. */
const sceneApi = (command) =>
  command.kind === 'scene.read'
    ? { kind: 'scene', status: 'found', catId: 'cat-a', revision: 1, updatedAt: 1, snapshot: { schemaVersion: 1 } }
    : { kind: 'scene-put', status: 'ok', revision: 2 };
const flushAsks = (body) => events(body, 'scene-flush').length;

test('a body that draws during the retry scene flush is kept: readiness is checked again before replacing', async (t) => {
  const f = fixture({
    api: sceneApi,
    replies: (command) =>
      command.kind === 'state'
        ? state('xianxian-living')
        : ['settings.read', 'settings.update'].includes(command.kind)
          ? settings({ skin: 'xianxian-living' })
          : undefined,
  });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  await settle();
  const [first] = f.bodies;
  const him = { x: 485, y: 556, width: 109, height: 160 };
  assert.equal((await f.request(first, { kind: 'scene.get' })).status, 'found');
  await f.request(first, { kind: 'body.anchor', rect: him });
  await f.request(first, { kind: 'body.hit', rects: [] });
  await f.request(f.panel, { kind: 'settings.update', field: 'skin', value: 'xianxian-living' }, true);
  await settle();
  assert.equal(f.bodies.length, 2);
  assert.equal(flushAsks(first), 1, 'the retry has loaded and waits for the scene flush');
  await f.request(first, { kind: 'body.hit', rects: [him] }); // the first one draws meanwhile
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-living');
  assert.equal(first.opacity, 1);
  await f.request(first, { kind: 'scene.report', snapshot: { schemaVersion: 1 }, dirty: [] });
  await settle();
  assert.equal(first.destroyed, false, 'the healthy body stays');
  assert.equal(f.bodies[1].destroyed, true, 'the replacement is dropped');
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-living');
});

test('an older living reply cannot reveal a body concealed for a swap out, nor hide the ball', async (t) => {
  let hold = false;
  let resolveOld;
  let chosen = 'xianxian-living';
  const f = fixture({
    api: sceneApi,
    replies: (command) => {
      if (command.kind === 'state') {
        if (!hold) return state(chosen);
        hold = false;
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      }
      if (['settings.read', 'settings.update'].includes(command.kind)) return settings({ skin: chosen });
      return undefined;
    },
  });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  await settle();
  const [body] = f.bodies;
  const him = { x: 485, y: 556, width: 109, height: 160 };
  await f.request(body, { kind: 'scene.get' });
  await f.request(body, { kind: 'body.anchor', rect: him });
  await f.request(body, { kind: 'body.hit', rects: [him] });
  await f.request(f.panel, { kind: 'state' });
  assert.equal(body.opacity, 1);
  hold = true;
  const early = f.request(f.panel, { kind: 'state' }); // begun while the cat was still chosen
  await settle();
  chosen = 'xianxian-codex';
  await f.request(f.panel, { kind: 'settings.read' }); // the newer read: the ball
  await settle();
  assert.equal(body.opacity, 0);
  assert.equal(flushAsks(body), 1, 'the swap out waits for his latest scene');
  const ballBounds = f.panel.getBounds();
  resolveOld(state('xianxian-living'));
  const reply = await early;
  await settle();
  assert.equal(body.opacity, 0, 'the older reply does not undo the conceal');
  assert.deepEqual(f.panel.getBounds(), ballBounds, 'the panel window stays the ball');
  assert.equal(reply.skin, 'xianxian-codex', 'and the panel is told the ball it still draws');
});

test('an older ball reply cannot bring the ball back over a living cat on screen: replies carry what is shown', async (t) => {
  // 守望猫 1087: the reverse of the late-living case.
  let hold = false;
  let resolveOld;
  let chosen = 'xianxian-codex';
  const f = fixture({
    api: sceneApi,
    replies: (command) => {
      if (command.kind === 'state') {
        if (!hold) return state(chosen);
        hold = false;
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      }
      if (['settings.read', 'settings.update'].includes(command.kind)) return settings({ skin: chosen });
      return undefined;
    },
  });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  hold = true;
  const early = f.request(f.panel, { kind: 'state' }); // begun while the ball was chosen
  await settle();
  chosen = 'xianxian-living';
  await f.request(f.panel, { kind: 'settings.read' });
  await settle();
  const [body] = f.bodies;
  const him = { x: 485, y: 556, width: 109, height: 160 };
  await f.request(body, { kind: 'scene.get' });
  await f.request(body, { kind: 'body.anchor', rect: him });
  await f.request(body, { kind: 'body.hit', rects: [him] });
  assert.equal((await f.request(f.panel, { kind: 'settings.read' })).values.skin, 'xianxian-living');
  assert.equal(body.opacity, 1);
  const livingBounds = f.panel.getBounds();
  resolveOld(state('xianxian-codex'));
  assert.equal((await early).skin, 'xianxian-living', 'the older reply reaches the panel as the cat on screen');
  assert.equal(body.opacity, 1);
  assert.deepEqual(f.panel.getBounds(), livingBounds);
});

test('choosing the living cat again while the swap out flushes keeps him: the swap out is called off', async (t) => {
  // 守望猫 1090: re-revealed during the flush, then destroyed after it, left no cat while a new one loaded.
  let chosen = 'xianxian-living';
  const f = fixture({
    api: sceneApi,
    replies: (command) =>
      command.kind === 'state'
        ? state(chosen)
        : ['settings.read', 'settings.update'].includes(command.kind)
          ? settings({ skin: chosen })
          : undefined,
  });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  await settle();
  const [body] = f.bodies;
  const him = { x: 485, y: 556, width: 109, height: 160 };
  await f.request(body, { kind: 'scene.get' });
  await f.request(body, { kind: 'body.anchor', rect: him });
  await f.request(body, { kind: 'body.hit', rects: [him] });
  await f.request(f.panel, { kind: 'state' });
  assert.equal(body.opacity, 1);
  chosen = 'xianxian-codex';
  await f.request(f.panel, { kind: 'state' });
  await settle();
  assert.equal(body.opacity, 0);
  assert.equal(flushAsks(body), 1, 'the swap out waits for his scene');
  chosen = 'xianxian-living';
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-living');
  assert.equal(body.opacity, 1, 'chosen again: he is back at once');
  await f.request(body, { kind: 'scene.report', snapshot: { schemaVersion: 1 }, dirty: [] });
  await settle();
  assert.equal(body.destroyed, false, 'the swap out was called off');
  assert.equal(f.bodies.length, 1, 'no new body was needed');
  assert.equal(body.opacity, 1);
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-living');
});

test('a new ball choice hides the cat in the same step, not after a retry that is still loading', async (t) => {
  // codex61-sol post-merge P1 (postmerge-retry-load-choice-p1.md): the conceal sat in the swap out,
  // queued behind the held retry load, while the panel already had the ball: two cats, no bound.
  let gated = false;
  let release;
  let chosen = 'xianxian-living';
  const f = fixture({
    bodyGate: () => (gated ? new Promise((resolve) => (release = resolve)) : undefined),
    replies: (command) =>
      command.kind === 'state'
        ? state(chosen)
        : ['settings.read', 'settings.update'].includes(command.kind)
          ? settings({ skin: chosen })
          : undefined,
  });
  const managed = await f.open();
  t.after(() => {
    release?.();
    return managed.close();
  });
  await f.request(f.panel, { kind: 'state' });
  await settle();
  const [body] = f.bodies;
  const him = { x: 485, y: 556, width: 109, height: 160 };
  await f.request(body, { kind: 'body.anchor', rect: him });
  await f.request(body, { kind: 'body.hit', rects: [] });
  gated = true;
  await f.request(f.panel, { kind: 'settings.update', field: 'skin', value: 'xianxian-living' }, true);
  await settle();
  assert.equal(f.bodies.length, 2, 'the retry load is held');
  await f.request(body, { kind: 'body.hit', rects: [him] });
  assert.equal((await f.request(f.panel, { kind: 'state' })).skin, 'xianxian-living');
  assert.equal(body.opacity, 1, 'the old body drew and is on screen while the retry loads');
  const living = f.panel.getBounds();
  chosen = 'xianxian-codex';
  const reply = await f.request(f.panel, { kind: 'settings.update', field: 'skin', value: chosen }, true);
  assert.equal(reply.values.skin, 'xianxian-codex');
  assert.equal(body.opacity, 0, 'the reply that gives the panel the ball hides him too');
  assert.notDeepEqual(f.panel.getBounds(), living, 'and the panel window is the ball again');
  release();
  await settle();
  assert.equal(body.destroyed, true, 'the swap out still runs, in order, once the retry is done');
  assert.equal(f.bodies[1].destroyed, true, 'the retry is dropped: the old body had drawn');
});

test('the body is told its area, stand height and behaviorEnabled on open and on each change', async (t) => {
  const { owner, replies } = api({ state: state('xianxian-living', false) });
  const f = fixture({ replies });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  await settle();
  const [body] = f.bodies;
  assert.deepEqual(events(body, 'body-area'), [{ kind: 'body-area', width: 1280, height: 720, standHeight: 150 }]);
  assert.deepEqual(events(body, 'body-preferences'), [{ kind: 'body-preferences', behaviorEnabled: false }]);
  owner.settings = settings({ skin: 'xianxian-living', ballSize: 144, behaviorEnabled: false });
  await f.request(f.panel, { kind: 'settings.read' });
  await f.request(f.panel, { kind: 'settings.read' });
  assert.deepEqual(events(body, 'body-area').at(-1), { kind: 'body-area', width: 1280, height: 720, standHeight: 300 });
  assert.equal(events(body, 'body-area').length, 2, 'an unchanged size is not re-announced');
  owner.state = state('xianxian-living', true);
  await f.request(f.panel, { kind: 'state' });
  await f.request(f.panel, { kind: 'state' });
  assert.deepEqual(events(body, 'body-preferences'), [
    { kind: 'body-preferences', behaviorEnabled: false },
    { kind: 'body-preferences', behaviorEnabled: true },
  ]);
  Object.assign(f.area, { height: 690 });
  f.screen.emit('display-metrics-changed');
  assert.deepEqual(events(body, 'body-area').at(-1), { kind: 'body-area', width: 1280, height: 690, standHeight: 300 });
  assert.deepEqual(
    [43, 72, 192, 20, 1000].map(standHeight),
    [90, 150, 400, 60, 480],
    'round(150 × ballSize / 72) within 60–480',
  );
});

test('body-preferences is the owner setting settings.read returns: an open panel does not change it (candidate.3)', async (t) => {
  // PR #7292 R1 P2: the published schema defines it as the same value settings.read returns. Holding him
  // still while a panel is open waits for a candidate that defines it as the Host's current permission.
  const { owner, replies } = api({ state: state('xianxian-living', true) });
  const f = fixture({ replies });
  const managed = await f.open();
  t.after(() => managed.close());
  await f.request(f.panel, { kind: 'state' });
  await settle();
  const [body] = f.bodies;
  const told = () => events(body, 'body-preferences').map((row) => row.behaviorEnabled);
  await f.request(f.panel, { kind: 'view.layout', panel: 'menu', width: 200, height: 180 });
  await f.request(f.panel, { kind: 'state' });
  await f.request(f.panel, { kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  assert.deepEqual(told(), [true], 'opening and closing the menu sends nothing');
  owner.state = state('xianxian-living', false);
  await f.request(f.panel, { kind: 'state' });
  assert.deepEqual(told(), [true, false], 'only the owner changing it does');
});

test('a context click on him opens the panel menu, placed beside his last anchor', async (t) => {
  const { replies } = api({ state: state('xianxian-living') });
  const f = fixture({ replies });
  const managed = await f.open();
  t.after(() => managed.close());
  await managed.attachBody();
  const [body] = f.bodies;
  const lying = { x: 600, y: 600, width: 300, height: 70 };
  assert.deepEqual(await f.request(body, { kind: 'body.anchor', rect: lying }), { kind: 'ok' });
  await f.request(body, { kind: 'body.hit', rects: [lying] }); // drawn: his body rect is clickable
  await f.request(f.panel, { kind: 'state' }); // the panel is told the living skin: handed over
  assert.deepEqual(await f.request(body, { kind: 'body.menu' }), { kind: 'ok' });
  assert.deepEqual(events(f.panel, 'view-open'), [{ kind: 'view-open', panel: 'menu' }], 'on the panel channel');
  assert.deepEqual(events(body, 'view-open'), [], 'never to the body');
  const reply = await f.request(f.panel, { kind: 'view.layout', panel: 'menu', width: 200, height: 180 });
  const expected = placePanelForBody(lying, { kind: 'menu', width: 200, height: 180 }, f.area, f.cursor);
  assert.deepEqual(f.panel.getBounds(), expected.bounds);
  assert.deepEqual(reply.panel, {
    x: expected.panel.x - expected.bounds.x,
    y: expected.panel.y - expected.bounds.y,
    width: 200,
    height: 180,
  });
  assert.deepEqual(await f.request(body, { kind: 'body.menu', x: 1 }), { kind: 'error', code: 'invalid_request' });
  assert.deepEqual(await f.request(f.panel, { kind: 'body.menu' }), { kind: 'error', code: 'permission_required' });
  await managed.attachBody();
  assert.deepEqual(await f.request(body, { kind: 'body.menu' }), { kind: 'error', code: 'permission_required' });
  assert.equal(events(f.panel, 'view-open').length, 1, 'a replaced body opens nothing');
});

test('the menu he opens takes focus, so Escape or a click elsewhere closes it; a second context click closes it too', async (t) => {
  const f = fixture();
  const managed = await f.open();
  t.after(() => managed.close());
  await managed.attachBody();
  const [body] = f.bodies;
  assert.deepEqual(await f.request(body, { kind: 'body.menu' }), { kind: 'ok' });
  // U9: the body window never takes focus, so the panel never blurred and nothing but a menu item closed it.
  assert.equal(f.panel.focused, 1, 'the menu window is focused as it opens');
  await f.request(f.panel, { kind: 'view.layout', panel: 'menu', width: 200, height: 180 });
  f.panel.emit('blur');
  assert.deepEqual(events(f.panel, 'view-dismiss'), [{ kind: 'view-dismiss' }], 'a click elsewhere closes it');
  assert.deepEqual(await f.request(body, { kind: 'body.menu' }), { kind: 'ok' });
  assert.deepEqual(events(f.panel, 'view-dismiss').length, 2, 'as a second click on the ball does');
  assert.deepEqual(events(f.panel, 'view-open').length, 1);
  await f.request(f.panel, { kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  assert.deepEqual(await f.request(body, { kind: 'body.menu' }), { kind: 'ok' });
  assert.deepEqual(events(f.panel, 'view-open').length, 2, 'closed, the next context click opens it again');
  assert.equal(f.panel.focused, 2);
});

test('the pending badge the panel draws takes clicks over the living cat only while it is shown', async (t) => {
  const { owner, replies } = api({
    settings: settings({ skin: 'xianxian-living' }),
    'decisions.read': { kind: 'decisions', version: 1, status: 'available', items: [], totalCount: 3 },
  });
  const f = fixture({ replies });
  const managed = await f.open();
  t.after(() => managed.close());
  await managed.attachBody();
  const cat = { x: 600, y: 600, width: 140, height: 110 };
  await f.request(f.bodies[0], { kind: 'body.anchor', rect: cat });
  await f.request(f.bodies[0], { kind: 'body.hit', rects: [cat] }); // his region covers the badge
  await f.request(f.panel, { kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  await f.request(f.panel, { kind: 'settings.read' });
  await f.request(f.panel, { kind: 'decisions.read', offset: 0, limit: 10 });
  const panelIgnores = async (point) => {
    Object.assign(f.cursor, point);
    await new Promise((resolve) => setTimeout(resolve, 70)); // the shared 32 ms tick
    return f.panel.ignores.at(-1)?.[0] ?? false; // a window starts taking clicks until told otherwise
  };
  // With no panel the window is the 120 x 130 anchor box at the cat's bottom right: (620, 580)-(740, 710).
  // The badge "3": 25 px wide at its top right, 24 px tall: (715, 580)-(740, 604).
  const bodyIgnores = () => f.bodies[0].ignores.at(-1)?.[0] ?? true;
  assert.equal(await panelIgnores({ x: 650, y: 650 }), true, 'the rest of the panel window passes through');
  assert.equal(bodyIgnores(), false, 'to the cat');
  assert.equal(await panelIgnores({ x: 730, y: 590 }), false, 'the badge takes the click');
  assert.equal(bodyIgnores(), true, 'and the cat above it lets it through');
  assert.equal(await panelIgnores({ x: 705, y: 590 }), true, 'just left of the badge passes through');
  owner['decisions.read'] = { ...owner['decisions.read'], totalCount: 0 };
  await f.request(f.panel, { kind: 'decisions.read', offset: 0, limit: 10 });
  assert.equal(await panelIgnores({ x: 730, y: 590 }), true, 'no badge, nothing to click');
  owner['decisions.read'] = { kind: 'error', code: 'unavailable' };
  await f.request(f.panel, { kind: 'decisions.read', offset: 0, limit: 10 });
  assert.equal(await panelIgnores({ x: 730, y: 590 }), false, 'a failed read shows "?"');
  owner.settings = settings({ skin: 'xianxian-living', proactivePolicy: 'ambient' });
  await f.request(f.panel, { kind: 'settings.read' });
  assert.equal(await panelIgnores({ x: 730, y: 590 }), true, 'ambient hides the badge');
});

// F317 promise kept in living mode (守望猫 11-19): while a screen is shared or picked, its stop badge
// on the panel stays clickable over the living cat, so sharing can always be stopped directly.
test('the stop-sharing badge takes clicks over the living cat while a screen is shared or picked', async (t) => {
  const { replies } = api({ settings: settings({ skin: 'xianxian-living', proactivePolicy: 'ambient' }) });
  const f = fixture({ replies });
  const managed = await f.open();
  t.after(() => managed.close());
  await managed.attachBody();
  const cat = { x: 600, y: 600, width: 140, height: 110 };
  await f.request(f.bodies[0], { kind: 'body.anchor', rect: cat });
  await f.request(f.bodies[0], { kind: 'body.hit', rects: [cat] }); // his region covers the badge
  await f.request(f.panel, { kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  await f.request(f.panel, { kind: 'settings.read' });
  const panelIgnores = async (point) => {
    Object.assign(f.cursor, point);
    await new Promise((resolve) => setTimeout(resolve, 70)); // the shared 32 ms tick
    return f.panel.ignores.at(-1)?.[0] ?? false;
  };
  // The 32 px badge sits at the bottom right of the anchor box, which is the cat's bottom right: (708, 678)-(740, 710).
  assert.equal(await panelIgnores({ x: 725, y: 700 }), true, 'no share: the cat keeps that spot');
  await f.request(f.panel, { kind: 'prepare' }, true);
  assert.equal((await f.request(f.panel, { kind: 'screen.pick' }, true)).kind, 'selection');
  assert.equal(await panelIgnores({ x: 725, y: 700 }), false, 'picking a screen: the badge cancels it');
  await f.request(f.panel, { kind: 'screen.close' });
  assert.equal(await panelIgnores({ x: 725, y: 700 }), true, 'after stopping, the cat has that spot again');
});
