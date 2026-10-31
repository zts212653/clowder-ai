import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createScreeningJourney, decodedSeek, openPreparedProject } from './f326-screening-journey.harness.mjs';

function nextPresentedFrame(video, expected) {
  return video.evaluate(
    (element, time) =>
      new Promise((resolve, reject) => {
        let id;
        const observed = [];
        const timeout = setTimeout(() => {
          element.cancelVideoFrameCallback(id);
          reject(
            new Error(
              `Frame button expected ${time}, playhead=${element.currentTime}, observed=${JSON.stringify(observed)}`,
            ),
          );
        }, 15000);
        const capture = (_now, metadata) => {
          observed.push({ mediaTime: metadata.mediaTime, currentTime: element.currentTime });
          if (Math.abs(metadata.mediaTime - time) > 0.01) {
            id = element.requestVideoFrameCallback(capture);
            return;
          }
          clearTimeout(timeout);
          resolve(metadata.mediaTime);
        };
        id = element.requestVideoFrameCallback(capture);
      }),
    expected,
  );
}

test('F326 actual frame buttons and native playback loop the frozen EP0 shot', { timeout: 300000 }, async (t) => {
  const journey = await createScreeningJourney();
  const manifest = JSON.parse(await readFile(process.env.F326_BROWSER_MANIFEST, 'utf8'));
  const result = { outcome: 'running' };
  let failure;
  t.after(async () => {
    await writeFile(
      path.join(journey.evidence, 'result.json'),
      JSON.stringify({ ...result, failure: failure?.message, errors: journey.errors }, null, 2),
    );
    await journey.close();
    console.log(`F326 playback evidence: ${journey.evidence}`);
  });
  try {
    await openPreparedProject(journey, manifest);
    const surface = journey.page.locator(`[data-video-project="${manifest.contentRef}"]`);
    const player = surface.getByRole('region', { name: '成片播放器' });
    const video = player.locator('video');
    await decodedSeek(video, 1429 / 30);
    const next = nextPresentedFrame(video, 1430 / 30);
    await player.getByRole('button', { name: '下一帧 ›', exact: true }).click();
    result.nextFrame = await next;
    const previous = nextPresentedFrame(video, 1429 / 30);
    await player.getByRole('button', { name: '‹ 上一帧', exact: true }).click();
    result.previousFrame = await previous;
    const input = await journey.request(
      `/api/video-projects/${encodeURIComponent(manifest.contentRef)}?ownerRevision=1`,
    );
    const segment = input.document.timeline.segments.find((candidate) => candidate.id === 'C08');
    const start = segment.startTick / 30;
    const end = (segment.startTick + segment.durationTicks) / 30;
    const loop = player.getByRole('button', { name: '↻ 循环镜头', exact: true });
    await loop.click();
    assert.equal(await loop.getAttribute('aria-pressed'), 'true');
    await decodedSeek(video, end - 1 / 30);
    await video.focus();
    await journey.page.keyboard.press('Space');
    await journey.page.waitForFunction(
      ({ start, end }) => {
        const element = document.querySelector('[aria-label="成片播放器"] video');
        return (
          element &&
          !element.paused &&
          !element.seeking &&
          element.currentTime >= start &&
          element.currentTime < Math.min(end, start + 0.8)
        );
      },
      { start, end },
      { timeout: 20000 },
    );
    result.loop = await video.evaluate((element) => ({ time: element.currentTime, paused: element.paused }));
    await video.focus();
    await journey.page.keyboard.press('Space');
    await loop.click();
    assert.equal(await loop.getAttribute('aria-pressed'), 'false');
    result.tail = await decodedSeek(video, 450);
    assert.ok((await player.innerText()).includes('尚未对应镜头'));
    assert.equal(await loop.isDisabled(), true);
    const tailNext = nextPresentedFrame(video, 450 + 1 / 30);
    await player.getByRole('button', { name: '下一帧 ›', exact: true }).click();
    result.tailNextFrame = await tailNext;
    const media = manifest.descriptors.at(-1).screening.media.media;
    const frameSeconds = media.frameRate.denominator / media.frameRate.numerator;
    const endSeconds = (media.durationTicks * media.timebase.numerator) / media.timebase.denominator;
    const lastFrame = endSeconds - frameSeconds;
    result.lastFrame = await decodedSeek(video, lastFrame + frameSeconds / 2);
    assert.ok(Math.abs(result.lastFrame.mediaTime - lastFrame) < 0.001);
    await journey.page.waitForFunction(
      () =>
        [...document.querySelectorAll('[aria-label="成片播放器"] button')].find(
          (button) => button.textContent === '下一帧 ›',
        )?.disabled === true,
    );
    const tailPrevious = nextPresentedFrame(video, lastFrame - frameSeconds);
    await player.getByRole('button', { name: '‹ 上一帧', exact: true }).click();
    result.penultimateFrame = await tailPrevious;
    await journey.page.screenshot({ path: path.join(journey.evidence, 'tail-frame.png'), fullPage: false });
    await decodedSeek(video, 1429 / 30);
    assert.deepEqual(journey.errors, []);
    result.outcome = 'pass';
  } catch (error) {
    failure = error;
    result.outcome = 'fail';
    throw error;
  }
});
