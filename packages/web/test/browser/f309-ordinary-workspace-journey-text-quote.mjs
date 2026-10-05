import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { routeThroughRealOwner, startRealWorkspaceOwner } from './f309-ordinary-workspace-real-owner.mjs';

const FILE_NAME = 'f309-text-quote-journey.md';
const FILE_PATH = `packages/web/test/browser/fixtures/${FILE_NAME}`;
// Crosses bold → soft line break → paragraph → emphasis: the rendered shape the retired composer lost (red banner).
const FROM = '暮色里的灯塔';
const TO = 'salt on the window';
const COMMENT = ['这里的灯塔意象要保留 · keep the lighthouse', '第二行：换一个动词 / change the verb'];

/** The model-facing text the cat receives, through the API's own send schema and routing projection. */
async function modelProjection(body) {
  const { sendMessageSchema, buildMessageContentBlocks } = await import('../../../api/dist/routes/messages.schema.js');
  const { appendContextAttachmentsToPrompt } = await import(
    '../../../api/dist/domains/cats/services/agents/routing/context-attachment-prompt.js'
  );
  const input = sendMessageSchema.parse(body);
  return appendContextAttachmentsToPrompt(
    input.content,
    buildMessageContentBlocks(input.content, input.contextAttachments),
  );
}

async function selectRendered(page, from, to) {
  await page.evaluate(
    ([start, end]) => {
      const root = document.querySelector('[data-testid="workspace-content-review-text"]');
      if (!root) throw new Error('text surface is missing');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let anchor = null;
      let focus = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        if (!anchor && text.includes(start)) anchor = [node, text.indexOf(start)];
        if (text.includes(end)) focus = [node, text.indexOf(end) + end.length];
      }
      if (!anchor || !focus) throw new Error(`not rendered: ${start} … ${end}`);
      const range = document.createRange();
      range.setStart(anchor[0], anchor[1]);
      range.setEnd(focus[0], focus[1]);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    },
    [from, to],
  );
}

