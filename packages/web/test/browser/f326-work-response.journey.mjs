import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';

test(
  'Work response: v1 opinion → common v4 submit → original source → exact new frame → Human accept/reopen',
  { timeout: 180000 },
  async (t) => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'f326-work-response-'));
    const evidence = process.env.F309_BROWSER_EVIDENCE_DIR ?? scratch;
    await mkdir(evidence, { recursive: true });
    for (const revision of [1, 2, 3, 4])
      await promisify(execFile)(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=s=640x360:r=25:d=3',
          '-vf',
          `hue=h=${revision * 30}`,
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          '-video_track_timescale',
          revision === 4 ? '90000' : '12800',
          path.join(scratch, revision === 1 ? 'review-input.mp4' : `v${revision}.mp4`),
        ],
        { timeout: 15000 },
      );
    const host = await startReviewHost(scratch, 'video/mp4', {
      entryPath: path.join(import.meta.dirname, 'fixtures/f326-work-response.tsx'),
      workSubmissions: true,
    });
    let browser,
      page,
      passed = false;
    const errors = [],
      calls = [];
    t.after(async () => {
      if (page)
        await page.screenshot({ path: path.join(evidence, 'work-response-final.png'), fullPage: true }).catch(() => {});
      await writeFile(
        path.join(evidence, 'work-response.json'),
        JSON.stringify(
          {
            passed,
            errors,
            calls,
            boundary:
              'Private real MP4 fixture, shipped common callback/owner/review/ledger and production video UI. Fixture-created invocation; no C5, real-film or You C7 claim.',
          },
          null,
          2,
        ),
      );
      await browser?.close();
      await host.close();
      console.log(`Work response evidence: ${evidence}`);
      if (scratch !== evidence) await rm(scratch, { recursive: true, force: true });
    });
    let contentTaskId;
    const work = async (command) =>
      JSON.parse(
        (
          await host.taskCallback('work', {
            command,
            ...(contentTaskId ? { contentTaskId } : {}),
          })
        ).json,
      );
    const source = async (name) =>
      (await work({ action: 'inspect-source', locator: { worktreeId: 'work', path: name } })).source;
    const created = await work({
      action: 'create',
      operationId: 'v1',
      title: '同一件作品',
      changeSummary: '原版',
      source: await source('review-input.mp4'),
    });
    // Actual Human modification admission supplies the exact Task/content grant.
    // Merely putting a ref on an arbitrary Task must not grant a cat the original asset.
    const ledger = await host.ledgers.prepare({
      principal: host.human,
      publication: created.reference,
      operationId: 'open-original-ledger',
    });
    const asset = await host.media.read(created.reference.contentRef, 1, host.human);
    const secondsToTick = (seconds, media) =>
      media.startTick + Math.round((seconds * media.timebase.denominator) / media.timebase.numerator);
    const setStory = async (reference, media, start, end) =>
      work({
        action: 'set-context',
        reference,
        operationId: `story-${reference.ownerRevision}`,
        expectedMetadataRevision: 0,
        context: {
          format: 'video',
          extractorVersion: 'actual-fixture-clock',
          provenance: [{ ref: 'fixture-script', digest: `sha256:${'a'.repeat(64)}` }],
          assets: [],
          story: [
            {
              id: `paragraph-v${reference.ownerRevision}`,
              sourceId: 'original-script#tail',
              title: '片尾',
              streamId: media.streamId,
              startPts: secondsToTick(start, media),
              endPts: secondsToTick(end, media),
            },
          ],
        },
      });

    const admitted = await host.app.inject({
      method: 'POST',
      url: '/api/content-modifications',
      payload: {
        operationId: randomUUID(),
        threadId: host.thread.id,
        targetCatId: 'codex-astra',
        source: {
          kind: 'publication',
          ...created.reference,
          ledgerRef: ledger.review.reviewId,
          expectedLedgerRevision: ledger.review.revision,
        },
        intent: {
          body: '片尾切得太晚，请在新版前移。',
          selection: {
            kind: 'video-range',
            streamId: asset.media.streamId,
            startTick: secondsToTick(2.4, asset.media),
            endTick: secondsToTick(2.8, asset.media),
          },
        },
      },
    });
    assert.equal(admitted.statusCode, 200, admitted.body);
    const request = admitted.json();
    assert.equal(request.stage, 'queued', JSON.stringify(request));
    contentTaskId = request.record.progress.task.taskId;
    await setStory(created.reference, asset.media, 2.4, 2.8);
    const taskRevision = request.record.progress.task.revision;
    const reviewId = request.record.progress.review.reviewId;
    const current = { view: await host.reviews.read(reviewId, host.human) };
    const original = current.view.review.rounds[0];
    assert.equal(original.annotations.length, 1);
    assert.equal(original.annotations[0].body, '片尾切得太晚，请在新版前移。');
    assert.equal(original.ledgerRef, ledger.review.reviewId);
    for (const revision of [2, 3])
      await work({
        action: 'submit',
        contentRef: created.reference.contentRef,
        expectedOwnerRevision: revision - 1,
        operationId: `v${revision}`,
        title: '同一件作品',
        changeSummary: `中间版本 ${revision}`,
        source: await source(`v${revision}.mp4`),
      });
    const inspected = await work({ action: 'inspect-source', locator: { worktreeId: 'work', path: 'v4.mp4' } });
    const result = await work({
      action: 'submit',
      contentRef: created.reference.contentRef,
      expectedOwnerRevision: 3,
      operationId: 'v4-and-original-response',
      title: '同一件作品',
      changeSummary: '按原版意见前移',
      source: inspected.source,
      reviewResponse: {
        reviewId,
        sourceRound: 1,
        requestId: request.record.requestId,
        expectedReviewRevision: current.view.review.revision,
        expectedTaskRevision: taskRevision,
        expectedLedgerRevision: current.view.review.rounds[0].ledgerRevision,
        responses: [
          {
            annotationId: original.annotations[0].id,
            disposition: 'addressed',
            explanation: '第 4 版已将这一段前移到 1.2 秒。',
            resultAnchor: {
              kind: 'video-range',
              streamId: inspected.media.streamId,
              startTick: secondsToTick(1.2, inspected.media),
              endTick: secondsToTick(1.6, inspected.media),
            },
          },
        ],
      },
    });
    assert.equal(result.reference.ownerRevision, 4);
    await setStory(result.reference, inspected.media, 1.2, 1.6);
    assert.equal(host.store.get(reviewId).rounds.length, 2, 'owner revisions do not create fake review rounds');
    assert.equal(host.store.get(reviewId).rounds[0].annotations[0].state, 'open', 'cat claim is not Human acceptance');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.url().includes('/api/artifact-reviews/'))
        calls.push({ url: response.url(), status: response.status() });
    });
    const url = `${host.origin}?${new URLSearchParams({ ...result.reference, threadId: host.thread.id })}`;
    await page.goto(url);
    await openWorkDiscussion(page);
    const responsePanel = page.getByRole('region', { name: '这一版对原意见的回应' });
    await responsePanel.getByText('等待你的判断', { exact: true }).waitFor();
    await page.getByRole('button', { name: '对比版本', exact: true }).click();
    await page.getByRole('combobox', { name: '左侧作品版本', exact: true }).selectOption('1');
    await page.locator('video[aria-label="对比原件第 1 版"]').waitFor();
    await page.getByRole('combobox', { name: '对齐故事段', exact: true }).selectOption('original-script#tail');
    await page.getByRole('button', { name: '两版定位到这段', exact: true }).click();
    await page.waitForFunction(() => {
      const left = document.querySelector('video[aria-label="对比原件第 1 版"]');
      const right = [...document.querySelectorAll('video')].find((v) => !v.hasAttribute('aria-label'));
      return (
        left?.readyState >= 2 &&
        Math.abs(left.currentTime - 2.4) < 0.05 &&
        right?.readyState >= 2 &&
        Math.abs(right.currentTime - 1.2) < 0.05
      );
    });
    const alignment = await page.locator('video').evaluateAll((videos) =>
      videos.map((video) => ({
        name: video.getAttribute('aria-label'),
        seconds: video.currentTime,
        width: video.videoWidth,
        frames: video.getVideoPlaybackQuality().totalVideoFrames,
      })),
    );
    assert.ok(alignment.every((video) => video.width > 0 && video.frames > 0));
    assert.notDeepEqual(asset.media.timebase, inspected.media.timebase, 'Actual clips have independent media clocks');
    await page.screenshot({ path: path.join(evidence, 'work-response-aligned.png'), fullPage: true });
    await page.getByRole('combobox', { name: '对比方式', exact: true }).selectOption('sequential');
    await page.getByRole('button', { name: '两版定位到这段', exact: true }).click();
    await page.getByRole('button', { name: '看左版（第 1 版）', exact: true }).click();
    await page.waitForFunction(() => {
      const left = document.querySelector('video[aria-label="对比原件第 1 版"]');
      return left?.readyState >= 2 && Math.abs(left.currentTime - 2.4) < 0.05;
    });
    await page.getByRole('button', { name: '返回看片', exact: true }).click();

    await responsePanel.getByText('原意见 · 第 1 版', { exact: true }).click();
    await responsePanel.getByText('片尾切得太晚，请在新版前移。', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'work-response-original.png'), fullPage: true });
    await responsePanel.getByRole('button', { name: '看原意见所在版本', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-content-ready="true"]')?.dataset.ownerRevision === '1',
    );
    await page.getByRole('combobox', { name: '作品版本', exact: true }).selectOption('4');
    await openWorkDiscussion(page);
    await responsePanel.getByRole('button', { name: '查看新版位置', exact: true }).click();
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video?.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - 1.2) < 0.05;
    });
    const frame = await page
      .locator('video')
      .first()
      .evaluate((video) => ({
        currentTime: video.currentTime,
        width: video.videoWidth,
        height: video.videoHeight,
        presentedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
      }));
    assert.ok(frame.width > 0 && frame.presentedFrames > 0);
    await responsePanel.getByRole('button', { name: '已改', exact: true }).click();
    await responsePanel.getByText('你已确认：已改', { exact: true }).waitFor();
    assert.equal(host.store.get(reviewId).rounds[0].annotations[0].state, 'resolved');
    await page.reload();
    await openWorkDiscussion(page);
    await responsePanel.getByText('你已确认：已改', { exact: true }).waitFor();
    await responsePanel.getByRole('button', { name: '还不对', exact: true }).click();
    await responsePanel.getByText('你已确认：还不对', { exact: true }).waitFor();
    assert.equal(host.store.get(reviewId).rounds[0].annotations[0].state, 'open');
    await page.reload();
    await openWorkDiscussion(page);
    await responsePanel.getByText('你已确认：还不对', { exact: true }).waitFor();
    const saved = host.store.get(reviewId);
    assert.equal(saved.rounds[1].asset.ownerRevision, 4);
    assert.equal(saved.rounds[1].responses[0].judgment.outcome, 'reopened');
    assert.equal(saved.rounds[1].responses[0].judgment.actor.kind, 'human');
    assert.equal((await host.owner.describe(created.reference.contentRef)).currentOwnerRevision, 4);
    assert.equal(
      (await host.owner.listOutbox(created.reference.contentRef)).length,
      4,
      'judgment cannot publish another version',
    );
    const retainedLedger = await host.ledgers.read({ reviewId: saved.rounds[0].ledgerRef, principal: host.human });
    assert.equal(retainedLedger.review.annotations[0].state, 'open');
    assert.deepEqual(errors, []);
    await writeFile(
      path.join(evidence, 'work-response-owner.json'),
      JSON.stringify(
        {
          reference: result.reference,
          frame,
          alignment: { frames: alignment, leftClock: asset.media.timebase, rightClock: inspected.media.timebase },
          review: saved,
          ledger: retainedLedger.review,
        },
        null,
        2,
      ),
    );
    passed = true;
  },
);

async function openWorkDiscussion(page) {
  const button = page.getByRole('button', { name: /^一起讨论/ });
  await button.waitFor();
  if ((await button.getAttribute('aria-expanded')) === 'false') await button.click();
}
