import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';

await import('tsx/esm');
const { startHomeWorkHost } = await import('./fixtures/f317-home-work-host.mjs');

// Standalone consumer proof: synthetic session/card issuer, real C/F309/Hub owners, pixels and transport.
// No Live admission, model, media device, actual user source or ordinary Alpha result is claimed here.
test(
  'original work card -> authenticated one-use Hub -> F309 exact original version pixels -> applied receipt',
  { timeout: 150000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'f317-work-display-'));
    const evidence = process.env.F317_HOME_WORK_EVIDENCE_DIR ?? root;
    await mkdir(evidence, { recursive: true });
    await mediaFixture(root, 'png');
    let host, browser, page;
    const errors = [],
      stages = [],
      requests = [];
    t.after(async () => {
      if (page && stages.length !== 3) {
        await writeFile(
          path.join(evidence, 'home-work-failure.json'),
          JSON.stringify(
            {
              errors,
              stages,
              requests,
              outcomes: host?.outcomes,
              transport: host?.observations,
              body: await page
                .locator('body')
                .innerText()
                .catch(() => null),
              surfaces: await page
                .getByTestId('workspace-content-review-surface')
                .evaluateAll((nodes) =>
                  nodes.map((node) => ({ html: node.outerHTML, rect: node.getBoundingClientRect().toJSON() })),
                )
                .catch(() => []),
            },
            null,
            2,
          ),
        );
        await page.screenshot({ path: path.join(evidence, 'home-work-failure.png') }).catch(() => {});
      }
      await browser?.close();
      await host?.close();
      if (evidence !== root) await rm(root, { recursive: true, force: true });
    });
    host = await startHomeWorkHost(root);
    const first = await host.media.prepare({ ...host.prepare, principal: host.human });
    const secondBytes = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#3186c4' } })
      .png()
      .toBuffer();
    await writeFile(path.join(root, 'review-response.png'), secondBytes);
    const secondMessage = host.publish('review-response.png');
    await host.owner.settle({
      contentRef: first.contentRef,
      expectedOwnerRevision: 1,
      bytes: secondBytes,
      actor: host.cat.actor,
      operationId: 'home-work-second-version',
      sourcePublication: {
        artifactRef: '/uploads/review-response.png',
        sourceRef: `message:${host.thread.id}:${secondMessage.id}`,
        revision: String(secondMessage.timestamp),
      },
    });
    const beforeMessages = host.messages.getByThread(host.thread.id).length;
    const beforeTasks = host.tasks.listByThread(host.thread.id).length;
    const original = await host.media.read(first.contentRef, 1, host.human),
      second = await host.media.read(first.contentRef, 2, host.human);
    assert.notEqual(original.blobDigest, second.blobDigest);
    browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(12000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (
        response.url().includes('/api/concierge/home/') ||
        response.url().includes('/api/content-publications/') ||
        response.url().includes('/api/content-reviews/')
      )
        requests.push({ url: response.url(), status: response.status(), method: response.request().method() });
    });
    await page.addInitScript(() => {
      window.__mediaCaptureAttempts = [];
      if (navigator.mediaDevices)
        for (const method of ['getUserMedia', 'getDisplayMedia'])
          Object.defineProperty(navigator.mediaDevices, method, {
            value: async () => {
              window.__mediaCaptureAttempts.push(method);
              throw Error('No media device in consumer test');
            },
          });
    });
    const registration = page.waitForResponse(
      (r) => r.url().endsWith('/api/concierge/home/clients') && r.request().method() === 'POST',
    );
    await page.goto(`${host.origin}/thread/${host.thread.id}?shell=v2`);
    assert.equal((await registration).status(), 200);
    for (const version of [1, 2]) {
      const card = await host.select(version);
      assert.equal(card.artifact.version, String(version));
      const reply = page.waitForResponse((r) => r.url().endsWith('/fixture/work/open'));
      await page.getByRole('button', { name: 'Open the original work card', exact: true }).click();
      const response = await reply;
      assert.equal(response.status(), 200);
      const outcome = await response.json();
      assert.equal(outcome.delivery, 'applied');
      const surface = page.getByTestId('workspace-content-review-surface');
      assert.equal(await surface.getAttribute('data-content-ref'), first.contentRef);
      assert.equal(await surface.getAttribute('data-owner-revision'), String(version));
      assert.equal(await surface.getAttribute('data-content-ready'), 'true');
      const pixels = await surface.getByTestId('workspace-content-review-media').evaluate((image) => ({
        src: image.src,
        currentSrc: image.currentSrc,
        complete: image.complete,
        width: image.naturalWidth,
        height: image.naturalHeight,
        rect: image.getBoundingClientRect().toJSON(),
      }));
      assert.equal(pixels.complete, true);
      assert.equal(pixels.width, 900);
      assert.equal(pixels.height, 600);
      assert.ok(pixels.src.endsWith(`/media/${version}`));
      assert.equal(pixels.currentSrc, pixels.src);
      stages.push({ version, card, outcome, pixels });
      await page.screenshot({ path: path.join(evidence, `home-work-version-${version}.png`) });
    }
    // Same original DOM remains mounted under the actual comparison CSS, but it may not ACK visible.
    await page.getByRole('button', { name: 'Toggle original comparison', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-content-ready="true"]'));
    const hiddenReply = page.waitForResponse((r) => r.url().endsWith('/fixture/work/open'));
    await page.getByRole('button', { name: 'Open the original work card', exact: true }).click();
    assert.equal((await (await hiddenReply).json()).delivery, 'unconfirmed');
    stages.push({ label: 'original comparison hides pixels', delivery: 'unconfirmed' });
    assert.equal(host.tasks.listByThread(host.thread.id).length, beforeTasks);
    assert.equal(host.messages.getByThread(host.thread.id).length, beforeMessages);
    assert.deepEqual(await page.evaluate(() => window.__mediaCaptureAttempts), []);
    assert.deepEqual(errors, []);
    await writeFile(
      path.join(evidence, 'home-work-display.json'),
      JSON.stringify(
        {
          stages,
          requests,
          errors,
          messageCountBefore: beforeMessages,
          messageCountAfter: host.messages.getByThread(host.thread.id).length,
          taskCountBefore: beforeTasks,
          taskCountAfter: host.tasks.listByThread(host.thread.id).length,
          transport: host.observations.map((row) => ({
            event: row.event,
            at: row.at,
            receipts: row.result.map((value) => ({ status: value?.status, artifact: value?.artifact })),
          })),
          ordinaryLivePositive: 'not_exercised',
          syntheticIssuer: true,
        },
        null,
        2,
      ),
    );
  },
);
