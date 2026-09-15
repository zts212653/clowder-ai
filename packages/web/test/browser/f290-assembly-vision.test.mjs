import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, startNext, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';

async function captureCandidate(page, name) {
  const directory = process.env.F290_BROWSER_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
}

test(
  'F290 candidate keeps membership, named reception, a new-context proposal, revocation, and narrow navigation actionable',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'f290-assembly-vision-direct-'));
    const port = await availablePort();
    const serviceUrl = `http://127.0.0.1:${port}`;
    const opened = await CollectiveServiceStore.open({
      dataDirectory: directory,
      humanAuthProvider: { id: 'github', readiness: { ready: false } },
    });
    const service = await startCollectiveServer({ store: opened.store, host: '127.0.0.1', port });
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      await page.goto(`${serviceUrl}/?experienceGate=f290-assembly`, { waitUntil: 'networkidle' });
      await page.getByTestId('f290-assembly-experience').waitFor();
      await captureCandidate(page, 'direct-default');

      const membersEntry = page.getByRole('button', { name: '成员入席', exact: true });
      assert.equal(
        await membersEntry.isDisabled(),
        false,
        'the candidate members entry must begin an admission action',
      );
      await membersEntry.click();
      await page.getByRole('button', { name: '让 宪宪 在 # 产品方向 值守', exact: true }).click();
      await page.getByText('宪宪已在 # 产品方向 值守', { exact: true }).waitFor();

      await page.getByLabel('在 # 产品方向 里说点什么').fill('@宪宪 F290_NAMED_RECIPIENT');
      await page.getByRole('button', { name: '发送到 # 产品方向', exact: true }).click();
      await page.getByText('recipient: 宪宪 · location: 当前频道', { exact: true }).waitFor();
      await page.getByRole('button', { name: '宪宪回应', exact: true }).click();
      await page.getByText('宪宪已在原处具名回应', { exact: true }).waitFor();

      await page.getByLabel('在 # 产品方向 里说点什么').fill('@小团团 F290_UNKNOWN_RECIPIENT');
      await page.getByRole('button', { name: '发送到 # 产品方向', exact: true }).click();
      await page.getByText('recipient: @小团团 · 未在当前频道', { exact: true }).waitFor();

      await page.getByLabel('在 # 产品方向 里说点什么').fill('F290_UNMENTIONED_REQUEST');
      await page.getByRole('button', { name: '发送到 # 产品方向', exact: true }).click();
      const unmentionedRequest = page.locator('.f290-message').filter({ hasText: 'F290_UNMENTIONED_REQUEST' });
      await unmentionedRequest.getByText('已送达 · 尚未接住', { exact: true }).waitFor();
      assert.equal(
        await unmentionedRequest.getByRole('button', { name: '砚砚回应', exact: true }).count(),
        0,
        'an unmentioned request must remain unclaimed instead of silently assigning the first member',
      );

      await page.getByLabel('在 # 产品方向 里说点什么').fill('@宪宪 F290_REVOKED_RESPONSE');
      await page.getByRole('button', { name: '发送到 # 产品方向', exact: true }).click();
      const responseAfterRevocation = page
        .locator('.f290-message')
        .filter({ hasText: 'F290_REVOKED_RESPONSE' })
        .getByRole('button', { name: '宪宪回应', exact: true });
      await responseAfterRevocation.waitFor();

      await page.getByRole('button', { name: '提议新上下文', exact: true }).click();
      await page.getByLabel('新事项标题').fill('F290_PUBLIC_CONTEXT_PROPOSAL');
      await page.getByRole('button', { name: '提交候选事项', exact: true }).click();
      await page.getByText('候选事项：F290_PUBLIC_CONTEXT_PROPOSAL', { exact: true }).waitFor();

      await page.getByRole('button', { name: '提议新上下文', exact: true }).click();
      await page.getByLabel('新事项标题').fill('F290_REVOKED_PROPOSAL');
      const proposalAfterRevocation = page.getByRole('button', { name: '提交候选事项', exact: true });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: '频道导航', exact: true }).click();
      await page.getByRole('button', { name: /社区协作/u }).click();
      await page.getByRole('button', { name: '频道导航', exact: true }).click();
      await page.getByRole('button', { name: /产品方向/u }).click();
      await captureCandidate(page, 'direct-narrow');
      await page.getByRole('button', { name: '撤回体验参与', exact: true }).click();
      assert.equal(
        await responseAfterRevocation.isDisabled(),
        true,
        'revoked participation must not permit a named response to revive an old route',
      );
      assert.equal(
        await proposalAfterRevocation.isDisabled(),
        true,
        'revoked participation must not permit a proposal that was already open to create new candidate state',
      );
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(
        await page.getByRole('button', { name: '模拟离线', exact: true }).isDisabled(),
        true,
        'ordinary network toggles must not reactivate revoked participation',
      );
      await page.setViewportSize({ width: 1440, height: 960 });
      assert.equal(
        await page.getByRole('button', { name: '成员入席', exact: true }).isDisabled(),
        true,
        'revoked participation must not leave the destination admission action looking live',
      );
    } finally {
      await browser.close();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'F290 embedded candidate preserves Work origin, leaves Client controls clickable, and lets Host create a private proposal',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'f290-assembly-vision-host-'));
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
      const frame = page
        .frames()
        .find(
          (candidate) =>
            candidate.url().startsWith(`${serviceUrl}/?`) && candidate.url().includes('experienceGate=f290-assembly'),
        );
      assert.ok(frame, 'Host must mount the canonical Client candidate');
      await frame.getByTestId('f290-assembly-experience').waitFor();

      await frame.locator('.f290-context-panel [data-work-ref="work_demo_product-brief"]').click();
      await page.getByTestId('f290-host-cafe-panel').waitFor();
      const hostPanelBox = await page.getByTestId('f290-host-cafe-panel').boundingBox();
      const sceneHeaderBox = await frame.locator('.f290-scene-header').boundingBox();
      assert.ok(hostPanelBox && sceneHeaderBox, 'the Host panel and Client scene must have visible bounds');
      assert.ok(
        hostPanelBox.x >= sceneHeaderBox.x + sceneHeaderBox.width - 1,
        'the Host private panel must stay in the context region without covering the Client scene',
      );
      await captureCandidate(page, 'embedded-host');
      await frame.getByRole('button', { name: /社区协作/u }).click();
      await frame.getByRole('button', { name: '模拟离线', exact: true }).click({ timeout: 2_500 });
      await frame.getByText('当前离线：位置保留，尚不冒充送达。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '将公开结果带回原 Channel', exact: true }).click();
      await page.getByText('Client 暂时离线；未回传公开结果。', { exact: true }).waitFor();
      await page.getByTestId('f290-host-cafe-panel').waitFor();
      await captureCandidate(page, 'embedded-offline-rejected');
      await frame.getByRole('button', { name: '恢复连接', exact: true }).click();
      await page.getByRole('button', { name: '将公开结果带回原 Channel', exact: true }).click();
      await page.getByTestId('f290-host-cafe-panel').waitFor({ state: 'detached' });
      assert.equal(
        await frame.getByText('共同空间首页 已从我的 Café 回到这里', { exact: true }).count(),
        0,
        'the result must not follow the current Channel focus',
      );
      await frame.getByRole('button', { name: /产品方向/u }).click();
      await frame.getByText('共同空间首页 已从我的 Café 回到这里', { exact: true }).waitFor();
      await captureCandidate(page, 'embedded-result');

      await frame.getByRole('button', { name: '打开我的 Café', exact: true }).click();
      await page.getByTestId('f290-host-cafe-panel').waitFor();
      await page.getByRole('button', { name: '提出新事项草案', exact: true }).click();
      await page.getByText('已在我的 Café 保留新事项草案；尚未授权公开。', { exact: true }).waitFor();
      await captureCandidate(page, 'embedded-private-proposal');
    } finally {
      await browser.close();
      await stopChild(next);
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
