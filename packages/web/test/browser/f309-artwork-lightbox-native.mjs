import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkNativeImageCoordinates,
  checkNativeImagePixels,
  checkNativeImageSelection,
  nativeWebpDisplayBytes,
} from './f309-artwork-lightbox-image-formats.mjs';
import { verifyNativeArtworkCatalogues } from './f309-artwork-lightbox-native-catalogues.mjs';
import { createNativeArtworkFixture, digest } from './f309-artwork-lightbox-native-fixture.mjs';
import { openDocumentSession } from './f309-ordinary-document-session.mjs';
import {
  startF309OrdinaryWorkspaceJourney,
  stopF309OrdinaryWorkspaceJourney,
} from './f309-ordinary-workspace-journey-runtime.mjs';
import { verifyTextAnnotationWorkBoundary } from './f309-text-annotation-work-boundary.mjs';

async function selectPlaces(page, f, kind) {
  const original = page.locator(`[data-message-id="${f.publication.id}"]`);
  await original.getByRole('button', { name: /打开作品/ }).click();
  const dialog = page.getByRole('dialog');
  const surface = dialog.getByTestId('workspace-content-review-surface');
  await surface.getByTestId('workspace-content-review-media').waitFor();
  if (kind === 'jpg' || kind === 'webp') {
    await page.waitForFunction(() => {
      const img = document.querySelector('[role="dialog"] img[data-testid="workspace-content-review-media"]');
      return img?.complete && img.naturalWidth > 0;
    });
    f.displayCoordinates = await checkNativeImageCoordinates(surface, f.original, f.source.media);
    const download = dialog.locator('a[download]').first();
    assert.ok((await download.getAttribute('download')).endsWith(`.${kind}`));
    const href = await download.getAttribute('href');
    assert.ok(href && !href.includes('display=oriented'));
    const downloaded = await download.evaluate(async (link) => {
      const response = await fetch(link.href, { headers: { 'x-cat-cafe-user': 'operator' } });
      const data = await response.arrayBuffer();
      const hash = await crypto.subtle.digest('SHA-256', data);
      return {
        status: response.status,
        mime: response.headers.get('content-type'),
        sha256: [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join(''),
      };
    });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.mime, f.source.mime);
    assert.equal(downloaded.sha256, digest(f.original));
    f.displayCoordinates.download = downloaded;
  }
  if (kind === 'mp4') {
    const video = surface.getByTestId('workspace-content-review-media');
    await page.waitForFunction(() => {
      const video = document.querySelector('[role="dialog"] video');
      return video && video.readyState >= 2 && video.seekable.length;
    });
    const duration = await video.evaluate((video) => video.duration);
    const seconds = duration > 100 ? 82 : 0.8;
    await video.evaluate(
      (video, seconds) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('matching presented frame missing')), 12_000);
          const observe = (_now, frame) => {
            if (Math.abs(frame.mediaTime - seconds) < 0.05) {
              clearTimeout(timer);
              resolve();
            } else video.requestVideoFrameCallback(observe);
          };
          video.requestVideoFrameCallback(observe);
          video.pause();
          video.currentTime = seconds;
        }),
      seconds,
    );
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('[role="dialog"] button')].find(
        (button) => button.textContent === '圈这一帧',
      );
      return button && !button.disabled;
    });
    await dialog.getByRole('button', { name: '选时间段', exact: true }).click();
    await dialog.getByLabel('片段起点', { exact: true }).fill(duration > 100 ? '80' : '.4');
    await dialog.getByLabel('片段终点', { exact: true }).fill(duration > 100 ? '86' : '1.2');
    await dialog.getByRole('button', { name: '放入对话', exact: true }).click();
    await dialog.getByRole('button', { name: '圈这一帧', exact: true }).click();
  } else await dialog.getByRole('button', { name: '圈选', exact: true }).click();
  const stage = surface.getByTestId('review-media-stage');
  const rect = await stage.boundingBox();
  assert.ok(rect && rect.width > 100 && rect.height > 50);
  await page.mouse.move(rect.x + rect.width * 0.25, rect.y + rect.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * 0.55, rect.y + rect.height * 0.55, { steps: 8 });
  await page.mouse.up();
  return dialog;
}

