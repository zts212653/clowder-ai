import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createScreeningJourney, decodedSeek, openPreparedProject } from './f326-screening-journey.harness.mjs';

// Real pointer/keyboard selections queue in the product's actual persisted composer draft; none is sent.
test(
  'F326 real range and display region, shot and whole-film marks use the original unsent composer',
  { timeout: 300000 },
  async (t) => {
    const journey = await createScreeningJourney();
    const manifest = JSON.parse(await readFile(process.env.F326_BROWSER_MANIFEST, 'utf8'));
    const result = { outcome: 'running' };
    let failure;
    t.after(async () => {
      await journey.page.screenshot({ path: path.join(journey.evidence, 'last.png'), fullPage: true }).catch(() => {});
      await writeFile(
        path.join(journey.evidence, 'result.json'),
        JSON.stringify({ ...result, failure: failure?.message, calls: journey.calls, errors: journey.errors }, null, 2),
      );
      await journey.close();
      console.log(`F326 selection evidence: ${journey.evidence}`);
    });
    try {
      const before = await journey.request(`/api/video-projects/${encodeURIComponent(manifest.contentRef)}/review`);
      await openPreparedProject(journey, manifest);
      const { page } = journey;
      const surface = page.locator(`[data-video-project="${manifest.contentRef}"]`);
      const player = surface.getByRole('region', { name: '成片播放器' });
      const video = player.locator('video');
      const composer = page.locator('textarea[placeholder*="输入消息"]').first();
      const originalWords = await composer.inputValue();
      await composer.fill('隔离验收草稿');
      await composer.press('m');
      assert.equal(
        await player.getByRole('button', { name: '记到原输入框', exact: true }).count(),
        0,
        'Typing M in the original composer never steals input or opens a mark',
      );
      const readDraft = () =>
        page.evaluate(
          (threadId) =>
            new Map(JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') ?? '[]')).get(
              threadId,
            ) ?? [],
          manifest.threadId,
        );
      assert.equal((await readDraft()).length, 0);
      const mark = async () => {
        await video.focus();
        await page.keyboard.press('m');
        await player.getByRole('button', { name: '记到原输入框', exact: true }).waitFor();
      };
      const drawRegion = async () => {
        const bounds = await video.boundingBox();
        const field = player.getByRole('group', { name: '拖选画面区域', exact: true });
        await field.waitFor();
        await page.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.25);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.45, { steps: 8 });
        await page.mouse.up();
      };
      await decodedSeek(video, 1429 / 30);
      await mark();
      await player.getByRole('button', { name: '设为范围起点', exact: true }).click();
      await drawRegion();
      await player.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal((await readDraft()).length, 0, 'Cancel never creates an opinion chip');
      await mark(); // Same frame: a PTS change must not mask old-region retention.
      assert.equal(
        await player.getByRole('group', { name: '拖选画面区域' }).locator('..').locator('.border-2').count(),
        0,
      );
      await player.getByRole('button', { name: '记到原输入框', exact: true }).click();
      const sameFrame = (await readDraft())[0].selections[0];
      assert.equal(sameFrame.displayRegion, undefined);
      assert.equal(sameFrame.canvasRegion, undefined);
      await page.getByRole('button', { name: /^移除审片位置 / }).click();
      await mark();
      await player.getByRole('button', { name: '设为范围起点', exact: true }).click();
      await player.getByRole('button', { name: '全片', exact: true }).click();
      await player.getByRole('button', { name: '取消', exact: true }).click();
      await decodedSeek(video, 1434 / 30);
      await mark();
      assert.equal(
        await player.getByRole('button', { name: '这一刻／一段时间', exact: true }).getAttribute('aria-pressed'),
        'true',
      );
      await player.getByRole('button', { name: '记到原输入框', exact: true }).click();
      const fresh = (await readDraft())[0].selections[0];
      assert.equal(
        fresh.mediaRange.startPts,
        1434 * 512,
        'Reopened moment uses the newly decoded frame, not the cancelled range start',
      );
      assert.equal(fresh.target.kind, 'moment');
      assert.equal(fresh.target.tick, 1434);
      assert.equal(fresh.displayRegion, undefined);
      result.cancelledSelection = { sameFrame, fresh };
      await page.screenshot({
        path: path.join(journey.evidence, '00-cancelled-selection-fresh-composer.png'),
        fullPage: true,
      });
      await page.getByRole('button', { name: /^移除审片位置 / }).click();
      assert.equal(await composer.inputValue(), '隔离验收草稿m');
      assert.deepEqual(
        (await journey.request(`/api/video-projects/${encodeURIComponent(manifest.contentRef)}/review`)).review,
        before.review,
      );
      await decodedSeek(video, 1429 / 30);
      await mark();
      await player.getByRole('button', { name: '设为范围起点', exact: true }).click();
      await decodedSeek(video, 1432 / 30);
      const bounds = await video.boundingBox();
      const field = player.getByRole('group', { name: '拖选画面区域', exact: true });
      await field.waitFor();
      await page.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.25);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.45, { steps: 8 });
      await page.mouse.up();
      await player.getByRole('button', { name: '记到原输入框', exact: true }).click();
      const ranged = (await readDraft())[0];
      const selection = ranged.selections[0];
      assert.equal(selection.target.kind, 'moment');
      assert.equal(selection.target.tick, 1429);
      assert.equal(selection.target.endTick, 1433);
      assert.equal(selection.displayRegion.coordinateSpace, 'display-pixels');
      assert.equal(selection.displayRegion.width, 1280);
      assert.equal(selection.canvasRegion.coordinateSpace, 'canvas-pixels');
      assert.equal(selection.canvasRegion.width, 1920);
      assert.ok(Math.abs(selection.canvasRegion.bbox.width / selection.displayRegion.bbox.width - 1.5) < 0.01);
      assert.deepEqual(ranged.input, manifest.input);
      assert.equal(ranged.screeningId, manifest.descriptors.at(-1).screening.id);
      await mark();
      await player.getByRole('button', { name: '这个镜头', exact: true }).click();
      await player.getByRole('button', { name: '记到原输入框', exact: true }).click();
      await mark();
      await player.getByRole('button', { name: '全片', exact: true }).click();
      await player.getByRole('button', { name: '记到原输入框', exact: true }).click();
      const draft = await readDraft();
      assert.equal(draft.length, 3);
      assert.deepEqual(draft[1].selections[0].target, { kind: 'segment', segmentId: 'C08' });
      assert.deepEqual(draft[2].selections[0].target, { kind: 'project' });
      assert.equal(await composer.inputValue(), '隔离验收草稿m');
      const after = await journey.request(`/api/video-projects/${encodeURIComponent(manifest.contentRef)}/review`);
      assert.deepEqual(
        after.review,
        before.review,
        'None of these real UI drafts changes ledger history or creates another message/Task',
      );
      result.attachments = draft;
      await page.screenshot({
        path: path.join(journey.evidence, '01-original-range-region-composer.png'),
        fullPage: true,
      });
      for (let i = 0; i < 3; i++)
        await page
          .getByRole('button', { name: /^移除审片位置 / })
          .first()
          .click();
      await composer.fill(originalWords);
      assert.equal((await readDraft()).length, 0);
      // Hold the real newer media response: an accepted M must wait for its first decoded frame.
      const [prior, final] = manifest.descriptors;
      let release;
      const withheld = new Promise((resolve) => {
        release = resolve;
      });
      const mediaRoute = `${journey.apiOrigin}${final.mediaUrl}`;
      await page.route(mediaRoute, async (route) => {
        await withheld;
        await route.continue();
      });
      try {
        await surface
          .getByRole('combobox', { name: '与旧版对比（当前版固定在右侧）', exact: true })
          .selectOption(prior.screening.id);
        await surface.getByRole('region', { name: '两版审片对比', exact: true }).waitFor();
        await surface.getByRole('button', { name: /标记问题/ }).focus();
        await page.keyboard.press('m');
        await surface.getByText('正在确认画面…', { exact: true }).waitFor();
        assert.equal((await readDraft()).length, 0, 'No unconfirmed frame may enter the original draft');
        await page.screenshot({ path: path.join(journey.evidence, '02-comparison-pending.png'), fullPage: true });
        release();
        await surface.getByText('右侧新版的位置已放进原输入框，发送后记录意见。', { exact: true }).waitFor();
        const comparedDraft = await readDraft();
        assert.equal(comparedDraft.length, 1);
        assert.equal(comparedDraft[0].screeningId, final.screening.id);
        assert.deepEqual(comparedDraft[0].input, final.screening.input);
        assert.equal(await composer.inputValue(), originalWords);
        await page.screenshot({ path: path.join(journey.evidence, '03-comparison-mark-composer.png'), fullPage: true });
        result.comparisonMark = comparedDraft[0];
        await page.getByRole('button', { name: /^移除审片位置 / }).click();
      } finally {
        release();
        await page.unroute(mediaRoute);
      }
      assert.equal((await readDraft()).length, 0);
      assert.deepEqual(
        (await journey.request(`/api/video-projects/${encodeURIComponent(manifest.contentRef)}/review`)).review,
        before.review,
      );
      assert.deepEqual(journey.errors, []);
      result.outcome = 'pass';
    } catch (error) {
      failure = error;
      result.outcome = 'fail';
      throw error;
    }
  },
);
