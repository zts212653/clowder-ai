import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { createCardSelectionApiFixture } from './card-selection-api-fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.join(WEB_ROOT, 'node_modules/next/dist/bin/next');
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

test(
  'card selection forwards to a real isolated conversation and exports only the same selected parts',
  { timeout: 240_000 },
  async () => {
    const fixture = await createCardSelectionApiFixture();
    const apiUrl = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const port = await freePort();
    const nextDev = await createNextDevTestEnvironment('card-forward-selection', {
      NEXT_PUBLIC_API_URL: apiUrl,
      API_SERVER_PORT: new URL(apiUrl).port,
      FRONTEND_PORT: String(port),
      CAT_CAFE_DEPLOYMENT_REVISION_REQUIRED: '0',
    });
    const serverOutput = [];
    const server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: WEB_ROOT,
      env: nextDev.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (data) => serverOutput.push(data.toString()));
    server.stderr.on('data', (data) => serverOutput.push(data.toString()));
    const origin = `http://127.0.0.1:${port}`;
    const evidenceDir = process.env.CARD_FORWARD_EVIDENCE_DIR;
    const previousFrontend = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = origin;
    let browser;
    const network = [];
    try {
      const url = `${origin}/dev/f294-card-selection?test=card-forward&shell=v2`;
      const deadline = Date.now() + 90_000;
      while (true) {
        if (server.exitCode !== null || Date.now() > deadline) throw new Error(serverOutput.join(''));
        try {
          if ((await fetch(url)).ok) break;
        } catch {
          /* server is starting */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
      const errors = [];
      page.on('pageerror', (error) => {
        errors.push(error.message);
        network.push(error.stack);
      });
      page.on('response', (response) => {
        if (response.url().includes('/api/')) network.push(`${response.status()} ${response.url()}`);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') network.push(message.text());
      });
      await page.addInitScript(() => {
        localStorage.setItem('cat-cafe:shell-language', 'zh');
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-rich-block-id="quota-card"]').waitFor();
      const source = page.locator(`[data-message-id="${fixture.rich.id}"]`);
      await source.hover({ position: { x: 130, y: 18 } });
      const select = page
        .locator(`[data-message-actions-owner="${fixture.rich.id}"]`)
        .getByRole('button', { name: '多选：转发或导出' });
      await select.waitFor();
      assert.equal(await page.getByTestId('rich-block-forward-actions').count(), 0);
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: path.join(evidenceDir, 'hover-1440.png') });
      }
      await select.click();
      await page.getByRole('checkbox', { name: '选择卡片：额度表 · 本周' }).click();
      const richRow = page.locator(`[data-selection-message-id="${fixture.rich.id}"]`);
      assert.equal(await richRow.getByRole('checkbox', { name: '选择整条消息' }).getAttribute('aria-checked'), 'mixed');
      const plainRow = page.locator(`[data-selection-message-id="${fixture.plain.id}"]`);
      await plainRow.getByRole('checkbox', { name: '选择这条消息' }).click();
      assert.equal(await page.getByText('1 张卡没勾', { exact: true }).count(), 1);
      await plainRow.getByRole('checkbox', { name: '取消选择这条消息' }).waitFor();
      await plainRow.getByRole('checkbox', { name: '取消选择这条消息' }).evaluate(async (element) => {
        await new Promise(requestAnimationFrame);
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'selection-1440.png') });
      await page.getByRole('button', { name: '转发', exact: true }).click();
      const picker = page.getByRole('dialog', { name: '转发到' });
      await picker.waitFor();
      assert.match(
        await picker.getByTestId('transfer-selection-summary').innerText(),
        /转发 2 条消息[\s\S]*审批卡统一结果行[\s\S]*没带「额度表 · 本周」/,
      );
      assert.equal(await picker.getByRole('checkbox').count(), 0, 'the picker must not repeat card choices');
      if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'picker-1440.png') });
      await picker.getByRole('button', { name: /接收测试对话/ }).click();
      await picker.locator('button[aria-pressed]').first().click();
      const responseReady = page.waitForResponse(
        (response) => response.url() === `${apiUrl}/api/messages` && response.request().method() === 'POST',
      );
      await picker.getByRole('button', { name: '转发 2 条消息', exact: true }).click();
      const forward = await responseReady;
      assert.equal(forward.status(), 202, await forward.text());
      const receipt = await forward.json();
      assert.match(fixture.messageStore.getById(receipt.messageBundleId).content, /转发了 2 条聊天记录/);
      const hydrated = await fetch(`${apiUrl}/api/message-bundles/${receipt.messageBundleId}`).then((response) =>
        response.json(),
      );
      assert.equal(hydrated.targetThreadId, fixture.targetThread.id);
      assert.deepEqual(
        hydrated.items.map((item) => item.kind),
        ['quote', 'rich_block', 'message'],
      );
      assert.ok(hydrated.items.some((item) => item.richBlock?.id === 'result-card'));
      assert.ok(!JSON.stringify(hydrated).includes('quota-card'));
      assert.ok(!JSON.stringify(hydrated).includes('额度表 · 本周'));
      // Re-enter the real selection owner to export the same basket after forward success clears it.
      await picker.waitFor({ state: 'hidden' });
      await source.hover({ position: { x: 130, y: 18 } });
      await select.click();
      await page.getByRole('checkbox', { name: '选择卡片：额度表 · 本周' }).click();
      await plainRow.getByRole('checkbox', { name: '选择这条消息' }).click();
      const downloadReady = page.waitForEvent('download');
      await page.getByRole('button', { name: '文本', exact: true }).click();
      const download = await downloadReady;
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const imageResponse = await fetch(`${apiUrl}/api/threads/${fixture.sourceThread.id}/export-selection-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: forward.request().postDataJSON().messageBundle.items }),
      });
      assert.equal(imageResponse.status, 200, imageResponse.status === 200 ? '' : await imageResponse.text());
      assert.match(imageResponse.headers.get('content-type'), /image\/png/);
      const image = Buffer.from(await imageResponse.arrayBuffer());
      if (evidenceDir) await writeFile(path.join(evidenceDir, 'export.png'), image);
      assert.match(text, /消息数: 2/);
      assert.match(text, /两件都弄好了/);
      assert.match(text, /审批卡统一结果行/);
      assert.doesNotMatch(text, /额度表|3 个号/);
      if (evidenceDir) {
        await writeFile(path.join(evidenceDir, 'export.txt'), text);
        await writeFile(
          path.join(evidenceDir, 'receipt.json'),
          JSON.stringify({ forward: receipt, hydrated, errors }, null, 2) + '\n',
        );
      }
      assert.deepEqual(errors, [], 'the actual source and picker must not throw browser errors');
    } catch (error) {
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(
          path.join(evidenceDir, 'failure.log'),
          `${String(error)}\n${network.join('\n')}\n${serverOutput.join('')}`,
        );
        for (const context of browser?.contexts() ?? [])
          for (const page of context.pages()) {
            await page.screenshot({ path: path.join(evidenceDir, 'failure.png') }).catch(() => {});
            await writeFile(
              path.join(evidenceDir, 'failure-body.txt'),
              await page
                .locator('body')
                .innerText()
                .catch(() => ''),
            );
          }
      }
      throw error;
    } finally {
      if (browser) await browser.close();
      await fixture.app.close();
      if (previousFrontend === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = previousFrontend;
      if (server.exitCode === null) {
        server.kill('SIGTERM');
        await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
        if (server.exitCode === null) server.kill('SIGKILL');
      }
      await nextDev.cleanup();
    }
  },
);
