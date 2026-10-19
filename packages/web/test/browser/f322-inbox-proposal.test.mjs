import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { CALENDAR_THREAD } from './f310-work-calendar.fixture.mjs';
import { registerInformationJourneys } from './f322-inbox-information.journey.mjs';
import { registerOriginalApprovalJourneys } from './f322-inbox-original-approval.journey.mjs';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url));
const tree = path.resolve(web, '../..');
const evidenceRoot = process.env.F322_INBOX_PARITY_EVIDENCE ?? path.join(tree, '.tmp/f322-inbox-proposal');
registerOriginalApprovalJourneys(evidenceRoot);
registerInformationJourneys(evidenceRoot);

/** Keep the history owner's real reading input and the captured viewport in agreement. */
async function captureHistoryTarget(page, target, screenshotPath, detailPath) {
  // Editing/cancelling changes the real card height. Measure and wheel only
  // after that layout settles; a wheel against a collapsing card is a different gesture.
  await page.waitForFunction(
    async (element) => {
      const history = element.closest('[data-chat-container]');
      const measure = () => [element.getBoundingClientRect().height, history.scrollHeight];
      const before = measure();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return element.isConnected && measure().every((value, index) => Math.abs(value - before[index]) < 1);
    },
    await target.elementHandle(),
  );
  const port = await page.locator('[data-chat-container]').boundingBox();
  const box = await target.boundingBox();
  assert.ok(port);
  assert.ok(box);
  await target.evaluate((element) => {
    const history = element.closest('[data-chat-container]');
    const records = [];
    const sample = (event) => {
      if (records.length === 96) records.splice(32, 1);
      const port = history.getBoundingClientRect();
      const hit = document.elementFromPoint(port.x + 8, port.y + 24);
      records.push({
        event: event.type,
        at: performance.now(),
        deltaY: event.deltaY,
        connected: element.isConnected,
        scrollTop: history.scrollTop,
        scrollHeight: history.scrollHeight,
        bounds: element.getBoundingClientRect().toJSON(),
        viewport: port.toJSON(),
        hitTag: hit?.tagName,
        hitInHistory: history.contains(hit),
        saved: localStorage.getItem('cat-cafe:thread-scroll:thread-f310-calendar-contract'),
      });
    };
    const events = ['wheel', 'scroll', 'scrollend'];
    for (const event of events) history.addEventListener(event, sample, { passive: true });
    window.__f322CaptureTrace = () => {
      sample(new Event('capture-end'));
      for (const event of events) history.removeEventListener(event, sample);
      delete window.__f322CaptureTrace;
      return records;
    };
    sample(new Event('capture-start'));
  });
  try {
    await page.mouse.move(port.x + 8, port.y + 24);
    const wheelDelta = Math.round(box.y + box.height / 2 - (port.y + port.height / 2));
    await page.mouse.wheel(0, wheelDelta || -64);
    await page.waitForFunction(
      (element) => {
        const box = element.getBoundingClientRect();
        const port = element.closest('[data-chat-container]').getBoundingClientRect();
        return box.top >= port.top && box.bottom <= port.bottom;
      },
      await target.elementHandle(),
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const captured = await target.evaluate((element) => ({
      text: element.innerText,
      bounds: element.getBoundingClientRect().toJSON(),
      viewport: element.closest('[data-chat-container]').getBoundingClientRect().toJSON(),
    }));
    assert.ok(
      captured.bounds.top >= captured.viewport.top && captured.bounds.bottom <= captured.viewport.bottom,
      'The original card target must remain visible after the full-page capture',
    );
    if (detailPath) await target.screenshot({ path: detailPath });
    return captured;
  } finally {
    const trace = await page.evaluate(() => window.__f322CaptureTrace());
    await writeFile(`${screenshotPath}.trace.json`, JSON.stringify(trace, null, 2));
  }
}

for (const language of ['zh', 'en'])
  for (const width of [1440, 390])
    test(`F322 original new-conversation card ${language} ${width}`, { timeout: 180000 }, async (t) => {
      const evidence = path.join(evidenceRoot, `${language}-${width}`);
      await mkdir(evidence, { recursive: true });
      const fixture = await createInboxProposalFixture();
      let environment, server, browser;
      t.after(async () => {
        const cleanup = await Promise.allSettled([
          browser?.close(),
          (async () => {
            if (server) await stopChild(server);
            await environment?.cleanup();
          })(),
          fixture.close(),
        ]);
        await writeFile(
          path.join(evidence, 'cleanup.json'),
          JSON.stringify(
            cleanup.map((result) => ({
              status: result.status,
              ...(result.status === 'rejected' ? { reason: String(result.reason) } : {}),
            })),
            null,
            2,
          ),
        );
        const failed = cleanup.filter((result) => result.status === 'rejected');
        if (failed.length)
          throw new AggregateError(
            failed.map((result) => result.reason),
            'Owned proposal cleanup failed',
          );
      });
      const webPort = await availablePort();
      environment = await createNextDevTestEnvironment(`f322-inbox-proposal-${language}-${width}`, {
        API_SERVER_PORT: String(fixture.apiPort),
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
        FRONTEND_PORT: String(webPort),
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
          String(webPort),
        ],
        { cwd: web, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      server.stdout.on('data', (d) => writeFile(path.join(evidence, 'web.log'), d, { flag: 'a' }));
      server.stderr.on('data', (d) => writeFile(path.join(evidence, 'web.log'), d, { flag: 'a' }));
      await waitForHttp(`http://127.0.0.1:${webPort}/thread/${CALENDAR_THREAD}`, server);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.addInitScript((language) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', language);
        localStorage.setItem('theme', language === 'en' ? 'dark' : 'light');
      }, language);
      const labels =
        language === 'en'
          ? {
              edit: 'Edit',
              name: 'Conversation name:',
              parent: 'Parent conversation',
              project: 'Project (absolute path; leave blank to keep its current project):',
              members: 'Assigned cats (comma separated):',
              initial: 'Message source:',
              editInitial: 'Edit message source (Markdown)',
              cancel: 'Cancel changes',
              collaboration: 'Collaboration',
              reporting: 'Reporting',
              pin: 'Pin when created',
              approve: 'Approve with changes',
              reject: 'Reject',
            }
          : {
              edit: '编辑',
              name: '对话名:',
              parent: '父对话',
              project: '项目（绝对路径；留空保留原归属）:',
              members: '谁来做（逗号分隔）:',
              initial: '消息原文:',
              editInitial: '修改消息原文（Markdown）',
              cancel: '取消修改',
              collaboration: '协作方式',
              reporting: '回报方式',
              pin: '建好后置顶',
              approve: '按修改后的同意并创建',
              reject: '拒绝',
            };
      try {
        await page.goto(`http://127.0.0.1:${webPort}/thread/${CALENDAR_THREAD}?shell=v2`);
        const draft = page.locator('[data-testid="chat-input-composer-row"] textarea');
        await draft.fill('Original unsent draft for the native-card parity journey');
        await draft.evaluate((el) => el.setSelectionRange(3, 8));
        const chatCard = page.locator('[data-chat-container]').getByTestId('approval-item-inbox-native-approve');
        await chatCard.getByTestId('approve-btn').waitFor();
        // The card's proposal and parent conversation are separate owner reads.
        await chatCard.getByText('Parent project discussion', { exact: true }).waitFor();
        assert.match(await chatCard.innerText(), /Parent project discussion/);
        assert.equal((await chatCard.innerText()).includes(fixture.parent.id), false);
        assert.equal((await chatCard.innerText()).includes('final-only'), false);
        assert.equal((await chatCard.innerText()).includes('建议成员'), false);
        await chatCard.scrollIntoViewIfNeeded();
        await chatCard.getByRole('button', { name: labels.edit, exact: true }).click();
        const chatPreview = chatCard.getByTestId('proposal-initial-message-editor-preview');
        assert.equal(await chatPreview.locator('strong').first().innerText(), 'Start with the actual evidence');
        assert.equal((await chatPreview.innerText()).includes('**'), false);
        const chatEditRender = await captureHistoryTarget(
          page,
          chatPreview,
          path.join(evidence, 'chat-edit-formatted.png'),
          path.join(evidence, 'chat-edit-formatted-detail.png'),
        );
        await chatCard.getByRole('button', { name: labels.cancel, exact: true }).click();
        const chatClosedRender = await captureHistoryTarget(page, chatCard, path.join(evidence, 'chat-closed.png'));
        await page.getByTestId('mailbox-button').click();
        const row = page.getByTestId('mailbox-item').filter({ hasText: 'Native new conversation approve' });
        await row.getByTestId('approve-btn').waitFor();
        await page.waitForFunction(() => {
          const button = document.querySelector(
            '[data-testid="approval-item-inbox-native-approve"] [data-testid="approve-btn"]',
          );
          return button && !button.disabled;
        });
        await page.waitForFunction(() => {
          const panel = document.querySelector('[data-testid="mailbox-panel"]');
          return (
            panel &&
            getComputedStyle(panel).opacity === '1' &&
            panel.getAnimations().every((a) => a.playState === 'finished')
          );
        });
        assert.equal(await row.getAttribute('data-expanded'), 'false');
        assert.match(await row.innerText(), /Parent project discussion/);
        assert.equal((await row.innerText()).includes(fixture.parent.id), false);
        assert.match(await row.innerText(), /小太阳·砚砚/);
        assert.match(await row.innerText(), /gpt-6\.1-sol/);
        assert.equal((await row.innerText()).includes('codex61-sol'), false);
        const disclosure = row.getByTestId('proposal-initial-message');
        assert.equal(await disclosure.evaluate((el) => el.open), false);
        const geometry = await row.evaluate((el) => {
          const footer = el.querySelector('[data-testid="proposal-actions"]'),
            box = el.getBoundingClientRect(),
            buttons = [...footer.querySelectorAll('button')];
          return {
            rowHeight: box.height,
            overflow: el.scrollWidth > el.clientWidth,
            buttons: buttons.map((b) => ({
              label: b.textContent.trim(),
              disabled: b.disabled,
              width: b.getBoundingClientRect().width,
            })),
          };
        });
        assert.equal(geometry.overflow, false);
        assert.ok(
          geometry.rowHeight < 700,
          'a long initial task does not push the primary actions to a 1438px card bottom',
        );
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, 'closed.png'), fullPage: true });
        await disclosure.locator('summary').click();
        assert.equal(await disclosure.locator('strong').first().innerText(), 'Start with the actual evidence');
        const region = disclosure.getByRole('region');
        assert.equal(await region.evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 260), true);
        await region.focus();
        await page.keyboard.press('PageDown');
        await page.waitForFunction((el) => el.scrollTop > 0, await region.elementHandle());
        await row.getByTestId('approve-btn').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, 'open.png'), fullPage: true });
        await row.getByRole('button', { name: labels.edit, exact: true }).click();
        await row.getByLabel(labels.name, { exact: true }).fill('Edited controlled child');
        await row.getByLabel(labels.parent, { exact: true }).selectOption(fixture.alternateParent.id);
        await row.getByLabel(labels.project, { exact: true }).fill(tree);
        await row.getByLabel(labels.members, { exact: true }).fill('codex61-sol');
        const initialPreview = row.getByTestId('proposal-initial-message-editor-preview');
        assert.equal(await initialPreview.locator('strong').first().innerText(), 'Start with the actual evidence');
        await row.locator('summary').filter({ hasText: labels.editInitial }).click();
        await row
          .getByRole('textbox', { name: labels.initial, exact: true })
          .fill('**Edited controlled task**\n\nVerify only the disposable sample.');
        assert.equal(await initialPreview.locator('strong').first().innerText(), 'Edited controlled task');
        await row.getByLabel(labels.collaboration, { exact: true }).selectOption('parallel');
        await row.getByLabel(labels.reporting, { exact: true }).selectOption('none');
        await row.getByLabel(labels.pin, { exact: true }).check();
        await page.screenshot({ path: path.join(evidence, 'edit.png'), fullPage: true });
        const approved = page.waitForResponse(
          (r) => r.url().endsWith('/api/proposals/inbox-native-approve/approve') && r.request().method() === 'POST',
        );
        const primary = row.getByRole('button', { name: labels.approve, exact: true });
        await primary.focus();
        await page.keyboard.press('Enter');
        const approveResponse = await approved;
        assert.equal(approveResponse.status(), 200);
        const result = await approveResponse.json();
        // The choice must already be stored before the browser receives its reply.
        // A disappearing card or refresh can no longer cancel a second pin write.
        assert.deepEqual(fixture.approvalResponses, [
          { path: '/api/proposals/inbox-native-approve/approve', threadId: result.threadId, pinned: true },
        ]);
        await page.waitForURL((url) => url.pathname === `/thread/${result.threadId}`);
        const created = fixture.threads.get(result.threadId),
          approvedRecord = fixture.proposals.get('inbox-native-approve');
        assert.equal(approvedRecord.status, 'approved');
        assert.equal(created.title, 'Edited controlled child');
        assert.equal(created.parentThreadId, fixture.alternateParent.id);
        assert.equal(created.pinned, true);
        assert.equal(approvedRecord.reportingMode, 'none');
        assert.equal(approvedRecord.declaredWorkMode, 'parallel');
        assert.equal(approvedRecord.initialMessage, '**Edited controlled task**\n\nVerify only the disposable sample.');
        const seed = fixture.messages.getByThread(created.id, 100, 'default-user');
        assert.equal(seed.length, 1);
        assert.match(seed[0].content, /Edited controlled task/);
        assert.equal(
          fixture.original.getDraft(CALENDAR_THREAD)?.text,
          'Original unsent draft for the native-card parity journey',
        );
        await page.screenshot({ path: path.join(evidence, 'approved-navigation.png'), fullPage: true });
        await page.goto(`http://127.0.0.1:${webPort}/thread/${CALENDAR_THREAD}?shell=v2`);
        const reloadedThread = await page.request.get(`http://127.0.0.1:${fixture.apiPort}/api/threads/${created.id}`);
        assert.equal(reloadedThread.status(), 200);
        assert.equal((await reloadedThread.json()).pinned, true);
        const coldChatResult = page.locator('[data-chat-container]').getByTestId('approval-item-inbox-native-approve');
        await coldChatResult
          .getByRole('button', {
            name: language === 'en' ? 'Open new conversation' : '打开新对话',
            exact: true,
          })
          .waitFor();
        assert.match(
          await coldChatResult.innerText(),
          language === 'en' ? /Approved · Conversation created/ : /已同意 · 对话已创建/,
        );
        assert.equal(await coldChatResult.getByTestId('approve-btn').count(), 0);
        if (width === 1440) {
          const sidebarPin = page.locator(`[data-thread-id="${created.id}"]`).getByTestId('thread-pin-button');
          await sidebarPin.waitFor();
          assert.equal(await sidebarPin.getAttribute('aria-pressed'), 'true');
          await page.screenshot({ path: path.join(evidence, 'pin-after-refresh.png'), fullPage: true });
        }
        await page.getByTestId('mailbox-button').click();
        const rejectRow = page.getByTestId('mailbox-item').filter({ hasText: 'Native new conversation reject' });
        await rejectRow.getByTestId('reject-btn').waitFor();
        await page.waitForFunction(() => {
          const button = document.querySelector(
            '[data-testid="approval-item-inbox-native-reject"] [data-testid="reject-btn"]',
          );
          return button && !button.disabled;
        });
        const rejected = page.waitForResponse(
          (r) => r.url().endsWith('/api/proposals/inbox-native-reject/reject') && r.request().method() === 'POST',
        );
        await rejectRow.getByTestId('reject-btn').focus();
        await page.keyboard.press('Enter');
        assert.equal((await rejected).status(), 200);
        assert.equal(fixture.proposals.get('inbox-native-reject').status, 'rejected');
        const resultLine = page.getByTestId('mailbox-retained-line').filter({
          hasText: language === 'en' ? 'Rejected' : '已拒绝',
        });
        await resultLine.waitFor();
        await page.waitForFunction(() => {
          const panel = document.querySelector('[data-testid="mailbox-panel"]');
          return (
            panel &&
            getComputedStyle(panel).opacity === '1' &&
            panel.getAnimations().every((a) => a.playState === 'finished')
          );
        });
        await resultLine.scrollIntoViewIfNeeded();
        const resultPresentation = {
          language,
          text: await resultLine.innerText(),
          box: await resultLine.boundingBox(),
        };
        assert.equal(resultPresentation.text.includes('default-user'), false);
        assert.ok(resultPresentation.text.includes(language === 'en' ? 'You' : '你'));
        assert.ok(resultPresentation.box.x >= 0 && resultPresentation.box.x + resultPresentation.box.width <= width);
        await page.screenshot({ path: path.join(evidence, 'rejected.png'), fullPage: true });
        const decisionWrites = fixture.mutations.filter((m) =>
          /^\/api\/proposals\/[^/]+\/(approve|reject)$/.test(m.path),
        );
        assert.equal(decisionWrites.length, 2);
        assert.equal(decisionWrites[0].body.pinned, true);
        assert.equal(
          fixture.mutations.filter((m) => m.method === 'PATCH' && m.path === `/api/threads/${created.id}`).length,
          0,
        );
        assert.equal(
          fixture.mutations.some((m) => /ignored-items|taste-proposals|person-memory/.test(m.path)),
          false,
        );
        await writeFile(
          path.join(evidence, 'proof.json'),
          JSON.stringify(
            {
              language,
              width,
              controlled: true,
              sourceHead: process.env.F322_INBOX_PARITY_HEAD,
              geometry,
              chatEditRender,
              chatClosedRender,
              resultPresentation,
              approvedRecord,
              created,
              seed,
              rejectedRecord: fixture.proposals.get('inbox-native-reject'),
              decisionWrites,
              approvalResponses: fixture.approvalResponses,
              mutations: fixture.mutations,
              originalDraft: fixture.original.getDraft(CALENDAR_THREAD),
              providerBoundary:
                'Original proposal store/routes and seed materialization; provider dispatch dependencies intentionally absent, no execution claim.',
            },
            null,
            2,
          ),
        );
      } catch (error) {
        await writeFile(path.join(evidence, 'failure.txt'), String(error.stack ?? error));
        await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
        await writeFile(path.join(evidence, 'failure.html'), await page.content());
        throw error;
      }
    });
