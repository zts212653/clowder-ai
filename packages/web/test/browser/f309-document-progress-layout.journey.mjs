import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openWorkspaceTools } from './f307-workspace-open.mjs';
import { createDocumentRequest } from './f309-ordinary-document-request.mjs';
import { openDocumentSession } from './f309-ordinary-document-session.mjs';
import { EVIDENCE } from './f309-ordinary-workspace-journey-chat-progress.mjs';

const PROJECTION_EVENT = 'cat-cafe:entrusted-work-projection-invalidated';

async function geometry(paper, passage) {
  return {
    paper: await paper.evaluate((node) => ({ top: node.getBoundingClientRect().top, scrollTop: node.scrollTop })),
    passage: await passage.evaluate((node) => node.getBoundingClientRect().top),
  };
}

export function registerDocumentProgressLayoutJourneys(suite) {
  for (const [width, requestCount] of [
    [1440, 1],
    [390, 2],
  ]) {
    test(
      `document progress: delayed owner read preserves native selection at ${width}px`,
      { timeout: 120_000 },
      async () => {
        const f = await createDocumentRequest();
        let session;
        let releaseRead;
        const pendingRead = new Promise((resolve) => {
          releaseRead = resolve;
        });
        let observedRead;
        const readStarted = new Promise((resolve) => {
          observedRead = resolve;
        });
        try {
          const records = [f.record];
          if (requestCount === 2) records.push((await f.shareResponsibility()).record);
          await f.owner.artifacts.dispatcher.drain();
          const taskCount = f.owner.tasks.listByThread(f.owner.thread.id).length;
          for (let index = 0; index < 12; index++) {
            f.owner.messages.append({
              userId: 'operator',
              threadId: f.owner.thread.id,
              from: { kind: 'user', userId: 'operator' },
              mentions: [],
              timestamp: 1,
              content: `An earlier untaken quote ${index}`,
              contentBlocks: f.message.contentBlocks,
            });
          }
          session = await openDocumentSession(suite, f.owner, { width, dark: width === 390 });
          const { page, calls } = session;
          await page.locator(`[data-message-id="${f.message.id}"] [data-testid="modification-progress"]`).waitFor();
          // Delay only the real document owner's initial response. Chat has already read the same original request.
          await page.route(
            '**/api/workspace/content-reviews/prepare',
            async (route) => {
              observedRead();
              await pendingRead;
              const url = new URL(route.request().url());
              const response = await route.fetch({ url: `${f.owner.api}${url.pathname}${url.search}` });
              await route.fulfill({ response });
            },
            { times: 1 },
          );
          const tools = await openWorkspaceTools(page);
          await tools.getByTestId('workspace-launcher-search').fill(f.filename);
          await tools
            .getByTestId('workspace-launcher-file-result')
            .filter({ has: page.getByText(f.filename, { exact: true }) })
            .first()
            .click();
          const paper = page.getByTestId('workspace-content-review-text');
          await paper.waitFor();
          await readStarted;
          await page.locator('[data-file-quote-mark]').first().waitFor();
          const identity = await paper.elementHandle();
          const text = 'Second unique paragraph.';
          const passage = paper.getByText(text, { exact: true });
          await passage.scrollIntoViewIfNeeded();
          const before = await geometry(paper, passage);
          const rect = await passage.evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const bounds = range.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right, y: bounds.top + bounds.height / 2 };
          });
          await page.mouse.move(rect.left + 0.1, rect.y);
          await page.mouse.down();
          await page.mouse.move((rect.left + rect.right) / 2, rect.y, { steps: 4 });
          releaseRead();
          const progress = page.getByTestId('text-work-progress');
          await progress.getByRole('button', { name: '取消修改', exact: true }).first().waitFor();
          await page.waitForFunction(
            (count) =>
              document.querySelectorAll('[data-testid="text-work-progress"] [data-testid="modification-progress"]')
                .length === count,
            requestCount,
          );
          const during = await geometry(paper, passage);
          await page.mouse.move(rect.right + 0.1, rect.y, { steps: 4 });
          await page.mouse.up();
          const selected = await page.evaluate(() => window.getSelection()?.toString().trim());
          await mkdir(EVIDENCE, { recursive: true });
          await writeFile(
            `${EVIDENCE}/document-progress-layout-${width}.json`,
            JSON.stringify({ before, during, selected, requestCount }, null, 2),
          );
          assert.deepEqual(during, before, 'a delayed progress read must not move the text during a native drag');
          assert.equal(selected, text);
          assert.equal(
            await identity.evaluate(
              (node) => node === document.querySelector('[data-testid="workspace-content-review-text"]'),
            ),
            true,
          );
          const slot = page.getByTestId('text-work-progress-slot');
          assert.equal(
            (await slot.boundingBox()).height,
            32,
            'one document slot, independent of historical and active request counts',
          );
          await page.screenshot({ path: `${EVIDENCE}/document-progress-layout-${width}.png` });

          let failRead = true;
          await page.route(`**/api/content-modifications/${f.record.requestId}`, (route) =>
            failRead && route.request().method() === 'GET'
              ? route.fulfill({
                  status: 503,
                  contentType: 'application/json',
                  body: '{"error":"controlled_read_failure"}',
                })
              : route.fallback(),
          );
          await page.evaluate((event) => window.dispatchEvent(new Event(event)), PROJECTION_EVENT);
          await slot.locator('[data-state="unavailable"]').waitFor();
          assert.deepEqual(await geometry(paper, passage), before, 'read failure stays inside the same slot');
          failRead = false;
          await slot.getByRole('button', { name: '重新加载', exact: true }).click();
          await slot.locator('[data-state="unavailable"]').waitFor({ state: 'hidden' });
          for (let index = 0; index < requestCount; index++) {
            await slot.getByRole('button', { name: '取消修改', exact: true }).first().click();
            await page.waitForFunction(
              (remaining) =>
                document.querySelectorAll('[data-testid="text-work-progress-slot"] button[aria-label="取消修改"]')
                  .length === remaining,
              requestCount - index - 1,
            );
          }
          assert.deepEqual(
            calls
              .filter((call) => call.method === 'POST' && call.path.endsWith('/cancel'))
              .map((call) => call.path)
              .sort(),
            records.map((record) => `/api/content-modifications/${record.requestId}/cancel`).sort(),
          );
          // Each real request admitted its own queued provider turn. Releasing the first
          // starts the next; close only after that exact turn has actually awakened.
          for (const record of records) {
            const view = await f.owner.integration.requests.read(record.requestId, f.owner.human);
            await f.owner.driver.waitForAwakening(view.execution.messageId);
            await f.owner.driver.close();
          }
          await page.evaluate((event) => window.dispatchEvent(new Event(event)), PROJECTION_EVENT);
          await page.waitForFunction(
            () =>
              document.querySelectorAll('[data-testid="text-work-progress-slot"] [data-testid="modification-progress"]')
                .length === 0,
          );
          assert.deepEqual(await geometry(paper, passage), before, 'terminal requests leave the reader in place');
          assert.equal((await slot.boundingBox()).height, 32);
          assert.equal(f.owner.tasks.listByThread(f.owner.thread.id).length, taskCount);
          assert.deepEqual(session.errors, []);
          assert.deepEqual(f.owner.errors, []);
        } finally {
          releaseRead();
          await session?.page.mouse.up();
          await session?.context.unrouteAll({ behavior: 'ignoreErrors' });
          await session?.context.close();
          await f.close();
        }
      },
    );
  }
}
