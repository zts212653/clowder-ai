import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createInboxScheduleFixture } from './f322-inbox-schedule.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
const evidenceRoot = process.env.F322_INBOX_PARITY_EVIDENCE ?? path.join(tree, '.tmp/f322-schedule');
async function freeze(page, card) {
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
}
async function decide(page, card, record, word, responses, expected = 200) {
  const button = card.getByRole('button', { name: word, exact: true });
  await button.waitFor();
  await page.waitForFunction((el) => !el.disabled, await button.elementHandle());
  const pending = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname ===
        `/api/schedule-proposals/${record.proposalId}/${record.action === 'reject' ? 'reject' : 'approve'}` &&
      r.request().method() === 'POST',
  );
  await button.focus();
  await page.keyboard.press('Enter');
  const response = await pending,
    body = await response.json();
  responses.push({ path: new URL(response.url()).pathname, status: response.status(), body });
  assert.equal(response.status(), expected, JSON.stringify(body));
  if (expected === 200) assert.equal(body.status, record.action === 'reject' ? 'rejected' : 'approved');
}

for (const language of ['zh', 'en'])
  for (const width of [1440, 390])
    test(`F322 original scheduled task Chat and Inbox ${language} ${width}`, { timeout: 240000 }, async (t) => {
      const evidence = path.join(evidenceRoot, 'schedule', `${language}-${width}`);
      await mkdir(evidence, { recursive: true });
      const f = await createInboxScheduleFixture(language),
        source = f.approvalSources;
      const rejected = source.records.find((r) => r.action === 'reject');
      let env, server, browser, page;
      const errors = [],
        responses = [],
        decisions = [],
        render = [];
      t.after(async () => {
        try {
          if (page && !page.isClosed()) {
            await page.screenshot({ path: path.join(evidence, 'final.png'), fullPage: true });
            await writeFile(
              path.join(evidence, 'final-state.json'),
              JSON.stringify(
                {
                  text: await page.locator('body').innerText(),
                  errors,
                  responses,
                  decisions,
                  mutations: f.mutations,
                  reads: f.reads,
                  effects: await source.effects(),
                },
                null,
                2,
              ),
            );
          }
        } finally {
          const results = await Promise.allSettled([
            browser?.close(),
            server ? stopChild(server) : undefined,
            env?.cleanup(),
            f.close(),
          ]);
          const failures = results.filter((r) => r.status === 'rejected');
          if (failures.length)
            throw new AggregateError(
              failures.map((r) => r.reason),
              'Owned schedule journey cleanup failed',
            );
        }
      });
      const port = await availablePort();
      env = await createNextDevTestEnvironment(`f322-schedule-${language}-${width}`, {
        API_SERVER_PORT: String(f.apiPort),
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${f.apiPort}`,
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
        { cwd: web, env: env.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      for (const stream of [server.stdout, server.stderr])
        stream.on('data', (data) => writeFile(path.join(evidence, 'web.log'), data, { flag: 'a' }));
      const base = `http://127.0.0.1:${port}`;
      await waitForHttp(`${base}/thread/${rejected.thread.id}`, server);
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          /^\/api\/schedule-proposals\/[^/]+\/(approve|reject)$/.test(new URL(request.url()).pathname)
        )
          decisions.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
      });
      await page.addInitScript((lang) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', lang);
      }, language);
      await page.goto(`${base}/thread/${rejected.thread.id}?shell=v2`);
      const chat = page.locator(`[data-rich-block-id="${rejected.block.id}"]`),
        rejectWord = language === 'en' ? 'Reject' : '驳回';
      await chat.getByRole('button', { name: rejectWord, exact: true }).waitFor();
      await freeze(page, chat);
      const chatText = await chat.innerText();
      assert.ok(chatText.includes(rejected.task.display.label) && chatText.includes(rejected.destination.title));
      assert.ok(
        !chatText.includes(rejected.task.id) && !chatText.includes('default-user') && !chatText.includes('F139'),
      );
      render.push({ entrance: 'Chat', text: chatText, box: await chat.boundingBox() });
      await page.screenshot({ path: path.join(evidence, 'chat-before.png'), fullPage: true });
      await decide(page, chat, rejected, rejectWord, responses);
      await chat.getByTestId('decision-result-label').waitFor();
      await freeze(page, chat);
      assert.match(await chat.innerText(), language === 'en' ? /Rejected.*You/ : /已拒绝.*你/);
      await page.screenshot({ path: path.join(evidence, 'chat-result.png'), fullPage: true });
      const draft = page.locator('[data-testid="chat-input-composer-row"] textarea'),
        draftText = 'Preserved original scheduled-task draft';
      await draft.fill(draftText);
      await page.getByTestId('mailbox-button').click();
      for (const action of ['create', 'delete', 'recover']) {
        const record = source.records.find((r) => r.action === action),
          card = page.getByTestId(`schedule-approval-${record.proposalId}`);
        await card.waitFor();
        await freeze(page, card);
        const row = card.locator('xpath=ancestor::li'),
          text = await card.innerText();
        assert.equal(await row.getAttribute('data-expanded'), 'false');
        assert.equal(await row.getByTestId('mailbox-item-toggle').count(), 0);
        assert.ok(text.includes(record.task.display.label) && text.includes(record.destination.title));
        assert.ok(!text.includes(record.task.id) && !text.includes('default-user') && !text.includes('F139'));
        const disclosure = card.locator('details');
        assert.equal(await disclosure.getAttribute('open'), null);
        render.push({ entrance: 'Inbox', action, text, box: await card.boundingBox() });
        await page.screenshot({ path: path.join(evidence, `inbox-${action}-closed.png`), fullPage: true });
        const secondary = card.getByTestId('mailbox-row-secondary-actions');
        const actions = await secondary.getByRole('button').evaluateAll((elements) =>
          elements.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right };
          }),
        );
        assert.equal(actions.length, 2);
        assert.equal(actions[0].y, actions[1].y);
        await disclosure.locator('summary').click();
        const region = disclosure.getByRole('region');
        assert.equal(await region.evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 260), true);
        await region.focus();
        await page.keyboard.press('PageDown');
        await page.waitForFunction((el) => el.scrollTop > 0, await region.elementHandle());
        await freeze(page, card);
        await page.screenshot({ path: path.join(evidence, `inbox-${action}-open.png`), fullPage: true });
        const word =
          language === 'en'
            ? action === 'delete'
              ? 'Approve and permanently delete'
              : 'Approve and create'
            : action === 'delete'
              ? '批准并永久删除'
              : '批准并创建';
        if (action === 'recover') {
          source.failRegistrationOnce();
          await decide(page, card, record, word, responses, 500);
          assert.equal(source.store.getById(record.proposalId).status, 'applying');
          const resume = language === 'en' ? 'Retry execution' : '重试执行';
          await card.getByRole('button', { name: resume, exact: true }).waitFor();
          const recoveryRead = f.reads.at(-1),
            recoveryItem = recoveryRead.items.find((item) => item.approval?.proposalId === record.proposalId);
          assert.equal(recoveryRead.consistency.state, 'verified');
          assert.equal(recoveryItem.approval.resolution, 'accepted');
          assert.equal(recoveryItem.approval.inlineApprovable, false);
          assert.equal(recoveryItem.approval.materialization.state, 'outcome_unknown');
          assert.equal(
            await page.getByTestId('mailbox-group-other').getByTestId(`schedule-approval-${record.proposalId}`).count(),
            1,
          );
          assert.equal(await card.getByRole('button', { name: rejectWord, exact: true }).count(), 0);
          const reread = row.getByTestId('mailbox-approval-reread');
          if (await reread.count()) await reread.click();
          await freeze(page, card);
          await page.screenshot({ path: path.join(evidence, 'inbox-recovery.png'), fullPage: true });
          await decide(page, card, record, resume, responses);
        } else await decide(page, card, record, word, responses);
        const result = page.getByTestId('mailbox-retained-result').filter({ hasText: record.task.display.label });
        await result.waitFor();
        await page.waitForFunction(({ element, word }) => element.textContent.includes(word), {
          element: await result.elementHandle(),
          word:
            language === 'en'
              ? action === 'delete'
                ? 'Scheduled task permanently deleted'
                : 'Scheduled task created and registered'
              : action === 'delete'
                ? '定时任务已永久删除'
                : '定时任务已创建并注册',
        });
        await freeze(page, result);
        assert.match(await result.innerText(), language === 'en' ? /You/ : /你/);
        await page.screenshot({ path: path.join(evidence, `inbox-${action}-result.png`), fullPage: true });
      }
      const effects = await source.effects();
      assert.deepEqual(effects.tasks.map((t) => t.id).sort(), ['private-schedule-create', 'private-schedule-recover']);
      assert.deepEqual(effects.registered.sort(), ['private-schedule-create', 'private-schedule-recover']);
      assert.equal(effects.proposals.filter((p) => p.effectCheckpoint?.kind === 'create').length, 2);
      assert.equal(effects.proposals.filter((p) => p.effectCheckpoint?.kind === 'delete').length, 1);
      assert.equal(effects.proposals.filter((p) => p.status === 'approved' && p.effectCheckpoint).length, 3);
      assert.equal(effects.proposals.find((p) => p.proposalId === rejected.proposalId).status, 'rejected');
      assert.equal(decisions.length, 5);
      assert.equal(responses.length, 5);
      await page.getByTestId('mailbox-close').click();
      assert.equal(await draft.inputValue(), draftText);
      await page.reload();
      await chat.getByTestId('decision-result-label').waitFor();
      await page.screenshot({ path: path.join(evidence, 'chat-cold-result.png'), fullPage: true });
      await page.getByTestId('mailbox-button').click();
      await page.getByTestId('approval-item-inbox-native-approve').waitFor();
      const pendingPanel = page.getByTestId('mailbox-panel');
      assert.equal(await pendingPanel.locator('[data-testid^="schedule-approval-schedule-"]').count(), 0);
      assert.equal(f.reads.at(-1).items.filter((item) => item.approval?.sourceFeatureId === 'F139').length, 0);
      // The rejected original card remains in Chat as a durable result after leaving the pending list.
      assert.equal(await chat.getByTestId('decision-result-label').count(), 1);
      assert.equal(await chat.getByRole('button', { name: rejectWord, exact: true }).count(), 0);
      await freeze(page, pendingPanel);
      await page.screenshot({ path: path.join(evidence, 'pending-cold-retired.png'), fullPage: true });
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(evidence, 'proof.json'),
        JSON.stringify(
          {
            language,
            width,
            render,
            responses,
            decisions,
            effects,
            reads: f.reads,
            mutations: f.mutations,
            errors,
            draftPreserved: true,
            boundary:
              'Real Next/original session writer/private SQLite TaskRunner registration; never starts scheduler, provider, Redis, runtime/Alpha or whole17 acceptance.',
          },
          null,
          2,
        ),
      );
    });
