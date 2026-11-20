// F336 Phase C U5: the living body window and its click lease. The page says where the cat is
// clickable (body.hit) and keeps that alive with a repaint-independent renewal; the Host decides.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createLivingBody, openBodyWindow, HIT_LEASE_MS } = require('./body-window.cjs');

const workArea = { x: 0, y: 25, width: 1440, height: 850 };
const bodyUrl = `http://companion-${'a'.repeat(32)}.localhost:4187/packages/fixture/body/body.html`;
const presentation = { width: 320, height: 350, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true };

function bodyFixture({ revealed = true } = {}) {
  let time = 1_000;
  let cursor = { x: 0, y: 0 };
  const ignores = [];
  const win = {
    visible: true,
    destroyed: false,
    webContents: new EventEmitter(),
    getBounds: () => ({ ...workArea }),
    isVisible: () => win.visible,
    isDestroyed: () => win.destroyed,
    setIgnoreMouseEvents: (value, options) => ignores.push([value, options]),
    setOpacity: (value) => {
      win.opacity = value;
    },
  };
  const screen = {
    getCursorScreenPoint: () => cursor,
    getDisplayMatching: () => ({ workArea }),
  };
  const body = createLivingBody({ win, generation: 1, screen, now: () => time });
  if (revealed) body.reveal(); // the panel was told: most tests start from a cat on screen
  const at = (x, y) => {
    cursor = { x: workArea.x + x, y: workArea.y + y }; // body-window coordinates to screen
  };
  const clickable = (overPanel = false) => {
    body.tick(cursor, overPanel);
    return ignores.length > 0 && ignores.at(-1)[0] === false;
  };
  return {
    win,
    body,
    ignores,
    at,
    clickable,
    advance: (ms) => {
      time += ms;
    },
    press: (type) => win.webContents.emit('input-event', {}, { type }),
  };
}
const cat = { x: 600, y: 700, width: 140, height: 120 };

test('renewals keep a still cat clickable past the 1.5 s lease without any region change', () => {
  const f = bodyFixture();
  assert.deepEqual(f.body.request({ kind: 'body.hit', rects: [cat] }), { kind: 'ok' });
  f.at(650, 750);
  assert.equal(f.clickable(), true);
  for (let elapsed = 0; elapsed < 4_000; elapsed += 500) {
    f.advance(500);
    assert.deepEqual(f.body.request({ kind: 'body.hit.renew' }), { kind: 'ok' });
    assert.equal(f.clickable(), true, `still clickable ${elapsed + 500} ms after the only body.hit`);
  }
  f.at(100, 100);
  assert.equal(f.clickable(), false, 'blank desktop around the cat passes through');
});

test('once renewals stop the body passes through within 1.5 s, and a later renewal revives the same region', () => {
  const f = bodyFixture();
  f.body.request({ kind: 'body.hit', rects: [cat] });
  f.at(650, 750);
  f.advance(500);
  f.body.request({ kind: 'body.hit.renew' });
  f.advance(HIT_LEASE_MS - 1);
  assert.equal(f.clickable(), true);
  f.advance(1);
  assert.equal(f.clickable(), false, 'a hung page cannot hold desktop clicks past the lease');
  assert.deepEqual(f.ignores.at(-1), [true, { forward: true }], 'pass-through keeps forwarding the cursor');
  f.body.request({ kind: 'body.hit.renew' });
  assert.equal(f.clickable(), true);
});

test('he is on screen once his visible body rect is one of the clickable rects; that latches', () => {
  // #7292 R1 P1-3: alpha.38 sends an anchor even with no atlas, and the paper ball's rect when only
  // the ball's atlas loaded (守望猫: restored side-sit, atlas 1 failed). Only his own rect counts.
  const f = bodyFixture();
  const sitting = { x: 600, y: 680, width: 110, height: 160 };
  const ball = { x: 900, y: 790, width: 46, height: 46 };
  assert.deepEqual(f.body.request({ kind: 'body.anchor', rect: sitting }), { kind: 'ok' });
  assert.equal(f.body.shown(), false, 'an anchor alone is not a drawn cat');
  assert.deepEqual(f.body.request({ kind: 'body.hit', rects: [ball] }), { kind: 'ok' });
  assert.equal(f.body.shown(), false, 'the paper ball drawn without him is not him');
  f.body.request({ kind: 'body.hit', rects: [sitting, ball] });
  assert.equal(f.body.shown(), true, 'his body rect among the clickable rects');
  f.body.request({ kind: 'body.anchor', rect: { x: 300, y: 740, width: 430, height: 100 } }); // all of him in the box
  f.body.request({ kind: 'body.hit', rects: [ball] });
  assert.equal(f.body.shown(), true, 'hiding later is not a failure');
  const g = bodyFixture();
  g.body.request({ kind: 'body.hit', rects: [sitting] });
  g.body.request({ kind: 'body.anchor', rect: sitting });
  assert.equal(g.body.shown(), true, 'either order');
});

