const assert = require('node:assert/strict');
const test = require('node:test');
const { createManagedWindow } = require('./window.cjs');
const { petMetrics } = require('./pet-placement.cjs');
const { fixture, input, deferred } = require('./window-motion-fixture.cjs');

test('initial layout waits for saved size across the real loading-to-show boundary', async (t) => {
  const f = fixture();
  const settings = deferred();
  let settingsRead;
  let firstLayout;
  const BaseWindow = f.electron.BrowserWindow;
  f.electron.BrowserWindow = class extends BaseWindow {
    async loadURL(url) {
      await super.loadURL(url);
      settingsRead = f.request({ kind: 'settings.read' });
      firstLayout = f.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
    }
    showInactive() {
      super.showInactive();
      this.emit('show');
    }
  };
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async () => settings.promise,
  });
  t.after(() => managed.close());
  settings.resolve({ kind: 'settings', status: 'available', values: { ballSize: 89 } });
  await settingsRead;
  const placed = await firstLayout;
  const metrics = petMetrics(89);
  assert.equal(placed.width, 213, 'the renderer must receive the saved-size native rectangle, not default 175');
  assert.equal(placed.height, 190);
  assert.equal(placed.pet.x, metrics.art.left + 8, 'the first reply already contains the scaled art inset');
  assert.equal(placed.pet.y, metrics.art.top + 8);
  assert.ok(placed.pet.x + (120 * 89) / 72 < placed.width);
  assert.equal(managed.motionLease(), null, 'a pre-show settings read cannot rearm private movement');
});

test('a fresh layout cannot race the latest settings read or let an old read overwrite geometry', async (t) => {
  const f = fixture();
  const old = deferred();
  const latest = deferred();
  let reads = 0;
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async () => (++reads === 1 ? old.promise : latest.promise),
  });
  t.after(() => managed.close());
  const first = f.request({ kind: 'settings.read' });
  const layout = f.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  const second = f.request({ kind: 'settings.read' });
  old.resolve({ kind: 'settings', status: 'available', values: { ballSize: 43 } });
  await first;
  latest.resolve({ kind: 'settings', status: 'available', values: { ballSize: 192 } });
  await second;
  const placed = await layout;
  assert.equal(placed.width, 440);
  assert.equal(placed.pet.x, petMetrics(192).art.left + 8);
});

test('a layout waiting on settings cannot outlive its native window', async () => {
  const f = fixture();
  const settings = deferred();
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async () => settings.promise,
  });
  const read = f.request({ kind: 'settings.read' });
  const layout = f.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  managed.close();
  settings.resolve({ kind: 'settings', status: 'available', values: { ballSize: 89 } });
  await read;
  assert.deepEqual(await layout, { kind: 'error', code: 'permission_required' });
});
