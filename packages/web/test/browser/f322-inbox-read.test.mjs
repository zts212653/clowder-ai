import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { CALENDAR_THREAD } from './f310-work-calendar.fixture.mjs';
import { createInboxReadFixture } from './f322-inbox-read.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url));
const tree = path.resolve(web, '../..');
const evidenceRoot = process.env.F322_INBOX_READ_EVIDENCE ?? path.join(tree, '.tmp/f322-inbox-read');

async function settledPanel(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="mailbox-panel"]');
    return el && getComputedStyle(el).opacity === '1' && el.getAnimations().every((a) => a.playState === 'finished');
  });
}

for (const language of ['zh', 'en'])
  for (const width of [1440, 390])
    test(`F322 original inbox and sidebar read close mentions ${language} ${width}`, { timeout: 180000 }, async (t) => {
      const evidence = path.join(evidenceRoot, `${language}-${width}`);
      await mkdir(evidence, { recursive: true });
      const fixture = await createInboxReadFixture();
      t.after(() => fixture.close());
      const webPort = await availablePort();
      const environment = await createNextDevTestEnvironment(`f322-inbox-read-${language}-${width}`, {
        API_SERVER_PORT: String(fixture.apiPort),
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
        FRONTEND_PORT: String(webPort),
      });
      t.after(() => environment.cleanup());
      const server = spawn(
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
      t.after(() => stopChild(server));
      for (const stream of [server.stdout, server.stderr])
        stream.on('data', (d) => writeFile(path.join(evidence, 'web.log'), d, { flag: 'a' }));
      await waitForHttp(`http://127.0.0.1:${webPort}/thread/${CALENDAR_THREAD}`, server);
      const browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {}),
      });
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const observedReads = [],
        pendingReadObservations = [];
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (!/\/api\/threads\/[^/]+\/read\/latest$/.test(url.pathname)) return;
        pendingReadObservations.push(
          response
            .json()
            .catch(() => null)
            .then((body) => {
              observedReads.push({ path: url.pathname, status: response.status(), body });
            }),
        );
      });
      await page.addInitScript((language) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', language);
        localStorage.setItem('theme', language === 'en' ? 'dark' : 'light');
      }, language);
      const base = `http://127.0.0.1:${webPort}`;
      const rowFor = (title) => page.getByTestId('mailbox-item').filter({ hasText: title });
      const historyRowFor = (title) => page.getByTestId('mailbox-history-row').filter({ hasText: title });
      const sidebarRow = (id) => page.getByTestId('sidebar-thread-list').locator(`[data-thread-id="${id}"]`);
      const ensureSidebar = async () => {
        const expand = page.getByTestId('header-sidebar-expand');
        if (await expand.isVisible()) await expand.click();
      };
      const openMailbox = async () => {
        if (!(await page.getByTestId('mailbox-panel').count())) {
          // On mobile the real sidebar overlays the world rail. Close it through
          // its original control before returning to the inbox; never force-click
          // the obscured rail button or bypass either navigation entrance.
          if (width < 768) {
            const collapse = page.getByTestId('sidebar-collapse');
            if (await collapse.isVisible()) await collapse.click();
          }
          await page.getByTestId('mailbox-button').click();
        }
        await settledPanel(page);
      };
      try {
        await page.goto(`${base}/thread/${CALENDAR_THREAD}?shell=v2`);
        const draft = page.locator('[data-testid="chat-input-composer-row"] textarea');
        await draft.fill('Unsent draft retained across both mention-reading entrances');
        await ensureSidebar();
        await sidebarRow(fixture.inbox.thread.id).getByTestId('thread-row-mention').waitFor();
        await sidebarRow(fixture.sidebar.thread.id).getByTestId('thread-row-mention').waitFor();
        await openMailbox();
        await rowFor('Read from the inbox').waitFor();
        assert.equal(await rowFor('Read from the sidebar').count(), 1);
        assert.equal(await rowFor('Foreign owner request').count(), 0);
        await page.screenshot({ path: path.join(evidence, 'pending.png'), fullPage: true });
        // The real inbox original-place control navigates to the exact original message.
        const inboxRead = page.waitForResponse(
          (r) =>
            r.url().endsWith(`/api/threads/${fixture.inbox.thread.id}/read/latest`) &&
            r.request().method() === 'POST' &&
            r.status() === 200,
        );
        await rowFor('Read from the inbox').getByTestId('mailbox-open-original').click();
        await page.waitForURL((url) => url.pathname === `/thread/${fixture.inbox.thread.id}`);
        await page.getByText(fixture.inbox.message.content, { exact: true }).waitFor();
        await page.waitForFunction((id) => window.location.pathname === `/thread/${id}`, fixture.inbox.thread.id);
        assert.equal((await (await inboxRead).json()).caughtUp, true);
        assert.equal(
          fixture.messages.listUserMentionRequests('default-user').some((m) => m.id === fixture.inbox.message.id),
          false,
        );
        await ensureSidebar();
        await sidebarRow(fixture.inbox.thread.id).waitFor();
        await sidebarRow(fixture.inbox.thread.id).getByTestId('thread-row-mention').waitFor({ state: 'detached' });
        await page.screenshot({ path: path.join(evidence, 'inbox-original.png'), fullPage: true });
        // Return through the original navigation. The second entrance is the actual sidebar link.
        await page.goto(`${base}/thread/${CALENDAR_THREAD}?shell=v2`);
        await openMailbox();
        await rowFor('Read from the sidebar').waitFor();
        assert.equal(await rowFor('Read from the inbox').count(), 0);
        await page.getByTestId('mailbox-close').click();
        await ensureSidebar();
        const sidebarLink = page
          .getByTestId('sidebar-thread-list')
          .getByRole('link', { name: 'Read from the sidebar', exact: true });
        const sidebarRead = page.waitForResponse(
          (r) =>
            r.url().endsWith(`/api/threads/${fixture.sidebar.thread.id}/read/latest`) &&
            r.request().method() === 'POST' &&
            r.status() === 200,
        );
        await sidebarLink.click();
        await page.waitForURL((url) => url.pathname === `/thread/${fixture.sidebar.thread.id}`);
        await page.getByText(fixture.sidebar.message.content, { exact: true }).waitFor();
        assert.equal((await (await sidebarRead).json()).caughtUp, true);
        await ensureSidebar();
        await sidebarRow(fixture.sidebar.thread.id).getByTestId('thread-row-mention').waitFor({ state: 'detached' });
        await openMailbox();
        await page.waitForFunction(() =>
          document
            .querySelector('[data-testid="mailbox-group-mentions"]')
            ?.textContent?.match(/暂无 @你 请求|No @you requests/),
        );
        assert.equal(fixture.messages.listUserMentionRequests('default-user').length, 0);
        assert.equal(
          fixture.records.every((r) => fixture.proposals.get(r.proposalId).status === 'pending'),
          true,
          'reading never settles either original approval',
        );
        await page.getByTestId('mailbox-history').click();
        await page.getByTestId('mailbox-history-tab-mentions').click();
        await historyRowFor('Read from the inbox').waitFor();
        await historyRowFor('Read from the sidebar').waitFor();
        const viewedLabel = language === 'en' ? 'Viewed' : '看过';
        for (const title of ['Read from the inbox', 'Read from the sidebar']) {
          await historyRowFor(title).getByTestId('mailbox-history-item-toggle').click();
          assert.equal(await rowFor(title).getByTestId('mailbox-mention-handled-reason').innerText(), viewedLabel);
          await rowFor(title).getByText(title, { exact: true }).waitFor();
        }
        await settledPanel(page);
        await page.screenshot({ path: path.join(evidence, 'handled-viewed.png'), fullPage: true });
        await page.reload();
        await openMailbox();
        await page.getByTestId('mailbox-history').click();
        await page.getByTestId('mailbox-history-tab-mentions').click();
        await historyRowFor('Read from the inbox').waitFor();
        assert.equal(
          fixture.messages.getUserMentionHandlingMetadata('default-user')[fixture.inbox.message.id].reason,
          'viewed',
        );
        // A new request in the already-read conversation remains pending until that new request is actually read.
        const latest = fixture.messages.append({
          userId: 'default-user',
          threadId: fixture.inbox.thread.id,
          from: { kind: 'agent', catId: 'codex61-sol' },
          mentionsUser: true,
          content: 'A newly published request remains pending',
          timestamp: Date.now(),
        });
        assert.equal(fixture.messages.listUserMentionRequests('default-user')[0].id, latest.id);
        const replied = fixture.request('Answered in the original conversation');
        fixture.messages.append({
          userId: 'default-user',
          threadId: replied.thread.id,
          from: { kind: 'user', userId: 'default-user' },
          content: 'Controlled human answer at the original source',
          timestamp: Date.now(),
        });
        assert.equal(
          fixture.messages.getUserMentionHandlingMetadata('default-user')[replied.message.id].reason,
          'replied',
        );
        await page.goto(`${base}/thread/${CALENDAR_THREAD}?shell=v2`);
        await openMailbox();
        await rowFor('A newly published request remains pending').waitFor();
        await page.getByTestId('mailbox-history').click();
        await page.getByTestId('mailbox-history-tab-mentions').click();
        await historyRowFor('Answered in the original conversation').getByTestId('mailbox-history-item-toggle').click();
        await rowFor('Answered in the original conversation').waitFor();
        assert.equal(
          await rowFor('Answered in the original conversation')
            .getByTestId('mailbox-mention-handled-reason')
            .innerText(),
          language === 'en' ? 'Replied' : '回了话',
        );
        await settledPanel(page);
        await page.screenshot({ path: path.join(evidence, 'handled-replied.png'), fullPage: true });
        assert.equal(
          fixture.mutations.some((m) => /ignored-items/.test(m.path) && m.method === 'PATCH'),
          false,
        );
        assert.equal(
          fixture.mutations.some((m) => /\/proposals\/.*\/(approve|reject)$/.test(m.path)),
          false,
        );
        assert.equal(
          fixture.original.getDraft(CALENDAR_THREAD).text,
          'Unsent draft retained across both mention-reading entrances',
        );
        await Promise.all(pendingReadObservations);
        await writeFile(
          path.join(evidence, 'proof.json'),
          JSON.stringify(
            {
              language,
              width,
              sourceHead: process.env.F322_INBOX_READ_HEAD,
              readReceipts: fixture.readReceipts,
              observedReads,
              source: { inbox: fixture.inbox, sidebar: fixture.sidebar, foreign: fixture.foreign, replied, latest },
              cursors: [...fixture.cursors.values()],
              pending: fixture.messages.listUserMentionRequests('default-user'),
              history: fixture.messages.listHandledUserMentions('default-user'),
              causes: fixture.messages.getUserMentionHandlingMetadata('default-user'),
              mutations: fixture.mutations,
              draft: fixture.original.getDraft(CALENDAR_THREAD),
              boundary:
                'Original MessageStore/routes/projection and ephemeral cursor port; no Redis durability or provider-execution claim. Human reply is a controlled canonical append, not an actual provider chat send.',
            },
            null,
            2,
          ),
        );
      } catch (error) {
        await Promise.all(pendingReadObservations);
        await writeFile(
          path.join(evidence, 'failure-state.json'),
          JSON.stringify(
            {
              observedReads,
              serverReadReceipts: fixture.readReceipts,
              cursors: [...fixture.cursors.values()],
              pending: fixture.messages.listUserMentionRequests('default-user'),
              url: page.url(),
              document: await page.evaluate(() => ({
                visibility: document.visibilityState,
                focused: document.hasFocus(),
              })),
              error: error.message,
            },
            null,
            2,
          ),
        );
        await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
        await writeFile(path.join(evidence, 'failure.html'), await page.content());
        throw error;
      }
    });
