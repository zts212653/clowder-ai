import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { loadChromium } from '../../../scripts/f317-page-action/browser-binary.mjs';
import { startFixtureServer } from '../../../scripts/f317-page-action/serve.mjs';
import { fixture, scope, startedActionCall } from './helpers/f317-page-action-fixture.ts';

const compiled = process.env.F317_TEST_COMPILED_ACTOR === '1';
const actionPath = compiled ? '../dist/domains/concierge/action/' : '../src/domains/concierge/action/';
const hostPath = compiled ? '../dist/domains/concierge/live/host/' : '../src/domains/concierge/live/host/';
const extension = compiled ? '.js' : '.ts';
const { createHostLaunchedLocalNoteConnector } = await import(`${actionPath}LocalNoteTrialConnector${extension}`);
const { createCdpPageActionPort } = await import(`${actionPath}CdpPageActionPort${extension}`);
const { createOwnerLocalNoteProfile } = await import(`${hostPath}owner-local-note-profile${extension}`);
const { OwnerPageActionService } = await import(`${hostPath}owner-page-action-service${extension}`);

let browser;
before(async () => {
  const chromium = await loadChromium();
  browser = await puppeteer.launch({ headless: true, executablePath: chromium.executablePath() });
});
after(async () => browser?.close());

async function startedFixture(t) {
  const started = await startFixtureServer();
  t.after(async () => new Promise((resolve) => started.server.close(resolve)));
  return started;
}

test('Host-launched connector opens only the exact fixture in a disposable browser context', async (t) => {
  const started = await startedFixture(t);
  const profile = createOwnerLocalNoteProfile(started.url);
  const connector = createHostLaunchedLocalNoteConnector(started, browser);
  const originalContexts = browser.browserContexts().length;
  const handle = await connector.open(profile, new AbortController().signal);
  assert.equal(browser.browserContexts().length, originalContexts + 1);
  const port = createCdpPageActionPort(handle.page, profile.spec);
  try {
    const snapshot = await port.inspect();
    assert.equal(snapshot.url, started.url);
    assert.equal(snapshot.readback, JSON.stringify({ open: false, note: '', deleted: false }));
    assert.deepEqual(
      snapshot.candidates.map(({ id, operation, label }) => ({ id, operation, label })),
      [{ id: 'note', operation: 'fill', label: 'Note text' }],
    );
  } finally {
    await port.close();
    await handle.close();
    await handle.close();
  }
  assert.equal(handle.page.isClosed(), true);
  assert.equal(browser.browserContexts().length, originalContexts);
});

test('Host connector refuses a changed profile, an aborted action and a stopped fixture', async (t) => {
  const started = await startedFixture(t);
  const profile = createOwnerLocalNoteProfile(started.url);
  const connector = createHostLaunchedLocalNoteConnector(started, browser);
  const originalContexts = browser.browserContexts().length;
  await assert.rejects(connector.open({ ...profile, url: 'http://127.0.0.1:5227/' }, new AbortController().signal));
  await assert.rejects(
    connector.open(
      {
        ...profile,
        spec: { ...profile.spec, targets: [{ id: 'delete-note', selector: '#delete-note', operation: 'click' }] },
      },
      new AbortController().signal,
    ),
  );
  assert.throws(() => createHostLaunchedLocalNoteConnector({ ...started, url: 'http://127.0.0.1:5227/' }, browser));
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(connector.open(profile, stopped.signal));
  await new Promise((resolve) => started.server.close(resolve));
  await assert.rejects(connector.open(profile, new AbortController().signal));
  assert.equal(browser.browserContexts().length, originalContexts);
});

test('the A owner entry consumes the Host-owned connector through consent, actual readback and restoration', async (t) => {
  const started = await startedFixture(t);
  const profile = createOwnerLocalNoteProfile(started.url);
  const connector = createHostLaunchedLocalNoteConnector(started, browser);
  const f = fixture();
  const { call, approvalLedger } = await startedActionCall(f);
  const service = new OwnerPageActionService({
    ownerUserId: scope.userId,
    sessions: {
      async observeCall(userId) {
        return userId === scope.userId ? call.boundaryContexts.observeCall() : null;
      },
    },
    messages: f.store,
    profile,
    connector,
  });
  service.bindCall(call, approvalLedger);
  t.after(async () => {
    await call.stop();
    await service.close();
  });
  const originalContexts = browser.browserContexts().length;
  const consent = await service.inspect(f.source.id);
  assert.equal(consent.pageUrl, started.url);
  assert.equal(consent.value, 'F317 local trial');
  assert.equal(browser.browserContexts().length, originalContexts + 1);
  const outcome = await service.confirm(consent.previewId);
  assert.equal(outcome.status, 'restored', JSON.stringify(outcome));
  assert.equal(outcome.forward.after, JSON.stringify({ open: false, note: 'F317 local trial', deleted: false }));
  assert.equal(outcome.rollback?.after, JSON.stringify({ open: false, note: '', deleted: false }));
  assert.equal(browser.browserContexts().length, originalContexts);
  await assert.rejects(service.confirm(consent.previewId), /unavailable/);
});

test('owner cancellation releases the disposable browser context before any page effect', async (t) => {
  const started = await startedFixture(t);
  const profile = createOwnerLocalNoteProfile(started.url);
  const f = fixture();
  const { call, approvalLedger } = await startedActionCall(f);
  const service = new OwnerPageActionService({
    ownerUserId: scope.userId,
    sessions: {
      async observeCall(userId) {
        return userId === scope.userId ? call.boundaryContexts.observeCall() : null;
      },
    },
    messages: f.store,
    profile,
    connector: createHostLaunchedLocalNoteConnector(started, browser),
  });
  service.bindCall(call, approvalLedger);
  t.after(async () => {
    await call.stop();
    await service.close();
  });
  const originalContexts = browser.browserContexts().length;
  const consent = await service.inspect(f.source.id);
  assert.equal(browser.browserContexts().length, originalContexts + 1);
  service.cancel(consent.previewId);
  await assert.rejects(service.confirm(consent.previewId), /unavailable/);
  const deadline = Date.now() + 1_500;
  while (browser.browserContexts().length !== originalContexts && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(browser.browserContexts().length, originalContexts);
});
