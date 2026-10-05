import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import puppeteer from 'puppeteer-core';
import { loadChromium } from '../../../scripts/f317-page-action/browser-binary.mjs';
import { startFixtureServer } from '../../../scripts/f317-page-action/serve.mjs';
import { maybeStartOwnerLocalNoteLab } from '../src/domains/concierge/live/host/owner-local-note-lab.ts';
import { createOwnerLocalNoteProfile } from '../src/domains/concierge/live/host/owner-local-note-profile.ts';
import { OwnerPageActionService } from '../src/domains/concierge/live/host/owner-page-action-service.ts';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.ts';
import { f317PageActionRoutes } from '../src/routes/f317-page-action.ts';
import { fixture, scope, startedActionCall } from './helpers/f317-page-action-fixture.ts';

let browser;
let server;
let url;
const originalOwnerId = process.env.DEFAULT_OWNER_USER_ID;
before(async () => {
  process.env.DEFAULT_OWNER_USER_ID = scope.userId;
  ({ server, url } = await startFixtureServer());
  const chromium = await loadChromium();
  browser = await puppeteer.launch({ headless: true, executablePath: chromium.executablePath() });
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  if (originalOwnerId === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = originalOwnerId;
});

const empty = JSON.stringify({ open: false, note: '', deleted: false });
const filled = JSON.stringify({ open: false, note: 'F317 local trial', deleted: false });

async function episode(t, options = {}) {
  const page = await browser.newPage();
  await page.goto(url);
  const f = fixture();
  const { call, approvalLedger } = await startedActionCall(f);
  const sessions = {
    async observeCall(userId) {
      return userId === scope.userId ? call.boundaryContexts.observeCall() : null;
    },
  };
  const namedProfile = createOwnerLocalNoteProfile(url);
  const service = new OwnerPageActionService(
    {
      ownerUserId: scope.userId,
      sessions,
      messages: f.store,
      profile: options.profile?.(namedProfile) ?? namedProfile,
      connector: options.connector?.(page) ?? {
        async open() {
          return { page, async close() {} };
        },
      },
    },
    options.timing,
  );
  service.bindCall(call, approvalLedger);
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: scope.userId });
  await app.register(f317PageActionRoutes, { ownerUserId: scope.userId, service });
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost:3011' };
  t.after(async () => {
    await call.stop();
    await app.close();
    await service.close();
    await page.close();
  });
  return { f, call, page, service, app, headers, approvalLedger };
}

