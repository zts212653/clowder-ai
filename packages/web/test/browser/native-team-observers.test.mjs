import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { assertLivePageHealthy, observePageFaults } from './native-team-observers.mjs';

test('only a proven retired document cancellation is exempt; raw evidence remains', () => {
  const record = {
    pageErrors: [],
    dialogs: [],
    consoleErrors: [],
    documentTransitions: [{ frameId: 'frame', previous: 'old', current: 'new' }],
    networkErrors: [
      {
        frameId: 'frame',
        activeDocumentAtFailure: 'new',
        failure: 'net::ERR_ABORTED',
        canceled: true,
        document: 'old',
        path: '/slow',
      },
    ],
  };
  assertLivePageHealthy(record);
  assert.equal(record.expectedDocumentCancellations.length, 1);
  assert.equal(record.networkErrors.length, 1);
  for (const error of [
    { failure: 'net::ERR_ABORTED', canceled: true, document: 'new' },
    { failure: 'net::ERR_ABORTED', canceled: true },
    { failure: 'net::ERR_CONNECTION_RESET', document: 'old' },
    { status: 503, document: 'old' },
  ])
    assert.throws(() => assertLivePageHealthy({ ...record, networkErrors: [error] }), /Unexpected renderer faults/);
});

test('Chromium reports a canceled old document with its exact loader identity', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<main>observer</main>' }));
    await page.goto('http://observer.invalid/first');
    const record = { pageErrors: [], dialogs: [] };
    await observePageFaults(page, record);
    let started;
    const requested = new Promise((resolve) => {
      started = resolve;
    });
    await page.route('**/slow', () => {
      started();
      return new Promise(() => {});
    });
    await page.evaluate(() => {
      void fetch('/slow').catch(() => {});
    });
    await requested;
    await page.goto('http://observer.invalid/second');
    for (let i = 0; i < 100 && !record.networkErrors.length; i++) await page.waitForTimeout(20);
    assert.ok(record.networkErrors.some((error) => error.path === '/slow' && error.canceled));
    assertLivePageHealthy(record);
    assert.ok(record.expectedDocumentCancellations.some((error) => error.path === '/slow'));
  } finally {
    await browser.close();
  }
});

test('a cached document returning does not exempt its new current-page aborts', () => {
  const record = {
    pageErrors: [],
    dialogs: [],
    consoleErrors: [],
    documentTransitions: [
      { frameId: 'frame', previous: 'old', current: 'other' },
      { frameId: 'frame', previous: 'other', current: 'old' },
    ],
    networkErrors: [
      {
        frameId: 'frame',
        document: 'old',
        activeDocumentAtFailure: 'old',
        failure: 'net::ERR_ABORTED',
        canceled: true,
      },
    ],
  };
  assert.throws(() => assertLivePageHealthy(record), /Unexpected renderer faults/);
});

test('a request predating Network.enable is still diagnosed during the first observed document retirement', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<main>old</main>' }));
    await page.goto('http://early.invalid/old');
    let seen;
    const started = new Promise((resolve) => {
      seen = resolve;
    });
    await page.route('**/slow', () => {
      seen();
      return new Promise(() => {});
    });
    await page.evaluate(() => {
      void fetch('/slow').catch(() => {});
    });
    await started;
    const record = { pageErrors: [], dialogs: [] };
    const stop = await observePageFaults(page, record);
    await page.goto('http://early.invalid/new');
    for (let i = 0; i < 100 && !record.networkErrors.length; i++) await page.waitForTimeout(20);
    assert.ok(
      record.networkErrors.some((error) => !error.document),
      'Reproduce missing request start on late attachment',
    );
    assertLivePageHealthy(record);
    await stop();
  } finally {
    await browser.close();
  }
});

test('a pre-observer request canceled without document navigation remains a failure', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<main>current</main>' }));
    await page.goto('http://early.invalid/');
    let seen;
    const started = new Promise((resolve) => {
      seen = resolve;
    });
    await page.route('**/slow', () => {
      seen();
      return new Promise(() => {});
    });
    await page.evaluate(() => {
      window.oldController = new AbortController();
      void fetch('/slow', { signal: window.oldController.signal }).catch(() => {});
    });
    await started;
    const record = { pageErrors: [], dialogs: [] };
    const stop = await observePageFaults(page, record);
    await page.evaluate(() => window.oldController.abort());
    for (let i = 0; i < 100 && !record.networkErrors.length; i++) await page.waitForTimeout(20);
    assert.equal(record.callerCancellations.length, 0);
    assert.throws(() => assertLivePageHealthy(record), /Unexpected renderer faults/);
    await stop();
  } finally {
    await browser.close();
  }
});
