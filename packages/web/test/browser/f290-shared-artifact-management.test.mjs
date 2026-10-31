import '../../../api/test/helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { custodyHttpFixture } from '../../../api/test/collective-custody-http.fixture.ts';

test(
  'normal information panel grants explicit access, cancels an offer and transfers the real owner unit to the selected one of multiple Cafes',
  { timeout: 90000 },
  async (t) => {
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.CAT_CAFE_TEST_REAL_HOME && process.platform === 'darwin')
      process.env.PLAYWRIGHT_BROWSERS_PATH = join(
        process.env.CAT_CAFE_TEST_REAL_HOME,
        'Library',
        'Caches',
        'ms-playwright',
      );
    const { chromium } = await import('../../../ppt-forge/node_modules/playwright/index.mjs');
    const f = await custodyHttpFixture(t);
    const spareIntent = await f.store.createPairingIntent({
      sessionToken: f.member.sessionToken,
      collectiveId: f.coordinates.collectiveId,
      hostOrigin: 'http://localhost:5182',
      nonce: 'spare-unselected-cafe',
    });
    const spare = await f.store.exchangePairingIntent({ ...spareIntent, endpointLabel: 'Unselected Café' });
    const browser = await chromium.launch({ headless: true });
    const contexts = [];
    const active = new Map();
    const failures = [];
    let paused = false;
    const timer = setInterval(() => {
      if (paused) return;
      for (const [connector, connection] of [
        [f.connector, f.connection],
        [f.targetConnector, f.target],
      ]) {
        if (active.has(connection.connectionId)) continue;
        const job = connector
          .sync(connection.connectionId)
          .catch((error) => failures.push(String(error)))
          .finally(() => active.delete(connection.connectionId));
        active.set(connection.connectionId, job);
      }
    }, 60);
    const pages = [];
    try {
      for (const auth of [f.owner, f.member]) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
        contexts.push(context);
        await context.addInitScript(
          ({ origin, token }) => {
            if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
          },
          { origin: f.server.url, token: auth.sessionToken },
        );
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        await page.goto(`${f.server.url}/?collectiveId=${f.coordinates.collectiveId}&channelId=general`, {
          waitUntil: 'networkidle',
        });
        await page.locator('.shared-artifact-card').filter({ hasText: f.artifact.title }).first().click();
        await page.locator('.shared-artifact-document').waitFor();
        pages.push(page);
      }
      const [owner, member] = pages;
      await owner.getByRole('button', { name: /作品信息/ }).click();
      const panel = owner.getByRole('region', { name: '权限与保管', exact: true });
      const memberName = f.member.human.displayName;
      await panel.getByLabel(`${memberName}的作品权限`, { exact: true }).selectOption('apply');
      await panel.getByRole('button', { name: `更新${memberName}的权限`, exact: true }).click();
      await member.getByRole('button', { name: /作品信息/ }).click();
      await member.getByText('你有权采用修改', { exact: true }).waitFor();
      await panel.getByLabel(`${memberName}的作品权限`, { exact: true }).selectOption('revoked');
      await panel.getByRole('button', { name: `更新${memberName}的权限`, exact: true }).click();
      await member.getByRole('heading', { name: '你已无法查看这件作品', exact: true }).waitFor();
      await panel.getByLabel(`${memberName}的作品权限`, { exact: true }).selectOption('apply');
      await panel.getByRole('button', { name: `更新${memberName}的权限`, exact: true }).click();
      await member.locator('.shared-artifact-document').waitFor();
      const ownerName = f.store
        .listMembers(f.owner.sessionToken, f.coordinates.collectiveId)
        .humans.find((human) => human.humanId === f.owner.human.humanId).displayName;
      await panel.getByLabel(`${ownerName}的作品权限`, { exact: true }).selectOption('revoked');
      await panel.getByRole('button', { name: `更新${ownerName}的权限`, exact: true }).click();
      await owner.getByRole('heading', { name: '你已无法查看这件作品', exact: true }).waitFor();
      await panel.getByLabel(`${ownerName}的作品权限`, { exact: true }).selectOption('apply');
      await panel.getByRole('button', { name: `更新${ownerName}的权限`, exact: true }).click();
      await owner.locator('.shared-artifact-document').waitFor();
      const destination = panel.getByLabel('作品接收 Café', { exact: true });
      assert.ok((await destination.textContent()).includes('Destination Cafe'));
      assert.ok((await destination.textContent()).includes('Unselected Café'));
      await destination.selectOption(f.target.connectionId);
      await owner.route('**/api/artifacts/custody/offer', async (route) => {
        paused = true;
        await Promise.allSettled([...active.values()]);
        await route.continue();
      });
      await panel.getByRole('button', { name: '交接作品与记录', exact: true }).click();
      await panel.getByText('已发起交接，等待原 Café 准备。', { exact: true }).waitFor();
      await panel.getByText(`本次交接目的地：${memberName} · Destination Cafe`, { exact: true }).waitFor();
      await panel.getByRole('button', { name: '取消这次交接', exact: true }).click();
      await panel.getByText('交接已取消。', { exact: true }).waitFor();
      await owner.unroute('**/api/artifacts/custody/offer');
      paused = false;
      await panel.getByRole('button', { name: '交接作品与记录', exact: true }).click();
      await panel.getByText('作品与记录已交接。', { exact: true }).waitFor();
      const targetPanel = member.getByRole('region', { name: '权限与保管', exact: true });
      await targetPanel.getByText('作品与记录已交接。', { exact: true }).waitFor();
      assert.equal(await targetPanel.getByRole('heading', { name: '成员的作品权限', exact: true }).count(), 0);
      await member
        .locator('.shared-artifact-document')
        .getByText('这是一份共同阅读的真实正文。', { exact: true })
        .waitFor();
      assert.equal((await f.contentOwner.collectiveCustody.fence.read(f.artifact.contentRef)).state, 'source_retired');
      assert.equal((await f.destination.current.owner.describe(f.artifact.contentRef)).currentOwnerRevision, 1);
      assert.equal((await f.destination.current.owner.load(f.artifact.contentRef)).bytes.toString('utf8'), f.text);
      assert.deepEqual(
        f.store.pollArtifactCustody(spare.endpointCredential, {
          ...f.coordinates,
          connectionId: spare.connectionId,
        }),
        [],
      );
      assert.equal(failures.length, 0, failures.join('\n'));
      await member.setViewportSize({ width: 390, height: 844 });
      const information = member.getByRole('dialog', { name: '作品信息', exact: true });
      const sheet = await information.boundingBox();
      const surface = await member.getByRole('region', { name: '作品模式', exact: true }).boundingBox();
      assert.ok(sheet && surface);
      assert.ok(Math.abs(sheet.y + sheet.height - surface.y - surface.height) < 2);
      assert.ok(sheet.y > surface.y + 50);
      assert.ok(sheet.width <= surface.width);
      await member.keyboard.press('Escape');
      assert.equal(await information.count(), 0);
      assert.ok(await member.evaluate(() => document.activeElement?.textContent?.includes('作品信息')));
      await member
        .locator('.shared-artifact-document')
        .getByText('这是一份共同阅读的真实正文。', { exact: true })
        .waitFor();
      await member.getByRole('button', { name: /作品信息/ }).click();
      assert.ok(await member.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      if (process.env.F290_SCREENSHOTS) {
        await mkdir(process.env.F290_SCREENSHOTS, { recursive: true });
        await owner.screenshot({ path: join(process.env.F290_SCREENSHOTS, 'artifact-permissions-and-custody.png') });
        await member.screenshot({ path: join(process.env.F290_SCREENSHOTS, 'custody-target-mobile.png') });
        await member.evaluate(() => {
          document.documentElement.dataset.theme = 'dark';
          document.documentElement.dataset.consoleTheme = 'dark';
        });
        await member.screenshot({ path: join(process.env.F290_SCREENSHOTS, 'custody-target-mobile-dark.png') });
      }
    } finally {
      clearInterval(timer);
      await Promise.allSettled([...active.values()]);
      await Promise.all(contexts.map((context) => context.close()));
      await browser.close();
    }
  },
);
