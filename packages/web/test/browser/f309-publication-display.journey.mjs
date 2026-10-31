import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';

const entryPath = path.resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
  'test/browser/fixtures/f309-publication-display.tsx',
);
for (const kind of ['png', 'mp4']) {
  test(
    `publication display: real ${kind} pixels/frame, historical version, hidden comparison and identity`,
    { timeout: 150000 },
    async (t) => {
      const scratch = await mkdtemp(path.join(tmpdir(), 'f309-display-'));
      const evidence = process.env.F309_BROWSER_EVIDENCE_DIR ?? scratch;
      await mkdir(evidence, { recursive: true });
      await mediaFixture(scratch, kind);
      await copyFile(path.join(scratch, `review-input.${kind}`), path.join(scratch, `review-response.${kind}`));
      const host = await startReviewHost(scratch, kind === 'png' ? 'image/png' : 'video/mp4', { entryPath });
      let browser;
      t.after(async () => {
        await browser?.close();
        await host.close();
        if (scratch !== evidence) await rm(scratch, { recursive: true, force: true });
      });
      const asset = await host.media.prepare({ ...host.prepare, principal: host.human });
      // Fixture F138 versions deliberately keep identical bytes; selected owner revision must never come from SHA/review.revision.
      for (const expectedOwnerRevision of [1, 2])
        await host.owner.settle({
          contentRef: asset.contentRef,
          expectedOwnerRevision,
          bytes: await readFile(path.join(scratch, `review-input.${kind}`)),
          actor: host.cat.actor,
          operationId: `display-version-${expectedOwnerRevision}`,
          sourcePublication: asset.sourcePublication,
        });
      const message = host.publish(`review-response.${kind}`);
      const other = await host.media.prepare({
        source: {
          kind: 'message',
          threadId: host.thread.id,
          messageId: message.id,
          messageRevision: String(message.timestamp),
          item:
            kind === 'png'
              ? { kind: 'media-gallery', blockId: `review-response.${kind}`, itemIndex: 0 }
              : { kind: 'rich-file', blockId: `review-response.${kind}` },
          expectedUrl: `/uploads/review-response.${kind}`,
        },
        operationId: 'other-publication',
        principal: host.human,
      });
      assert.notEqual(other.contentRef, asset.contentRef);
      assert.equal(other.blobDigest, asset.blobDigest);
      await host.owner.settle({
        contentRef: other.contentRef,
        expectedOwnerRevision: 1,
        bytes: await readFile(path.join(scratch, `review-input.${kind}`)),
        actor: host.cat.actor,
        operationId: 'other-version-2',
        sourcePublication: other.sourcePublication,
      });
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(10000);
      const errors = [],
        observations = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.__displayEvents = [];
        let sequence = 0;
        const identities = new WeakMap();
        const resource = (media) => {
          if (!media) return { node: null, mediaReady: null };
          if (!identities.has(media)) identities.set(media, ++sequence);
          const identity = {
            node: identities.get(media),
            src: media.src,
            currentSrc: media.currentSrc,
          };
          if (media instanceof HTMLImageElement)
            return {
              ...identity,
              complete: media.complete,
              pixels: [media.naturalWidth, media.naturalHeight],
              mediaReady: media.complete && media.naturalWidth > 0,
            };
          return { ...identity, complete: null, pixels: null, mediaReady: media.readyState };
        };
        const observe = (event) => {
          const root = document.querySelector('[data-testid="workspace-content-review-surface"]');
          const media = root?.querySelector('[data-testid="workspace-content-review-media"]');
          window.__displayEvents.push({
            event: event instanceof Event ? event.type : 'mutation',
            ...resource(media),
            ready: root?.dataset.contentReady ?? null,
            contentRef: root?.dataset.contentRef ?? null,
            revision: root?.dataset.ownerRevision ?? null,
            at: performance.now(),
          });
        };
        new MutationObserver(observe).observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['data-content-ready', 'data-content-ref', 'data-owner-revision', 'src', 'srcset', 'sizes'],
        });
        document.addEventListener('load', observe, true);
        document.addEventListener('error', observe, true);
      });
      let releaseAsset;
      const assetGate = new Promise((resolve) => {
        releaseAsset = resolve;
      });
      const descriptor = `${host.apiOrigin}/api/content-publications/${encodeURIComponent(asset.contentRef)}?ownerRevision=2`;
      await page.route(descriptor, async (route) => {
        await assetGate;
        await route.continue();
      });
      await page.goto(
        `${host.origin}?${new URLSearchParams({ contentRef: asset.contentRef, otherRef: other.contentRef })}`,
      );
      const root = page.getByTestId('workspace-content-review-surface');
      const media = root.getByTestId('workspace-content-review-media');
      await media.waitFor();
      if (kind === 'png') await media.evaluate((image) => image.decode());
      else await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      async function absent(label) {
        await page.waitForFunction(() =>
          [...document.querySelectorAll('[data-testid="workspace-content-review-surface"]')].every((element) =>
            ['data-content-ref', 'data-owner-revision', 'data-content-ready'].every(
              (key) => !element.hasAttribute(key),
            ),
          ),
        );
        observations.push({ label, ready: false });
      }
      async function ready(ref, revision) {
        await page.waitForFunction(
          ({ ref, revision }) => {
            const element = document.querySelector('[data-testid="workspace-content-review-surface"]');
            return (
              element?.dataset.contentReady === 'true' &&
              element.dataset.contentRef === ref &&
              element.dataset.ownerRevision === String(revision)
            );
          },
          { ref, revision },
        );
        const snapshot = await media.evaluate((element) => ({
          ready: element.closest('[data-testid="workspace-content-review-surface"]')?.dataset.contentReady,
          src: element.src,
          currentSrc: element.currentSrc,
          complete: element instanceof HTMLImageElement ? element.complete : element.readyState >= 2,
          pixels:
            element instanceof HTMLImageElement
              ? [element.naturalWidth, element.naturalHeight]
              : [element.videoWidth, element.videoHeight],
          rect: element.getBoundingClientRect().toJSON(),
        }));
        observations.push({
          label: 'ready',
          contentRef: ref,
          ownerRevision: revision,
          media: snapshot,
        });
        await writeFile(
          path.join(evidence, `publication-${kind}-snapshot.json`),
          JSON.stringify({ observations, events: await page.evaluate(() => window.__displayEvents) }, null, 2),
        );
        assert.equal(snapshot.ready, 'true');
        assert.equal(snapshot.complete, true, 'ready must refer to the currently decoded native resource');
        assert.ok(
          snapshot.pixels.every((dimension) => dimension > 0),
          'ready cannot describe an empty native image/frame',
        );
        assert.equal(snapshot.currentSrc, snapshot.src, 'ready must belong to the requested native resource');
      }
      await absent('decoded media alone cannot bypass independent asset verification');
      releaseAsset();
      await ready(asset.contentRef, 2);
      await page.screenshot({ path: path.join(evidence, `publication-${kind}-ready.png`) });
      await page.getByRole('button', { name: 'Toggle production comparison CSS', exact: true }).click();
      assert.equal(await media.count(), 1, 'original media stays mounted under the real production comparison CSS');
      assert.equal(await media.isVisible(), false);
      await absent('comparison hides mounted artwork');
      await page.getByRole('button', { name: 'Toggle production comparison CSS', exact: true }).click();
      await ready(asset.contentRef, 2);
      await page.getByRole('button', { name: 'Toggle F307 visibility', exact: true }).click();
      await absent('F307 hidden');
      await page.getByRole('button', { name: 'Toggle F307 visibility', exact: true }).click();
      await ready(asset.contentRef, 2);
      const oldMedia = await media.elementHandle();
      await page.getByRole('combobox', { name: '作品版本' }).selectOption('1');
      await ready(asset.contentRef, 1);
      await oldMedia.evaluate((element) => element.dispatchEvent(new Event('load')));
      assert.equal(
        await root.getAttribute('data-owner-revision'),
        '1',
        'late detached old load cannot restore version 2',
      );
      await page.getByRole('button', { name: 'Same bytes, other publication', exact: true }).click();
      await ready(other.contentRef, 2);
      await page.getByRole('button', { name: 'Toggle mount', exact: true }).click();
      await absent('unmounted');
      assert.equal(await root.count(), 0);
      await page.getByRole('button', { name: 'Toggle mount', exact: true }).click();
      await ready(other.contentRef, 2);
      await page.route(
        `${host.apiOrigin}/api/content-publications/${encodeURIComponent(other.contentRef)}/media/1`,
        (route) => route.abort(),
      );
      await page.getByRole('combobox', { name: '作品版本' }).selectOption('1');
      await page.getByText(/此浏览器无法显示这张图片|此浏览器无法播放这份视频/).waitFor();
      await absent('native resource error');
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(evidence, `publication-${kind}.json`),
        JSON.stringify(
          {
            kind,
            observations,
            events: await page.evaluate(() => window.__displayEvents),
            errors,
            boundaries:
              'Real PublicationContentReviewSurface, shipped owner HTTP and native decoded media; fixture F307 visibility and production comparison CSS controls. No A/Home/Alpha/model claim.',
          },
          null,
          2,
        ),
      );
      const events = await page.evaluate(() => window.__displayEvents);
      assert.deepEqual(
        events.filter((event) => event.ready === 'true' && event.mediaReady === false),
        [],
        'no readiness transition may describe an empty native image',
      );
    },
  );
}
