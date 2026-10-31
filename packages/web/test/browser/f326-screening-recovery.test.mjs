import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createScreeningJourney, openPreparedProject } from './f326-screening-journey.harness.mjs';

// Continue the original real Human source; this test never sends another chat message or fabricates a Cat result.
test(
  'F326 original sent opinion → actual Cat save → artwork comparison → Human reopen → refresh',
  { timeout: 300000 },
  async (t) => {
    const journey = await createScreeningJourney();
    const manifest = JSON.parse(await readFile(process.env.F326_BROWSER_MANIFEST, 'utf8'));
    const sent = JSON.parse(await readFile('/tmp/f326-b-human-send-receipt.json', 'utf8'));
    const result = { outcome: 'running', sourceMessageId: sent.userMessageId, assertions: [] };
    let failure;
    t.after(async () => {
      await journey.page.screenshot({ path: path.join(journey.evidence, 'last.png'), fullPage: true }).catch(() => {});
      await writeFile(
        path.join(journey.evidence, 'result.json'),
        JSON.stringify(
          {
            ...result,
            ...(failure ? { failure: String(failure), stack: failure.stack } : {}),
            calls: journey.calls,
            errors: journey.errors,
          },
          null,
          2,
        ),
      );
      await journey.close();
      console.log(`F326 recovery evidence: ${journey.evidence}`);
    });
    try {
      assert.equal(sent.threadId, manifest.threadId);
      assert.equal(sent.contentRef, manifest.contentRef);
      const { page } = journey;
      const base = `/api/video-projects/${encodeURIComponent(manifest.contentRef)}`;
      const before = await journey.request(`${base}/review`);
      const annotations = before.review.annotations.filter(
        (a) => a.projectMessage?.source.messageId === sent.userMessageId,
      );
      assert.equal(annotations.length, 1);
      const original = annotations[0];
      const addressed = original.projectHistory.findLast((event) => event.kind === 'addressed');
      assert.equal(addressed?.actor.actorId, 'codex61-sol');
      assert.ok(addressed.result.operationId);
      const sourceMessages = await journey.request(
        `/api/messages?threadId=${encodeURIComponent(sent.threadId)}&limit=100`,
      );
      const message = sourceMessages.messages.find((entry) => entry.id === sent.userMessageId);
      const attachment = message.contentBlocks.find(
        (block) => block.type === 'context_attachment' && block.attachment.kind === 'project-screening',
      ).attachment;
      assert.deepEqual(attachment.input, manifest.input);
      assert.equal(attachment.selections[0].target.tick, 1429);
      assert.equal(attachment.selections[0].mediaRange.startPts, 731648);
      const frozen = await journey.request(`${base}?ownerRevision=1`);
      const changed = await journey.request(`${base}?ownerRevision=${addressed.result.ownerRevision}`);
      assert.equal(changed.blobDigest, addressed.result.blobDigest);
      const oldUse = frozen.document.timeline.segments
        .find((segment) => segment.id === 'C08')
        .visuals.find((visual) => visual.id === 'C08:visual:2');
      const newUse = changed.document.timeline.segments
        .find((segment) => segment.id === 'C08')
        .visuals.find((visual) => visual.id === oldUse.id);
      const version = (document, ref) =>
        document.assets.flatMap((asset) => asset.versions).find((item) => item.id === ref);
      assert.notEqual(
        version(frozen.document, oldUse.assetVersionRef).sha256,
        version(changed.document, newUse.assetVersionRef).sha256,
      );
      result.actualResult = { annotationId: original.id, history: original.projectHistory, result: addressed.result };
      await openPreparedProject(journey, manifest);
      const surface = page.locator(`[data-video-project="${manifest.contentRef}"]`);
      const panel = surface.getByRole('complementary', { name: '问题与经过' });
      await page.getByRole('button', { name: '整窗查看作品', exact: true }).click();
      const playerBox = await surface.getByRole('region', { name: '成片播放器' }).boundingBox();
      const panelBox = await panel.boundingBox();
      assert.ok(
        panelBox.x > playerBox.x + playerBox.width - 5 && Math.abs(panelBox.y - playerBox.y) < 80,
        'In the wide work area, opinions remain alongside the actual film',
      );
      await page.getByRole('button', { name: '展开聊天', exact: true }).click();
      await panel.getByRole('button', { name: '查看修改', exact: true }).click();
      const modification = surface.getByRole('region', { name: '查看修改', exact: true });
      await modification.waitFor();
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll('[aria-label="查看修改"] img')];
        return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0);
      });
      assert.ok((await modification.innerText()).includes('修改尚未生成成片'));
      assert.equal(
        await modification.getByRole('button', { name: '在影片中查看', exact: true }).count(),
        0,
        'No existing output represents this new Host input; never relabel the old MP4',
      );
      const zoom = modification.getByRole('slider', { name: '同步缩放' });
      const initialWidths = await modification
        .locator('img')
        .evaluateAll((images) => images.map((image) => image.getBoundingClientRect().width));
      await zoom.focus();
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
      assert.equal(await zoom.inputValue(), '2');
      const imageWidths = await modification
        .locator('img')
        .evaluateAll((images) => images.map((image) => image.getBoundingClientRect().width));
      assert.equal(imageWidths[0], imageWidths[1]);
      assert.ok(
        imageWidths.every((width, index) => Math.abs(width / initialWidths[index] - 2) < 0.05),
        'Both actual decoded artworks double their displayed size',
      );
      await page.screenshot({ path: path.join(journey.evidence, '01-real-artwork-change.png'), fullPage: true });
      result.assertions.push(
        'original source and actual Cat receipt bind distinct artwork bytes; synchronized zoom; absent new output honest',
      );
      await modification.getByRole('button', { name: '返回审片', exact: true }).click();
      await panel.getByRole('button', { name: '还不对', exact: true }).click();
      await panel
        .getByLabel('还不对的原因', { exact: true })
        .fill('隔离验收：验证真实重开与恢复，保留原意见和修改经过。');
      const reopening = page.waitForResponse(
        (response) => response.url().endsWith('/review/actions') && response.request().method() === 'POST',
      );
      await panel.getByRole('button', { name: '重新打开问题', exact: true }).click();
      const reopenedResponse = await reopening;
      assert.ok(reopenedResponse.ok(), await reopenedResponse.text());
      const reopened = await journey.request(`${base}/review`);
      const retained = reopened.review.annotations.find((annotation) => annotation.id === original.id);
      assert.deepEqual(retained.projectHistory.slice(0, original.projectHistory.length), original.projectHistory);
      assert.equal(retained.projectHistory.at(-1).kind, 'reopened');
      assert.equal(retained.projectHistory.at(-1).actor.kind, 'human');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await surface.waitFor();
      const sentChip = page.locator(
        `[data-message-id="${sent.userMessageId}"] [data-context-kind="project-screening"]`,
      );
      await sentChip.getByRole('button', { name: /回到.*的标记 1/ }).click();
      await page.waitForFunction(() => {
        const video = document.querySelector('[data-video-project] video');
        return video && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - 1429 / 30) < 0.05;
      });
      assert.equal(await surface.getByRole('combobox', { name: '成片版本' }).inputValue(), attachment.screeningId);
      assert.ok((await surface.innerText()).includes('输入 v1'));
      const latest = await journey.request(`/api/messages?threadId=${encodeURIComponent(sent.threadId)}&limit=100`);
      assert.equal(latest.messages.filter((entry) => entry.id === sent.userMessageId).length, 1);
      result.assertions.push(
        'Human reopen appends history; reload retains one original sent message and its frozen C08c position',
      );
      assert.deepEqual(journey.errors, []);
      result.outcome = 'pass';
      await page.screenshot({ path: path.join(journey.evidence, '02-original-source-reload.png'), fullPage: true });
    } catch (error) {
      failure = error;
      result.outcome = 'fail';
      throw error;
    }
  },
);
