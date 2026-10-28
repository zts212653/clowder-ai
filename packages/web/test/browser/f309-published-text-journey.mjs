import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { collapseV2Workspace } from './f307-workspace-open.mjs';
import { startRealDocumentOwner } from './f309-ordinary-document-owner.mjs';
import { openDocumentSession } from './f309-ordinary-document-session.mjs';
import { EVIDENCE } from './f309-ordinary-workspace-journey-chat-progress.mjs';

const BODY = '# Published copy\n\nOriginal words.\n\nAnother paragraph.\n';
const RAW_PHRASE = 'Another paragraph.';

async function select(page, node, actionId, comment) {
  await node.scrollIntoViewIfNeeded();
  const box = await node.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(box.left + 0.1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.right + 0.1, box.y, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId(actionId).click();
  const editor = page.getByTestId('context-annotation-comment');
  await editor.fill(comment);
  await editor.press('Enter');
  await editor.waitFor({ state: 'hidden' });
}

async function closeMobileWorkspace(page, width) {
  if (width >= 768) return;
  const drawer = page.getByTestId('contextual-workspace-host');
  if (!(await drawer.isVisible())) return;
  await collapseV2Workspace(page);
}

/** Real Next, original file-open/reader/composer and production quote schema. Session/assets/send issuer are private fixtures. */
export function registerPublishedTextJourneys(suite) {
  for (const scenario of [
    { width: 1440, dark: false, shell: 'v2' },
    { width: 390, dark: true, shell: 'v2' },
  ]) {
    test(
      `published text: original read-only reader and exact file quotes ${scenario.width}`,
      { timeout: 120_000 },
      async () => {
        await mkdir(EVIDENCE, { recursive: true });
        const data = await mkdtemp('/tmp/f309-published-text-');
        const owner = await startRealDocumentOwner(path.join(data, 'owner'));
        let session;
        const sent = [],
          assetReads = [];
        const file = {
          kind: 'file',
          id: 'published-document-file',
          v: 1,
          fileName: 'published.md',
          url: '/uploads/doc-native-published.md',
          mimeType: 'text/markdown',
          fileSize: Buffer.byteLength(BODY),
        };
        const original = owner.messages.append({
          userId: 'operator',
          threadId: owner.thread.id,
          from: { kind: 'agent', catId: owner.catId },
          content: 'Published document.',
          timestamp: 41,
          extra: { rich: { blocks: [file] } },
        });
        const { projectMessageArtifacts } = await import(
          '../../../api/dist/domains/cats/services/agents/routing/thread-artifacts-aggregator.js'
        );
        const artifacts = projectMessageArtifacts([original]);
        assert.equal(artifacts.length, 1);
        const tasksBefore = owner.tasks.listByThread(owner.thread.id).length;
        try {
          session = await openDocumentSession(suite, owner, {
            ...scenario,
            beforeNavigate: async (context, calls) => {
              await context.route(`**/api/threads/${owner.thread.id}/artifacts`, (route) =>
                route.fulfill({
                  status: 200,
                  contentType: 'application/json',
                  body: JSON.stringify({ artifacts, lineage: 'complete' }),
                }),
              );
              await context.route('**/uploads/**', async (route) => {
                assert.equal(new URL(route.request().url()).pathname, file.url);
                assetReads.push({ url: route.request().url(), method: route.request().method() });
                await route.fulfill({ status: 200, contentType: 'text/markdown', body: BODY });
              });
              await context.route('**/api/messages', async (route) => {
                if (route.request().method() !== 'POST') return route.fallback();
                const { sendMessageSchema, buildMessageContentBlocks } = await import(
                  '../../../api/dist/routes/messages.schema.js'
                );
                const input = sendMessageSchema.parse(route.request().postDataJSON());
                const message = owner.messages.append({
                  userId: 'operator',
                  threadId: owner.thread.id,
                  from: { kind: 'user', userId: 'operator' },
                  timestamp: Date.now(),
                  content: input.content,
                  contentBlocks: buildMessageContentBlocks(input.content, input.contextAttachments),
                });
                sent.push({ input, message });
                calls.push({ method: 'POST', path: '/api/messages', status: 200 });
                await route.fulfill({
                  status: 200,
                  contentType: 'application/json',
                  body: JSON.stringify({ status: 'queued', userMessageId: message.id, threadId: owner.thread.id }),
                });
              });
            },
          });
          const { page } = session;
          const composer = page.getByRole('textbox', { name: '消息输入框', exact: true });
          await composer.fill('Unsent words\nsecond line');
          await page.locator(`[data-message-id="${original.id}"]`).getByTestId('file-block-open').click();
          const reader = page.getByTestId('workspace-file-viewer');
          await reader.getByText('Original words.', { exact: true }).waitFor();
          const handle = await reader.elementHandle();
          assert.equal(await reader.getByText('只读', { exact: true }).count(), 1);
          for (const action of ['编辑', '请猫修改', '采用并写回'])
            assert.equal(await reader.getByRole('button', { name: action, exact: true }).count(), 0);
          assert.equal(await reader.getByRole('button', { name: '朗读', exact: true }).count(), 1);
          await select(
            page,
            reader.getByText('Original words.', { exact: true }),
            'workspace-markdown-selection-add-to-chat',
            'First comment.',
          );
          const mark = page.locator('[data-pending-file-quote]').first();
          await mark.waitFor();
          await mark.click();
          await page.getByTestId('context-annotation-comment').fill('Edited comment.');
          await page.getByTestId('context-annotation-comment').press('Enter');
          await page.getByTestId('context-annotation-comment').waitFor({ state: 'hidden' });
          await page.screenshot({ path: `${EVIDENCE}/published-text-${scenario.width}-reader.png` });
          await reader.getByRole('button', { name: '源码', exact: true }).click();
          await reader.locator('.cm-editor').waitFor();
          assert.equal(
            await handle.evaluate(
              (element) => element === document.querySelector('[data-testid="workspace-file-viewer"]'),
            ),
            true,
          );
          await select(
            page,
            reader.locator('.cm-line').filter({ hasText: RAW_PHRASE }),
            'workspace-code-selection-add-to-chat',
            'Source comment.',
          );
          await page.screenshot({ path: `${EVIDENCE}/published-text-${scenario.width}-source.png` });
          await reader.getByRole('button', { name: '渲染', exact: true }).click();
          await reader.getByText('Original words.', { exact: true }).waitFor();
          await reader.getByRole('button', { name: '返回来源', exact: true }).click();
          await closeMobileWorkspace(page, scenario.width);
          await composer.waitFor({ state: 'visible' });
          assert.equal(await composer.inputValue(), 'Unsent words\nsecond line');
          await page.screenshot({ path: `${EVIDENCE}/published-text-${scenario.width}-quoted.png` });
          const [response] = await Promise.all([
            page.waitForResponse(
              (item) => new URL(item.url()).pathname === '/api/messages' && item.request().method() === 'POST',
            ),
            page.getByRole('button', { name: '发送消息', exact: true }).click(),
          ]);
          assert.equal(response.status(), 200);
          assert.equal(sent.length, 1);
          const quotes = sent[0].input.contextAttachments;
          assert.equal(quotes.length, 2);
          assert.deepEqual(
            quotes.map((quote) => [quote.text, quote.comment]),
            [
              ['Original words.', 'Edited comment.'],
              [RAW_PHRASE, 'Source comment.'],
            ],
          );
          for (const quote of quotes)
            assert.deepEqual(quote.source, {
              kind: 'message',
              threadId: owner.thread.id,
              messageId: original.id,
              senderCatId: owner.catId,
              artifactFile: {
                item: artifacts[0].publicationItem,
                url: file.url,
                fileName: file.fileName,
                messageRevision: '41',
                displayDigest: `sha256:${createHash('sha256').update(BODY).digest('hex')}`,
              },
            });
          assert.deepEqual(owner.messages.getById(original.id), original);
          assert.equal(owner.tasks.listByThread(owner.thread.id).length, tasksBefore);
          assert.equal(
            session.calls.some(
              (call) =>
                call.path.startsWith('/api/content-') ||
                (call.path.startsWith('/api/workspace/') && call.method !== 'GET'),
            ),
            false,
          );
          assert.deepEqual(session.errors, []);
          await writeFile(
            `${EVIDENCE}/published-text-${scenario.width}.json`,
            JSON.stringify(
              {
                testedHead: process.env.F309_TESTED_HEAD,
                scenario,
                artifact: artifacts[0],
                sent,
                assetReads,
                calls: session.calls,
                errors: session.errors,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          if (session) {
            await session.page.screenshot({ path: `${EVIDENCE}/published-text-${scenario.width}-failure.png` });
            await writeFile(
              `${EVIDENCE}/published-text-${scenario.width}-failure.txt`,
              `${error}\n${await session.page.locator('body').innerText()}`,
            );
          }
          throw error;
        } finally {
          await session?.context.unrouteAll({ behavior: 'ignoreErrors' });
          await session?.context.close();
          await owner.close();
          await rm(data, { recursive: true, force: true });
        }
      },
    );
  }
}