async function readComparisonPixels(comparison, kind, fixture, returned, record) {
  const compare = comparison.getByRole('region', { name: '版本对比', exact: true });
  await compare.getByRole('button', { name: '切换', exact: true }).click();
  const versions = [];
  for (const [index, label] of ['原版', '候选版本'].entries()) {
    await compare.getByRole('group', { name: '显示版本', exact: true }).getByRole('button').nth(index).click();
    const pane = compare.getByRole('figure', { name: label, exact: true });
    await pane.waitFor({ state: 'visible' });
    const media = pane.locator(kind === 'mp4' ? 'video' : 'img');
    await media.evaluate(
      (node) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('comparison media did not decode')), 12_000);
          const ready = () => {
            if (node.tagName === 'IMG' ? node.complete && node.naturalWidth > 0 : node.readyState >= 2) {
              clearTimeout(timer);
              resolve();
            } else requestAnimationFrame(ready);
          };
          ready();
        }),
    );
    const bytes = await media.evaluate(async (node) => {
      const data = await fetch(node.currentSrc || node.src).then((response) => response.arrayBuffer());
      const hash = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
    });
    if (kind === 'webp') {
      const original = index === 0 ? fixture.original : returned.bytes;
      assert.equal(bytes, digest(await nativeWebpDisplayBytes(original)));
      const pixels = await checkNativeImagePixels(media, original, fixture.source.media);
      const response = await fetch(
        `${fixture.owner.api}/api/artifact-reviews/${encodeURIComponent(record.progress.review.reviewId)}/media/${index + 1}`,
        { headers: { 'x-cat-cafe-user': 'operator' } },
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/webp');
      versions.push({ label, sha256: digest(Buffer.from(await response.arrayBuffer())), displaySha256: bytes, pixels });
    } else versions.push({ label, sha256: bytes });
  }
  return versions;
}