test('isolated Host lab connects owner HTTP consent to a Host-owned browser and restores the note', async (t) => {
  const lab = await maybeStartOwnerLocalNoteLab(
    {
      enabled: true,
      projectRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      apiPort: 3202,
      apiHost: '127.0.0.1',
      memoryStore: true,
      nodeEnv: 'test',
    },
    10_000,
  );
  assert.ok(lab);
  const { f, app, headers } = await episode(t, {
    profile: () => lab.profile,
    connector: () => lab.connector,
  });
  t.after(() => lab.close());
  const route = '/api/concierge/page-action';
  const view = await app.inject({ method: 'GET', url: route, headers });
  assert.equal(view.statusCode, 200, view.body);
  assert.equal(view.json().requestMessageId, f.source.id);

  const inspect = await app.inject({
    method: 'POST',
    url: `${route}/inspect`,
    headers,
    payload: { requestMessageId: f.source.id },
  });
  assert.equal(inspect.statusCode, 200, inspect.body);
  const preview = inspect.json().preview;
  assert.equal(preview.pageUrl, lab.url);
  assert.equal(preview.value, 'F317 local trial');
  assert.equal(preview.expectedReadback, filled);

  const cancel = await app.inject({
    method: 'DELETE',
    url: route,
    headers,
    payload: { previewId: preview.previewId },
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  const denied = await app.inject({
    method: 'POST',
    url: `${route}/confirm`,
    headers,
    payload: { previewId: preview.previewId },
  });
  assert.equal(denied.statusCode, 409, denied.body);

  const secondInspect = await app.inject({
    method: 'POST',
    url: `${route}/inspect`,
    headers,
    payload: { requestMessageId: f.source.id },
  });
  assert.equal(secondInspect.statusCode, 200, secondInspect.body);
  const confirm = await app.inject({
    method: 'POST',
    url: `${route}/confirm`,
    headers,
    payload: { previewId: secondInspect.json().preview.previewId },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  assert.equal(confirm.json().forward.status, 'applied');
  assert.equal(confirm.json().rollback?.status, 'applied');
  assert.equal(confirm.json().status, 'restored');
});

test('explicit owner consent uses one direct source, verifies the page effect, and restores with a fresh actor', async (t) => {
  const { f, page, app, headers } = await episode(t);
  const route = '/api/concierge/page-action';
  const viewResponse = await app.inject({ method: 'GET', url: route, headers });
  assert.equal(viewResponse.statusCode, 200, viewResponse.body);
  const view = viewResponse.json();
  assert.equal(view.kind, 'available');
  assert.equal(view.requestMessageId, f.source.id);
  const inspect = await app.inject({
    method: 'POST',
    url: `${route}/inspect`,
    headers,
    payload: { requestMessageId: f.source.id },
  });
  assert.equal(inspect.statusCode, 200, inspect.body);
  const preview = inspect.json().preview;
  assert.equal(preview.pageUrl, url);
  assert.equal(preview.value, 'F317 local trial');
  assert.equal(preview.expectedReadback, filled);
  assert.equal(preview.restoreValue, '');
  assert.equal(await page.$eval('#readback', (element) => element.textContent), empty);
  const confirm = await app.inject({
    method: 'POST',
    url: `${route}/confirm`,
    headers,
    payload: { previewId: preview.previewId },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const outcome = confirm.json();
  assert.equal(outcome.forward.status, 'applied');
  assert.equal(outcome.rollback?.status, 'applied');
  assert.equal(outcome.status, 'restored', JSON.stringify(outcome));
  assert.equal(await page.$eval('#readback', (element) => element.textContent), empty);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `${route}/confirm`,
        headers,
        payload: { previewId: preview.previewId },
      })
    ).statusCode,
    409,
  );
  const next = f.store.appendIdempotent({
    userId: scope.userId,
    threadId: scope.threadId,
    catId: null,
    content: '新的独立请求',
    mentions: [],
    timestamp: Date.now(),
    idempotencyKey: 'owner-request-after-restoration',
  }).message;
  const nextView = (await app.inject({ method: 'GET', url: route, headers })).json();
  assert.equal(nextView.requestMessageId, next.id);
  assert.equal(nextView.state, 'ready');
  assert.equal(nextView.result, undefined);
});

test('cancel consumes the preview and a later owner correction cannot authorize its old source', async (t) => {
  const { f, page, service } = await episode(t);
  const preview = await service.inspect(f.source.id);
  service.cancel(preview.previewId);
  await assert.rejects(service.confirm(preview.previewId), /unavailable/);
  f.store.appendIdempotent({
    userId: scope.userId,
    threadId: scope.threadId,
    catId: null,
    content: 'I changed my mind',
    mentions: [],
    timestamp: Date.now(),
    idempotencyKey: 'owner-changed-trial',
  });
  await assert.rejects(service.inspect(f.source.id), /Direct owner request unavailable/);
  assert.equal(await page.$eval('#readback', (element) => element.textContent), empty);
});

test('owner revoke at the real browser commit fence prevents the page effect', async (t) => {
  const { f, page, service } = await episode(t);
  let previewId;
  let reachedCommit = false;
  const createSession = page.createCDPSession.bind(page);
  page.createCDPSession = async () => {
    const session = await createSession();
    session.on('Runtime.bindingCalled', () => {
      reachedCommit = true;
      service.cancel(previewId);
    });
    return session;
  };
  const preview = await service.inspect(f.source.id);
  previewId = preview.previewId;
  const outcome = await service.confirm(preview.previewId);
  assert.equal(reachedCommit, true);
  assert.notEqual(outcome.status, 'restored');
  assert.equal(await page.$eval('#readback', (element) => element.textContent), empty);
});

for (const mismatch of ['field', 'value']) {
  test(`consent ${mismatch} must match the action before a preview exists`, async (t) => {
    const { f, page, service, approvalLedger } = await episode(t, {
      profile: (named) => ({
        ...named,
        prepare(snapshot) {
          const plan = named.prepare(snapshot);
          return {
            ...plan,
            consent: { ...plan.consent, [mismatch]: `Different ${mismatch}` },
          };
        },
      }),
    });
    let issued = 0;
    const issue = approvalLedger.issue.bind(approvalLedger);
    approvalLedger.issue = (record) => {
      issued++;
      return issue(record);
    };
    await assert.rejects(service.inspect(f.source.id), /Named page changed/);
    assert.equal(issued, 0);
    assert.equal(await page.$eval('#readback', (element) => element.textContent), empty);
  });
}

for (const mismatch of ['value', 'expectedReadback']) {
  test(`rollback ${mismatch} must match disclosed restoration before ledger issue`, async (t) => {
    const { f, page, service, approvalLedger } = await episode(t, {
      profile: (named) => ({
        ...named,
        rollback(plan, result, snapshot) {
          const action = named.rollback(plan, result, snapshot);
          return { ...action, [mismatch]: `Different ${mismatch}` };
        },
      }),
    });
    let issued = 0;
    const issue = approvalLedger.issue.bind(approvalLedger);
    approvalLedger.issue = (record) => {
      issued++;
      return issue(record);
    };
    const preview = await service.inspect(f.source.id);
    const outcome = await service.confirm(preview.previewId);
    assert.equal(outcome.status, 'unknown');
    assert.equal(outcome.forward.status, 'applied');
    assert.equal(issued, 1, 'only the disclosed forward action may receive a ledger approval');
    assert.equal(await page.$eval('#readback', (element) => element.textContent), filled);
  });
}

test('preview expires and closes its page without another owner request', async (t) => {
  let closes = 0;
  const { f, service } = await episode(t, {
    timing: { previewMs: 30 },
    connector: (page) => ({
      async open() {
        return {
          page,
          async close() {
            closes++;
          },
        };
      },
    }),
  });
  const preview = await service.inspect(f.source.id);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(closes, 1, 'expiry must actively release the Host-selected page');
  await assert.rejects(service.confirm(preview.previewId), /unavailable/);
});

test('inspect interruption settles despite a hung page close and leaves no preview', async (t) => {
  let entered;
  const inspecting = new Promise((resolve) => {
    entered = resolve;
  });
  const { f, call, service } = await episode(t, {
    connector: () => ({
      async open() {
        return {
          page: {
            createCDPSession() {
              entered();
              return new Promise(() => {});
            },
          },
          close() {
            return new Promise(() => {});
          },
        };
      },
    }),
  });
  const pending = service.inspect(f.source.id);
  await inspecting;
  await call.stop();
  const settled = await Promise.race([
    pending.then(
      () => 'unexpected-preview',
      () => 'rejected',
    ),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 1_600)),
  ]);
  assert.equal(settled, 'rejected');
  assert.equal((await service.view()).kind, 'unavailable');
});
