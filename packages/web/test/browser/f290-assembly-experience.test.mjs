import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, startNext, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';

test(
  'F290 assembly candidate grows a user sentinel into an explicit attention state and restores it after refresh',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'f290-assembly-browser-'));
    const port = await availablePort();
    const serviceUrl = `http://127.0.0.1:${port}`;
    const opened = await CollectiveServiceStore.open({
      dataDirectory: directory,
      humanAuthProvider: { id: 'github', readiness: { ready: false } },
    });
    const service = await startCollectiveServer({ store: opened.store, host: '127.0.0.1', port });
    const browser = await chromium.launch({ headless: true });
    const sentinel = 'F290_ASSEMBLY_SENTINEL';

    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      const clientRequests = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (
          url.origin === serviceUrl &&
          ['/api/session', '/api/me', '/api/events/human', '/api/participants'].includes(url.pathname)
        )
          clientRequests.push(url.pathname);
      });
      await page.goto(`${serviceUrl}/?experienceGate=f290-assembly`, { waitUntil: 'networkidle' });
      await page.getByTestId('f290-assembly-experience').waitFor();
      assert.deepEqual(
        clientRequests,
        [],
        'the F290 candidate must not start the ordinary Client session/polling path',
      );
      await page.getByLabel('消息期待').selectOption('request');
      await page.getByLabel('在 # 产品方向 里说点什么').fill(sentinel);
      await page.getByRole('button', { name: '发送到 # 产品方向', exact: true }).click();
      await page.getByText(sentinel, { exact: true }).waitFor();
      await page.getByText('已送达 · 尚未接住', { exact: true }).waitFor();
      assert.equal(
        await page
          .locator('.f290-message', { hasText: sentinel })
          .getByRole('button', { name: '砚砚回应', exact: true })
          .count(),
        0,
        'an unmentioned request must not silently assign a named responder',
      );

      await page.getByLabel('消息期待').selectOption('expression');
      await page.getByLabel('在 # 产品方向 里说点什么').fill('F290_EXPRESSION_SENTINEL');
      await page.getByRole('button', { name: '发送到 # 产品方向', exact: true }).click();
      await page.getByText('表达已送达 · 允许安静', { exact: true }).waitFor();
      await page.getByLabel('消息期待').selectOption('unspecified');
      await page.getByLabel('在 # 产品方向 里说点什么').fill('F290_UNSPECIFIED_SENTINEL');
      await page.getByRole('button', { name: '发送到 # 产品方向', exact: true }).click();
      await page.getByText('期待尚未说明 · 不会按关键词静默丢弃', { exact: true }).waitFor();
      await page.getByLabel('消息期待').selectOption('request');
      await page.getByLabel('在 # 产品方向 里说点什么').fill('@砚砚 F290_MENTION_SENTINEL');
      await page.getByRole('button', { name: '发送到 # 产品方向', exact: true }).click();
      await page.getByText('recipient: 砚砚 · location: 当前频道', { exact: true }).waitFor();

      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText(sentinel, { exact: true }).waitFor();
      await page.getByRole('button', { name: /社区协作/u }).click();
      assert.equal(await page.getByText(sentinel, { exact: true }).count(), 0);
      await page.getByRole('button', { name: /产品方向/u }).click();
      await page.getByText(sentinel, { exact: true }).waitFor();
      assert.equal(
        await page
          .locator('.f290-message', { hasText: sentinel })
          .getByRole('button', { name: '砚砚回应', exact: true })
          .count(),
        0,
        'refresh and channel navigation must preserve the unclaimed request',
      );
      await page
        .locator('.f290-message', { hasText: 'F290_MENTION_SENTINEL' })
        .getByRole('button', { name: '砚砚回应', exact: true })
        .click();
      await page.getByText('砚砚已在原处具名回应', { exact: true }).waitFor();

      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'narrow candidate must not overflow horizontally',
      );
      await page.getByRole('button', { name: '撤回体验参与', exact: true }).click();
      await page.getByText('参与已撤回；网络恢复不会让旧路由复活', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '发送到 # 产品方向', exact: true }).isDisabled(), true);
    } finally {
      await browser.close();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('F290 compact styling leaves the default canonical Client navigation visible', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'f290-default-shell-browser-'));
  const port = await availablePort();
  const serviceUrl = `http://127.0.0.1:${port}`;
  const opened = await CollectiveServiceStore.open({
    dataDirectory: directory,
    humanAuthProvider: { id: 'github', readiness: { ready: false } },
  });
  const service = await startCollectiveServer({ store: opened.store, host: '127.0.0.1', port });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${serviceUrl}/`, { waitUntil: 'networkidle' });
    const destinationPane = page.locator('.destination-pane');
    await destinationPane.waitFor();
    assert.notEqual(await destinationPane.evaluate((element) => getComputedStyle(element).display), 'none');
  } finally {
    await browser.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'F290 embedded candidate gives private Work to the Host and returns only a public reference to the canonical Client',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'f290-assembly-host-browser-'));
    const servicePort = await availablePort();
    const hostPort = await availablePort();
    const serviceUrl = `http://127.0.0.1:${servicePort}`;
    const hostUrl = `http://127.0.0.1:${hostPort}`;
    const opened = await CollectiveServiceStore.open({
      dataDirectory: directory,
      humanAuthProvider: { id: 'github', readiness: { ready: false } },
    });
    const service = await startCollectiveServer({
      store: opened.store,
      host: '127.0.0.1',
      port: servicePort,
      allowedHostOrigins: [hostUrl],
    });
    const next = startNext(hostPort);
    const browser = await chromium.launch({ headless: true });

    try {
      await waitForHttp(`${hostUrl}/collective`, next);
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === serviceUrl) return route.continue();
        if (url.pathname === '/api/session') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
          return;
        }
        if (url.pathname === '/api/plugins/collective-connector') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              runtimeStatus: 'active',
              connections: [
                {
                  serviceUrl,
                  canonicalClientAnchor: {
                    kind: 'collective-client',
                    serviceUrl,
                    clientBuildId: 'collective-client-v2',
                    serviceInstanceId: opened.store.serviceInstanceId,
                    collectiveId: 'col_f290_assembly_candidate',
                    connectionId: 'con_f290_assembly_candidate',
                  },
                  serviceInstanceId: opened.store.serviceInstanceId,
                  collectiveId: 'col_f290_assembly_candidate',
                  connectionId: 'con_f290_assembly_candidate',
                  endpointId: 'ep_f290_assembly_candidate',
                  endpointLabel: 'You 的 Clowder AI',
                  authorityStatus: 'connected',
                  liveStatus: 'online',
                  lastAckedSequence: 0,
                  outbox: { queued: 0, accepted: 0 },
                  route: { configured: true },
                  inbox: { persisted: 0, pending: 0, routed: 0, failed: 0 },
                },
              ],
            }),
          });
          return;
        }
        await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      });

      await page.goto(`${hostUrl}/collective?experienceGate=f290-assembly`, { waitUntil: 'networkidle' });
      await page.getByTestId('collective-launch-surface').waitFor();
      const frame = page
        .frames()
        .find(
          (candidate) =>
            candidate.url().startsWith(`${serviceUrl}/?`) && candidate.url().includes('experienceGate=f290-assembly'),
        );
      assert.ok(frame, 'Host must mount the same canonical Client candidate in its iframe');
      await frame.getByTestId('f290-assembly-experience').waitFor();
      await page.evaluate(() => window.postMessage({ type: 'collective:f290-experience-open-cafe' }, location.origin));
      assert.equal(await page.getByTestId('f290-host-cafe-panel').count(), 0, 'Host ignores a non-iframe message');

      await frame.getByRole('button', { name: '打开我的 Café', exact: true }).click();
      await page.getByTestId('f290-host-cafe-panel').waitFor();
      await page.getByText('Host 私密渲染：这里没有把私人对话、Thread ID 或凭据交给 Collective Client。').waitFor();
      await page.locator('[data-work-ref="work_demo_product-brief"]').click();
      await page.getByRole('button', { name: '将公开结果带回原 Channel', exact: true }).click();
      await frame.getByText('共同空间首页 已从我的 Café 回到这里', { exact: true }).waitFor();
      assert.equal(await frame.getByText('Host 私密渲染', { exact: false }).count(), 0);
      assert.equal(
        await page.getByTestId('f290-host-cafe-panel').count(),
        0,
        'result return closes the private Host panel',
      );

      await frame.getByRole('button', { name: '撤回体验参与', exact: true }).click();
      await frame.getByText('参与已撤回；网络恢复不会让旧路由复活', { exact: true }).waitFor();
      assert.equal(await frame.getByRole('button', { name: '打开我的 Café', exact: true }).isDisabled(), true);
      const workActions = frame.locator('.f290-context-panel [data-work-ref]');
      assert.equal(await workActions.count(), 2);
      for (let index = 0; index < (await workActions.count()); index += 1)
        assert.equal(await workActions.nth(index).isDisabled(), true);

      const resultCountBefore = await frame.locator('.f290-message[data-work-ref="work_demo_product-brief"]').count();
      await page
        .locator('iframe[title="Collective"]')
        .evaluate(
          (iframe, targetOrigin) =>
            iframe.contentWindow?.postMessage(
              { type: 'collective:f290-experience-result-ready', workRef: 'work_demo_product-brief' },
              targetOrigin,
            ),
          serviceUrl,
        );
      await page.waitForTimeout(50);
      assert.equal(
        await frame.locator('.f290-message[data-work-ref="work_demo_product-brief"]').count(),
        resultCountBefore,
        'a revoked Client ignores late Host results',
      );
    } finally {
      await browser.close();
      await stopChild(next);
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
