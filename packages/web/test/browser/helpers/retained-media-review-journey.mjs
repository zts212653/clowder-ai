import assert from 'node:assert/strict';

export async function checkRetainedMediaDiscussion(page, surface, mime, index) {
  if (index === 0) {
    await surface.getByRole('button', { name: '评论', exact: true }).click();
    const stage = await surface.getByTestId('review-media-stage').boundingBox();
    assert.ok(stage);
    await page.mouse.click(stage.x + stage.width * 0.3, stage.y + stage.height * 0.3);
    await surface.getByLabel('评论内容', { exact: true }).fill('这处画面请保留。');
    const committed = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/artifacts/owner/request') &&
        response.request().postDataJSON()?.action === 'annotate',
    );
    await surface.getByLabel('保存批注', { exact: true }).click();
    const saved = await committed;
    assert.equal(saved.status(), 200, await saved.text());
    await surface.getByRole('button', { name: '打开作品讨论', exact: true }).click();
    await surface.getByText('这处画面请保留。', { exact: true }).waitFor();
    await surface.getByLabel('编辑我的批注').click();
    await surface.getByLabel('编辑批注内容').fill('这处画面请保留，颜色不变。');
    await surface.getByRole('button', { name: '保存修改', exact: true }).click();
    await surface.getByText('这处画面请保留，颜色不变。', { exact: true }).waitFor();
    await surface.getByRole('button', { name: '关闭讨论', exact: true }).click();
    if (mime === 'image/png') {
      const box = await surface.getByTestId('review-media-stage').boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.4, { steps: 5 });
      await page.mouse.up();
    } else {
      await surface.getByLabel('片段起点', { exact: true }).fill('0.2');
      await surface.getByLabel('片段终点', { exact: true }).fill('0.8');
    }
    await surface.getByLabel('评论内容', { exact: true }).fill('这段范围也已确认。');
    await surface.getByLabel('保存批注', { exact: true }).click();
    await surface.getByRole('button', { name: '打开作品讨论', exact: true }).click();
    await surface.getByText('这段范围也已确认。', { exact: true }).waitFor();
  } else {
    await surface.getByRole('button', { name: '打开作品讨论', exact: true }).click();
    await surface.getByText('这处画面请保留，颜色不变。', { exact: true }).waitFor();
    assert.equal(await surface.getByLabel('编辑我的批注').count(), 0);
    await surface
      .getByRole('textbox', { name: /回复批注/ })
      .first()
      .fill('另一位成员已确认。');
    const replyResult = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/artifacts/owner/request') &&
        response.request().postDataJSON()?.action === 'annotate',
    );
    await surface.getByRole('button', { name: '回复', exact: true }).first().click();
    const replied = await replyResult;
    assert.equal(replied.status(), 200, await replied.text());
    await surface.getByRole('button', { name: '查看回复', exact: true }).click();
    try {
      await surface
        .getByText(/另一位成员已确认。/)
        .first()
        .waitFor({ timeout: 5000 });
    } catch (error) {
      console.log('Reply surface:', await surface.innerText());
      await page.screenshot({ path: '/tmp/f290-w4-reply-failure.png' });
      throw error;
    }
    await surface.getByLabel('编辑我的回复').click();
    await surface.getByLabel('编辑回复内容').fill('另一位成员已确认，保留红色。');
    await surface.getByRole('button', { name: '保存修改', exact: true }).click();
    await surface.getByRole('button', { name: '查看回复', exact: true }).click();
    await surface
      .getByText(/另一位成员已确认，保留红色。/)
      .first()
      .waitFor();
    await surface.getByRole('button', { name: '标为已解决', exact: true }).first().click();
    await surface.getByText('已解决', { exact: true }).first().waitFor();
  }
}
