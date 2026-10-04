import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { mediaFixture, offsetRotatedVfrFixture } from './fixtures/f309-artifact-review-media.mjs';
import { selectReviewMode } from './fixtures/f309-artwork-controls.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const samples = path.join(repository, 'docs/evidence/2026-09-29-f309-studio-northstar/mock');
async function input(root, kind, version) {
  if (kind === 'mp4') return mediaFixture(root, kind, version);
  const name = version === 1 ? 'review-input.png' : 'review-response.png';
  await copyFile(
    path.join(
      samples,
      version === 1
        ? 'f323-phase-a-design-mobile-e2869df73c14cdae.png'
        : 'f323-phase-a-design-mobile-review-r2-20260928-2e688e95.png',
    ),
    path.join(root, name),
  );
  return name;
}

for (const sample of ['png', 'mp4', 'mp4-offset', 'mp4-short'])
  test(
    `K3 ${sample}: real F307 comparison, exact bytes, review receipt and original return`,
    { timeout: 150000 },
    async (t) => {
      const kind = sample === 'png' ? 'png' : 'mp4';
      const root = await mkdtemp(path.join(tmpdir(), `f309-k3-${sample}-`));
      const evidence = process.env.F309_BROWSER_EVIDENCE_DIR ?? root;
      await mkdir(evidence, { recursive: true });
      if (sample === 'mp4-offset') await offsetRotatedVfrFixture(root);
      else await input(root, kind, 1);
      const host = await startReviewHost(root, kind === 'png' ? 'image/png' : 'video/mp4');
      let browser, page;
      t.after(async () => {
        if (page)
          await page
            .screenshot({ path: path.join(evidence, `task-${sample}-last.png`), fullPage: true })
            .catch(() => {});
        await browser?.close();
        await host.close();
      });
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(10000);
      const errors = [],
        mutations = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (request.method() === 'POST') mutations.push({ url: request.url(), body: request.postDataJSON() });
      });
      await page.goto(host.origin);
      await page.getByTestId('open-artifact-review').click();
      await page.getByTestId('artifact-review-surface').waitFor();
      const prepared = await host.reviews.prepare(host.prepare, host.human);
      const reviewId = prepared.review.reviewId;
      const responseFile = await input(root, kind, 2);
      if (sample === 'mp4-short')
        execFileSync('ffmpeg', [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=s=640x360:r=25:d=1.5',
          '-vf',
          'hue=h=25',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          path.join(root, responseFile),
        ]);
      const publication = host.publish(responseFile);
      await host.catCallback('respond', {
        reviewId,
        expectedRevision: prepared.review.revision,
        expectedTaskRevision: 1,
        expectedOwnerRevision: 1,
        operationId: 'k3-return-version',
        artifactRef: `/uploads/${responseFile}`,
        expectedArtifactRevision: String(publication.timestamp),
        responses: [],
      });
      await host.lifecycle.update({
        taskId: host.taskId,
        expectedRevision: 1,
        artifactRefs: [`content:${prepared.review.contentRef}`],
      });
      let view = await host.reviews.read(reviewId, host.cat);
      await host.catCallback('act', {
        reviewId,
        expectedRevision: view.review.revision,
        expectedTaskRevision: 2,
        round: 2,
        operationId: 'k3-request-decision',
        action: { kind: 'request_judgment', summary: '两版已准备好', judgmentNeeded: '确认此版本' },
      });
      await page.getByTestId('artifact-review-surface').getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByRole('combobox', { name: '审阅版本' }).selectOption('2');
      const canvas = page.getByTestId('workspace-review-artwork');
      await canvas.evaluate((element) => (element.dataset.k3Continuity = 'original-canvas'));
      await selectReviewMode(page, 'comment');
      const draft = `对比前未提交的评论-${sample}`;
      await page.getByRole('textbox', { name: '评论内容' }).fill(draft);
      await page.getByRole('button', { name: '对比版本', exact: true }).click();
      const compare = page.getByTestId('artifact-media-compare');
      const media = compare.locator(kind === 'png' ? 'figure img' : 'figure video');
      await media.first().waitFor({ state: 'attached' });
      if (kind === 'png') await media.evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
      else await compare.getByRole('button', { name: '同步播放', exact: true }).waitFor();
      assert.equal(await media.count(), 2);
      const bytePairs = await media.evaluateAll(async (elements) =>
        Promise.all(
          elements.map(async (element) => Array.from(new Uint8Array(await (await fetch(element.src)).arrayBuffer()))),
        ),
      );
      assert.deepEqual(Buffer.from(bytePairs[0]), await readFile(path.join(root, `review-input.${kind}`)));
      assert.deepEqual(Buffer.from(bytePairs[1]), await readFile(path.join(root, responseFile)));
      assert.notDeepEqual(bytePairs[0], bytePairs[1]);
      if (kind === 'png') {
        assert.equal(await compare.locator('[aria-label="版本对比"]').getAttribute('data-compare-mode'), 'side');
        const widths = await media.evaluateAll((images) => images.map((image) => image.getBoundingClientRect().width));
        assert.ok(
          widths.every((width) => width >= 389),
          `portrait side by side remains readable: ${widths}`,
        );
        await compare.getByTestId('media-compare-viewport').evaluate((element) => {
          element.scrollTop = 120;
        });
      }
      const beforeCompare = mutations.length;
      await compare.getByRole('button', { name: '切换', exact: true }).click();
      await compare.getByRole('button', { name: '原版 · v1', exact: true }).click();
      await compare.getByRole('button', { name: '候选版本 · v2', exact: true }).click();
      if (kind === 'png')
        assert.equal(await compare.getByTestId('media-compare-viewport').evaluate((element) => element.scrollTop), 120);
      if (kind === 'mp4') {
        const starts = view.review.rounds.map(
          (round) =>
            (round.asset.media.startTick * round.asset.media.timebase.numerator) /
            round.asset.media.timebase.denominator,
        );
        await compare.getByRole('button', { name: '同步播放', exact: true }).click();
        await page.waitForFunction(
          (starts) =>
            [...document.querySelectorAll('[data-testid="artifact-media-compare"] video')].every(
              (video, index) => video.currentTime > starts[index] + 0.2 && !video.paused,
            ),
          starts,
        );
        if (sample === 'mp4-short') {
          assert.ok(view.review.rounds[1].asset.media.durationTicks < view.review.rounds[0].asset.media.durationTicks);
          await page.waitForFunction(() => {
            const videos = [...document.querySelectorAll('[data-testid="artifact-media-compare"] figure video')];
            return videos[1].ended && !videos[0].paused;
          });
          await compare.getByRole('slider', { name: '对比播放位置' }).evaluate((slider) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '0.4');
            slider.dispatchEvent(new Event('input', { bubbles: true }));
          });
          await page.waitForFunction(() =>
            [...document.querySelectorAll('[data-testid="artifact-media-compare"] figure video')].every(
              (video) => !video.paused && video.currentTime > 0.5,
            ),
          );
          await compare.screenshot({ path: path.join(evidence, 'task-mp4-short-rewound.png') });
        }
        await compare.getByRole('button', { name: '暂停两版', exact: true }).click();
        const times = await media.evaluateAll((videos) => videos.map((video) => video.currentTime));
        assert.ok(Math.abs(times[0] - starts[0] - (times[1] - starts[1])) < 0.15, `aligned real playheads: ${times}`);
      }
      assert.equal(mutations.length, beforeCompare, 'view/seek/switch/play must not mutate the review or write files');
      await compare.screenshot({ path: path.join(evidence, `task-${sample}-desktop.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(
        () => document.querySelector('[aria-label="版本对比"]')?.getAttribute('data-compare-mode') === 'toggle',
      );
      await compare.screenshot({ path: path.join(evidence, `task-${sample}-mobile.png`) });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await compare.getByRole('button', { name: '返回作品', exact: true }).click();
      assert.equal(await canvas.getAttribute('data-k3-continuity'), 'original-canvas');
      assert.equal(await page.getByRole('textbox', { name: '评论内容' }).inputValue(), draft);
      await page.getByRole('button', { name: '对比版本', exact: true }).click();
      await compare.getByRole('textbox', { name: '审阅结论说明' }).fill('此版本审阅通过；原任务仍由负责猫继续。');
      const actionUrl = `${host.apiOrigin}/api/artifact-reviews/${reviewId}/actions`;
      if (sample === 'png') {
        await page.route(actionUrl, async (route) => {
          const committed = await route.fetch();
          assert.equal(committed.status(), 200, await committed.text());
          await route.abort('failed');
        });
        await compare.getByRole('button', { name: '通过此版本', exact: true }).click();
        await compare.getByRole('status').filter({ hasText: '保存结果尚未确认；此版本与判断草稿已保留。' }).waitFor();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('[data-testid="artifact-media-compare"] button')].some(
            (button) => button.textContent === '重试原保存操作' && !button.disabled,
          ),
        );
        assert.equal((await host.reviews.read(reviewId, host.human)).review.rounds.at(-1).state, 'approved');
        assert.ok(
          await page.evaluate(() =>
            Object.entries(localStorage).some(
              ([key, value]) => key.endsWith(':decision') && value.includes('此版本审阅通过'),
            ),
          ),
        );
        await compare.screenshot({ path: path.join(evidence, 'task-png-unknown.png') });
        await compare.getByRole('button', { name: '返回作品', exact: true }).click();
        await page.getByRole('button', { name: '对比版本', exact: true }).click();
        await compare.getByRole('button', { name: '重试原保存操作', exact: true }).waitFor();
        await page.unroute(actionUrl);
      }
      const decision = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/artifact-reviews/${reviewId}/actions`) &&
          response.request().method() === 'POST',
      );
      await compare
        .getByRole('button', { name: sample === 'png' ? '重试原保存操作' : '通过此版本', exact: true })
        .click();
      const receipt = await decision;
      const decisions = mutations.filter((request) => request.url === actionUrl);
      assert.equal(decisions.length, sample === 'png' ? 2 : 1);
      if (sample === 'png') assert.equal(decisions[0].body.operationId, decisions[1].body.operationId);
      assert.equal(receipt.status(), 200, await receipt.text());
      view = await host.reviews.read(reviewId, host.human);
      assert.equal(view.review.rounds.at(-1).decision.outcome, 'approved');
      assert.notEqual(host.tasks.get(host.taskId).status, 'done', 'a review decision must not close the original Task');
      assert.ok(
        mutations.every(
          (request) =>
            !request.url.includes('/content-modifications/') && !request.url.includes('/workspace/edit-session'),
        ),
      );
      await compare.getByRole('button', { name: '返回来源', exact: true }).click();
      await page.getByTestId('product-schedule-panel').waitFor();
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(evidence, `task-${sample}-receipt.json`),
        JSON.stringify(
          {
            reviewId,
            mutations,
            decision: view.review.rounds.at(-1).decision,
            byteLengths: bytePairs.map((bytes) => bytes.length),
            errors,
          },
          null,
          2,
        ),
      );
      console.log(`K3 evidence: ${evidence}`);
    },
  );
