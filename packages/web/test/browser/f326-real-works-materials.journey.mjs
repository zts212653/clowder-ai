import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyPlayableMaterials({ page, sidebar, evidence, record }) {
  const observations = [];
  await sidebar.getByRole('combobox', { name: '故事线或素材', exact: true }).selectOption('assets');
  for (const mediaType of ['video/webm', 'audio/wav']) {
    const row = record.context.assets.find(
      (item) => item.asset.versions.find((v) => v.id === item.versionId)?.mediaType === mediaType,
    );
    assert.ok(row, `The actual delivered film uses ${mediaType}`);
    const group = sidebar.locator('details').filter({ hasText: row.asset.name });
    if (!(await group.evaluate((node) => node.open))) await group.locator('summary').click();
    await group.getByRole('button', { name: `预览 ${row.asset.name}`, exact: true }).click();
    const media = group.getByLabel(row.asset.name, { exact: true });
    if (mediaType === 'video/webm') {
      // Materials have their own frame rates (this WebM is not a 30 fps film).
      // Observe actual playback advancing to a decoded frame, without guessing a frame timestamp.
      const frame = await media.evaluate(
        (node) =>
          new Promise((resolve, reject) => {
            let token;
            const timeout = setTimeout(() => {
              node.cancelVideoFrameCallback(token);
              node.pause();
              reject(new Error(`No advancing material frame: ${node.error?.message || node.readyState}`));
            }, 15000);
            const capture = (_now, metadata) => {
              if (metadata.mediaTime <= 0 || node.seeking) {
                token = node.requestVideoFrameCallback(capture);
                return;
              }
              clearTimeout(timeout);
              node.pause();
              resolve({
                mediaTime: metadata.mediaTime,
                currentTime: node.currentTime,
                duration: node.duration,
                readyState: node.readyState,
                seeking: node.seeking,
              });
            };
            token = node.requestVideoFrameCallback(capture);
            node.play().catch((error) => {
              clearTimeout(timeout);
              node.cancelVideoFrameCallback(token);
              reject(error);
            });
          }),
      );
      assert.ok(!frame.seeking && frame.mediaTime > 0 && frame.duration > 0);
      observations.push({ name: row.asset.name, mediaType, decoded: frame });
    } else {
      await media.evaluate(async (node) => {
        await node.play();
      });
      await page.waitForFunction((name) => {
        const node = [...document.querySelectorAll('audio')].find((item) => item.getAttribute('aria-label') === name);
        return node && node.readyState >= 2 && node.currentTime > 0 && node.duration > 0;
      }, row.asset.name);
      observations.push(
        await media.evaluate((node) => ({
          name: node.getAttribute('aria-label'),
          mediaType: 'audio/wav',
          currentTime: node.currentTime,
          duration: node.duration,
          readyState: node.readyState,
        })),
      );
    }
    await media.evaluate(async (node) => {
      await node.play();
    });
    await page.screenshot({ path: path.join(evidence, `material-${mediaType.replace('/', '-')}.png`), fullPage: true });
    await group.locator('summary').click();
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('audio, video')].find((node) => node.getAttribute('aria-label') === name)?.paused,
      row.asset.name,
    );
    assert.equal(await media.evaluate((node) => node.paused), true, 'Collapsing the actual group pauses its media');
  }
  await page.screenshot({ path: path.join(evidence, 'playable-materials.png'), fullPage: true });
  return observations;
}

export async function verifyMaterials({ page, context, sidebar, evidence, readContext, item }) {
  await sidebar.getByRole('combobox', { name: '故事线或素材', exact: true }).selectOption('assets');
  await sidebar
    .locator('summary')
    .filter({ hasText: /^图片 ·/ })
    .click();
  const material = sidebar.getByRole('link', { name: 'crop-goal-head.png', exact: true });
  await material.waitFor();
  const url = await material.getAttribute('href');
  const read = await context.request.get(url, { headers: { range: 'bytes=0-31' } });
  assert.equal(read.status(), 206);
  assert.ok(read.headers()['content-range'].startsWith('bytes 0-31/'));
  // Role queries deliberately omit collapsed groups. Exercise their actual
  // controls before counting discoverable materials, then restore the view.
  const groups = await sidebar.locator('details').all();
  for (const group of groups) if (!(await group.evaluate((node) => node.open))) await group.locator('summary').click();
  item.assetLinks = await sidebar.getByRole('link').count();
  const indexed = await readContext(item.reference);
  assert.equal(item.assetLinks, indexed.context.assets.length, 'Every admitted material is discoverable in its work');
  item.metadataRevision = indexed.metadataRevision;
  for (const group of groups)
    if (!(await group.locator('summary').innerText()).startsWith('图片 ·')) await group.locator('summary').click();
  assert.ok(url.includes(`/1/${indexed.metadataRevision}/`), 'The material route names the exact retained metadata');
  await sidebar.getByRole('button', { name: '预览 crop-goal-head.png', exact: true }).click();
  const image = sidebar.getByRole('img', { name: 'crop-goal-head.png', exact: true });
  await image.waitFor();
  await image.evaluate(async (node) => {
    await node.decode();
  });
  item.preview = await image.evaluate((node) => ({ width: node.naturalWidth, height: node.naturalHeight }));
  assert.ok(
    item.preview.width > 0 && item.preview.height > 0,
    'The actual indexed material decodes in the work, without leaving it',
  );
  await page.screenshot({ path: path.join(evidence, 'real-material-index.png'), fullPage: true });
}