test('an unrevealed body is transparent and takes no click, even on its region; concealing undoes reveal', () => {
  // #7292 R1 (F317 one body at a time): the ball and the cat must never both be on screen.
  const f = bodyFixture({ revealed: false });
  assert.equal(f.win.opacity, 0, 'transparent from attach');
  f.body.request({ kind: 'body.hit', rects: [cat] });
  f.at(650, 750);
  assert.equal(f.clickable(), false, 'not yet the cat on screen: clicks go through');
  f.body.reveal();
  assert.equal(f.win.opacity, 1);
  assert.equal(f.clickable(), true);
  f.body.conceal();
  assert.equal(f.win.opacity, 0);
  assert.equal(f.clickable(), false, 'concealed for a swap out: clicks go through at once');
});

test('a renewal without any region never makes the body clickable', () => {
  const f = bodyFixture();
  assert.deepEqual(f.body.request({ kind: 'body.hit.renew' }), { kind: 'ok' });
  f.at(650, 750);
  assert.equal(f.clickable(), false);
  assert.deepEqual(f.ignores, [], 'the factory default (ignore with forward) is never changed');
});

test('whole-screen, more than 8, out-of-window and malformed regions are rejected whole; the old region stays', () => {
  const f = bodyFixture();
  f.body.request({ kind: 'body.hit', rects: [cat] });
  const tiny = (i) => ({ x: i * 20, y: 0, width: 10, height: 10 });
  const rejected = [
    [{ x: 0, y: 0, width: 1440, height: 850 }],
    [{ x: 0, y: 0, width: 1440, height: 130 }], // 15.3% of the work area
    Array.from({ length: 9 }, (_, i) => tiny(i)),
    [{ x: 1400, y: 700, width: 41, height: 10 }],
    [{ x: -1, y: 700, width: 20, height: 10 }],
    [{ x: 10, y: 845, width: 20, height: 6 }],
    [{ x: Number.NaN, y: 0, width: 10, height: 10 }],
    [{ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 }],
    [{ x: 0, y: 0, width: 0, height: 10 }],
    [{ x: 0, y: 0, width: 10, height: -4 }],
    [{ x: 0, y: 0, width: 10, height: 10, z: 1 }],
    [{ x: '0', y: 0, width: 10, height: 10 }],
    [null],
    'all',
    undefined,
  ];
  for (const rects of rejected)
    assert.deepEqual(
      f.body.request({ kind: 'body.hit', rects }),
      { kind: 'error', code: 'invalid_request' },
      JSON.stringify(rects),
    );
  assert.deepEqual(f.body.request({ kind: 'body.hit', rects: [cat], extra: true }), {
    kind: 'error',
    code: 'invalid_request',
  });
  f.at(650, 750);
  assert.equal(f.clickable(), true, 'the previous region is still the clickable one');
  f.at(5, 5);
  assert.equal(f.clickable(), false, 'no rejected region became clickable');
  assert.deepEqual(f.body.request({ kind: 'body.hit', rects: Array.from({ length: 8 }, (_, i) => tiny(i)) }), {
    kind: 'ok',
  });
  assert.equal(f.clickable(), true, 'eight small rects are a legal region');
  assert.deepEqual(f.body.request({ kind: 'body.hit', rects: [] }), { kind: 'ok' });
  assert.equal(f.clickable(), false, 'an empty region means nothing on the cat layer is clickable');
});

