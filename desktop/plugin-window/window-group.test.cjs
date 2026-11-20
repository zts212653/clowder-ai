// F336 Phase C U3/U4 through the real Host window: the living body joins the same Host controller.
// A body swap during a call is internal; hide, lock, close and crashes belong to the whole cat.
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, openWithCall, bodyUrl } = require('./window-group-fixture.cjs');

test('swapping the body during an open call keeps the call, the controller, the voice host and the handler', async (t) => {
  const f = fixture();
  const managed = await openWithCall(f);
  t.after(() => managed.close());
  const voice = f.windows.find((w) => w.isVoice);
  const commandsAfterConnect = f.voiceCommands.length;
  assert.equal(await managed.attachBody(), 1);
  const [first] = f.bodies;
  assert.equal(first.visible, true, 'the new body is shown with the group');
  assert.deepEqual(await f.request(first, { kind: 'body.hit', rects: [] }), { kind: 'ok' });
  assert.deepEqual(
    await f.request(first, { kind: 'scene.get' }),
    { kind: 'scene', status: 'error', reason: 'unavailable' },
    'the scene writer answers the body; this fixture API has no archive',
  );
  assert.deepEqual(await f.request(first, { kind: 'view.layout' }), { kind: 'error', code: 'permission_required' });
  assert.deepEqual(await f.request(first, { kind: 'audio.close' }), { kind: 'error', code: 'permission_required' });
  assert.deepEqual(await f.request(f.panel, { kind: 'body.hit' }), { kind: 'error', code: 'permission_required' });
  assert.equal(await managed.attachBody(), 2, 'replacing the body mints a new generation');
  assert.equal(first.destroyed, true);
  assert.deepEqual(await f.request(first, { kind: 'scene.report' }), { kind: 'error', code: 'permission_required' });
  await managed.detachBody();
  assert.equal(f.bodies[1].destroyed, true);
  assert.equal(await managed.attachBody(), 3);

  assert.deepEqual(f.mediaStops(), [], 'no revocation reached the package');
  assert.equal(f.apiCommands.includes('stop'), false, 'the controller was never suspended');
  assert.equal(f.voiceCommands.length, commandsAfterConnect, 'no media command reached the voice document');
  assert.equal(voice.destroyed, false, 'the voice document survived the swap');
  assert.equal(f.handlers.has('companion:media-offer'), true, 'the voice host was never closed');
  assert.deepEqual([f.counts.handle, f.counts.removeHandler], [1, 0], 'one handler for the whole process');
  assert.equal(f.panel.visible, true);
  assert.deepEqual(f.failures, []);
  assert.equal((await f.request(f.panel, { kind: 'state' })).audio.activeMode, 'receive_only');
  assert.equal(managed.poll(), 'visible');
});

test('a same-origin side window cannot reach the Host even while a body is attached', async (t) => {
  const f = fixture();
  const managed = await f.open();
  t.after(() => managed.close());
  await managed.attachBody();
  const side = new f.Window({ body: true, url: bodyUrl });
  await side.loadURL(bodyUrl);
  for (const kind of ['state', 'body.hit', 'scene.get'])
    assert.deepEqual(await f.request(side, { kind }, true), { kind: 'error', code: 'permission_required' }, kind);
});

test('a deliberate hide in living mode revokes once and hides both windows; show restores both', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const managed = await openWithCall(f);
  t.after(() => managed.close());
  await managed.attachBody();
  const [body] = f.bodies;
  assert.equal((await f.request(f.panel, { kind: 'view.hide' }, true)).kind, 'ok');
  t.mock.timers.tick(1500); // past the ambiguous-native-hide confirmation bound
  assert.deepEqual(f.mediaStops(), ['hidden'], 'one revocation for one user hide');
  assert.equal(f.apiCommands.filter((kind) => kind === 'stop').length, 1);
  assert.equal(f.panel.visible, false);
  assert.equal(body.visible, false);
  assert.equal(managed.poll(), 'hidden');
  managed.show();
  assert.equal(f.panel.visible, true);
  assert.equal(body.visible, true);
  assert.equal(managed.poll(), 'visible');
});

