const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createMediaRevocation, reloadForMediaRevocation } = require('./media-revocation.cjs');

test('a stalled capture document rejects in bounds and removes all listeners; new document or window destruction confirms revocation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  win.webContents = new EventEmitter();
  win.webContents.reload = () => {};
  const stalled = reloadForMediaRevocation(win);
  const failed = assert.rejects(stalled, /unconfirmed/);
  t.mock.timers.tick(2000);
  await failed;
  assert.equal(win.webContents.listenerCount('dom-ready'), 0);
  assert.equal(win.listenerCount('closed'), 0);
  const loaded = reloadForMediaRevocation(win);
  win.webContents.emit('dom-ready');
  await loaded;
  const closed = reloadForMediaRevocation(win);
  win.emit('closed');
  await closed;
  assert.equal(win.webContents.listenerCount('render-process-gone'), 0);
});

test('a later revocation waits for its own reload after an earlier reload timed out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  win.webContents = new EventEmitter();
  let reloads = 0;
  win.webContents.reload = () => reloads++;
  const revocation = createMediaRevocation(win);
  await revocation.wait();
  assert.equal(reloads, 0);
  revocation.reload();
  const previous = revocation.wait();
  const failed = assert.rejects(previous, /unconfirmed/);
  t.mock.timers.tick(2000);
  await failed;
  win.webContents.emit('dom-ready'); // The late event must not recycle a rejected promise.
  const next = revocation.wait();
  assert.notEqual(next, previous);
  assert.equal(reloads, 2);
  assert.equal(revocation.wait(), next, 'concurrent awaiters share the new pending revocation');
  let settled = false;
  void next.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  win.webContents.emit('dom-ready');
  await next;
  assert.equal(revocation.wait(), next, 'confirmed revocation needs no redundant reload');
  assert.equal(win.webContents.listenerCount('dom-ready'), 0);
  assert.equal(win.listenerCount('closed'), 0);
});

test('an older timeout cannot replace the conclusion of a newer pending reload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  win.webContents = new EventEmitter();
  let reloads = 0;
  win.webContents.reload = () => reloads++;
  const revocation = createMediaRevocation(win);
  revocation.reload();
  const previous = assert.rejects(revocation.wait(), /unconfirmed/);
  t.mock.timers.tick(1000);
  revocation.reload();
  const current = revocation.wait();
  t.mock.timers.tick(1000);
  await previous;
  assert.equal(revocation.wait(), current);
  assert.equal(reloads, 2);
  win.webContents.emit('dom-ready');
  await current;
});
