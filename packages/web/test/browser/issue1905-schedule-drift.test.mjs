import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createInboxScheduleFixture } from './f322-inbox-schedule.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url));
const tree = path.resolve(web, '../..');
test(
  'issue1905: Chat and Inbox explain drift; reject, cat repropose, then approve the new request',
  { timeout: 900000 },
  async (t) => {
    const evidence = path.join(tree, '.tmp/issue1905-browser');
    await mkdir(evidence, { recursive: true });
    const fixture = await createInboxScheduleFixture('zh');
    const source = fixture.approvalSources;
    const original = source.records.find((r) => r.action === 'delete');
    source.pauseDeletionTarget();
    const port = await availablePort();
    let environment, server, browser, page;
    const errors = [],
      responses = [];
    t.after(async () => {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: path.join(evidence, 'final.png'), fullPage: true });
        await writeFile(path.join(evidence, 'final.html'), await page.content());
        await writeFile(
          path.join(evidence, 'proof.json'),
          JSON.stringify({ errors, responses, effects: await source.effects() }, null, 2),
        );
      }
      const results = await Promise.allSettled([
        browser?.close(),
        server ? stopChild(server) : undefined,
        fixture.close(),
      ]);
      if (!server || server.exitCode !== null || server.signalCode !== null)
        results.push(...(await Promise.allSettled([environment?.cleanup()])));
      const failures = results.filter((r) => r.status === 'rejected');
      assert.equal(failures.length, 0, failures.map((r) => r.reason).join('\n'));
    });
    environment = await createNextDevTestEnvironment('issue1905-drift', {
      API_SERVER_PORT: String(fixture.apiPort),
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
      FRONTEND_PORT: String(port),
    });
    execFileSync(process.execPath, [path.join(web, 'scripts/sync-vendor-assets.mjs')], {
      cwd: web,
      env: environment.env,
      stdio: 'ignore',
    });
    server = spawn(
      process.execPath,
      [path.join(tree, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)],
      { cwd: web, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    for (const stream of [server.stdout, server.stderr])
      stream.on('data', (data) => writeFile(path.join(evidence, 'web.log'), data, { flag: 'a' }));
    const base = `http://127.0.0.1:${port}`;
    await waitForHttp(`${base}/thread/${original.thread.id}`, server);
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.request().method() === 'POST' && response.url().includes('/api/schedule-proposals/'))
        responses.push({ url: new URL(response.url()).pathname, status: response.status() });
    });
    await page.addInitScript(() => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:shell-language', 'zh');
    });
    await page.goto(`${base}/thread/${original.thread.id}?shell=v2`);
    const chat = page.locator(`[data-rich-block-id="${original.block.id}"]`);
    await chat.getByTestId('schedule-approve').waitFor();
    await chat.getByTestId('schedule-approve').click();
    await chat.getByRole('alert').filter({ hasText: '任务已变化' }).waitFor();
    assert.equal(await chat.getByTestId('schedule-approve').isDisabled(), true);
    assert.equal(await chat.getByTestId('schedule-reject').isEnabled(), true);
    assert.match(await chat.innerText(), /在原对话让发起猫核对当前任务/);
    await page.screenshot({ path: path.join(evidence, 'chat-conflict.png'), fullPage: true });
    await page.getByTestId('mailbox-button').click();
    const inbox = page.getByTestId('mailbox-panel').getByTestId(`schedule-approval-${original.proposalId}`);
    await inbox.waitFor();
    assert.equal(await inbox.getByTestId('schedule-approve').isDisabled(), true);
    await page.getByTestId('mailbox-close').click();
    // A full reload discards only transient refusal observations; the first new attempt re-observes the server refusal.
    await page.reload();
    await page.getByTestId('mailbox-button').click();
    await inbox.getByTestId('schedule-approve').click();
    const host = inbox.locator('xpath=ancestor::*[@data-testid="mailbox-hosted-approval"]');
    await host.getByTestId('mailbox-approval-result').filter({ hasText: '当前删除请求不能执行' }).waitFor();
    assert.equal(await inbox.getByTestId('schedule-approve').isDisabled(), true);
    assert.equal(await inbox.getByTestId('schedule-reject').isEnabled(), true);
    assert.equal((await host.innerText()).match(/任务已变化/g).length, 1);
    assert.equal(await host.getByTestId('mailbox-approval-reread').count(), 0);
    await host.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, 'inbox-conflict.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await host.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, 'inbox-conflict-mobile.png'), fullPage: true });
    await inbox.getByTestId('schedule-reject').click();
    await page.getByTestId('mailbox-retained-result').filter({ hasText: '已拒绝' }).waitFor();
    assert.equal(source.store.getById(original.proposalId).status, 'rejected');
    assert.equal(source.tasks.getById(original.task.id).enabled, false);
    const fresh = await source.reproposeDeletion();
    assert.equal(source.store.getById(fresh.proposalId).status, 'pending');
    assert.equal(source.tasks.getById(original.task.id).enabled, false);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.reload();
    const freshCard = page.getByTestId(`schedule-approval-${fresh.proposalId}`);
    await freshCard.getByTestId('schedule-approve').waitFor();
    await page.screenshot({ path: path.join(evidence, 'new-proposal-unapproved.png'), fullPage: true });
    await freshCard.getByTestId('schedule-approve').click();
    await freshCard.getByTestId('decision-result-label').waitFor();
    assert.equal(source.tasks.getById(original.task.id), null);
    assert.equal(source.store.getById(original.proposalId).effectCheckpoint, undefined);
    assert.equal(source.store.getById(fresh.proposalId).status, 'approved');
    assert.deepEqual(
      responses.map((r) => r.status),
      [409, 409, 200, 200],
    );
    assert.deepEqual(errors, []);
  },
);
