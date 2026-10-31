import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import puppeteer from 'puppeteer-core';
import { loadChromium } from '../../../scripts/f317-page-action/browser-binary.mjs';
import { createConfiguredJevPageProfile } from '../src/domains/concierge/action/jev/ConfiguredJevPage.ts';
import { createJevPageSelector } from '../src/domains/concierge/action/jev/JevPageSelector.ts';
import { createOwnerCdpConnector } from '../src/domains/concierge/action/jev/OwnerCdpConnector.ts';
import { readConfiguredPageAction } from '../src/domains/concierge/action/jev/page-action-config.ts';
import { OwnerPageActionService } from '../src/domains/concierge/live/host/owner-page-action-service.ts';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.ts';
import { f317LivePageActionRoutes } from '../src/routes/f317-live-page-action.ts';
import { f317PageActionRoutes } from '../src/routes/f317-page-action.ts';
import { fixture, scope, startedActionCall } from './helpers/f317-page-action-fixture.ts';

let server, browser, page, config;
const originalOwner = process.env.DEFAULT_OWNER_USER_ID;
before(async () => {
  process.env.DEFAULT_OWNER_USER_ID = scope.userId;
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      '<input id="note" aria-label="今日便签"><button id="open">打开清单</button><output id="state">closed</output><script>document.querySelector("#open").onclick=()=>document.querySelector("#state").textContent="opened"</script>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chromium = await loadChromium();
  browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium.executablePath(),
    args: ['--remote-debugging-port=0'],
  });
  page = await browser.newPage();
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(url);
  const endpoint = new URL(browser.wsEndpoint());
  config = {
    profileId: 'owner-note',
    pageUrl: url,
    browserURL: `http://127.0.0.1:${endpoint.port}`,
    allowJevProjection: true,
    targets: [
      { id: 'note', selector: '#note', operation: 'fill', expectedReadbackTemplate: '{value}' },
      { id: 'open', selector: '#open', operation: 'click', expectedReadback: 'opened' },
    ],
    readback: { selector: '#note', kind: 'value' },
  };
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  if (originalOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = originalOwner;
});

async function episode(
  t,
  {
    target = 'C0',
    profilePatch = {},
    timing,
    beforeResponse,
    beforePersist,
    realProvider = false,
    utterance = '把今日便签填成「带伞」',
  } = {},
) {
  await page.reload();
  const f = fixture();
  const { call, approvalLedger } = await startedActionCall(f); // Native transport stub; never counted as real voice.
  const persisted = [];
  let providerCalls = 0;
  const realKeyFile = realProvider ? process.env.F317_VERIFIED_JEV_API_KEY_FILE : undefined;
  const provider = createJevPageSelector({
    apiKey: realKeyFile ? (await readFile(realKeyFile, 'utf8')).trim() : 'fixture-key',
    ...(realKeyFile
      ? {}
      : {
          fetch: async () => {
            providerCalls++;
            await beforeResponse?.(call);
            return new Response(
              JSON.stringify({
                model: 'jev-1.13.0',
                answers: {
                  target: { type: 'choice', choice: target, confidence: 0.99 },
                  value: { type: 'choice', choice: 'V0', confidence: 0.99 },
                },
              }),
            );
          },
        }),
  });
  let configured;
  if (realKeyFile) {
    const evidenceDir = process.env.F317_JEV_EVIDENCE_DIR;
    assert.ok(evidenceDir, 'real product verification must record its explicit configuration');
    await mkdir(evidenceDir, { recursive: true });
    const configFile = join(evidenceDir, `page-${target}.json`);
    await writeFile(configFile, JSON.stringify({ ...config, ...profilePatch }, null, 2));
    configured = await readConfiguredPageAction({
      CAT_CAFE_JEV_PAGE_CONFIG: configFile,
      TYPESAFE_API_KEY_FILE: realKeyFile,
    });
  }
  const profile = configured?.profile ?? createConfiguredJevPageProfile({ ...config, ...profilePatch }, provider);
  const service = new OwnerPageActionService(
    {
      ownerUserId: scope.userId,
      sessions: {
        async observeCall() {
          return call.boundaryContexts.observeCall();
        },
      },
      messages: f.store,
      profile,
      connector: configured?.connector ?? createOwnerCdpConnector({ ...config, ...profilePatch }),
      recordResult: async (input) => {
        persisted.push(input);
        await beforePersist?.(input);
      },
    },
    timing,
  );
  service.bindCall(call, approvalLedger);
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: scope.userId });
  await app.register(f317PageActionRoutes, { ownerUserId: scope.userId, service });
  await app.register(f317LivePageActionRoutes, {
    service,
    registry: {
      async verify(id, token) {
        if (token !== 'test-token') return { ok: false, reason: 'unknown_invocation' };
        return {
          ok: true,
          record: { invocationId: id, userId: scope.userId, threadId: scope.threadId, catId: scope.catId },
        };
      },
    },
  });
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const owner = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost:3011' };
  const live = { 'x-invocation-id': scope.invocationId, 'x-callback-token': 'test-token' };
  const delivery = await call.sendText(utterance, crypto.randomUUID());
  assert.equal(delivery.delivery, 'accepted');
  const inspect = () =>
    app.inject({ method: 'POST', url: '/api/callbacks/page-action-inspect', headers: live, payload: {} });
  const confirm = (preview) =>
    app.inject({
      method: 'POST',
      url: '/api/concierge/page-action/confirm',
      headers: owner,
      payload: { previewId: preview.previewId },
    });
  t.after(async () => {
    await call.stop();
    await app.close();
  });
  return { app, call, service, owner, live, inspect, confirm, persisted, providerCalls: () => providerCalls };
}

