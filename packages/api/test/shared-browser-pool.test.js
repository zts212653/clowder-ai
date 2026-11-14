import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PAGES_PER_THREAD, WorkspaceBrowser } from '../dist/domains/browser/shared-browser-pool.js';
import { FakeContext } from './helpers/fake-browser-context.js';

function pool() {
  const launches = [];
  const browser = new WorkspaceBrowser(async () => {
    const context = new FakeContext();
    launches.push(context);
    return context;
  });
  return { browser, launches };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a session view lists its own page first and only its thread pages', async () => {
  const { browser, launches } = pool();
  const a = await browser.view('thread-a').prepare();
  const b = await browser.view('thread-b').prepare();
  const a2 = await browser.view('thread-a').prepare();

  assert.equal(launches.length, 1, 'one browser per workspace');
  assert.equal(launches[0].list.length, 3, 'the blank startup page is closed, three session pages remain');
  const [aOwn] = a.pages();
  const [a2Own] = a2.pages();
  assert.notEqual(aOwn, a2Own, 'each session gets its own current page');
  assert.deepEqual(a2.pages(), [a2Own, aOwn], 'same thread sees the other cat page after its own');
  assert.equal(b.pages().length, 1, 'another thread sees none of thread-a pages');
  assert.ok(!b.pages().includes(aOwn));
});

test('page events reach only views of the owning thread, popups follow their opener', async () => {
  const { browser, launches } = pool();
  const aView = browser.view('thread-a');
  const bView = browser.view('thread-b');
  const a = await aView.prepare();
  const b = await bView.prepare();
  const seenA = [];
  const seenB = [];
  a.on('page', (page) => seenA.push(page));
  b.on('page', (page) => seenB.push(page));

  const created = await a.newPage();
  const popup = launches[0].popup(created);
  await settle();
  const orphan = launches[0].popup(null);
  await settle();

  assert.deepEqual(seenA, [created, popup]);
  assert.deepEqual(seenB, []);
  assert.ok(a.pages().includes(popup));
  assert.ok(!a.pages().includes(orphan) && !b.pages().includes(orphan), 'a page with no known owner is hidden');
});

test('removed and once listeners stop receiving thread pages', async () => {
  const { browser } = pool();
  const a = await browser.view('thread-a').prepare();
  let onceCount = 0;
  let removedCount = 0;
  const removed = () => removedCount++;
  a.once('page', () => onceCount++);
  a.on('page', removed);
  a.off('page', removed);
  await a.newPage();
  await a.newPage();
  assert.equal(onceCount, 1);
  assert.equal(removedCount, 0);
});

test('closing through a view never closes the shared login, other context calls pass through', async () => {
  const { browser, launches } = pool();
  const a = await browser.view('thread-a').prepare();
  await a.close();
  assert.equal(launches[0].closed, false);
  await a.clearCookies();
  assert.equal(launches[0].cookiesCleared, true, 'non-overridden methods reach the real context');
});

test('closeThread closes that thread and unowned pages only', async () => {
  const { browser, launches } = pool();
  const a = await browser.view('thread-a').prepare();
  const b = await browser.view('thread-b').prepare();
  launches[0].popup(null);
  await settle();

  assert.equal(await browser.closeThread('thread-a'), 2, 'thread-a page plus the unowned popup');
  assert.equal(a.pages().length, 0);
  assert.equal(b.pages().length, 1);
  assert.equal(await browser.ownedPageCount(), 1);
});

test('a closed browser relaunches on the next session', async () => {
  const { browser, launches } = pool();
  await browser.view('thread-a').prepare();
  await browser.close();
  assert.equal(browser.isRunning(), false);
  await browser.view('thread-a').prepare();
  assert.equal(launches.length, 2);
});

