import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { cleanAuthorDraft } from './f326-real-works-composer.journey.mjs';
import { verifyDeliveredLibrary, verifyParagraphOpinion } from './f326-real-works-library.journey.mjs';
import { decodedSeek } from './f326-screening-journey.harness.mjs';

const api = 'http://127.0.0.1:3362',
  web = 'http://127.0.0.1:3361';
const digestFile = async (filename) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
};

test(
  'a real delivered film enters the original Works, seeks a sourced paragraph and queues an original-composer mark',
  { timeout: 300000 },
  async (t) => {
    assert.equal(process.env.F326_C_BROWSER_ALLOW_MUTATIONS, 'isolated-feature');
    const manifest = JSON.parse(await readFile(process.env.F326_C_REAL_FILM_MANIFEST, 'utf8'));
    assert.equal(await digestFile(manifest.film), manifest.digest);
    const evidence = await mkdtemp('/tmp/f326-c-real-works-');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    const errors = [],
      calls = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let outcome = 'running',
      failure,
      observedFrame,
      observedLayout,
      cleanOwnDraft;
    t.after(async () => {
      await page.screenshot({ path: path.join(evidence, 'last.png'), fullPage: true }).catch(() => {});
      await writeFile(
        path.join(evidence, 'composer-draft.json'),
        JSON.stringify(
          await page.evaluate(() => ({
            drafts: JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') || '[]'),
            notices: [...document.querySelectorAll('[role="alert"], [data-testid="workspace-content-review-surface"]')]
              .filter((node) => node.getClientRects().length)
              .map((node) => node.textContent),
          })),
          null,
          2,
        ),
      ).catch(() => {});
      await writeFile(
        path.join(evidence, 'result.json'),
        JSON.stringify({ outcome, failure, observedFrame, observedLayout, errors, calls }, null, 2),
      );
      try {
        if (cleanOwnDraft) {
          const cleanup = await cleanOwnDraft();
          await writeFile(path.join(evidence, 'composer-cleanup.json'), JSON.stringify(cleanup, null, 2));
        }
      } finally {
        await browser.close();
        console.log(`F326 C real Works evidence: ${evidence}`);
      }
    });
    try {
      const session = await context.request.get(`${api}/api/session`);
      assert.equal(session.status(), 200);
      const { csrfToken } = await session.json();
      const request = async (route, data) => {
        const response =
          data === undefined
            ? await context.request.get(`${api}${route}`)
            : await context.request.post(`${api}${route}`, { data, headers: { 'x-csrf-token': csrfToken } });
        const text = await response.text();
        calls.push({ route, status: response.status() });
        assert.ok(response.ok(), `${route}: ${response.status()} ${text.slice(0, 1600)}`);
        return JSON.parse(text);
      };
      const thread = await request('/api/threads', {
        title: 'F326 C · 真实片子',
        idempotencyKey: 'be1df368-cd1c-4acb-9227-0eb155fac653',
      });
      const roots = await request('/api/workspace/worktrees');
      let root = roots.worktrees.find(
        (row) => row.resolvedRoot === path.dirname(manifest.film) || row.root === path.dirname(manifest.film),
      );
      if (!root?.id?.startsWith('f063_root_v1_')) {
        const value = await request('/api/workspace/linked-roots', {
          name: 'f326-c-real-film-rsi',
          path: path.dirname(manifest.film),
        });
        root = value.linked;
        await request('/api/workspace/worktrees');
      }
      const command = (value) => request('/api/works/command', { threadId: thread.id, command: value });
      const { source } = await command({
        action: 'inspect-source',
        locator: { worktreeId: root.id, path: path.basename(manifest.film) },
      });
      assert.equal(source.expectedSourceRevision, manifest.digest);
      const saved = await command({
        action: 'create',
        operationId: manifest.operationId,
        title: manifest.title,
        versionLabel: manifest.versionLabel,
        changeSummary: manifest.changeSummary,
        source,
      });
      const { asset } = await request(
        `/api/content-publications/${encodeURIComponent(saved.reference.contentRef)}?ownerRevision=${saved.reference.ownerRevision}`,
      );
      const timeline = JSON.parse(await readFile(manifest.timeline, 'utf8'));
      const toPts = (seconds) =>
        Math.round((seconds * asset.media.timebase.denominator) / asset.media.timebase.numerator);
      const story = timeline.lines.map((line) => ({
        id: line.id,
        title: line.chapter,
        text: line.text,
        sourceId: `${manifest.timeline}#${line.id}`,
        streamId: asset.media.streamId,
        startPts: toPts(line.start),
        endPts: toPts(line.end),
      }));
      await command({
        action: 'set-context',
        reference: saved.reference,
        operationId: 'rsi-timeline-index-v1',
        expectedMetadataRevision: 0,
        context: {
          format: 'video',
          extractorVersion: 'timeline-lines-v1',
          provenance: [{ ref: manifest.timeline, digest: await digestFile(manifest.timeline) }],
          story,
          assets: [],
        },
      });
      const catalogue = await request(`/api/threads/${thread.id}/artifacts?view=works`);
      assert.ok(
        catalogue.artifacts.some(
          (row) => row.work?.contentRef === saved.reference.contentRef && row.sourceMessageId === null,
        ),
      );
      const indexed = await command({ action: 'read-context', reference: saved.reference });
      const paragraph = indexed.context.story[2];
      const cleanOptions = {
        page,
        context,
        api,
        threadId: thread.id,
        reference: saved.reference,
        allowedAnchors: [
          { kind: 'video-range', streamId: asset.media.streamId, startTick: toPts(12), endTick: toPts(12) + 1 },
          {
            kind: 'video-range',
            streamId: paragraph.streamId,
            startTick: paragraph.startPts,
            endTick: paragraph.endPts,
            storyEvidence: {
              metadataRevision: indexed.metadataRevision,
              paragraphId: paragraph.id,
              quote: paragraph.text || paragraph.title,
            },
          },
        ],
      };
      await context.addInitScript(() => localStorage.setItem('cat-cafe:shell-presentation', 'v2'));
      const hydrated = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/threads/${thread.id}/composer-draft`) && response.request().method() === 'GET',
      );
      await page.goto(`${web}/thread/${thread.id}`, { waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(page, { readinessTimeoutMs: 90000 });
      await hydrated;
      cleanOwnDraft = () => cleanAuthorDraft(cleanOptions);
      await writeFile(
        path.join(evidence, 'initial-author-cleanup.json'),
        JSON.stringify(await cleanOwnDraft(), null, 2),
      );
      // Home intentionally summarizes three recent works. Open its real full
      // catalogue before looking for an older film in the eight-work library.
      await page
        .locator('section[aria-labelledby="home-works-title"]')
        .getByRole('button', { name: '全部 ›', exact: true })
        .click();
      const cataloguePanel = page.locator('[data-testid="v2-works-panel"]:visible');
      const card = cataloguePanel.getByTestId('workspace-home-artifact-card').filter({ hasText: manifest.title });
      await card.waitFor({ state: 'visible' });
      await card.click();
      // Workspace retains hidden tabs; interact with the active picture only.
      const surface = page.locator('[data-testid="workspace-content-review-surface"]:visible');
      await surface.waitFor({ state: 'visible' });
      const video = surface.locator('video').first();
      await video.waitFor({ state: 'visible' });
      const frame = await decodedSeek(video, 12);
      observedFrame = frame;
      assert.ok(
        Math.abs(frame.mediaTime - 12) < 0.035 && frame.seeking === false,
        `Require the real presented frame and completed seek: ${JSON.stringify(frame)}`,
      );
      observedLayout = { video: await video.boundingBox(), surface: await surface.boundingBox() };
      if (observedLayout.surface.width >= 780) {
        await page.waitForFunction(() => document.querySelector('video').getBoundingClientRect().width >= 320);
        observedLayout.video = await video.boundingBox();
        assert.ok(observedLayout.video.width >= 320, 'The narrow work host must leave a readable video column');
      }
      await surface.getByRole('button', { name: '全屏播放', exact: true }).click();
      await page.waitForFunction(() => !!document.fullscreenElement);
      const fullscreen = await page.evaluate(() => {
        const box = document.fullscreenElement.getBoundingClientRect();
        return { width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
      });
      assert.ok(
        fullscreen.width >= fullscreen.viewportWidth - 2 && fullscreen.height >= fullscreen.viewportHeight - 2,
        'Fullscreen must fill the real browser viewport',
      );
      await page.screenshot({ path: path.join(evidence, 'native-fullscreen.png') });
      await page.getByRole('button', { name: '退出全屏', exact: true }).click();
      await page.waitForFunction(() => !document.fullscreenElement);
      await page.getByRole('button', { name: new RegExp(timeline.lines[2].text) }).click();
      await page.waitForFunction(
        (seconds) => Math.abs(document.querySelector('video').currentTime - seconds) < 0.05,
        timeline.lines[2].start,
      );
      await decodedSeek(video, 12);
      await surface.getByRole('button', { name: '标记问题', exact: true }).click();
      await page.locator('[data-context-kind="media"]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-context-kind="media"] [data-selection-id]').count(), 1);
      assert.ok((await page.locator('[data-context-kind="media"]').innerText()).includes(manifest.title));
      await page.screenshot({ path: path.join(evidence, 'work-and-original-composer.png'), fullPage: true });
      await verifyParagraphOpinion({
        page,
        surface,
        evidence,
        reference: saved.reference,
        threadId: thread.id,
        readContext: (reference) => command({ action: 'read-context', reference }),
      });
      if (process.env.F326_C_LIBRARY_MANIFEST) {
        await verifyDeliveredLibrary({
          page,
          context,
          surface,
          evidence,
          readContext: (reference) => command({ action: 'read-context', reference }),
        });
        assert.equal(
          await page.locator('[data-context-kind="media"]').count(),
          1,
          'Browsing other films preserves the one original unsent mark',
        );
        assert.ok((await page.locator('[data-context-kind="media"]').innerText()).includes(manifest.title));
      }
      await writeFile(
        path.join(evidence, 'manifest.json'),
        JSON.stringify(
          {
            threadId: thread.id,
            reference: saved.reference,
            frame,
            source,
            originalUnchanged: (await digestFile(manifest.film)) === manifest.digest,
          },
          null,
          2,
        ),
      );
      assert.deepEqual(errors, []);
      outcome = 'passed';
    } catch (error) {
      outcome = 'failed';
      failure = error.stack;
      throw error;
    }
  },
);
