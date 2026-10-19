import assert from 'node:assert/strict';
import sharp from 'sharp';

/** Reach history through the current card menu, preserving the exact artifact selection. */
export async function openRetainedMediaHistory(client, title) {
  const item = client
    .getByRole('region', { name: '全部作品', exact: true })
    .locator('.shared-artifact-item')
    .filter({ hasText: title });
  const menu = item.locator('details.shared-artifact-card-menu');
  if ((await menu.getAttribute('open')) === null) await menu.locator('summary').click();
  await item.getByRole('button', { name: '版本记录', exact: true }).click();
}

/** Version production stays with F138. Every public version goes through the normal Host picker. */
export async function checkRetainedMediaHistory({ f, page, client, surface, publisher, artifact, mime }) {
  const next = await f.publishNextRetainedVersion();
  await f.openHost(0, 4314);
  const shared = await shareSecondVersionFromPicker(publisher, f.source.body, artifact.title);
  assert.equal(shared.artifactId, artifact.artifactId);
  assert.equal(shared.versionCount, 2);
  assert.equal(shared.versions.length, 1);
  assert.equal(shared.versions[0].blobDigest, next.blobDigest);
  assert.notEqual(next.blobDigest, f.media.asset.blobDigest);
  await f.openHost(1, 4314);
  await page.reload();
  await client.getByRole('button', { name: /全部作品/ }).click();
  await openRetainedMediaHistory(client, artifact.title);
  const current = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/artifacts/owner/request') &&
      response.request().postDataJSON()?.ownerRevision === 2 &&
      response.request().postDataJSON()?.action === 'read' &&
      response.status() === 200,
  );
  await client.getByRole('button', { name: '查看第 2 版', exact: true }).click();
  assert.equal((await (await current).json()).value.blobDigest, next.blobDigest);
  await surface
    .getByText(/第 2 版/)
    .first()
    .waitFor();
  // Both immutable media versions must actually decode through this non-custodian Cafe.
  await assertBluePixels(page, mime, true);
  await surface.getByRole('button', { name: '返回原讨论', exact: true }).click();
  await client.getByRole('button', { name: /全部作品/ }).click();
  await openRetainedMediaHistory(client, artifact.title);
  const old = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/artifacts/owner/request') &&
      response.request().postDataJSON()?.ownerRevision === 1 &&
      response.request().postDataJSON()?.action === 'read' &&
      response.status() === 200,
  );
  await client.getByRole('button', { name: '查看第 1 版', exact: true }).click();
  const historical = (await (await old).json()).value;
  assert.equal(historical.blobDigest, f.media.asset.blobDigest);
  assert.equal(historical.view.historyReadOnly, true);
  assert.equal(historical.view.canWrite, false);
  assert.equal(historical.view.canReply, true);
  await assertBluePixels(page, mime, false);
  await surface.getByText(/历史版本 · 可查看与继续原讨论/).waitFor();
  await surface.getByRole('button', { name: '打开作品讨论', exact: true }).click();
  await surface.getByText('这处画面请保留，颜色不变。', { exact: true }).waitFor();
  assert.equal(await surface.getByLabel('编辑我的回复').count(), 0);
  assert.equal(await surface.getByLabel('编辑我的批注').count(), 0);
  assert.equal(await surface.getByRole('button', { name: '标为已解决', exact: true }).count(), 0);
  const body = '第二版已发布，继续保留第一版的红色讨论。';
  await surface
    .getByRole('textbox', { name: /回复批注/ })
    .first()
    .fill(body);
  const replied = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/artifacts/owner/request') &&
      response.request().postDataJSON()?.action === 'annotate',
  );
  await surface.getByRole('button', { name: '回复', exact: true }).first().click();
  const result = await replied;
  assert.equal(result.status(), 200, await result.text());
  assert.equal(result.request().postDataJSON().ownerRevision, 1);
  await f.reopenRetainedOwner();
  await page.reload();
  await client.getByRole('button', { name: /全部作品/ }).click();
  await openRetainedMediaHistory(client, artifact.title);
  await client.getByRole('button', { name: '查看第 1 版', exact: true }).click();
  await assertBluePixels(page, mime, false);
  await surface.getByRole('button', { name: '打开作品讨论', exact: true }).click();
  await surface.getByRole('button', { name: '查看回复', exact: true }).click();
  await surface.getByRole('button', { name: '更多回复', exact: true }).click();
  await surface.getByText(new RegExp(body)).first().waitFor();
}

async function shareSecondVersionFromPicker(publisher, sourceBody, title) {
  const author = await publisher.newPage();
  author.setDefaultTimeout(15000);
  try {
    await author.goto('http://127.0.0.1:4313/collective');
    const client = author.frameLocator('iframe[title="Collective"]');
    await client
      .getByRole('button', { name: /general/ })
      .first()
      .click();
    await client.getByText(sourceBody, { exact: true }).first().waitFor();
    await client.locator('.message').first().hover();
    await client.locator('.message-action-more').first().click();
    await client.getByRole('menuitem', { name: '分享作品…' }).click();
    await client.getByRole('button', { name: '从此 Café 选择图片或视频' }).click();
    await author.getByRole('dialog', { name: '从此 Café 分享图片或视频' }).waitFor();
    await author.getByRole('radio', { name: /第 2 版/ }).check();
    await author.getByLabel('作品名称', { exact: true }).fill(title);
    // Match the share effect, not the cross-origin OPTIONS preflight (which has no readable body).
    const publication = author.waitForResponse(
      (response) => response.url().endsWith('/artifacts/share-media') && response.request().method() === 'POST',
    );
    await author.getByRole('button', { name: '分享所选作品' }).click();
    const published = await publication;
    assert.equal(published.status(), 200, 'The normal picker must publish the second retained version');
    return await published.json();
  } finally {
    await author.close();
  }
}

async function assertBluePixels(page, mime, blue) {
  await page.waitForFunction((mime) => {
    const media = document.querySelector(
      mime === 'video/mp4' ? 'video' : '[data-testid="workspace-content-review-media"]',
    );
    return media && (mime === 'video/mp4' ? media.readyState >= 2 : media.complete && media.naturalWidth === 160);
  }, mime);
  // Inspect rendered pixels without bypassing the browser's cross-origin canvas protection.
  const bitmap = await page
    .locator(mime === 'video/mp4' ? 'video' : '[data-testid="workspace-content-review-media"]')
    .screenshot();
  const { width, height } = await sharp(bitmap).metadata();
  const [red, , b] = await sharp(bitmap)
    .extract({ left: Math.floor(width / 2), top: Math.floor(height / 2), width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.ok(
    blue ? b > 200 && red < 30 : red > 200 && b < 30,
    `Expected ${blue ? 'blue' : 'red'} version pixels, got ${red}/${b}`,
  );
}
