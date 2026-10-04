import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { registerDefaultEntryJourney } from './default-entry-journey.harness.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { CALENDAR_THREAD, createCalendarFixture } from './f310-work-calendar.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

registerDefaultEntryJourney(
  {
    journeyId: 'f310-work-calendar',
    surfaceTestId: 'product-schedule-panel',
    title: 'dates, progress, exact readable delivery and completed history',
    timeout: 180000,
  },
  async (journey, t) => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const fixture = await createCalendarFixture();
    t.after(() => fixture.close());
    const webPort = await availablePort();
    const environment = await createNextDevTestEnvironment('f310-calendar', {
      API_SERVER_PORT: String(fixture.apiPort),
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
      FRONTEND_PORT: String(webPort),
    });
    t.after(() => environment.cleanup());
    const server = spawn(
      process.execPath,
      [path.resolve(root, '../../node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(webPort)],
      { cwd: root, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => stopChild(server));
    const base = `http://127.0.0.1:${webPort}`;
    await waitForHttp(`${base}/thread/${CALENDAR_THREAD}`, server);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (error) => t.diagnostic(`browser error: ${error.message}`));
    page.on('response', async (response) => {
      if (response.url().includes('/api/entrusted-work/') && !response.ok())
        t.diagnostic(`owner read ${response.status()}: ${await response.text()}`);
    });
    let downloads = 0;
    page.on('download', () => downloads++);
    const openedFiles = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === fixture.artifactUrl) openedFiles.push(request.url());
    });
    const evidence = process.env.F310_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'f310-calendar');
    await mkdir(evidence, { recursive: true });
    await journey.enter(page, `${base}/thread/${CALENDAR_THREAD}`);
    await page.getByTestId('file-block-open').click();
    await page.getByText(fixture.sentinel, { exact: true }).waitFor();
    assert.ok(openedFiles.length > 0, 'the Chat file must open the same published file in Workspace');
    assert.equal(downloads, 0);
    await page.screenshot({ path: path.join(evidence, 'chat-artifact.png'), fullPage: true });
    await ensureWorkspaceOpen(page);
    await page.getByTestId('f307-add-surface').click();
    await page.getByTestId('workspace-launcher-product-schedule').click();
    await journey.arrive(page);
    const panel = page.getByTestId('product-schedule-panel');
    const work = page.locator(`[data-subject-ref="task:work:${fixture.taskId}"]`);
    await work.getByRole('heading', { name: fixture.title }).waitFor();
    assert.match(await work.innerText(), /开始/);
    assert.match(await work.innerText(), /预计完成/);
    assert.match(await work.innerText(), /截止未定/);
    assert.match(await work.innerText(), /检查完成后的成果回看/);
    await page.getByRole('region', { name: '本周安排', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok((await work.getByRole('heading').boundingBox()).y < 750);
    assert.ok(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: path.join(evidence, 'active-mobile.png'), fullPage: true });
    await work.getByRole('button', { name: '打开成果', exact: true }).click();
    await page.getByText(fixture.sentinel, { exact: true }).waitFor();
    assert.equal(downloads, 0);
    await page.getByRole('tab', { name: /Schedule/ }).click();
    await work.waitFor();
    await fixture.complete();
    await page.getByRole('button', { name: '已完成', exact: true }).click();
    assert.equal(await panel.getByRole('group', { name: '筛选工作', exact: true }).count(), 0);
    await work
      .locator('span')
      .filter({ hasText: /^已完成$/ })
      .waitFor();
    assert.doesNotMatch(await work.innerText(), /已逾期|下一步/);
    await work.getByRole('button', { name: '打开成果', exact: true }).click();
    await page.getByText(fixture.sentinel, { exact: true }).waitFor();
    await page.getByRole('tab', { name: /Schedule/ }).click();
    await work
      .locator('span')
      .filter({ hasText: /^已完成$/ })
      .waitFor();
    assert.equal(await work.getAttribute('data-selected'), 'true');
    await page.screenshot({ path: path.join(evidence, 'completed-mobile.png'), fullPage: true });
    fixture.republish();
    await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await work.getByText('交付材料未封存或已变更', { exact: true }).waitFor();
    assert.equal(await work.getByRole('button', { name: '打开成果', exact: true }).count(), 0);
    fixture.unavailable(true);
    await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await panel.getByText('暂时无法读取工作与安排，请重试刷新。', { exact: true }).waitFor();
    fixture.unavailable(false);
    await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await work.waitFor();
    t.diagnostic(
      JSON.stringify({
        defaultEntry: true,
        chatFileOpen: true,
        exactHistory: true,
        downloads,
        productionWrites: 0,
        evidence,
      }),
    );
  },
);
