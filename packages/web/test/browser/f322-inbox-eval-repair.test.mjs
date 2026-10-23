import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createInboxEvalRepairFixture } from './f322-inbox-eval-repair.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
const root = process.env.F322_INBOX_PARITY_EVIDENCE ?? path.join(tree, '.tmp/f322-eval-repair');
async function freeze(page, target, file) {
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: file, fullPage: true });
}
async function decide(page, card, record, responses) {
  const button = card.getByTestId(record.verb === 'approve' ? 'approve-btn' : 'reject-btn');
  await button.waitFor();
  await page.waitForFunction((element) => !element.disabled, await button.elementHandle());
  const waiting = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/eval-repair-proposals/${record.proposalId}/${record.verb}` &&
      r.request().method() === 'POST',
  );
  await button.focus();
  await page.keyboard.press('Enter');
  const response = await waiting,
    body = await response.json();
  responses.push({
    proposalId: record.proposalId,
    entrance: record.entrance,
    verb: record.verb,
    status: response.status(),
    body,
  });
  assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(body.status, record.verb === 'approve' ? 'accepted' : 'rejected');
}
for (const language of ['zh', 'en'])
  for (const width of [1440, 390]) {
    test(`F322 original evaluation repair Chat and Inbox ${language} ${width}`, { timeout: 240000 }, async (t) => {
      const evidence = path.join(root, 'eval-repair', `${language}-${width}`);
      await mkdir(evidence, { recursive: true });
      const fixture = await createInboxEvalRepairFixture(language),
        source = fixture.approvalSources;
      const chatRecords = source.records.filter((r) => r.entrance === 'Chat'),
        inboxRecords = source.records.filter((r) => r.entrance === 'Inbox');
      let environment, server, browser, page;
      const responses = [],
        errors = [];
      t.after(async () => {
        try {
          if (page && !page.isClosed()) {
            await page.screenshot({ path: path.join(evidence, 'final.png'), fullPage: true });
            await writeFile(
              path.join(evidence, 'final-state.json'),
              JSON.stringify(
                {
                  text: await page.locator('body').innerText(),
                  responses,
                  errors,
                  mutations: fixture.mutations,
                  reads: fixture.reads,
                  effects: await source.effects(),
                },
                null,
                2,
              ),
            );
          }
        } finally {
          const cleanup = await Promise.allSettled([
            browser?.close(),
            (async () => {
              // Next must stop writing before its owned build directory is removed.
              if (server) await stopChild(server);
              await environment?.cleanup();
            })(),
            fixture.close(),
          ]);
          const failed = cleanup.filter((r) => r.status === 'rejected');
          if (failed.length)
            throw new AggregateError(
              failed.map((r) => r.reason),
              'Owned evaluation repair cleanup failed',
            );
        }
      });
      const port = await availablePort();
      environment = await createNextDevTestEnvironment(`f322-eval-repair-${language}-${width}`, {
        API_SERVER_PORT: String(fixture.apiPort),
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
        FRONTEND_PORT: String(port),
      });
      server = spawn(
        process.execPath,
        [
          path.join(web, 'scripts/sync-vendor-assets.mjs'),
          '--watch',
          '--',
          process.execPath,
          path.join(tree, 'node_modules/next/dist/bin/next'),
          'dev',
          '-H',
          '127.0.0.1',
          '-p',
          String(port),
        ],
        { cwd: web, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      for (const stream of [server.stdout, server.stderr])
        stream.on('data', (data) => writeFile(path.join(evidence, 'web.log'), data, { flag: 'a' }));
      const base = `http://127.0.0.1:${port}`,
        threadId = chatRecords[0].thread.id;
      await waitForHttp(`${base}/thread/${threadId}`, server);
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((lang) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', lang);
      }, language);
      await page.goto(`${base}/thread/${threadId}?shell=v2`);
      const draft = page.locator('[data-testid="chat-input-composer-row"] textarea'),
        draftText = 'Preserved original evaluation repair draft';
      await draft.fill(draftText);
      const started = language === 'en' ? 'Repair work started' : '修复工作已发起';
      for (const record of chatRecords) {
        const card = page.locator(`[data-rich-block-id="${record.block.id}"]`);
        await card.getByTestId('approve-btn').waitFor();
        assert.match(await card.innerText(), language === 'en' ? /One reversible review/ : /一次可回滚的审查/);
        assert.match(
          await card.innerText(),
          language === 'en' ? /Withdraw if the original target/ : /原目标或授权改变/,
        );
        await freeze(page, card, path.join(evidence, `Chat-${record.verb}-before.png`));
        await decide(page, card, record, responses);
        const result = card.getByTestId('eval-repair-result');
        await card.getByTestId('decision-result-label').waitFor();
        await card.locator('button[aria-expanded="false"]').click();
        await result.waitFor();
        assert.match(
          await result.innerText(),
          record.verb === 'approve' ? new RegExp(started) : language === 'en' ? /Rejected/ : /已拒绝/,
        );
        assert.equal(await card.getByTestId('approve-btn').count(), 0);
        await freeze(page, result, path.join(evidence, `Chat-${record.verb}-result.png`));
      }
      await page.getByTestId('mailbox-button').click();
      const panel = page.getByTestId('mailbox-panel');
      for (const record of inboxRecords) {
        const card = panel.getByTestId(`approval-item-${record.proposalId}`);
        await card.getByTestId('approve-btn').waitFor();
        assert.match(await card.innerText(), language === 'en' ? /One reversible review/ : /一次可回滚的审查/);
        assert.equal(await card.getByTestId('mailbox-item-ignore').count(), 1);
        assert.equal(await card.locator('[data-testid="approval-item-technical-details"]').count(), 0);
        await freeze(page, card, path.join(evidence, `Inbox-${record.verb}-before.png`));
        await decide(page, card, record, responses);
        const result = panel
          .getByTestId('mailbox-retained-line')
          .filter({ hasText: record.verb === 'approve' ? started : language === 'en' ? 'Rejected' : '已拒绝' });
        await result.waitFor();
        assert.match(await result.innerText(), language === 'en' ? /You/ : /你/);
        await freeze(page, result, path.join(evidence, `Inbox-${record.verb}-result.png`));
      }
      const effects = await source.effects();
      assert.equal(responses.length, 4);
      assert.ok(effects.tasks.every((task) => task.status === 'doing'));
      const dispatched = effects.ownerLedger.filter((event) => event.type === 'dispatch_reserved');
      assert.equal(dispatched.length, 2);
      assert.equal(new Set(dispatched.map((event) => event.dispatchId)).size, 2);
      for (const record of source.records) {
        const approval = effects.approvals.find((row) => row.proposal.proposalId === record.proposalId);
        assert.equal(approval.lifecycle.resolution, record.verb === 'approve' ? 'accepted' : 'rejected');
        if (record.verb === 'approve')
          assert.equal(approval.materialization.taskRef.ownerStateRef, `task:${record.taskId}`);
        else assert.equal(approval.materialization, undefined);
      }
      await page.getByTestId('mailbox-close').click();
      assert.equal(await draft.inputValue(), draftText);
      await page.reload();
      for (const record of chatRecords) {
        const card = page.locator(`[data-rich-block-id="${record.block.id}"]`),
          result = card.getByTestId('eval-repair-result');
        await card.getByTestId('decision-result-label').waitFor();
        await card.locator('button[aria-expanded="false"]').click();
        await result.waitFor();
        assert.equal(await card.getByTestId('approve-btn').count(), 0);
        if (record.verb === 'approve') assert.match(await result.innerText(), new RegExp(started));
      }
      await freeze(
        page,
        page.locator(`[data-rich-block-id="${chatRecords[0].block.id}"]`),
        path.join(evidence, 'Chat-cold-result.png'),
      );
      await page.getByTestId('mailbox-button').click();
      await panel.getByTestId('approval-item-inbox-native-approve').waitFor();
      for (const record of source.records)
        assert.equal(await panel.getByTestId(`approval-item-${record.proposalId}`).count(), 0);
      assert.ok(!fixture.reads.at(-1).items.some((item) => item.approval?.sourceFeatureId === 'F266'));
      assert.deepEqual(errors, []);
      await freeze(page, panel, path.join(evidence, 'Inbox-cold-retired.png'));
      await writeFile(
        path.join(evidence, 'proof.json'),
        JSON.stringify(
          {
            language,
            width,
            responses,
            effects,
            reads: fixture.reads,
            mutations: fixture.mutations,
            errors,
            draftPreserved: true,
            boundary:
              'Actual Next, original Ingress/service/adapter/routes and F100 canonical dispatcher with fixture-owned preexisting Tasks/lease read ports. Two original custody reservations; Tasks remain doing. No runtime dispatch, new approval producer/store, or whole17 acceptance.',
          },
          null,
          2,
        ),
      );
    });
  }