test('a press that started inside the region keeps the body capturing after the cursor leaves, until mouse-up', () => {
  const f = bodyFixture();
  f.body.request({ kind: 'body.hit', rects: [{ x: 300, y: 800, width: 40, height: 40 }] }); // the paper ball
  f.at(320, 820);
  assert.equal(f.clickable(), true);
  f.press('mouseDown');
  f.at(900, 300); // dragging the paper ball far from the old region
  assert.equal(f.clickable(), true, 'the drag keeps the body until it is released');
  for (let i = 0; i < 6; i++) {
    f.advance(500);
    f.body.request({ kind: 'body.hit.renew' }); // a live page renews every 500 ms while you drag
  }
  assert.equal(f.clickable(), true, 'a renewed drag outlasts 1.5 s');
  f.press('mouseUp');
  assert.equal(f.clickable(), false, 'released over blank desktop: clicks pass through again');

  f.body.request({ kind: 'body.hit.renew' });
  f.at(5, 5);
  f.press('mouseDown'); // the cursor was not on the region when the press landed
  assert.equal(f.clickable(), false, 'a press outside the region never starts a capture');
});

test('a page that hangs mid-drag releases the desktop at the lease deadline, the press still held', () => {
  // PR #7292 R1 P1-2: the capture had bypassed the lease, so a hung page held every click until mouse-up or 15 s.
  const f = bodyFixture();
  f.body.request({ kind: 'body.hit', rects: [{ x: 300, y: 800, width: 40, height: 40 }] });
  f.at(320, 820);
  f.press('mouseDown');
  f.at(900, 300);
  f.advance(HIT_LEASE_MS - 1);
  assert.equal(f.clickable(), true, 'within the lease the drag still holds');
  f.advance(2); // no renewal: the page hung while the button is down
  assert.equal(f.clickable(), false, 'past the lease the desktop is clickable again');
  f.body.request({ kind: 'body.hit.renew' });
  assert.equal(f.clickable(), false, 'a late renewal does not bring back a capture the lease already ended');
});

test('a capture ends on hide and after 15 s even if mouse-up never arrives', () => {
  const f = bodyFixture();
  f.body.request({ kind: 'body.hit', rects: [cat] });
  f.at(650, 750);
  f.press('mouseDown');
  f.at(5, 5);
  f.advance(15_001);
  assert.equal(f.clickable(), false, 'no unbounded drag lifetime');
  f.body.request({ kind: 'body.hit', rects: [cat] });
  f.at(650, 750);
  f.press('mouseDown');
  f.win.visible = false;
  assert.equal(f.clickable(), false, 'a hidden body never holds clicks');
  f.win.visible = true;
  f.at(5, 5);
  assert.equal(f.clickable(), false, 'hiding dropped the capture');
});

test('an open panel wins over the body region; a held press still finishes on the body', () => {
  const f = bodyFixture();
  f.body.request({ kind: 'body.hit', rects: [cat] });
  f.at(650, 750);
  assert.equal(f.clickable(true), false, 'cursor over the open panel: the body passes through');
  assert.equal(f.clickable(false), true);
  f.press('mouseDown');
  assert.equal(f.clickable(true), true, 'a press that began on the cat is not stolen mid-drag');
  f.press('mouseUp');
  assert.equal(f.clickable(true), false);
});

test('release drops the region and the listener and leaves the window ignoring', () => {
  const f = bodyFixture();
  f.body.request({ kind: 'body.hit', rects: [cat] });
  f.at(650, 750);
  assert.equal(f.clickable(), true);
  f.body.release();
  assert.deepEqual(f.ignores.at(-1), [true, { forward: true }]);
  assert.equal(f.win.webContents.listenerCount('input-event'), 0);
  assert.equal(f.clickable(), false);
});

test('body.anchor converts a bounded in-window rect to screen coordinates; bad values are rejected', () => {
  const f = bodyFixture();
  assert.equal(f.body.anchor(), undefined);
  assert.deepEqual(f.body.request({ kind: 'body.anchor', rect: { x: 600.4, y: 700, width: 300, height: 70 } }), {
    kind: 'ok',
  });
  assert.deepEqual(f.body.anchor(), { x: 600, y: 725, width: 300, height: 70 });
  const rejected = [
    { x: 1300, y: 700, width: 300, height: 70 },
    { x: -10, y: 700, width: 30, height: 70 },
    { x: 0, y: 0, width: 1441, height: 70 },
    { x: Number.NaN, y: 700, width: 30, height: 70 },
    { x: 0, y: 700, width: Number.POSITIVE_INFINITY, height: 70 },
    { x: 0, y: 700, width: 0, height: 70 },
    { x: 0, y: 700, width: 30, height: 70, screen: true },
    null,
  ];
  for (const rect of rejected)
    assert.deepEqual(
      f.body.request({ kind: 'body.anchor', rect }),
      { kind: 'error', code: 'invalid_request' },
      JSON.stringify(rect),
    );
  assert.deepEqual(f.body.anchor(), { x: 600, y: 725, width: 300, height: 70 }, 'the last good anchor stays');
});

