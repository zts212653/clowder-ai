import assert from 'node:assert/strict';

/** Add real public comments through the original composer, then expand the owner-backed annotation list. */
export async function checkSharedArtifactAnnotationPages({ page, capture }) {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const body of ['分页检查：原讨论里的补充意见一。', '分页检查：原讨论里的补充意见二。']) {
    await page.locator('.shared-artifact-document').evaluate((paper) => {
      const walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent.indexOf('版本和来源');
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 5);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        paper.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        return;
      }
      throw new Error('Expected the current owner text');
    });
    await page.getByRole('button', { name: '讨论', exact: true }).click();
    await page.getByRole('group', { name: '作品引用', exact: true }).waitFor();
    const composer = page.locator('.context-panel textarea');
    await composer.fill(body);
    const response = page.waitForResponse(
      (item) =>
        item.url().endsWith('/api/artifacts/owner/request') && item.request().postDataJSON().action === 'annotate',
    );
    await page.locator('.context-panel').getByRole('button', { name: '发送', exact: true }).click();
    const received = await response;
    assert.equal(received.status(), 200, JSON.stringify(await received.json()));
    await page.waitForFunction(() => document.querySelector('.context-panel textarea')?.value === '');
    await page.getByRole('button', { name: '关闭话题', exact: true }).click();
  }
  const annotations = page.getByRole('complementary', { name: '作品批注', exact: true });
  const more = annotations.getByRole('button', { name: /^更多批注（2\// });
  await more.waitFor();
  const total = Number((await more.textContent()).match(/\/(\d+)）/)[1]);
  assert.ok(total > 2);
  assert.equal(await annotations.locator('article').count(), 2);
  let expandedReads = 0;
  const countRead = (request) => {
    if (
      request.url().endsWith('/api/artifacts/owner/request') &&
      request.method() === 'POST' &&
      request.postDataJSON().payload.annotationOffset > 0
    )
      expandedReads += 1;
  };
  page.on('request', countRead);
  try {
    await more.click();
    await annotations.getByText('分页检查：原讨论里的补充意见二。', { exact: true }).waitFor();
    assert.equal(await annotations.locator('article').count(), total);
    assert.equal(expandedReads, 1);
    await page.waitForResponse(
      (item) =>
        item.url().endsWith('/api/artifacts/owner/request') &&
        item.request().postDataJSON().action === 'read' &&
        !item.request().postDataJSON().payload.annotationOffset,
    );
    assert.equal(await annotations.locator('article').count(), total);
    assert.equal(expandedReads, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    const paper = await page.locator('.shared-artifact-document > .message-markdown').boundingBox();
    const notes = await annotations.boundingBox();
    assert.ok(paper && notes && paper.y + paper.height <= notes.y, 'Expanded annotations must follow the entire paper');
    await capture(page, 'annotation-pages-mobile');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.shared-artifact-card').filter({ hasText: '共同协作指南' }).first().click();
    await more.waitFor();
    assert.equal(await annotations.locator('article').count(), 2);
    assert.equal(expandedReads, 1);
    await page.setViewportSize({ width: 1440, height: 960 });
  } finally {
    page.off('request', countRead);
  }
}
