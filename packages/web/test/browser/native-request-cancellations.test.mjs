import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { callerCancellation, isPrefetch, verifiedRscCancellation } from './native-request-cancellations.mjs';
import { assertLivePageHealthy, observePageFaults } from './native-team-observers.mjs';

test('cancellation proof is specific to the request; resets, HTTP faults and ambiguity still fail', () => {
  const error = {
    method: 'POST',
    path: '/preview',
    startedAt: 1000,
    failedAt: 2000,
    canceled: true,
    failure: 'net::ERR_ABORTED',
  };
  const caller = { method: 'POST', path: '/preview', startedAt: 1001, failedAt: 1999 };
  assert.ok(callerCancellation(error, { callerCancellations: [caller] }));
  for (const changed of [{ path: '/other' }, { method: 'GET' }, { startedAt: 5000 }, { failedAt: 5000 }])
    assert.equal(callerCancellation(error, { callerCancellations: [{ ...caller, ...changed }] }), null);
  assert.equal(callerCancellation(error, { callerCancellations: [caller, caller] }), null);
  assert.equal(
    callerCancellation({ ...error, failure: 'net::ERR_CONNECTION_RESET' }, { callerCancellations: [caller] }),
    null,
  );
  assert.equal(callerCancellation({ status: 503, prefetch: true }, {}), null);
  assert.equal(isPrefetch({ RSC: '1' }), false);
  assert.equal(isPrefetch({ 'Next-Router-Prefetch': '1' }), true);
});

async function fixture(run) {
  const browser = await chromium.launch({ headless: true });
  let stop;
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<main>observer</main>' }));
    await page.goto('http://cancel.invalid/');
    const record = { pageErrors: [], dialogs: [] };
    const original = await page.evaluate(() => String(window.fetch));
    stop = await observePageFaults(page, record);
    await run(page, record);
    await stop();
    stop = null;
    assert.equal(
      await page.evaluate(() => String(window.fetch)),
      original,
      'Restore the original fetch implementation',
    );
  } finally {
    if (stop) await stop();
    await browser.close();
  }
}

test('actual browser caller abort is observed without changing request headers or returned response', async () => {
  await fixture(async (page, record) => {
    let signalRequest;
    const requested = new Promise((resolve) => {
      signalRequest = resolve;
    });
    await page.route('**/slow', (route) => {
      signalRequest(route.request());
      return new Promise(() => {});
    });
    await page.evaluate(() => {
      window.controller = new AbortController();
      window.result = fetch('/slow', {
        method: 'POST',
        headers: { 'X-Probe': 'same' },
        body: 'unchanged',
        signal: window.controller.signal,
      }).catch((error) => error.name);
    });
    const request = await requested;
    assert.equal(request.headers()['x-probe'], 'same');
    assert.equal(request.postData(), 'unchanged');
    await page.evaluate(() => window.controller.abort());
    assert.equal(await page.evaluate(() => window.result), 'AbortError');
    for (let i = 0; i < 100 && !record.networkErrors.length; i++) await page.waitForTimeout(20);
    assertLivePageHealthy(record);
    assert.equal(record.expectedCallerCancellations.length, 1);
    assert.equal(record.networkErrors.length, 1);
    assert.equal(await page.evaluate(() => fetch('/ok').then((response) => response.text())), '<main>observer</main>');
  });
});

test('the observer must not swallow an unhandled real fetch rejection', async () => {
  await fixture(async (page, record) => {
    await page.route('**/broken', (route) => route.abort('connectionreset'));
    await page.evaluate(() => {
      void fetch('/broken');
    });
    for (let i = 0; i < 100 && !record.pageErrors.length; i++) await page.waitForTimeout(20);
    assert.ok(record.pageErrors.length, 'A passive observer must preserve unhandled-rejection reporting');
    assert.equal(record.callerCancellations.length, 0);
    assert.throws(() => assertLivePageHealthy(record), /Unexpected renderer faults/);
  });
});

test('only fulfilled worker RSC cancellations with later visible route proof are expected', () => {
  const error = {
    path: '/settings',
    document: 'doc',
    frameId: 'frame',
    failedAt: 20,
    method: 'GET',
    canceled: true,
    failure: 'net::ERR_ABORTED',
    rsc: true,
    responseStatus: 200,
    mimeType: 'text/x-component',
    fromServiceWorker: true,
  };
  const route = { path: '/settings', document: 'doc', frameId: 'frame', verifiedAt: 21 };
  assert.ok(verifiedRscCancellation(error, { verifiedRoutes: [route] }));
  for (const change of [
    { responseStatus: 503 },
    { mimeType: 'text/html' },
    { rsc: false },
    { fromServiceWorker: false },
    { failure: 'net::ERR_CONNECTION_RESET' },
    { canceled: false },
    { method: 'POST' },
  ])
    assert.equal(verifiedRscCancellation({ ...error, ...change }, { verifiedRoutes: [route] }), false);
  for (const change of [{ verifiedAt: 19 }, { document: 'other' }, { frameId: 'other' }, { path: '/elsewhere' }])
    assert.equal(verifiedRscCancellation(error, { verifiedRoutes: [{ ...route, ...change }] }), false);
  assert.equal(verifiedRscCancellation(error, {}), false);
});
