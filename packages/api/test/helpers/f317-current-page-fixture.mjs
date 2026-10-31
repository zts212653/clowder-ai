import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import puppeteer from 'puppeteer-core';
import { loadChromium } from '../../../../scripts/f317-page-action/browser-binary.mjs';
import { createOwnerCurrentPageSource } from '../../src/domains/concierge/action/jev/OwnerCurrentPageSource.ts';
import { OwnerPageActionService } from '../../src/domains/concierge/live/host/owner-page-action-service.ts';
import { sessionAuthPlugin, sessionRoute } from '../../src/infrastructure/session-auth.ts';
import { f317LivePageActionRoutes } from '../../src/routes/f317-live-page-action.ts';
import { f317PageActionRoutes } from '../../src/routes/f317-page-action.ts';
import { appendUser, fixture, scope, startedActionCall } from './f317-page-action-fixture.ts';

export async function currentPageEpisode(t, select, requestText = '将清单改为「带伞」') {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // No IDs/selectors/readback hooks: these controls did not exist in operator configuration.
    res.end(
      '<title>临时工作页</title><input aria-label="清单" value="原值"><button onclick="this.textContent=\'已点击\'"><span>展开清单</span></button><input type="password" aria-label="密码" value="private"><input hidden aria-label="隐藏值"><div style="opacity:0"><input aria-label="透明值"></div><div inert><input aria-label="不可交互值"></div>' +
        '<button style="position:absolute;top:120px;left:20px;pointer-events:none">指针禁用</button><button style="position:absolute;top:160px;left:20px;width:100px;height:30px">被遮挡</button><div style="position:absolute;top:160px;left:20px;width:100px;height:30px;z-index:100">遮挡层</div>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const chromium = await loadChromium();
  const browser = await puppeteer.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    defaultViewport: null,
    args: ['--remote-debugging-port=0', '--window-size=1280,900'],
  });
  t.after(() => browser.close());
  const url = `http://127.0.0.1:${server.address().port}/unadapted`;
  const page = await browser.newPage(),
    other = await browser.newPage();
  await page.goto(url);
  await other.goto(url);
  await other.evaluate(() => {
    document.title = '另一同址页面';
  });
  const f = fixture();
  f.source = appendUser(f.store, requestText, 'current-page-owner');
  const { call, approvalLedger } = await startedActionCall(f);
  t.after(() => call.stop());
  const provider = {
    async select(input) {
      assert.equal(input.signal.aborted, false);
      assert.deepEqual(
        input.candidates.map((item) => item.label),
        ['清单', '展开清单'],
      );
      const target = input.candidates.find((item) => item.operation === 'fill');
      const choice = select
        ? await select(input)
        : { kind: 'act', targetId: target.id, operation: 'fill', value: '带伞' };
      return {
        choice,
        receipt: {
          requestId: crypto.randomUUID(),
          providerRequestId: null,
          requestedModel: 'jev-latest',
          servedModel: 'jev-1.13.0-stub',
          inputSha256: 'stub',
          candidates: input.candidates.map(({ id, label, operation }) => ({ id, label, operation })),
          choice,
          confidence: 1,
          elapsedMs: 0,
        },
      };
    },
  };
  const source = createOwnerCurrentPageSource(
    {
      mode: 'owner-selected',
      profileId: 'current-owner-browser',
      allowJevProjection: true,
      browserURL: `http://127.0.0.1:${new URL(browser.wsEndpoint()).port}/`,
    },
    provider,
  );
  let preparationError;
  const prepare = source.prepare.bind(source);
  source.prepare = async (...args) => {
    try {
      return await prepare(...args);
    } catch (error) {
      preparationError = error;
      throw error;
    }
  };
  const service = new OwnerPageActionService({
    ownerUserId: scope.userId,
    currentPages: source,
    messages: f.store,
    sessions: {
      async observeCall() {
        return call.boundaryContexts.observeCall();
      },
    },
    recordResult: async () => undefined,
  });
  service.bindCall(call, approvalLedger);
  t.after(() => service.close());
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = scope.userId;
  t.after(() => {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
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
  const callback = (action, headers = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/callbacks/page-action-${action}`,
      payload: {},
      headers: { 'x-invocation-id': scope.invocationId, 'x-callback-token': 'test-token', ...headers },
    });
  t.after(() => app.close());
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: 'http://localhost:3011' };
  const route = '/api/concierge/page-action';
  const post = (suffix, payload) => app.inject({ method: 'POST', url: `${route}/${suffix}`, headers, payload });
  const value = () => page.$eval('input[aria-label="清单"]', (node) => node.value);
  const list = async () => {
    const response = await post('pages', { requestMessageId: f.source.id });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().pages.find((item) => item.title === '临时工作页');
  };
  const choose = async () => {
    const response = await post('select', { requestMessageId: f.source.id, pageId: (await list()).pageId });
    assert.equal(
      response.statusCode,
      200,
      `${response.body}; preparation: ${preparationError?.stack || 'not entered'}`,
    );
    return response;
  };
  return { f, call, source, page, other, service, app, headers, post, list, choose, value, route, callback };
}
