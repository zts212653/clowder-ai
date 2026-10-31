import '../../../api/test/helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectiveArtifactOwnerFixture } from '../../../api/test/collective-artifact-owner.fixture.ts';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { reserveNativeOwnerPorts, startNativeOwner } from './f290-native-owner.harness.mjs';

test(
  'UI701 corrections use the production Host, exact artifact owner and explicit public membership',
  { timeout: 120000 },
  async (t) => {
    const shots = process.env.F290_CORRECTION_SHOTS;
    if (shots) await mkdir(shots, { recursive: true });
    const ports = await reserveNativeOwnerPorts();
    t.after(() => ports.close());
    const f = await collectiveArtifactOwnerFixture(t, {
      additionalHostOrigins: [`http://localhost:${ports.hostPort}`],
    });
    const browser = await chromium.launch({ headless: true });
    let owner;
    const errors = [];
    let syncing = false;
    const timer = setInterval(async () => {
      if (syncing) return;
      syncing = true;
      try {
        await f.connector.sync(f.connection.connectionId);
      } finally {
        syncing = false;
      }
    }, 80);
    const capture = async (page, name) =>
      shots && page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
    const geometry = [];
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      await context.addInitScript(
        ({ origin }) => {
          if (location.origin === origin) localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        },
        { origin: `http://localhost:${ports.hostPort}` },
      );
      await context.addInitScript(
        ({ origin, token }) => {
          if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
        },
        { origin: f.server.url, token: f.owner.sessionToken },
      );
      owner = await startNativeOwner({
        store: f.store,
        owner: f.owner,
        collectiveId: f.coordinates.collectiveId,
        serviceUrl: f.server.url,
        context,
        ports,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${owner.hostUrl}/collective`, { waitUntil: 'domcontentloaded' });
      const client = page.frameLocator('iframe[title="Collective"]');
      await client.getByRole('button', { name: '全部作品', exact: true }).click();
      const library = client.locator('.shared-artifact-library');
      const channelSearch = client.getByRole('searchbox', { name: '搜索频道与话题', exact: true });
      await client.locator('.destination-search-trigger').click();
      await channelSearch.waitFor();
      assert.equal(await channelSearch.evaluate((element) => element === document.activeElement), true);
      await channelSearch.press('Escape');
      const card = library.locator('.shared-artifact-card').filter({ hasText: f.artifact.title });
      await card.waitFor();
      await page.getByTestId('world-rail').waitFor();
      await capture(page, 'production-host-library-1440');
      assert.equal(await page.getByTestId('world-rail').count(), 1, 'the real v2 AppShell owns the one world rail');
      assert.equal(await client.locator('[data-spatial-role="global-rail"]').count(), 0);
      const measured = await library.evaluate((element) => {
        const preview = element.querySelector('.shared-artifact-preview').getBoundingClientRect();
        return {
          columns: getComputedStyle(element.querySelector('.shared-artifact-grid')).gridTemplateColumns.split(' '),
          preview: { width: preview.width, height: preview.height },
          searchHeight: element.querySelector('input[type="search"]').getBoundingClientRect().height,
          titleColor: getComputedStyle(element.querySelector('.shared-artifact-card strong')).color,
          headingColor: getComputedStyle(element.querySelector('h2')).color,
          searchY: document.querySelector('.destination-search-trigger').getBoundingClientRect().y + 14,
          headerY: document.querySelector('.destination-header').getBoundingClientRect().y + 26,
        };
      });
      assert.equal(measured.columns.length, 2);
      assert.ok(Math.abs(Number.parseFloat(measured.columns[0]) - Number.parseFloat(measured.columns[1])) < 1);
      assert.ok(Math.abs(measured.preview.width / measured.preview.height - 1.6) < 0.01);
      assert.equal(measured.searchHeight, 32);
      assert.ok(Math.abs(measured.searchY - measured.headerY) < 1, 'sidebar search shares the real header row');
      assert.equal(
        measured.titleColor,
        measured.headingColor,
        'work titles use ordinary ink, not the Open action accent',
      );
      geometry.push({ state: 'production-host-gallery-1440', ...measured });
      await capture(page, 'production-host-library-1440');
      const search = library.getByRole('searchbox', { name: '搜索作品', exact: true });
      await search.fill(f.artifact.title);
      await card.click();
      await client
        .locator('.shared-artifact-document')
        .getByText('这是一份共同阅读的真实正文。', { exact: true })
        .waitFor();
      await client.getByRole('button', { name: '返回全部作品', exact: true }).click();
      assert.equal(await search.inputValue(), f.artifact.title);
      await library.getByRole('button', { name: `在原讨论中打开 · ${f.artifact.title}`, exact: true }).click();
      await client.getByText(f.source.body, { exact: true }).first().waitFor();
      const sourceMessage = client.locator(`article.message[data-event-id="${f.source.eventId}"]`);
      await sourceMessage.hover();
      await sourceMessage.getByRole('button', { name: '更多消息动作', exact: true }).click();
      await sourceMessage.getByRole('menuitem', { name: '建成任务', exact: true }).click();
      const proposal = sourceMessage.locator('.collective-work-card');
      await proposal.waitFor();
      await proposal.scrollIntoViewIfNeeded();
      assert.equal(await proposal.evaluate((element) => getComputedStyle(element).borderLeftStyle), 'dashed');
      await capture(page, 'production-host-proposal-1440');
      await proposal.getByRole('button', { name: '由我负责', exact: true }).click();
      await proposal.getByText('可以开始', { exact: true }).waitFor();
      assert.equal(await proposal.evaluate((element) => getComputedStyle(element).borderLeftStyle), 'solid');
      await capture(page, 'production-host-committed-1440');
      await client.getByRole('button', { name: '频道作品', exact: true }).click();
      const compact = client.locator('.channel-artifact-list');
      await compact.locator('.shared-artifact-card').waitFor();
      assert.equal(await compact.getByRole('searchbox').count(), 0);
      assert.equal(await compact.locator('select').count(), 0);
      await capture(page, 'production-host-channel-artifacts-1440');
      await compact.getByRole('button', { name: '在全部作品中查看本频道', exact: false }).click();
      await library
        .locator('select[aria-label="作品来源频道"] option[value="general"]:checked')
        .waitFor({ state: 'attached' });
      assert.equal(await library.getByLabel('作品来源频道', { exact: true }).inputValue(), 'general');
      await client.locator('.channel-destination').filter({ hasText: 'general' }).click();
      const ownerRequest = '请把这份接入指南整理成可核验的工作结果。';
      assert.equal((await owner.receiveRequest(ownerRequest, 'general')).failed, 0);
      const inbound = (await owner.connector.listInbox(owner.connection.connectionId)).find(
        (item) => item.event.body === ownerRequest,
      );
      assert.ok(inbound);
      await owner.proposeWorkForEvent(inbound.event.eventId, ownerRequest);
      const ownerProposal = client
        .locator('article.message')
        .filter({ hasText: ownerRequest })
        .locator('.collective-work-card');
      await ownerProposal.getByRole('button', { name: '待你决定…', exact: true }).waitFor();
      await ownerProposal.scrollIntoViewIfNeeded();
      assert.equal(await ownerProposal.evaluate((element) => getComputedStyle(element).borderLeftStyle), 'dashed');
      await capture(page, 'production-host-owner-proposal-1440');
      await client.locator('.channel-menu > summary').click();
      await client.getByRole('button', { name: '谁留意频道消息…', exact: false }).click();
      const listening = page.getByRole('radio', { name: '留意所有消息', exact: true });
      const listeningAck = page.waitForResponse(
        (response) => response.url().endsWith('/listening') && response.request().method() === 'POST',
      );
      await listening.click();
      assert.equal(
        (await listeningAck).status(),
        200,
        'only an actual successful settings write enables all-message listening',
      );
      const choice = page.getByLabel('换一只留意消息的猫', { exact: true });
      await choice.waitFor();
      assert.equal(await listening.isChecked(), true);
      assert.ok((await choice.locator('option').allTextContents()).every((label) => label.includes('@')));
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await capture(page, 'production-host-listening-390');
      await page.getByRole('button', { name: '返回共同体', exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 960 });
      await client.locator('.member-destination button').click();
      await client.locator('.member-family > summary').first().waitFor();
      const groups = await client.locator('.member-family > summary').allTextContents();
      assert.ok(groups.length >= 2, 'distinct public endpoints are preserved');
      const roster = page.getByRole('region', { name: '我的猫 · 仅自己可见', exact: true });
      await roster.locator('[data-testid="collective-cat-row"]').nth(2).waitFor();
      await roster.getByText('已加入', { exact: true }).first().waitFor();
      await client.locator('.member-row-agent').nth(1).waitFor();
      await capture(page, 'production-host-members-1440');
      assert.equal(await roster.locator('[data-testid="collective-cat-row"]').count(), 3);
      const unknownIdentity = roster.locator('[data-testid="collective-cat-row"]').filter({ hasText: '@fable-5' });
      assert.equal(
        await unknownIdentity.getByText('宪宪', { exact: true }).count(),
        1,
        'unknown metadata does not repeat the name or invent a model',
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => {
        const roster = document.querySelector('section[aria-label="我的猫 · 仅自己可见"]');
        if (!roster) return false;
        const rect = roster.getBoundingClientRect();
        return rect.x >= 0 && rect.right <= innerWidth;
      });
      await capture(page, 'production-host-members-390');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      // The existing Host language owner drives both the private surface and embedded Client.
      await page.evaluate(() => {
        localStorage.setItem('cat-cafe:shell-language', 'en');
        window.dispatchEvent(new Event('cat-cafe:shell-language-sync'));
      });
      await page.evaluate(() => localStorage.setItem('theme', 'dark'));
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await client.locator('.member-destination button').click();
      await page.getByRole('heading', { name: 'My cats', exact: true }).waitFor();
      await client.getByRole('heading', { name: 'Members', exact: true }).waitFor();
      assert.ok(
        (await client.locator('.member-family > summary').allTextContents()).some((label) =>
          /1 member$/.test(label.trim()),
        ),
      );
      await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
      await client.locator('html[data-theme="dark"]').waitFor({ state: 'attached' });
      assert.equal(await client.locator('html').getAttribute('data-theme'), 'dark');
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(page, 'production-host-members-390-en-dark');
      await page.setViewportSize({ width: 1440, height: 960 });
      await client.getByRole('button', { name: 'All works', exact: true }).click();
      await library.locator('.shared-artifact-card').waitFor();
      assert.equal(await library.locator('.shared-artifact-library-count').count(), 0);
      assert.match(await library.locator('h2 small').textContent(), /1 work/);
      await capture(page, 'production-host-library-1440-en-dark');
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(page, 'production-host-library-390-en-dark');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const anonymous = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const login = await anonymous.newPage();
      await login.goto(`${f.server.url}/?lang=en`, { waitUntil: 'networkidle' });
      await login.getByRole('heading', { name: 'Sign in to your collective', exact: true }).waitFor();
      const font = await login.locator('.entry-card h2').evaluate((element) => getComputedStyle(element).fontFamily);
      assert.doesNotMatch(font, /ui-serif|Georgia|Times/);
      await capture(login, 'login-1440-en');
      await login.setViewportSize({ width: 390, height: 844 });
      await capture(login, 'login-390-en');
      assert.equal(await login.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      if (shots)
        await writeFile(
          join(shots, 'geometry.json'),
          JSON.stringify(
            {
              geometry,
              groups,
              errors,
              boundaries:
                'Production Service/Connector/Host and reader; fixture authentication and Agent replies, not real-model/two-Human UAT.',
            },
            null,
            2,
          ),
        );
    } catch (error) {
      if (shots) {
        for (const [index, page] of browser
          .contexts()
          .flatMap((context) => context.pages())
          .entries()) {
          await page.screenshot({ path: join(shots, `failure-${index}.png`), fullPage: true }).catch(() => undefined);
        }
        await writeFile(join(shots, 'failure.txt'), String(error?.stack ?? error));
      }
      throw error;
    } finally {
      clearInterval(timer);
      while (syncing) await new Promise((resolve) => setTimeout(resolve, 10));
      await browser.close();
      await owner?.close();
    }
  },
);
