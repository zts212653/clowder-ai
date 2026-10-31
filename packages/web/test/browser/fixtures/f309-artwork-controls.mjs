const labels = { markup: '标注', comment: '评论' };

async function isImageReview(page) {
  const media = page.getByTestId('review-media-stage').locator('img, video');
  await media.waitFor();
  return media.evaluate((element) => element.tagName === 'IMG');
}

/** PNG saves live in the editing menu; the original video save remains directly reachable. */
export async function openAnnotationSave(page) {
  const save = page.getByRole('button', { name: '保存批注', exact: true });
  const actions = page.getByLabel('批注操作', { exact: true });
  if ((await actions.count()) > 0 && !(await save.isVisible())) await actions.click();
  await save.waitFor();
  return save;
}

export async function selectReviewMode(page, mode) {
  const toolbar = page.getByRole('region', { name: '作品画布工具' });
  const image = await isImageReview(page);
  const current = await toolbar.getAttribute('data-review-mode');
  if (current === mode) return;
  if (current !== 'view')
    await toolbar
      .getByRole('button', { name: image && current === 'comment' ? '圈选' : `退出${labels[current]}`, exact: true })
      .click();
  if (mode !== 'view')
    await toolbar
      .getByRole('button', { name: image ? { markup: '画笔', comment: '圈选' }[mode] : labels[mode], exact: true })
      .click();
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
    comments: { landmark: '作品讨论', button: '打开作品讨论' },
    decision: { landmark: '审阅结论', button: '完成审阅' },
    details: { landmark: '版本与历史', button: '审阅详情' },
  };
  const target = targets[panel];
  const drawer = page.getByRole('complementary', { name: target.landmark, exact: true });
  if (await drawer.isVisible()) return;
  if (panel === 'comments' && (await isImageReview(page))) {
    const menu = page.getByLabel('图片更多操作', { exact: true });
    if (!(await menu.evaluate((element) => element.parentElement.open))) await menu.click();
  }
  await page.getByRole('button', { name: target.button, exact: typeof target.button === 'string' }).click();
  await drawer.waitFor();
}

/** Read the real composer's persisted attachment; no test-side source/coordinate reconstruction. */
export async function imageChatAttachment(page) {
  return page.evaluate(() => {
    const entries = JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') || '[]');
    return entries.flatMap(([, attachments]) => attachments).find((item) => item.kind === 'media') ?? null;
  });
}

/** Legacy discussion is fixture history, not a replacement for the current image-to-Chat user action. */
export async function seedRetainedImageAnnotation(page, host, reviewId, body, annotationId = 'retained-image-comment') {
  await page.waitForFunction(() => {
    const entries = JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') || '[]');
    return entries
      .flatMap(([, attachments]) => attachments)
      .some((item) => item.kind === 'media' && item.selections.length > 0);
  });
  const attachment = await imageChatAttachment(page);
  const view = await host.reviews.read(reviewId, host.human);
  await host.reviews.act(
    {
      reviewId,
      expectedRevision: view.review.revision,
      expectedTaskRevision: view.authority.taskRevision,
      round: view.review.rounds.at(-1).number,
      operationId: annotationId,
      action: { kind: 'annotate', annotationId, anchor: attachment.selections.at(-1).selection, body },
    },
    host.human,
  );
  await page.getByTestId('artifact-review-surface').getByRole('button', { name: '刷新', exact: true }).click();
}