test('the lease owns only its own commands; nothing answers with an unpublished code', () => {
  const f = bodyFixture();
  for (const kind of ['body.menu', 'scene.get', 'scene.report', 'body.other'])
    assert.deepEqual(f.body.request({ kind }), { kind: 'error', code: 'invalid_request' }, kind);
});

function electronFixture({ failLoad = false } = {}) {
  const log = [];
  const partitions = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => {
        this.openHandler = handler;
      };
      this.webContents.setVisualZoomLevelLimits = (...limits) => log.push(['zoom-limits', ...limits]);
      log.push(['new']);
    }
    setIgnoreMouseEvents(...args) {
      log.push(['ignore', ...args]);
    }
    setVisibleOnAllWorkspaces(...args) {
      log.push(['workspaces', ...args]);
    }
    async loadURL(url) {
      log.push(['load', url]);
      if (failLoad) throw new Error('load failed');
    }
    show() {
      log.push(['show']);
    }
    showInactive() {
      log.push(['showInactive']);
    }
    focus() {
      log.push(['focus']);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      log.push(['destroy']);
    }
  }
  const session = {
    fromPartition(name, options) {
      const partition = new EventEmitter();
      Object.assign(partition, { name, options, webRequest: { onBeforeRequest() {} } });
      partition.setPermissionCheckHandler = (handler) => {
        partition.check = handler;
      };
      partition.setPermissionRequestHandler = (handler) => {
        partition.ask = handler;
      };
      partitions.push(partition);
      return partition;
    },
  };
  const screen = { getPrimaryDisplay: () => ({ workArea }) };
  return { electron: { BrowserWindow, session, screen }, log, partitions };
}

test('the real body window: transparent, unfocusable, over the work area, ignoring with forward by default', async () => {
  const f = electronFixture();
  const win = await openBodyWindow(f.electron, { url: bodyUrl, presentation });
  const o = win.options;
  assert.deepEqual(
    [o.transparent, o.frame, o.focusable, o.hasShadow, o.resizable, o.show],
    [true, false, false, false, false, false],
  );
  assert.equal(o.alwaysOnTop, presentation.alwaysOnTop, 'the same always-on-top level as the panel');
  assert.equal(o.skipTaskbar, presentation.skipTaskbar);
  assert.deepEqual({ x: o.x, y: o.y, width: o.width, height: o.height }, workArea);
  assert.deepEqual(
    [o.webPreferences.sandbox, o.webPreferences.contextIsolation, o.webPreferences.nodeIntegration],
    [true, true, false],
  );
  assert.equal(o.webPreferences.session, f.partitions[0], 'its own ephemeral partition');
  assert.match(f.partitions[0].name, /^companion-/);
  assert.deepEqual(f.partitions[0].options, { cache: false });
  assert.equal(f.partitions[0].check(win.webContents, 'media', 'http://x'), false);
  let granted;
  f.partitions[0].ask(win.webContents, 'display-capture', (value) => {
    granted = value;
  });
  assert.equal(granted, false, 'the living body never holds a media permission');
  assert.deepEqual(win.openHandler(), { action: 'deny' });
  const steps = f.log.map(([name]) => name);
  assert.ok(steps.indexOf('ignore') < steps.indexOf('load'), 'ignoring before any page content can paint');
  assert.deepEqual(
    f.log.find(([name]) => name === 'ignore'),
    ['ignore', true, { forward: true }],
  );
  assert.deepEqual(
    f.log.find(([name]) => name === 'workspaces'),
    ['workspaces', true, { visibleOnFullScreen: true }],
  );
  assert.deepEqual(
    f.log.find(([name]) => name === 'load'),
    ['load', bodyUrl],
  );
  for (const forbidden of ['show', 'focus', 'showInactive'])
    assert.equal(steps.includes(forbidden), false, `${forbidden}: the window group shows it inactive`);
  let prevented = 0;
  win.webContents.emit('will-navigate', { preventDefault: () => prevented++ }, `${bodyUrl}?elsewhere`);
  win.webContents.emit('will-redirect', { preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
});

test('a body page that fails to load is destroyed, never left behind', async () => {
  const f = electronFixture({ failLoad: true });
  await assert.rejects(openBodyWindow(f.electron, { url: bodyUrl, presentation }), /load failed/);
  assert.deepEqual(f.log.at(-1), ['destroy']);
});
