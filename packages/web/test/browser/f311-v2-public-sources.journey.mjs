import assert from 'node:assert/strict';
import { openWorkspaceTools } from './f307-workspace-open.mjs';
import { CONTRACT_THREAD_ID } from './f311-workspace-browser.harness.mjs';

/** Exact existing Program shape and target, authenticated production reader, immutable original archives. */
export async function verifyV2PublicSources({ fixture, browser, capture }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const id = fixture.realDuck.program.programId;
  const work = page.getByTestId('evolution-exploration-workspace');
  try {
    const sourceResponse = await page.request.get(
      `${fixture.apiUrl}/api/capability-evolution/programs/${encodeURIComponent(id)}/exploration`,
    );
    assert.equal(sourceResponse.status(), 200);
    const publication = await sourceResponse.json();
    assert.deepEqual(publication.objectRef, fixture.realDuck.program.objectRef);
    const coverCount = publication.nodes.filter((node) => node.preview).length;
    await page.goto(`${fixture.apiUrl}/api/session`);
    await page.goto(`${fixture.webUrl}/thread/${CONTRACT_THREAD_ID}?shell=v2`);
    await (await openWorkspaceTools(page)).getByTestId('workspace-launcher-capability-evolution').click();
    const home = page.getByTestId('capability-evolution-workspace');
    await home.getByTestId(`capability-evolution-program-${id}`).click();
    const detail = home.getByTestId('capability-evolution-program-detail');
    await detail.getByRole('button', { name: '探索进化', exact: true }).click();
    await detail.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
    await work.waitFor();
    const walk = work.getByRole('region', { name: '同一场景逐版看走路' });
    const cortex = work.getByRole('region', { name: '两场整场比赛' });
    await walk.getByRole('button', { name: '四段同步播放', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="同一场景逐版看走路"] button')?.disabled);
    assert.equal(await walk.locator('[data-showcase-version]').count(), 4);
    for (const caption of ['2.5cm', '2.6秒', '19.9秒', '18.9秒']) assert.ok((await walk.innerText()).includes(caption));
    assert.equal(await cortex.locator('[data-showcase-version]').count(), 2);
    assert.ok((await cortex.innerText()).includes('源码和120/240秒观察窗也不同'));
    await walk.getByRole('button', { name: '四段同步播放', exact: true }).click();
    await page.waitForFunction(() => {
      const videos = [...document.querySelectorAll('[aria-label="同一场景逐版看走路"] video')];
      return videos.length === 4 && videos.every((video) => !video.paused && video.currentTime >= 2 && !video.seeking);
    });
    const walking = await walk
      .locator('video')
      .evaluateAll((videos) =>
        videos.map((video) => ({ time: video.currentTime, src: video.src, duration: video.duration })),
      );
    assert.ok(walking.every((video) => video.src.includes(encodeURIComponent(id)) && video.duration >= 19.9));
    assert.ok(Math.max(...walking.map((video) => video.time)) - Math.min(...walking.map((video) => video.time)) < 0.25);
    const walkingTops = await walk
      .locator('video')
      .evaluateAll((videos) => videos.map((video) => Math.round(video.getBoundingClientRect().top)));
    assert.ok(Math.max(...walkingTops) - Math.min(...walkingTops) <= 1, 'four walking originals must top-align');
    assert.equal(await walk.locator('[data-showcase-version] h4').count(), 0, 'showcase titles must not be repeated');
    assert.equal(
      await walk.locator('[data-showcase-version] > figure.exploration-media > figcaption > strong').count(),
      4,
      'each walking original has one visible media title',
    );
    await walk.getByRole('button', { name: '暂停联播', exact: true }).click();
    await capture(page, 's3-real-goal-four-walking-originals');
    const cards = work.locator('.exploration-version-cards');
    assert.ok((await cards.innerText()).includes('改了什么：'));
    assert.ok(!(await cards.innerText()).includes('未登记父边'));
    assert.ok((await cards.locator('img').count()) >= 5);
    await page.waitForFunction((count) => {
      const images = [...document.querySelectorAll('.exploration-version-cover')];
      return images.length === count && images.every((image) => image.complete && image.naturalWidth > 0);
    }, coverCount);
    await cortex.getByRole('button', { name: '两段同步播放', exact: true }).click();
    await page.waitForFunction(() => {
      const videos = [...document.querySelectorAll('[aria-label="两场整场比赛"] video')];
      return videos.length === 2 && videos.every((video) => !video.paused && video.currentTime >= 2 && !video.seeking);
    });
    const durations = await cortex.locator('video').evaluateAll((videos) => videos.map((video) => video.duration));
    assert.deepEqual(durations, [120, 240]);
    const cortexTops = await cortex
      .locator('video')
      .evaluateAll((videos) => videos.map((video) => Math.round(video.getBoundingClientRect().top)));
    assert.ok(Math.max(...cortexTops) - Math.min(...cortexTops) <= 1, 'both Cortex originals must top-align');
    assert.equal(await cortex.locator('[data-showcase-version] h4').count(), 0, 'Cortex titles must not be repeated');
    assert.equal(
      await cortex.locator('[data-showcase-version] > figure.exploration-media > figcaption > strong').count(),
      2,
    );
    for (const src of await cortex.locator('video').evaluateAll((videos) => videos.map((video) => video.currentSrc))) {
      const range = await page.request.get(src, { headers: { Range: 'bytes=0-127' } });
      assert.equal(range.status(), 206);
      assert.equal(range.headers()['accept-ranges'], 'bytes');
      assert.match(range.headers()['content-range'], /^bytes 0-127\/\d+$/);
      assert.equal((await range.body()).length, 128);
    }
    assert.ok(
      await cortex
        .locator('video')
        .evaluateAll((videos) =>
          videos.every((video) => video.seekable.length > 0 && video.seekable.end(video.seekable.length - 1) >= 10),
        ),
      'the authenticated original response must support seeking into the ten-second read window',
    );
    await cortex
      .locator('video')
      .first()
      .evaluate((video) => {
        video.currentTime = 9.8;
      });
    await page.waitForFunction(() => {
      const videos = [...document.querySelectorAll('[aria-label="两场整场比赛"] video')];
      return videos.length === 2 && videos.every((video) => video.paused && Math.abs(video.currentTime - 10) < 0.25);
    });
    const matches = await cortex.locator('video').evaluateAll((videos) =>
      videos.map((video) => ({
        time: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        src: video.currentSrc,
      })),
    );
    await capture(page, 's3-real-goal-cortex-ten-seconds');
    await cards.getByRole('button', { name: '阅读 v1', exact: true }).scrollIntoViewIfNeeded();
    await capture(cards, 's3-real-goal-version-covers');
    await work.getByRole('button', { name: '完整谱系', exact: true }).click();
    const lineage = page.getByRole('dialog', { name: '完整版本谱系' });
    await lineage.waitFor();
    await lineage.getByRole('region', { name: '谱系分组：公开归档 · 已登记派生' }).waitFor();
    const regionGeometry = await lineage.locator('.exploration-canvas-region').evaluateAll((regions) =>
      regions.map((region) => ({
        label: region.getAttribute('aria-label'),
        top: region.getBoundingClientRect().top,
        bottom: region.getBoundingClientRect().bottom,
        width: region.getBoundingClientRect().width,
        height: region.getBoundingClientRect().height,
      })),
    );
    assert.deepEqual(
      regionGeometry.map((region) => region.label),
      ['谱系分组：公开归档 · 已登记派生', '谱系分组：公开归档 · 父版未登记', '谱系分组：Cortex · 比赛归档'],
    );
    assert.ok(regionGeometry.every((region) => region.width > 0 && region.height > 0));
    for (let index = 1; index < regionGeometry.length; index += 1)
      assert.ok(
        regionGeometry[index - 1].bottom < regionGeometry[index].top,
        `lineage regions overlap: ${JSON.stringify(regionGeometry)}`,
      );
    const routeGeometry = await lineage.evaluate((dialog) => {
      const labels = [
        ...dialog.querySelectorAll('.exploration-node-wrap[data-label-visible="true"] .exploration-node-title'),
      ]
        .map((label) => ({ text: label.textContent?.trim(), rect: label.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0);
      const paths = [...dialog.querySelectorAll('path[data-edge-route="label-clear"]')];
      const collisions = [];
      for (const path of paths) {
        const length = path.getTotalLength();
        const matrix = path.getScreenCTM();
        if (!matrix) continue;
        const samples = Math.max(2, Math.ceil(length / 2));
        for (let index = 1; index < samples; index += 1) {
          const local = path.getPointAtLength((length * index) / samples);
          const point = new DOMPoint(local.x, local.y).matrixTransform(matrix);
          const hit = labels.find(
            ({ rect }) =>
              point.x > rect.left + 1 &&
              point.x < rect.right - 1 &&
              point.y > rect.top + 1 &&
              point.y < rect.bottom - 1,
          );
          if (hit) {
            collisions.push({ label: hit.text, x: point.x, y: point.y });
            break;
          }
        }
      }
      return { pathCount: paths.length, labelCount: labels.length, collisions };
    });
    assert.ok(routeGeometry.pathCount > 0 && routeGeometry.labelCount > 0);
    assert.deepEqual(routeGeometry.collisions, [], 'sparse lineage edges must remain clear of visible labels');
    await capture(lineage, 's3-real-goal-lineage-regions');
    await lineage.getByRole('button', { name: '返回比较', exact: true }).click();
    await lineage.waitFor({ state: 'detached' });
    for (const width of [416, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await cortex.scrollIntoViewIfNeeded();
      const boxes = await cortex
        .locator('article')
        .evaluateAll((items) =>
          items.map((item) => ({ x: item.getBoundingClientRect().x, y: item.getBoundingClientRect().y })),
        );
      assert.ok(Math.abs(boxes[0].x - boxes[1].x) <= 1 && boxes[1].y > boxes[0].y, 'narrow originals must stack');
      assert.equal(await work.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
      await capture(page, `s3-real-goal-cortex-${width}`);
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => localStorage.setItem('theme', 'dark'));
    await page.reload();
    const main = page.locator('[data-testid="evolution-program-surface"]:visible');
    await main.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
    await work.getByRole('region', { name: '两场整场比赛' }).waitFor();
    await page.waitForFunction(() => {
      const regions = ['同一场景逐版看走路', '两场整场比赛'];
      return regions.every((label) => {
        const button = document.querySelector(`[aria-label="${label}"] .exploration-playback-controls button`);
        return button && !button.disabled;
      });
    });
    await page.waitForFunction((count) => {
      const images = [...document.querySelectorAll('.exploration-version-cover')];
      return images.length === count && images.every((image) => image.complete && image.naturalWidth > 0);
    }, coverCount);
    await capture(page, 's3-real-goal-dark-restored');
    assert.deepEqual(errors, []);
    return {
      programId: id,
      objectRef: publication.objectRef,
      nodeCount: publication.nodes.length,
      experimentCount: publication.experiments.length,
      coverCount,
      walking,
      matches,
      viewports: [1440, 416, 320],
      pageErrors: errors,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        kind: 'f311-public-originals-failure',
        url: page.url(),
        videos: await page.locator('.exploration-public-showcase video').evaluateAll((videos) =>
          videos.map((video) => ({
            source: video.currentSrc,
            time: video.currentTime,
            duration: video.duration,
            paused: video.paused,
            seeking: video.seeking,
            readyState: video.readyState,
            seekable: Array.from({ length: video.seekable.length }, (_, index) => [
              video.seekable.start(index),
              video.seekable.end(index),
            ]),
            error: video.error?.message,
          })),
        ),
        controls: await work.locator('.exploration-public-showcase .exploration-playback-controls').allTextContents(),
      }),
    );
    await capture(page, 's3-real-goal-failure');
    throw error;
  } finally {
    await context.close();
  }
}