export function registerNativeArtworkLightboxJourneys() {
  for (const { kind, width, dark, sourceKind } of [
    { kind: 'png', width: 1440, dark: false, sourceKind: 'workspace' },
    { kind: 'mp4', width: 390, dark: true, sourceKind: 'workspace' },
    { kind: 'jpg', width: 1440, dark: false, sourceKind: 'workspace' },
    { kind: 'jpg', width: 390, dark: true, sourceKind: 'publication' },
    { kind: 'webp', width: 390, dark: true, sourceKind: 'workspace' },
    { kind: 'webp', width: 1440, dark: false, sourceKind: 'publication' },
  ])
    test(
      `native ${kind} ${width} ${sourceKind}: floating same Chat send, original progress/cancel, candidate comparison and original source decision`,
      { timeout: 240_000 },
      async () => {
        const evidence = path.join(
          process.env.F309_BROWSER_EVIDENCE_DIR ?? '/tmp/f309-artwork-lightbox-native',
          `${kind}-${width}`,
        );
        const f = await createNativeArtworkFixture(kind, evidence, sourceKind);
        let suite, session;
        const observations = {
          kind,
          width,
          dark,
          sourceKind,
          source: f.source,
          originalHash: digest(f.original),
          boundaries: [
            'synthetic private Human/session issuer consumes actual native POST with production schema',
            'original callback auth, QueueProcessor and deterministic non-LLM provider',
            'production GET history; push transport/AgentRouter/real model/runtime/Alpha excluded',
          ],
        };
        try {
          suite = await startF309OrdinaryWorkspaceJourney({ apiUrl: f.owner.api });
          session = await openDocumentSession(() => suite, f.owner, { width, dark, shell: 'v2' });
          await f.captureSend(session.context);
          const { page } = session;
          const composer = page.getByLabel('消息输入框', { exact: true });
          await composer.fill(`@${f.owner.catId} 先给这处修改的候选，等我决定。`);
          const send = async () => {
            const originalComposer = await composer.elementHandle();
            const dialog = await selectPlaces(page, f, kind);
            assert.equal(await composer.evaluate((node, original) => node === original, originalComposer), true);
            await page.screenshot({ path: path.join(evidence, `selected-${f.sent.length}.png`) });
            await dialog.getByRole('button', { name: '发送消息', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('[aria-label="消息输入框"]')?.value === '');
            const sent = f.sent.at(-1);
            assert.ok(sent);
            const [attachment] = sent.input.contextAttachments;
            assert.equal(attachment.mediaType, f.source.mime);
            if (sourceKind === 'workspace') {
              assert.equal(attachment.source.expectedSourceRevision, f.source.revision);
              assert.deepEqual(attachment.source.locator, f.source.locator);
            } else {
              assert.equal(attachment.source.kind, 'publication');
              assert.equal(attachment.source.contentRef, f.source.asset.contentRef);
              assert.equal(attachment.source.ownerRevision, f.source.asset.ownerRevision);
              assert.ok(attachment.source.ledgerRef);
              assert.equal(attachment.source.locator, undefined);
            }
            assert.equal(attachment.selections.length, kind === 'mp4' ? 2 : 1);
            if (kind === 'jpg' || kind === 'webp') {
              checkNativeImageSelection(attachment.selections[0].selection, f.source.media);
              observations.displayCoordinates = f.displayCoordinates;
            }
            assert.deepEqual(await readFile(f.absolute), f.original);
            await page.keyboard.press('Escape');
            const record = await f.owner.takeOver(sent.message.id);
            assert.equal(record.progress.sourceMessageId, sent.message.id);
            await page.reload({ waitUntil: 'domcontentloaded' });
            const progress = page
              .locator(`[data-message-id="${sent.message.id}"]`)
              .getByTestId('media-message-request');
            await progress.waitFor();
            const history = await f.owner.artifacts.reviews.readCurrent(record.progress.review.reviewId, f.owner.human);
            assert.deepEqual(
              history.review.rounds[0].annotations.map((item) => item.anchor),
              attachment.selections.map((item) => item.selection),
            );
            observations.historyAnchors = history.review.rounds[0].annotations;
            observations.sendAttempts ??= [];
            observations.sendAttempts.push({
              input: sent.input,
              messageId: sent.message.id,
              record,
              progress: await progress.innerText(),
            });
            assert.match(await progress.innerText(), /砚砚|小太阳/);
            await page.screenshot({ path: path.join(evidence, `progress-${f.sent.length}.png`) });
            return { record, sent, progress };
          };
          if (kind === 'mp4') {
            const cancelled = await send();
            const cancellation = page.waitForResponse(
              (response) =>
                response.url().endsWith(`/api/content-modifications/${cancelled.record.requestId}/cancel`) &&
                response.request().method() === 'POST',
            );
            await cancelled.progress.getByRole('button', { name: '取消修改', exact: true }).click();
            assert.equal((await cancellation).status(), 200);
            const state = await f.owner.inspect(cancelled.record.requestId);
            assert.equal(state.record.control?.state, 'cancelled');
            observations.cancel = { requestId: cancelled.record.requestId, control: state.record.control };
            assert.deepEqual(await readFile(f.absolute), f.original);
            await f.owner.driver.close(); // Release the deterministic provider with its explicit fixture-failed terminal, never a fake success.
            await composer.fill(`@${f.owner.catId} 再给这处的候选，原文件仍等我决定。`);
          }
          const { record, sent } = await send();
          observations.sent = sent.input;
          observations.request = record;
          const returned = await f.returnCandidate(record);
          await f.owner.driver.close();
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page
            .locator(`[data-message-id="${returned.receipt.id}"]`)
            .getByRole('button', { name: '打开对照', exact: true })
            .click();
          const comparison =
            sourceKind === 'workspace'
              ? page.locator(`[data-candidate-ref="${returned.candidate.candidateRef}"]`)
              : page.getByTestId('artifact-media-compare');
          await comparison.waitFor({ state: 'visible' });
          observations.comparison = await readComparisonPixels(comparison, kind, f, returned, record);
          assert.deepEqual(
            observations.comparison.map((version) => version.sha256),
            [digest(f.original), digest(returned.bytes)],
          );
          await page.screenshot({ path: path.join(evidence, 'comparison.png') });
          assert.deepEqual(await readFile(f.absolute), f.original);
          if (sourceKind === 'workspace') {
            await comparison.getByTestId('content-modification-accept').click();
            await comparison.getByText('已写回原文件', { exact: true }).waitFor();
            assert.deepEqual(await readFile(f.absolute), returned.bytes);
            const final = await f.owner.inspect(record.requestId);
            assert.equal(final.acceptances.at(-1).receipt.state, 'applied');
            observations.acceptance = final.acceptances.at(-1);
          } else {
            assert.equal(await comparison.getByTestId('content-modification-accept').count(), 0);
            await comparison.getByRole('button', { name: '通过此版本', exact: true }).click();
            await comparison.getByText('这版通过', { exact: true }).waitFor();
            const approved = await f.owner.artifacts.reviews.readCurrent(
              record.progress.review.reviewId,
              f.owner.human,
            );
            assert.equal(approved.review.rounds.at(-1).state, 'approved');
            assert.deepEqual(await readFile(f.absolute), f.original);
            observations.decision = approved.review.rounds.at(-1).decision;
            await comparison.getByRole('button', { name: '返回作品', exact: true }).click();
          }
          observations.candidateHash = digest(returned.bytes);
          await page.getByText('正在恢复作品的修改上下文…', { exact: true }).waitFor({ state: 'hidden' });
          if (sourceKind === 'workspace')
            await page.getByText('已写回原文件', { exact: true }).waitFor({ state: 'visible' });
          await page.screenshot({ path: path.join(evidence, 'applied.png') });
          await page.getByRole('button', { name: '‹ 聊天', exact: true }).click();
          await page.locator(`[data-message-id="${returned.receipt.id}"]`).waitFor({ state: 'visible' });
          assert.equal(new URL(page.url()).pathname, `/thread/${f.owner.thread.id}`);
          observations.catalogues = [];
          await verifyNativeArtworkCatalogues(page, returned, observations.catalogues);
          assert.deepEqual(session.errors, []);
          assert.deepEqual(f.owner.errors, []);
          if ((kind === 'png' && width === 1440) || (kind === 'webp' && width === 390))
            observations.textAnnotationBoundary = await verifyTextAnnotationWorkBoundary(page, f, evidence, width);
          observations.returned = true;
          observations.calls = session.calls;
        } catch (error) {
          observations.failure = { error: String(error), stack: error.stack };
          if (session) {
            observations.body = await session.page.locator('body').innerText();
            await session.page.screenshot({ path: path.join(evidence, 'failure.png') });
          }
          throw error;
        } finally {
          await writeFile(path.join(evidence, 'report.json'), JSON.stringify(observations, null, 2));
          await session?.context.unrouteAll({ behavior: 'ignoreErrors' });
          await session?.context.close();
          await stopF309OrdinaryWorkspaceJourney(suite);
          await f.close();
        }
      },
    );
}
