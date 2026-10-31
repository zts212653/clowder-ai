import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  createScreeningJourney,
  decodedSeek,
  openPreparedProject,
  prepareScreeningJourney,
} from './f326-screening-journey.harness.mjs';

// New isolated project, three honest registrations of existing verified outputs, and unsent composer marks only.
test(
  'F326 real version navigation clears fixed comparison and refuses mixed frozen draft sources',
  { timeout: 300000 },
  async (t) => {
    const journey = await createScreeningJourney();
    const result = { outcome: 'running' };
    let failure;
    t.after(async () => {
      await journey.page.screenshot({ path: path.join(journey.evidence, 'last.png'), fullPage: true }).catch(() => {});
      await writeFile(
        path.join(journey.evidence, 'result.json'),
        JSON.stringify({ ...result, failure: failure?.message, calls: journey.calls, errors: journey.errors }, null, 2),
      );
      await journey.close();
      console.log(`F326 source group evidence: ${journey.evidence}`);
    });
    try {
      const manifest = await prepareScreeningJourney(journey);
      const original = manifest.descriptors.at(-1).screening;
      const source = await journey.request('/api/video-projects/media-source', {
        locator: {
          worktreeId: manifest.movieRoot.id,
          path: path.basename(manifest.movies.at(-1).filename),
        },
      });
      assert.equal(source.revision, original.media.blobDigest);
      const head = await journey.request(`/api/video-projects/${encodeURIComponent(manifest.contentRef)}`);
      const third = await journey.request(`/api/video-projects/${encodeURIComponent(manifest.contentRef)}/screenings`, {
        expectedOwnerRevision: head.ownerRevision,
        operationId: randomUUID(),
        id: randomUUID(),
        title: '同一成片的比较切换验本',
        input: manifest.input,
        source: { locator: source.locator, expectedSourceRevision: source.revision },
        mapping: original.mapping,
        refs: original.refs,
      });
      result.thirdRegistration = {
        screeningId: third.screening.id,
        media: third.screening.media,
        note: 'The third registration reuses existing proven bytes/input; it is not a new render or revisioned movie.',
      };
      await openPreparedProject(journey, manifest);
      const { page } = journey;
      const surface = page.locator(`[data-video-project="${manifest.contentRef}"]`);
      const version = surface.getByRole('combobox', { name: '成片版本' });
      await version.selectOption(third.screening.id);
      const compare = surface.getByRole('combobox', { name: '与旧版对比（当前版固定在右侧）' });
      await compare.selectOption(original.id);
      const pair = surface.getByRole('region', { name: '两版审片对比', exact: true });
      await pair.waitFor();
      assert.equal(await pair.locator('video').count(), 2);
      await page.screenshot({ path: path.join(journey.evidence, '01-v2-left-v3-right.png'), fullPage: true });
      const first = manifest.descriptors[0].screening;
      await version.selectOption(first.id);
      await surface.getByRole('region', { name: '成片播放器', exact: true }).waitFor();
      assert.equal(await pair.count(), 0, 'Choosing v1 must clear v2-left/v3-right immediately');
      assert.equal(await compare.count(), 0, 'The earliest output has no older comparison');
      assert.equal(await version.inputValue(), first.id);
      await page.screenshot({ path: path.join(journey.evidence, '02-v1-single.png'), fullPage: true });
      const before = await journey.request(`/api/video-projects/${encodeURIComponent(manifest.contentRef)}/review`);
      const composer = page.locator('textarea[placeholder*="输入消息"]').first();
      const drafts = () =>
        page.evaluate(
          (threadId) =>
            new Map(JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') ?? '[]')).get(
              threadId,
            ) ?? [],
          manifest.threadId,
        );
      // Use the original product picker, not an injected draft or mocked source: ordinary context must survive.
      await composer.fill('/thread');
      const picker = page.getByRole('dialog', { name: '添加上下文', exact: true });
      await picker.locator('[data-testid^="context-thread-"]').first().click();
      await page.waitForFunction(
        (threadId) =>
          new Map(JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') ?? '[]'))
            .get(threadId)
            ?.some((item) => item.kind === 'thread'),
        manifest.threadId,
      );
      const originalContext = await drafts();
      assert.equal(originalContext.length, 1);
      assert.equal(originalContext[0].kind, 'thread');
      await composer.fill('隔离验收：两版位置不会混发');
      const mark = async () => {
        const player = surface.getByRole('region', { name: '成片播放器', exact: true });
        const video = player.locator('video');
        await decodedSeek(video, 1429 / 30);
        await video.focus();
        await page.keyboard.press('m');
        await player.getByRole('button', { name: '记到原输入框', exact: true }).click();
        return player;
      };
      await mark();
      await page.getByRole('button', { name: /^移除审片位置 / }).waitFor();
      const frozen = await drafts();
      assert.equal(frozen.length, 2);
      assert.deepEqual(frozen[0], originalContext[0]);
      assert.equal(frozen[1].screeningId, first.id);
      await version.selectOption(original.id);
      const newer = await mark();
      await newer.getByText(/先发送或移除/).waitFor();
      assert.deepEqual(await drafts(), frozen, 'Refusal preserves the original frozen chip instead of retargeting it');
      assert.equal(await composer.inputValue(), '隔离验收：两版位置不会混发');
      await page.screenshot({ path: path.join(journey.evidence, '03-mixed-source-refused.png'), fullPage: true });
      const after = await journey.request(`/api/video-projects/${encodeURIComponent(manifest.contentRef)}/review`);
      assert.deepEqual(after.review, before.review);
      assert.ok(
        !journey.requests.some((request) => /\/api\/messages(?:\?|$)/.test(request.url)),
        'This boundary journey never sends a Human/model message',
      );
      result.originalDraft = frozen;
      result.originalContext = originalContext;
      result.outcome = 'pass';
      assert.deepEqual(journey.errors, []);
    } catch (error) {
      failure = error;
      result.outcome = 'fail';
      throw error;
    }
  },
);
