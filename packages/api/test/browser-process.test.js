import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { BrowserProcess } from '../dist/domains/browser/BrowserProcess.js';

/** A child that answers `init` with `ready` (or never, or exits), like browser-process-entry. */
function fakeChild(behavior = 'ready') {
  const child = new EventEmitter();
  child.connected = true;
  child.stderr = new EventEmitter();
  child.received = [];
  child.killed = [];
  child.send = (message) => {
    child.received.push(message);
    if (behavior === 'ready') setImmediate(() => child.emit('message', { type: 'ready', port: 4242 }));
    if (behavior === 'exit') setImmediate(() => child.exit());
  };
  child.exit = () => {
    child.connected = false;
    child.emit('exit', 1);
  };
  child.kill = (signal) => {
    child.killed.push(signal);
    child.exit();
  };
  child.disconnect = () => child.exit();
  return child;
}

test('concurrent requests share one start, and the key travels over IPC only', async () => {
  const children = [];
  const browser = new BrowserProcess({ spawn: () => (children.push(fakeChild()), children.at(-1)) });
  const [a, b, c] = await Promise.all([browser.endpoint(), browser.endpoint(), browser.endpoint()]);
  assert.equal(children.length, 1, 'single-flight start');
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(a.port, 4242);
  assert.match(a.key, /^[0-9a-f]{64}$/);
  assert.deepEqual(children[0].received, [{ type: 'init', key: a.key }]);
});

test('a crashed child is replaced on the next request with a new key', async () => {
  const children = [];
  const browser = new BrowserProcess({ spawn: () => (children.push(fakeChild()), children.at(-1)) });
  const first = await browser.endpoint();
  children[0].exit();
  const second = await browser.endpoint();
  assert.equal(children.length, 2);
  assert.notEqual(first.key, second.key);
});

test('a child that dies or stalls during start fails that request and the next one retries the start', async () => {
  const children = [];
  const plan = ['exit', 'silent', 'ready'];
  const browser = new BrowserProcess({
    readyTimeoutMs: 50,
    spawn: () => (children.push(fakeChild(plan[children.length])), children.at(-1)),
  });
  await assert.rejects(browser.endpoint(), /browser_process_exited/);
  await assert.rejects(browser.endpoint(), /browser_process_start_timeout/);
  assert.equal((await browser.endpoint()).port, 4242);
  assert.equal(children.length, 3);
});

test('a child whose heartbeats stop is killed and the next request gets a fresh one (R1 P1-4)', async () => {
  let now = 0;
  const children = [];
  const browser = new BrowserProcess({
    now: () => now,
    hangTimeoutMs: 30_000,
    watchdogIntervalMs: 10,
    spawn: () => (children.push(fakeChild()), children.at(-1)),
  });
  const first = await browser.endpoint();
  now = 10_000;
  children[0].emit('message', { type: 'heartbeat' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(children[0].connected, true, 'a beating child is left alone');
  now = 45_000; // stuck event loop: no heartbeat for 35s
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(children[0].connected, false, 'the hung child was killed');
  assert.deepEqual(children[0].killed, ['SIGKILL']);
  const second = await browser.endpoint();
  assert.equal(children.length, 2);
  assert.notEqual(first.key, second.key);
  browser.stop();
});

test('a retiring child (idle, or poisoned by a late call) is replaced only after it exits; one that lingers is killed (R3)', async () => {
  const children = [];
  const browser = new BrowserProcess({
    retireGraceMs: 40,
    requestDeadlineMs: 1200,
    spawn: () => (children.push(fakeChild()), children.at(-1)),
  });
  const first = await browser.endpoint();
  assert.deepEqual(children[0].received, [{ type: 'init', key: first.key, requestDeadlineMs: 1200 }]);
  children[0].emit('message', { type: 'retiring' });
  const next = browser.endpoint();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(children.length, 1, 'no new child while the old one may still hold Chrome and its profile');
  const second = await next;
  assert.deepEqual(children[0].killed, ['SIGKILL'], 'past the grace the old generation is killed');
  assert.equal(children.length, 2);
  assert.notEqual(first.key, second.key);
});

test('a retiring child that closes in time exits by itself and is not killed (R3)', async () => {
  const children = [];
  const browser = new BrowserProcess({
    retireGraceMs: 5_000,
    spawn: () => (children.push(fakeChild()), children.at(-1)),
  });
  await browser.endpoint();
  children[0].emit('message', { type: 'retiring' });
  const next = browser.endpoint();
  setTimeout(() => children[0].exit(), 10);
  await next;
  assert.deepEqual(children[0].killed, []);
  assert.equal(children.length, 2);
});