test('Live tool to real CDP to owner consent to persistent effect and same-call status', async (t) => {
  const e = await episode(t, { realProvider: true });
  const inspected = await e.inspect();
  assert.equal(inspected.statusCode, 200, inspected.body);
  const preview = inspected.json().preview;
  if (!preview) {
    const v = await e.service.view();
    try {
      await e.service.inspect(v.requestMessageId);
    } catch (error) {
      assert.fail(`Product inspect failed: ${error.message}; ${inspected.body}`);
    }
  }
  assert.equal(preview.value, '带伞');
  assert.equal(preview.selection.candidates.length, 2);
  assert.equal(await page.$eval('#note', (node) => node.value), '');
  const denied = await e.app.inject({
    method: 'POST',
    url: '/api/concierge/page-action/confirm',
    headers: e.live,
    payload: { previewId: preview.previewId },
  });
  assert.ok([401, 403].includes(denied.statusCode));
  const result = await e.confirm(preview);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().status, 'applied', result.body);
  assert.equal(result.json().forward.after, '带伞');
  assert.equal(result.json().rollback, undefined);
  assert.equal(await page.$eval('#note', (node) => node.value), '带伞');
  const status = await e.app.inject({
    method: 'POST',
    url: '/api/callbacks/page-action-status',
    headers: e.live,
    payload: {},
  });
  assert.equal(status.json().callId, scope.callId);
  assert.equal(status.json().result.status, 'applied');
  const originalRequestMessageId = status.json().requestMessageId;
  const query = await e.call.sendText('现在结果怎样？', crypto.randomUUID());
  const queried = await e.app.inject({
    method: 'POST',
    url: '/api/callbacks/page-action-status',
    headers: e.live,
    payload: {},
  });
  assert.equal(queried.json().requestMessageId, query.messageId);
  assert.equal(queried.json().result?.status, 'applied', 'a status question retains the completed read-only receipt');
  assert.equal(
    queried.json().resultRequestMessageId,
    originalRequestMessageId,
    'a prior result is never attributed to the new source',
  );
  assert.equal(queried.json().preview, undefined, 'a receipt grants no replay authority');
  assert.equal(await page.$eval('#note', (node) => node.value), '带伞');

  assert.equal(e.persisted.length, 2);
  assert.match(e.persisted[0].body, /jev-1.13.0/);
  assert.equal(result.json().receiptPersistence, 'stored');
  assert.equal((await e.confirm(preview)).statusCode, 409);
  if (process.env.F317_JEV_EVIDENCE_DIR)
    await writeFile(
      join(process.env.F317_JEV_EVIDENCE_DIR, 'fill-receipt.json'),
      JSON.stringify(
        {
          kind: 'real-product-provider-and-CDP-with-native-transport-stub',
          request: '把今日便签填成「带伞」',
          preview,
          result: result.json(),
          status: status.json(),
          persisted: e.persisted,
        },
        null,
        2,
      ),
    );
});

