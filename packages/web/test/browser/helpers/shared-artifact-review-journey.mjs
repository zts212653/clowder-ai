import assert from 'node:assert/strict';

export async function checkSharedArtifactReview({ page, capture }) {
  const annotations = page.getByRole('complementary', { name: '作品批注', exact: true });
  const annotation = annotations.locator('article').filter({ hasText: '请把选中的这处写得更清楚。' });
  await annotation.getByRole('button', { name: '在原讨论回复', exact: true }).click();
  await page.getByText('第 1 版 · 历史版本，只读查看', { exact: false }).waitFor();
  await page
    .getByRole('group', { name: '作品引用', exact: true })
    .getByText('回复第 1 版的批注 · 留在原讨论', { exact: true })
    .waitFor();
  assert.equal(await annotations.getByRole('button', { name: '解决批注', exact: true }).count(), 0);
  const composer = page.locator('.context-panel textarea');
  await composer.fill('确认：这一处的历史说明已经理解。');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await capture(page, 'annotation-reply-mobile');
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/artifacts/owner/request') &&
      response.request().postDataJSON().payload.kind === 'review-action' &&
      response.request().postDataJSON().payload.action.kind === 'reply',
  );
  await page.locator('.context-panel').getByRole('button', { name: '发送', exact: true }).click();
  const acknowledged = await response;
  assert.equal(acknowledged.status(), 200, JSON.stringify(await acknowledged.json()));
  await page
    .locator('.context-panel .topic-message')
    .getByText('确认：这一处的历史说明已经理解。', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: '关闭话题', exact: true }).click();
  await annotation.getByRole('button', { name: '读取回复（0/1）', exact: true }).click();
  await annotation
    .locator('.shared-artifact-annotation-reply')
    .getByText('确认：这一处的历史说明已经理解。', { exact: true })
    .waitFor();
  await capture(page, 'historical-annotation-reply-mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  await capture(page, 'historical-annotation-reply');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.shared-artifact-card').filter({ hasText: '共同协作指南' }).first().click();
  await page
    .locator('.shared-artifact-document')
    .getByText('两名各自登录的成员阅读同一份正文。', { exact: true })
    .waitFor();
  await annotation.getByRole('button', { name: '读取回复（0/1）', exact: true }).click();
  await annotation
    .locator('.shared-artifact-annotation-reply')
    .getByText('确认：这一处的历史说明已经理解。', { exact: true })
    .waitFor();
  await annotation.getByRole('button', { name: '解决批注', exact: true }).click();
  await annotation.getByText('已解决', { exact: true }).waitFor();
  await capture(page, 'annotation-resolved');
  await annotation.getByRole('button', { name: '重新打开批注', exact: true }).click();
  await annotation.getByRole('button', { name: '解决批注', exact: true }).waitFor({ state: 'visible' });
}
