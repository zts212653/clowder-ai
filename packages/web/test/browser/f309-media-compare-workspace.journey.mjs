import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';

const outcomeLabels = {
  applied: '已写回原文件',
  conflict: '原文件已有改动，尚未写回；新版本已保留。',
  rejected: '已拒绝此候选；候选和原讨论仍保留。',
  cancelled: '本次修改请求已取消',
  unavailable: '已写回原文件',
  'unavailable-bytes': '已写回原文件',
  'unavailable-decode': '已写回原文件',
};
const entryPath = fileURLToPath(new URL('./fixtures/f309-modification-compare.tsx', import.meta.url));
for (const [kind, outcome] of [
  ['png', 'applied'],
  ['mp4', 'applied'],
  ['png', 'conflict'],
  ['png', 'rejected'],
  ['mp4', 'cancelled'],
  ['png', 'unavailable'],
  ['mp4', 'unavailable'],
  ['png', 'unavailable-bytes'],
  ['mp4', 'unavailable-bytes'],
  ['png', 'unavailable-decode'],
  ['mp4', 'unavailable-decode'],
])
  test(
    `K3 workspace ${kind}: comparison and explicit ${outcome} through real request/CAS/receipt`,
    { timeout: 150000 },
    async (t) => {
      const unavailable = outcome.startsWith('unavailable');
      const root = await mkdtemp(path.join(tmpdir(), `f309-k3-workspace-${outcome}-`));
      const evidence = process.env.F309_BROWSER_EVIDENCE_DIR ?? root;
      await mkdir(evidence, { recursive: true });
      await mediaFixture(root, kind);
      const host = await startReviewHost(root, kind === 'png' ? 'image/png' : 'video/mp4', {
        entryPath,
        workspaceComparison: true,
      });
      let browser, page;
      t.after(async () => {
        if (page)
          await page
            .screenshot({ path: path.join(evidence, `workspace-${kind}-${outcome}-last.png`), fullPage: true })
            .catch(() => {});
        await browser?.close();
        await host.close();
      });
      const json = async (url, body) => {
        const response = await fetch(`${host.apiOrigin}${url}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        assert.equal(response.status, 200, JSON.stringify(data));
        return data;
      };
      const file = await host.files.prepare({
        principal: host.human,
        locator: { worktreeId: 'work', path: `review-input.${kind}` },
        operationId: 'k3-open-workspace',
      });
      const request = await json('/api/content-modifications', {
        operationId: randomUUID(),
        threadId: host.thread.id,
        targetCatId: 'codex-astra',
        source: {
          kind: 'workspace',
          locator: { worktreeId: 'work', path: `review-input.${kind}` },
          reviewId: file.review.reviewId,
          expectedReviewRevision: file.review.revision,
          expectedSourceRevision: file.review.source.revision,
        },
        intent: { body: '修改此媒体，返回候选供对比；等待明确采用。' },
      });
      assert.ok(request.record.progress.review, JSON.stringify(request));
      const reviewId = request.record.progress.review.reviewId;
      const name = await mediaFixture(root, kind, 2),
        published = host.publish(name);
      const review = await host.reviews.read(reviewId, host.cat);
      await host.catCallback('respond', {
        requestId: request.record.requestId,
        reviewId,
        expectedRevision: review.review.revision,
        expectedTaskRevision: request.record.progress.task.revision,
        expectedOwnerRevision: 1,
        expectedLedgerRevision: review.review.rounds.at(-1).ledgerRevision,
        operationId: 'k3-workspace-response',
        artifactRef: `/uploads/${name}`,
        expectedArtifactRevision: String(published.timestamp),
        responses: review.review.rounds.at(-1).annotations.map((annotation) => ({
          annotationId: annotation.id,
          disposition: 'addressed',
          explanation: '已按原修改要求返回此候选。',
        })),
      });
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      page.setDefaultTimeout(10000);
      const errors = [],
        posts = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (request.method() === 'POST') posts.push({ url: request.url(), body: request.postDataJSON() });
      });
      if (outcome === 'unavailable') {
        const original = request.record.progress.prepared;
        await page.route(
          `${host.apiOrigin}/api/content-publications/${encodeURIComponent(original.contentRef)}?ownerRevision=${original.ownerRevision}`,
          (route) => route.abort('failed'),
        );
      } else if (unavailable) {
        const original = request.record.progress.prepared;
        await page.route(
          `${host.apiOrigin}/api/content-publications/${encodeURIComponent(original.contentRef)}/media/${original.ownerRevision}`,
          (route) =>
            outcome === 'unavailable-bytes'
              ? route.abort('failed')
              : route.fulfill({
                  status: 200,
                  contentType: kind === 'png' ? 'image/png' : 'video/mp4',
                  body: 'deliberately undecodable browser read; owner metadata and candidate unchanged',
                }),
        );
      }
      await page.goto(`${host.origin}?request=${request.record.requestId}`);
      const original = await readFile(path.join(root, `review-input.${kind}`));
      if (unavailable) {
        const candidate =
          kind === 'png'
            ? page.getByRole('img', { name: '返回的图片新版本', exact: true })
            : page.getByLabel('返回的视频新版本', { exact: true });
        await candidate.waitFor({ state: 'visible' });
        if (kind === 'png') await candidate.evaluate((image) => image.decode());
        else
          await page.waitForFunction(
            () => document.querySelector('video[aria-label="返回的视频新版本"]')?.readyState >= 1,
          );
        await page
          .getByRole('alert')
          .filter({ hasText: outcome === 'unavailable' ? '原版当前无法核对' : '两版暂无法核对' })
          .waitFor();
        const bytes = await candidate.evaluate(async (media) =>
          Array.from(new Uint8Array(await (await fetch(media.src)).arrayBuffer())),
        );
        assert.deepEqual(Buffer.from(bytes), await readFile(path.join(root, name)));
        await page.screenshot({
          path: path.join(evidence, `workspace-${kind}-original-${outcome}.png`),
          fullPage: true,
        });
      } else {
        const compare = page.getByRole('region', { name: '版本对比', exact: true });
        // A single candidate remains visible while the original metadata/bytes load.
        // Wait for both comparison panes, rather than mistaking that fallback for a settled pair.
        await compare
          .locator(kind === 'png' ? 'figure img' : 'figure video')
          .nth(1)
          .waitFor({ state: 'attached' });
        assert.equal(await compare.locator(kind === 'png' ? 'img' : 'video').count(), 2);
        if (kind === 'png') {
          const bounds = await compare.locator('figure:not([hidden]) img').boundingBox();
          assert.ok(bounds && bounds.width >= 450, `wide workspace media remains readable: ${JSON.stringify(bounds)}`);
        }
        const snapshot = await compare
          .locator(kind === 'png' ? 'img' : 'video')
          .first()
          .evaluate(async (media) => Array.from(new Uint8Array(await (await fetch(media.src)).arrayBuffer())));
        assert.deepEqual(Buffer.from(snapshot), original);
        await compare.getByRole('button', { name: '切换', exact: true }).click();
        await compare.getByRole('button', { name: '原版 · v1', exact: true }).click();
        await compare.getByRole('button', { name: '候选版本 · v2', exact: true }).click();
      }
      assert.ok(!posts.some((post) => /\/(accept|reject|cancel|edit-session)$/.test(post.url)));
      assert.deepEqual(
        await readFile(path.join(root, `review-input.${kind}`)),
        original,
        'comparison never writes bytes',
      );
      if (outcome === 'conflict')
        await writeFile(path.join(root, `review-input.${kind}`), await readFile(path.join(root, name)));
      await page.getByRole('button', { name: '收起修改面板', exact: true }).click();
      await page.getByRole('button', { name: '重新打开候选', exact: true }).click();
      if (outcome === 'rejected') await page.getByRole('button', { name: '不采用', exact: true }).click();
      else if (outcome === 'cancelled') await page.getByTestId('content-modification-cancel').click();
      else await page.getByRole('button', { name: '采用并写回', exact: true }).click();
      await page
        .getByText(outcomeLabels[outcome], { exact: outcome !== 'cancelled' })
        .first()
        .waitFor();
      const result = await (
        await fetch(`${host.apiOrigin}/api/content-modifications/${request.record.requestId}`)
      ).json();
      assert.equal(result.candidates.length, 1);
      if (['applied', 'conflict'].includes(outcome) || unavailable) {
        assert.equal(result.acceptances[0].receipt.state, unavailable ? 'applied' : outcome);
        assert.equal(posts.filter((post) => post.url.endsWith('/accept')).length, 1);
      } else assert.equal(result.acceptances.length, 0);
      if (['rejected', 'cancelled'].includes(outcome))
        assert.deepEqual(await readFile(path.join(root, `review-input.${kind}`)), original);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(evidence, `workspace-${kind}-${outcome}.png`), fullPage: true });
      await writeFile(
        path.join(evidence, `workspace-${kind}-${outcome}-receipt.json`),
        JSON.stringify(
          {
            posts: posts.map((post) => ({
              ...post,
              body: {
                ...post.body,
                ...(post.body?.editSessionToken ? { editSessionToken: '[redacted isolated fixture token]' } : {}),
              },
            })),
            result,
            errors,
          },
          null,
          2,
        ),
      );
      console.log(`K3 workspace evidence: ${evidence}`);
    },
  );