test('click uses current actual candidates and verifies its configured readback', async (t) => {
  const e = await episode(t, {
    target: 'C1',
    realProvider: true,
    utterance: '打开清单',
    profilePatch: { readback: { selector: '#state', kind: 'text' } },
  });
  const selected = await e.inspect();
  assert.equal(selected.json().preview.operation, 'click');
  const result = await e.confirm(selected.json().preview);
  assert.equal(result.json().status, 'applied', result.body);
  assert.equal(await page.$eval('#state', (node) => node.textContent), 'opened');
  if (process.env.F317_JEV_EVIDENCE_DIR)
    await writeFile(
      join(process.env.F317_JEV_EVIDENCE_DIR, 'click-receipt.json'),
      JSON.stringify(
        {
          kind: 'real-product-provider-and-CDP-with-native-transport-stub',
          request: '打开清单',
          preview: selected.json().preview,
          result: result.json(),
          persisted: e.persisted,
        },
        null,
        2,
      ),
    );
});

test('late persistence of an earlier action cannot replace the newer observed result', async (t) => {
  let release, reached;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const firstPersistence = new Promise((resolve) => {
    reached = resolve;
  });
  let receipts = 0;
  const e = await episode(t, {
    beforePersist: async (input) => {
      if (JSON.parse(input.body).kind !== 'host_page_action_receipt' || ++receipts !== 1) return;
      reached();
      await blocked;
    },
  });
  t.after(() => release());
  const first = (await e.inspect()).json().preview;
  const firstConfirmation = e.confirm(first);
  await firstPersistence;
  const pending = await e.service.view();
  assert.equal(pending.result.status, 'applied');
  assert.equal(pending.result.receiptPersistence, 'unconfirmed');
  const next = await e.call.sendText('改成「带电脑」', crypto.randomUUID());
  const second = (await e.inspect()).json().preview;
  assert.equal((await e.confirm(second)).json().status, 'applied');
  const newer = await e.service.view();
  release();
  assert.equal((await firstConfirmation).json().receiptPersistence, 'stored');
  const final = await e.service.view();
  assert.equal(final.resultRequestMessageId, next.messageId);
  assert.equal(final.result.forward.after, '带电脑');
  assert.equal(final.resultObservedAtMs, newer.resultObservedAtMs);
  assert.equal(await page.$eval('#note', (node) => node.value), '带电脑');
});

test('ASK/NONE publish selection truth but never enable owner execution', async (t) => {
  for (const target of ['ASK', 'NONE']) {
    await t.test(target, async (t) => {
      const e = await episode(t, { target });
      const result = await e.inspect();
      assert.equal(result.json().selectionNotice.kind, target === 'ASK' ? 'ask' : 'none');
      assert.equal(result.json().preview, undefined);
      assert.equal(await page.$eval('#note', (node) => node.value), '');
    });
  }
});

test('other invocation and model-supplied page, request or action are rejected before Jev', async (t) => {
  const e = await episode(t);
  for (const headers of [{}, { ...e.live, 'x-invocation-id': 'different-invocation' }]) {
    const r = await e.app.inject({ method: 'POST', url: '/api/callbacks/page-action-inspect', headers, payload: {} });
    assert.ok([401, 403].includes(r.statusCode));
  }
  const r = await e.app.inject({
    method: 'POST',
    url: '/api/callbacks/page-action-inspect',
    headers: e.live,
    payload: { url: config.pageUrl, requestMessageId: 'forged' },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(e.providerCalls(), 0);
});

test('cancel, changed owner request, stale DOM and expired consent leave the page untouched', async (t) => {
  for (const condition of ['cancel', 'change', 'stale', 'expire']) {
    await t.test(condition, async (t) => {
      const e = await episode(t, { timing: { previewMs: condition === 'expire' ? 80 : 60_000 } });
      const result = await e.inspect();
      const preview = result.json().preview;
      assert.ok(preview, result.body);
      if (condition === 'cancel') e.service.cancel(preview.previewId);
      if (condition === 'change') await e.call.sendText('改成「带水」', crypto.randomUUID());
      if (condition === 'stale')
        await page.$eval('#note', (node) => {
          node.replaceWith(node.cloneNode(true));
        });
      if (condition === 'expire') await new Promise((resolve) => setTimeout(resolve, 100));
      const confirmed = await e.confirm(preview);
      assert.notEqual(confirmed.json().status, 'applied');
      assert.equal(await page.$eval('#note', (node) => node.value), '');
    });
  }
});