test('lock in living mode revokes once and hides the body; unlock shows it again', async (t) => {
  const f = fixture();
  const managed = await openWithCall(f);
  t.after(() => managed.close());
  await managed.attachBody();
  const [body] = f.bodies;
  f.powerMonitor.emit('lock-screen');
  assert.deepEqual(f.mediaStops(), ['locked']);
  assert.equal(f.apiCommands.filter((kind) => kind === 'stop').length, 1);
  assert.equal(body.visible, false, 'a locked cat stops drawing and holding desktop clicks');
  assert.equal(f.panel.visible, true, 'the panel keeps its ball-mode lock behaviour');
  f.powerMonitor.emit('unlock-screen');
  assert.equal(body.visible, true);
  assert.deepEqual(f.mediaStops(), ['locked']);
});

test('close destroys the panel and the body in one batch and leaves no window open', async () => {
  const f = fixture();
  const managed = await openWithCall(f);
  await managed.attachBody();
  managed.close();
  assert.deepEqual(
    f.windows.filter((w) => !w.destroyed),
    [],
    'panel, body and the voice document are all gone',
  );
  assert.equal(f.handlers.has('companion:request'), false);
  assert.equal(f.handlers.has('companion:media-offer'), false);
  assert.throws(() => managed.poll(), /closed/);
});

test('a crashed body closes the whole cat: controller, voice and handler end and the panel is destroyed', async () => {
  const f = fixture();
  const managed = await openWithCall(f);
  await managed.attachBody();
  const [body] = f.bodies;
  body.webContents.emit('render-process-gone');
  assert.deepEqual(f.failures, ['renderer-gone']);
  assert.equal(f.panel.destroyed, true);
  assert.equal(body.destroyed, true);
  assert.deepEqual(
    f.windows.filter((w) => !w.destroyed),
    [],
  );
  assert.equal(f.handlers.has('companion:request'), false);
  assert.equal(f.handlers.has('companion:media-offer'), false, 'the voice host closed with the cat');
  assert.throws(() => managed.poll(), /closed/);
  await assert.rejects(managed.attachBody(), /closed/);
});

test('without an injected factory the Host opens the real body window and routes its hit lease and anchor', async (t) => {
  const f = fixture({ realBody: true });
  const managed = await f.open();
  t.after(() => managed.close());
  assert.equal(await managed.attachBody(), 1);
  const body = f.windows.find((w) => w.options.focusable === false);
  assert.ok(body, 'an unfocusable body window was created');
  assert.equal(body.url, bodyUrl);
  assert.equal(body.visible, true, 'shown inactive with the group');
  assert.deepEqual(body.ignores[0], [true, { forward: true }], 'it starts click-through');
  assert.deepEqual(body.getBounds(), { x: 0, y: 0, width: 1280, height: 720 }, 'it covers the work area');
  assert.equal(f.partitionNames.length, 2);
  assert.notEqual(f.partitionNames[0], f.partitionNames[1], 'the body has its own partition');
  const cat = { x: 1000, y: 600, width: 120, height: 100 };
  assert.deepEqual(await f.request(body, { kind: 'body.hit', rects: [cat] }), { kind: 'ok' });
  assert.deepEqual(await f.request(body, { kind: 'body.hit.renew' }), { kind: 'ok' });
  assert.deepEqual(await f.request(body, { kind: 'body.hit', rects: [{ x: 0, y: 0, width: 1280, height: 720 }] }), {
    kind: 'error',
    code: 'invalid_request',
  });
  assert.deepEqual(await f.request(body, { kind: 'body.anchor', rect: cat }), { kind: 'ok' });
  assert.deepEqual(await f.request(body, { kind: 'body.menu' }), { kind: 'ok' });
  assert.deepEqual(f.mediaStops(), []);
});
