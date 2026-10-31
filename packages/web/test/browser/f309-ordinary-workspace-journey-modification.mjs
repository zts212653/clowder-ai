import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { openChatPage } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { REVIEW_ID, SOURCE_REVISION, THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { modelProjection } from './f309-ordinary-workspace-journey-text-quote.mjs';

const evidenceRoot = process.env.F309_BROWSER_EVIDENCE_DIR;

function interceptChatSend(sent) {
  return async (request, url) => {
    if (url.pathname === '/api/messages' && request.method() === 'POST') {
      sent.push(request.postDataJSON());
      return { body: { status: 'queued' } };
    }
    return undefined;
  };
}

async function selectRegion(page) {
  await page.getByRole('button', { name: '圈选', exact: true }).click();
  const points = await page
    .getByTestId('review-media-stage')
    .locator('svg[aria-label="图片或视频上的批注"]')
    .evaluate((svg) =>
      [
        new DOMPoint(svg.viewBox.baseVal.width * 0.3, svg.viewBox.baseVal.height * 0.3),
        new DOMPoint(svg.viewBox.baseVal.width * 0.7, svg.viewBox.baseVal.height * 0.65),
      ].map((point) => {
        const at = point.matrixTransform(svg.getScreenCTM());
        return { x: at.x, y: at.y };
      }),
    );
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 5 });
  await page.mouse.up();
  await page.locator('[data-testid="context-attachment-list"] [data-context-kind="media"]').waitFor();
}

async function capture(page, width, scope, step, body) {
  if (!evidenceRoot) return;
  await mkdir(evidenceRoot, { recursive: true });
  const name = `${evidenceRoot}/modification-${width}-${scope.replace(' ', '-')}-${step}`;
  await page.screenshot({ path: `${name}.png`, fullPage: true });
  if (body) await writeFile(`${name}.json`, `${JSON.stringify(body, null, 2)}\n`);
}

export function registerOrdinaryModificationJourney(suite) {
  for (const width of [1280, 390]) {
    for (const scope of ['whole image', 'selected region']) {
      test(
        `ordinary Workspace modification keeps artwork and Chat usable at ${width}px with ${scope}`,
        { timeout: 90_000 },
        async () => {
          const sent = [];
          const { context, page, errors } = await openChatPage(suite, {
            width,
            messages: [],
            handleApi: interceptChatSend(sent),
          });
          try {
            await ensureWorkspaceOpen(page);
            const home = page.getByTestId('workspace-launcher-home');
            await home.getByTestId('workspace-launcher-search').fill('cover');
            await home.getByTestId('workspace-launcher-file-result').filter({ hasText: '文件名' }).click();
            const image = page.getByTestId('workspace-content-review-media');
            await image.waitFor();
            const defaultHeight = (await image.boundingBox())?.height ?? 0;
            assert.ok(defaultHeight >= 200, 'the default artwork is already readable');
            const words = `${width}px ${scope}: keep the eyes visible while changing the background`;
            const composer = page.getByLabel('消息输入框');
            await composer.fill(words);
            assert.equal(await page.getByTestId('content-modification-entry').count(), 0);
            if (scope === 'selected region') {
              await selectRegion(page);
            } else {
              await page.getByLabel('图片更多操作', { exact: true }).click();
              await page.getByTestId('workspace-media-chat-whole-work').click();
            }
            const chip = page.locator('[data-testid="context-attachment-list"] [data-context-kind="media"]');
            await chip.waitFor();
            assert.equal(await composer.inputValue(), words, 'adding media preserves the original Chat draft');
            assert.equal(sent.length, 0, 'adding a work is not sending it');
            assert.equal(await chip.count(), 1);
            assert.equal(await page.getByTestId('content-modification-submit').count(), 0);
            assert.equal(await page.getByTestId('workspace-content-review-surface').locator('textarea').count(), 0);
            const shown = await image.boundingBox();
            assert.ok(shown && shown.height >= Math.max(200, defaultHeight * 0.5));
            await capture(page, width, scope, 'artwork');
            if (width === 390) {
              await page
                .getByTestId('contextual-workspace-host')
                .getByRole('button', { name: /^(收起 Workspace|Collapse Workspace)$/ })
                .click();
            }
            const send = page.getByRole('button', { name: /^(Send message|发送消息)$/ });
            const inputBox = await composer.boundingBox();
            const sendBox = await send.boundingBox();
            assert.ok(inputBox);
            assert.ok(sendBox);
            assert.ok(sendBox.y >= 0 && sendBox.y + sendBox.height <= 900);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            await capture(page, width, scope, 'chat');
            await send.click();
            await page.waitForFunction(() => !document.querySelector('[data-testid="context-attachment-list"]'));
            assert.equal(sent.length, 1);
            const body = sent[0];
            assert.equal(body.threadId, THREAD_ID);
            assert.equal(body.content, words);
            assert.equal(body.contextAttachments.length, 1);
            const [media] = body.contextAttachments;
            assert.equal(media.source.locator.path, 'art/cover.png');
            assert.equal(media.source.expectedSourceRevision, SOURCE_REVISION);
            assert.equal(media.source.reviewId, REVIEW_ID);
            if (scope === 'selected region') {
              assert.equal(media.selections.length, 1);
              assert.equal(media.selections[0].selection.kind, 'image-region');
              assert.equal(media.selections[0].instruction, undefined, 'the sole Chat draft carries the instruction');
            } else assert.deepEqual(media.selections, []);
            const prompt = await modelProjection(body);
            assert.deepEqual(
              JSON.parse(prompt.slice(prompt.indexOf('<context_attachments>') + 21, prompt.lastIndexOf('<'))),
              body.contextAttachments,
            );
            await capture(page, width, scope, 'sent', body);
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        },
      );
    }
  }
}
