const labels = { markup: '标注', comment: '评论' };

export async function selectReviewMode(page, mode) {
  const toolbar = page.getByRole('region', { name: '作品画布工具' });
  const current = await toolbar.getAttribute('data-review-mode');
  if (current === mode) return;
  if (current !== 'view') await toolbar.getByRole('button', { name: `退出${labels[current]}`, exact: true }).click();
  if (mode !== 'view') await toolbar.getByRole('button', { name: labels[mode], exact: true }).click();
  await page.waitForFunction(
    (expected) => document.querySelector('[data-review-mode]')?.getAttribute('data-review-mode') === expected,
    mode,
  );
}

export async function selectMarkupTool(page, tool) {
  if (['矩形', '椭圆', '箭头'].includes(tool)) await page.getByLabel('形状', { exact: true }).click();
  await page.getByRole('button', { name: tool, exact: true }).click();
}

export async function selectMarkupColor(page, color) {
  await page.getByLabel('颜色与线条', { exact: true }).click();
  await page.getByRole('button', { name: `选择颜色 ${color}`, exact: true }).click();
}

export async function openReviewPanel(page, panel) {
  const targets = {
    comments: { landmark: '作品讨论', button: /^查看讨论/ },
    decision: { landmark: '审阅结论', button: '完成审阅' },
    details: { landmark: '版本与历史', button: '审阅详情' },
  };
  const target = targets[panel];
  const drawer = page.getByRole('complementary', { name: target.landmark, exact: true });
  if (await drawer.isVisible()) return;
  await page.getByRole('button', { name: target.button, exact: typeof target.button === 'string' }).click();
  await drawer.waitFor();
}
