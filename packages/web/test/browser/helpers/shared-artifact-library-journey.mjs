import assert from 'node:assert/strict';

/** Runs against the normal Client and canonical owner created by the enclosing journey. */
export async function checkSharedArtifactLibrary({ page, artifact, originalText, request, capture }) {
  await page.getByRole('button', { name: '返回作品', exact: true }).click();
  await page.getByRole('button', { name: '关闭作品', exact: true }).click();
  await page.getByRole('button', { name: '全部作品', exact: true }).click();
  const library = page.getByRole('region', { name: '全部作品', exact: true });
  const search = library.getByRole('searchbox', { name: '搜索作品', exact: true });
  await search.fill(artifact.title);
  assert.equal(await library.locator('.shared-artifact-card').count(), 1);
  await capture(page, 'library-desktop');
  await library.locator('.shared-artifact-card').click();
  await page
    .locator('.shared-artifact-document')
    .getByText('两名各自登录的成员阅读同一份正文。', { exact: true })
    .waitFor();
  const historyPage = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/artifacts/history') &&
      response.request().postDataJSON().artifactId === artifact.artifactId &&
      response.status() === 200,
  );
  await page.getByRole('button', { name: '版本记录', exact: true }).click();
  const metadata = await (await historyPage).json();
  assert.equal(metadata.total, 2);
  assert.deepEqual(
    metadata.versions.map((version) => version.ownerRevision),
    [2, 1],
  );
  assert.equal(artifact.versionCount, 2);
  assert.equal(artifact.versions.length, 1);
  const history = page.getByRole('dialog', { name: '版本记录', exact: true });
  await history.getByRole('button', { name: '查看第 1 版', exact: true }).waitFor();
  assert.equal(await history.locator('li').count(), 2);
  assert.ok((await history.textContent()).includes(artifact.versions[0].receiptRef));
  const historicalRead = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/artifacts/owner/request') &&
      response.status() === 200 &&
      response.request().postDataJSON().action === 'read' &&
      response.request().postDataJSON().ownerRevision === 1,
  );
  await history.getByRole('button', { name: '查看第 1 版', exact: true }).click();
  const historical = (await (await historicalRead).json()).value;
  assert.equal(historical.text, originalText);
  assert.equal(historical.blobDigest, metadata.versions[1].blobDigest);
  await page.getByText('第 1 版 · 历史版本，只读查看', { exact: false }).waitFor();
  await page
    .locator('.shared-artifact-document')
    .getByText('两名独立认证成员阅读同一份正文。', { exact: true })
    .waitFor();
  assert.equal(await page.getByRole('button', { name: '采用', exact: true }).count(), 0);
  await page.getByRole('button', { name: '返回全部作品', exact: true }).click();
  assert.equal(await search.inputValue(), artifact.title);
  assert.equal(new URL(page.url()).searchParams.get('view'), 'artifacts');
  assert.equal(await library.locator('.shared-artifact-card').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await capture(page, 'library-mobile');
  await library.locator('.shared-artifact-card').click();
  await page.getByRole('button', { name: '版本记录', exact: true }).click();
  await history.waitFor();
  const bounds = await history.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await capture(page, 'history-mobile');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.dataset.consoleTheme = 'dark';
  });
  await capture(page, 'history-mobile-dark');
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.consoleTheme;
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await capture(page, 'history-desktop');
  await history.getByRole('button', { name: '在讨论中查看第 2 版的请求', exact: true }).click();
  await page.locator('.context-panel').getByText(request.body, { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('channelId'), request.location.channelId);
  assert.equal(new URL(page.url()).searchParams.has('view'), false);
  assert.equal(await page.locator('.shared-artifact-surface').count(), 0);
  await capture(page, 'history-source-request');
  // Leave the original journey reading the same adopted work for its subsequent revoke checks.
  await page.getByRole('button', { name: '全部作品', exact: true }).click();
  await library.locator('.shared-artifact-card').click();
  await page
    .locator('.shared-artifact-document')
    .getByText('两名各自登录的成员阅读同一份正文。', { exact: true })
    .waitFor();
}