// CVO095/098 (Astra plan §3): a text selection goes through the one existing chain — in-place card →
// chat annotation chip → explicit send — never a second F309 text annotation.
export function registerOrdinaryTextQuoteJourney(suite) {
  async function openFromHome({ viewport, prefix, run }) {
    const evidence = await mkdtemp(`/tmp/${prefix}-`);
    const owner = await startRealWorkspaceOwner(path.join(evidence, 'data'));
    const context = await suite().browser.newContext({ viewport });
    const errors = [];
    const posts = [];
    const sent = [];
    try {
      await routeThroughRealOwner(context, owner, {
        extra: async (route, url) => {
          if (url.pathname !== '/api/messages' || route.request().method() !== 'POST') return false;
          sent.push(route.request().postDataJSON());
          await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
          return true;
        },
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
      });
      await page.goto(suite().baseUrl, { waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(page);
      const home = page.getByTestId('workspace-launcher-home');
      await home.getByTestId('workspace-launcher-search').fill(FILE_NAME);
      await home
        .getByTestId('workspace-launcher-file-result')
        .filter({ has: page.getByText(FILE_NAME, { exact: true }) })
        .first()
        .click();
      const surface = page.getByTestId('workspace-content-review-surface');
      await surface.getByText(TO, { exact: false }).waitFor({ timeout: 30_000 });
      assert.equal(await surface.locator('h2').first().getAttribute('title'), FILE_NAME);
      await run({ page, surface, errors, posts, sent, evidence });
    } catch (error) {
      const page = context.pages()[0];
      const body = page
        ? await page
            .locator('body')
            .innerText()
            .catch(() => 'unavailable')
        : 'no page';
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nerrors: ${errors}\nposts: ${posts}\nbody: ${body}`,
      );
    } finally {
      await context.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
      await owner.close();
    }
  }

  async function addToChat(page, posts) {
    const before = posts.length;
    await selectRendered(page, FROM, TO);
    await page.getByTestId('workspace-content-review-text-add-to-chat').click();
    const editor = page.getByTestId('context-annotation-comment');
    await editor.waitFor();
    await editor.fill(COMMENT[0]);
    await editor.press('Shift+Enter');
    await editor.pressSequentially(COMMENT[1]);
    await editor.press('Enter');
    await page.getByTestId('context-annotations-summary').waitFor({ state: 'attached' });
    // Adding is not sending, not a Task and not a new F309 text annotation: nothing is written at all.
    assert.deepEqual(posts.slice(before), []);
    return editor;
  }

  test(
    'text: a rendered selection → card → chat chip → explicit send, as the original chain',
    { timeout: 120_000 },
    async () => {
      await openFromHome({
        viewport: { width: 1280, height: 900 },
        prefix: 'f309-text-quote',
        run: async ({ page, surface, errors, posts, sent, evidence }) => {
          assert.equal(await surface.getByText('已选文本', { exact: false }).count(), 0);
          assert.equal(await surface.getByPlaceholder('写下这条批注…').count(), 0);
          await addToChat(page, posts);
          await page.screenshot({ path: `${evidence}/text-quote-chip.png` });

          // Return to where the file was opened from, then reload: the chip is the chat draft and survives both.
          await surface.getByRole('button', { name: '返回来源', exact: true }).click();
          await page.getByTestId('workspace-launcher-home').waitFor();
          await page.reload({ waitUntil: 'domcontentloaded' });
          const summary = page.getByTestId('context-annotations-summary');
          await summary.waitFor();
          assert.equal(sent.length, 0);
          await summary.click();
          const item = page.locator('[data-testid^="context-annotation-item-"]').first();
          await item.waitFor();
          const shown = await item.innerText();
          assert.ok(shown.includes(FROM) && shown.includes(TO), shown);
          assert.ok(shown.includes(COMMENT[0]) && shown.includes(COMMENT[1]), shown);

          await page.getByRole('button', { name: 'Send message', exact: true }).click();
          await page.waitForFunction(() => !document.querySelector('[data-testid="context-annotations-summary"]'));
          assert.equal(sent.length, 1);
          const [quote] = sent[0].contextAttachments;
          assert.equal(quote.kind, 'quote');
          assert.ok(quote.text.startsWith(FROM) && quote.text.endsWith(TO), quote.text);
          assert.ok(quote.text.includes('\n'), 'the quote keeps its line structure');
          assert.equal(quote.comment, COMMENT.join('\n'));
          assert.equal(quote.source.kind, 'workspace_file');
          assert.equal(quote.source.path, FILE_PATH);
          assert.ok(quote.source.worktreeId, 'the quote names its real worktree');
          assert.equal(quote.source.lineStart, undefined, 'rendered Markdown claims no file lines it does not have');

          const prompt = await modelProjection(sent[0]);
          const projected = JSON.parse(
            prompt.slice(prompt.indexOf('<context_attachments>') + 21, prompt.lastIndexOf('<')),
          );
          assert.deepEqual(projected, sent[0].contextAttachments);
          assert.ok(!posts.some((post) => post.endsWith('/annotations')), posts.join(', '));
          assert.deepEqual(errors, []);
        },
      });
    },
  );

  test(
    'text: at 390px the card opens inside the screen and still only adds the chip',
    { timeout: 120_000 },
    async () => {
      await openFromHome({
        viewport: { width: 390, height: 844 },
        prefix: 'f309-text-quote-390',
        run: async ({ page, posts, errors, evidence }) => {
          await selectRendered(page, FROM, TO);
          await page.getByTestId('workspace-content-review-text-add-to-chat').click();
          const card = page.getByTestId('context-annotation-editor');
          await card.waitFor();
          const box = await card.boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0, JSON.stringify(box));
          await page.screenshot({ path: `${evidence}/text-quote-390-card.png` });
          const before = posts.length;
          await page.getByTestId('context-annotation-comment').fill('390 宽也能写 · narrow');
          await page.getByTestId('context-annotation-comment').press('Enter');
          await page.getByTestId('context-annotations-summary').waitFor({ state: 'attached' });
          assert.deepEqual(posts.slice(before), []);
          assert.deepEqual(errors, []);
        },
      });
    },
  );
}