test('a disposed view returns the shared context and browser to their listener baseline', async () => {
  const { browser, launches } = pool();
  await browser.view('thread-a').prepare(); // first launch registers the pool's own listeners
  const context = launches[0];
  const baseline = {
    close: context.listenerCount('close'),
    disconnected: context.fakeBrowser.listenerCount('disconnected'),
  };
  for (let i = 0; i < 4; i++) {
    const view = browser.view('thread-a');
    const real = await view.prepare();
    // What upstream BrowserBackend does for every session.
    real.once('close', () => {});
    real.browser()?.once('disconnected', () => {});
    real.on('page', () => {});
    view.dispose();
  }
  assert.equal(context.listenerCount('close'), baseline.close);
  assert.equal(context.fakeBrowser.listenerCount('disconnected'), baseline.disconnected);
});

test('a thread cannot open more than the tab limit', async () => {
  const { browser } = pool();
  const view = await browser.view('thread-a').prepare();
  for (let i = 1; i < MAX_PAGES_PER_THREAD; i++) await view.newPage();
  await assert.rejects(view.newPage(), /already has 20 tabs/);
  const other = await browser.view('thread-b').prepare();
  assert.equal(other.pages().length, 1, 'another thread is not blocked by this one');
});

test('isolated contexts and popups count against the same hard tab limit (R2 P1-2)', async () => {
  const { browser, launches } = pool();
  const view = await browser.view('thread-a').prepare(); // 1 tab
  const announced = [];
  view.on('page', (page) => announced.push(page));
  const isolated = await view.browser().newContext();
  const opened = [];
  for (let i = 1; i < MAX_PAGES_PER_THREAD; i++) opened.push(await isolated.newPage()); // 20 tabs in total
  await settle();
  assert.equal(opened.filter((page) => page.isClosed()).length, 0, 'the tabs within the limit all stay open');
  await assert.rejects(isolated.newPage(), /already has 20 tabs/, 'isolated context is counted');
  await assert.rejects(view.newPage(), /already has 20 tabs/, 'and so is the default context');
  const popup = launches[0].popup(view.pages()[0]);
  await settle();
  assert.equal(popup.isClosed(), true, 'a popup beyond the limit is closed, not left uncounted');
  assert.deepEqual(
    announced,
    [],
    'isolated tabs reach upstream once, through their own context, never as default tabs',
  );
  assert.deepEqual(view.pages().length, 1, 'and they are not listed among the thread default pages');
});

test('a popup inside an isolated context is counted, and closed once the thread is full (R2 P1-2)', async () => {
  const { browser, launches } = pool();
  const view = await browser.view('thread-a').prepare(); // 1 tab
  const isolated = await view.browser().newContext();
  const realIsolated = launches[0].fakeBrowser.isolated[0];
  const first = await isolated.newPage(); // 2 tabs
  for (let i = 2; i < MAX_PAGES_PER_THREAD - 1; i++) await isolated.newPage(); // 19 tabs
  const within = realIsolated.popup(first); // 20 tabs
  await settle();
  assert.equal(within.isClosed(), false, 'the popup within the limit stays open');
  await assert.rejects(isolated.newPage(), /already has 20 tabs/, 'and it took the last slot');
  const beyond = realIsolated.popup(first);
  await settle();
  assert.equal(beyond.isClosed(), true, 'a popup beyond the limit is closed');
});

test('a page that is already closed when it is counted does not hold a slot', async () => {
  const { browser, launches } = pool();
  const view = await browser.view('thread-a').prepare(); // 1 tab
  const real = launches[0];
  const original = real.newPage.bind(real);
  real.newPage = async () => {
    const page = await original();
    await page.close(); // e.g. the page crashed or called window.close() before newPage returned
    return page;
  };
  await view.newPage();
  real.newPage = original;
  for (let i = 1; i < MAX_PAGES_PER_THREAD; i++) await view.newPage();
  await assert.rejects(view.newPage(), /already has 20 tabs/);
});

test('concurrent opens cannot overshoot the limit', async () => {
  const { browser } = pool();
  const view = await browser.view('thread-a').prepare();
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => view.newPage()));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, MAX_PAGES_PER_THREAD - 1);
  assert.equal(view.pages().length, MAX_PAGES_PER_THREAD);
});
