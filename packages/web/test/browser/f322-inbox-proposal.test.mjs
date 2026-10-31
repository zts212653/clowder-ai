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
      fixture.threads.updateProjectPath(fixture.alternateParent.id, tree);
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
      const draftTraffic = [];
      page.on('response', (response) => {
        if (new URL(response.url()).pathname !== `/api/threads/${CALENDAR_THREAD}/composer-draft`) return;
        draftTraffic.push({
          method: response.request().method(),
          status: response.status(),
          body: response.request().postData(),
        });
      });
      await page.addInitScript((language) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', language);
        localStorage.setItem('theme', language === 'en' ? 'dark' : 'light');
      }, language);
      const labels =
        language === 'en'
          ? {
              edit: 'Edit',
              project: 'Project',
              firstMessage: 'First message',
              instruction: 'What should change?',
              revise: /^Ask .* to revise…$/,
              first: 'Starts first',
              pin: 'Pin',
              approve: 'Approve',
            }
          : {
              edit: '编辑',
              project: '项目',
              firstMessage: '第一条消息',
              instruction: '想怎么改？',
              revise: /^让.*改…$/,
              first: '先开口',
              pin: '置顶',
              approve: '同意',
            };
      try {
        await page.goto(`http://127.0.0.1:${webPort}/thread/${CALENDAR_THREAD}?shell=v2`);
        const draft = page.locator('[data-testid="chat-input-composer-row"] textarea');
        const originalDraftSaved = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `/api/threads/${CALENDAR_THREAD}/composer-draft` &&
            response.request().method() === 'PUT' &&
            response.request().postDataJSON()?.text === 'Original unsent draft for the native-card parity journey',
        );
        // Observe from typing onward, but keep navigation racing the real asynchronous owner write.
        void originalDraftSaved.catch(() => {});
        await draft.fill('Original unsent draft for the native-card parity journey');
        await draft.evaluate((el) => el.setSelectionRange(3, 8));
        const chatCard = page.locator('[data-chat-container]').getByTestId('approval-item-inbox-native-approve');
        await chatCard.getByTestId('approve-btn').waitFor();
        // V2 identifies the source conversation; the parent remains in the stored proposal.
        await chatCard.getByText(/Controlled source conversation/).waitFor();
        assert.equal((await chatCard.innerText()).includes(fixture.parent.id), false);
        assert.equal((await chatCard.innerText()).includes('final-only'), false);
        assert.equal((await chatCard.innerText()).includes('建议成员'), false);
        assert.equal(await chatCard.getByRole('button', { name: labels.edit, exact: true }).count(), 0);
        assert.equal(await chatCard.getByText(labels.first, { exact: true }).count(), 1);
        assert.equal(await chatCard.getByTestId('proposal-auto-mentions').count(), 1);
        await chatCard.scrollIntoViewIfNeeded();
        await chatCard.getByRole('button', { name: labels.revise }).click();
        const instruction = chatCard.getByRole('textbox', { name: labels.instruction, exact: true });
        await instruction.fill('Keep this instruction local until I send it.');
        const chatPreview = chatCard.getByRole('region', { name: labels.firstMessage, exact: true });
        assert.equal(await chatPreview.locator('strong').first().innerText(), 'Start with the actual evidence');
        assert.equal((await chatPreview.innerText()).includes('**'), false);
        const chatRevisionRender = await captureHistoryTarget(
          page,
          chatPreview,
          path.join(evidence, 'chat-revision-formatted.png'),
          path.join(evidence, 'chat-revision-formatted-detail.png'),
        );
        await instruction.focus();
        await page.keyboard.press('Escape');
        assert.equal(await instruction.count(), 0);
        assert.equal(
          fixture.mutations.some((m) => m.path.endsWith('/request-revision')),
          false,
        );
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
        assert.match(await row.innerText(), /Controlled source conversation/);
        assert.equal((await row.innerText()).includes(fixture.parent.id), false);
        assert.match(await row.innerText(), /小太阳·砚砚/);
        assert.match(await row.innerText(), /gpt-6\.1-sol/);
        assert.equal((await row.innerText()).includes('codex61-sol'), false);
        const disclosure = row.getByTestId('proposal-initial-message');
        assert.equal(await disclosure.evaluate((el) => el.open), true);
        const geometry = await row.evaluate((el) => {
          const footer = el.querySelector('[data-testid="proposal-actions"]'),
            card = el.querySelector('[data-testid="approval-item-inbox-native-approve"]'),
            box = el.getBoundingClientRect(),
            buttons = [...footer.querySelectorAll('button')];
          return {
            rowHeight: box.height,
            cardHeight: card.getBoundingClientRect().height,
            overflow: el.scrollWidth > el.clientWidth,
            buttons: buttons.map((b) => ({
              label: b.textContent.trim(),
              disabled: b.disabled,
              width: b.getBoundingClientRect().width,
            })),
          };
        });
        await writeFile(path.join(evidence, 'geometry.json'), JSON.stringify(geometry, null, 2));
        assert.equal(geometry.overflow, false);
        assert.ok(
          geometry.rowHeight < page.viewportSize().height,
          'the bounded first message keeps the full Inbox item within the tested viewport, including a wrapped footer',
        );
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, 'closed.png'), fullPage: true });
        assert.equal(await disclosure.locator('strong').first().innerText(), 'Start with the actual evidence');
        const region = disclosure.getByRole('region', { name: labels.firstMessage, exact: true });
        assert.equal(await region.evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 260), true);
        await region.focus();
        await page.keyboard.press('PageDown');
        await page.waitForFunction((el) => el.scrollTop > 0, await region.elementHandle());
        await row.getByTestId('approve-btn').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, 'open.png'), fullPage: true });
        assert.equal(await row.getByRole('button', { name: labels.edit, exact: true }).count(), 0);
        await row.getByRole('combobox', { name: labels.project, exact: true }).click();
        await row.getByRole('option', { name: path.basename(tree), exact: true }).click();
        await row.getByRole('switch', { name: labels.pin, exact: true }).check();
        await page.screenshot({ path: path.join(evidence, 'inline-choices.png'), fullPage: true });
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
        assert.equal(created.title, 'Native new conversation approve');
        assert.equal(created.parentThreadId, fixture.parent.id);
        assert.equal(created.projectPath, tree);
        assert.equal(created.pinned, true);
        assert.equal(approvedRecord.reportingMode, 'final-only');
        assert.equal(approvedRecord.declaredWorkMode, 'investigation');
        assert.deepEqual(approvedRecord.preferredCats, ['codex61-sol']);
        assert.equal(approvedRecord.initialMessage, fixture.proposals.get('inbox-native-reject').initialMessage);
        const seed = fixture.messages.getByThread(created.id, 100, 'default-user');
        assert.equal(seed.length, 1);
        assert.match(seed[0].content, /Start with the actual evidence/);
        assert.equal((await originalDraftSaved).status(), 200);
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
            name: language === 'en' ? 'Open ›' : '打开 ›',
            exact: true,
          })
          .waitFor();
        assert.match(
          await coldChatResult.innerText(),
          language === 'en' ? /Approved · conversation opened/ : /已同意 · 对话已开/,
        );
        assert.equal(await coldChatResult.getByTestId('approve-btn').count(), 0);
        assert.equal(await coldChatResult.getByTestId('proposal-result-details').count(), 0);
        const summary = coldChatResult.getByTestId('proposal-result-label').locator('..');
        await summary.scrollIntoViewIfNeeded();
        await coldChatResult.screenshot({ path: path.join(evidence, 'chat-approved-result.png') });
        const rowBefore = await coldChatResult.boundingBox();
        assert.ok(rowBefore.height < 60, 'decided Chat proposal is a single result line');
        await summary.focus();
        await page.keyboard.press('Enter');
        await coldChatResult.getByTestId('proposal-result-details').waitFor();
        assert.match(await coldChatResult.innerText(), /Native new conversation approve/);
        await coldChatResult.getByTestId('proposal-initial-message').locator('summary').click();
        await coldChatResult.screenshot({ path: path.join(evidence, 'chat-approved-details.png') });
        await summary.click();
        assert.equal(await coldChatResult.getByTestId('proposal-result-details').count(), 0);
        await coldChatResult.getByTestId('proposal-result-open').click();
        await page.waitForURL((url) => url.pathname === `/thread/${created.id}`);
        await page.goto(`http://127.0.0.1:${webPort}/thread/${CALENDAR_THREAD}?shell=v2`);

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
        const resultLine = page.getByTestId('proposal-result-label').filter({
          hasText: language === 'en' ? 'Declined' : '已拒绝',
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
        assert.match(resultPresentation.text, / · \d{2}:\d{2}$/);
        assert.equal(await resultLine.locator('..').getAttribute('aria-expanded'), 'false');
        assert.ok(resultPresentation.box.x >= 0 && resultPresentation.box.x + resultPresentation.box.width <= width);
        await page.screenshot({ path: path.join(evidence, 'rejected.png'), fullPage: true });
        await resultLine.locator('..').click();
        await page.getByTestId('proposal-result-details').waitFor();
        assert.match(await page.getByTestId('proposal-result-details').innerText(), language === 'en' ? /You/ : /你/);
        await page.getByTestId('mailbox-panel').screenshot({ path: path.join(evidence, 'inbox-declined-details.png') });
        await page.getByTestId('mailbox-close').click();
        await page.reload();
        const rejectedCard = page.locator('[data-chat-container]').getByTestId('approval-item-inbox-native-reject');
        await rejectedCard.getByTestId('proposal-result-label').waitFor();
        await rejectedCard.scrollIntoViewIfNeeded();
        assert.match(
          await rejectedCard.innerText(),
          language === 'en' ? /Declined · \d{2}:\d{2}/ : /已拒绝 · \d{2}:\d{2}/,
        );
        assert.equal(await rejectedCard.getByRole('link').count(), 0);
        await rejectedCard.screenshot({ path: path.join(evidence, 'chat-declined-result.png') });

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
              chatRevisionRender,
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
        await writeFile(
          path.join(evidence, 'failure-draft.json'),
          JSON.stringify({ originalDraft: fixture.original.getDraft(CALENDAR_THREAD), draftTraffic }, null, 2),
        );
        await writeFile(path.join(evidence, 'failure.txt'), String(error.stack ?? error));
        await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
        await writeFile(path.join(evidence, 'failure.html'), await page.content());
        throw error;
      }
    });
