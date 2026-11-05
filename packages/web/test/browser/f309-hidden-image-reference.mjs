import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openWorkspaceTools } from './f307-workspace-open.mjs';

/** The canonical private draft/file owner supplies real HTTP/CAS; this forwards no runtime request. */
export async function forwardHiddenImageOwner(request, url, composer, calls) {
  const response = await fetch(`${composer.api}${url.pathname}${url.search}`, {
    method: request.method(),
    headers: { 'content-type': 'application/json' },
    ...(request.postDataBuffer() ? { body: request.postDataBuffer() } : {}),
  });
  const body = await response.json();
  if (url.pathname === '/api/workspace/worktrees') {
    body.worktrees = body.worktrees.filter((entry) => entry.root === composer.root);
    assert.equal(body.worktrees.length, 1, 'only the author checkout is offered');
  }
  calls.push({ method: request.method(), path: url.pathname, status: response.status, body });
  return { body, status: response.status };
}

/** Real visible document + retained Task image + explicit chip removal; no store or storage mutation. */
export async function verifyHiddenImageRemoval({ page, composer, owner, evidence, calls }) {
  // Opening a work no longer inserts an unsolicited draft reference. Make a real
  // selection before testing whether its acknowledged removal survives reload.
  await page.getByRole('button', { name: '圈选', exact: true }).click();
  const picture = await page.getByTestId('review-media-stage').boundingBox();
  assert.ok(picture);
  await page.mouse.move(picture.x + picture.width * 0.2, picture.y + picture.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(picture.x + picture.width * 0.4, picture.y + picture.height * 0.35);
  await page.mouse.up();
  const media = page.locator('[data-context-kind="media"]').filter({ visible: true });
  await media.waitFor();
  assert.equal(await media.count(), 1);
  const mediaId = (await media.getAttribute('data-testid')).slice('context-attachment-'.length);
  const tools = await openWorkspaceTools(page);
  await tools.getByTestId('workspace-launcher-search').fill('F309-collaborative-content-plane.md');
  await tools
    .getByTestId('workspace-launcher-file-result')
    .filter({ has: page.getByText('F309-collaborative-content-plane.md', { exact: true }) })
    .first()
    .click();
  const document = page.getByTestId('workspace-content-review-text').filter({ visible: true });
  await document.waitFor();
  assert.equal(await page.locator('[data-testid="artifact-review-surface"]:visible').count(), 0);
  const cleared = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/threads/${owner.thread.id}/composer-draft` &&
      !response.request().postDataJSON().contentBlocks?.length,
  );
  await media.getByRole('button', { name: /^移除上下文/ }).click();
  const acknowledgment = await cleared;
  assert.equal(acknowledgment.status(), 200);
  const before = (await acknowledgment.json()).draft;
  assert.equal(before.text, '原Chat未发送的说明');
  assert.ok(!before.contentBlocks?.length);
  const callStart = calls.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await document.waitFor();
  await page
    .locator('[data-testid="artifact-review-surface"] select[aria-label="审阅版本"]')
    .waitFor({ state: 'attached' });
  const observed = [];
  const end = Date.now() + 1500;
  // A bounded late-write observation after BOTH real owners restored, not an early DOMContentLoaded snapshot.
  while (Date.now() < end) {
    const draft = await composer.readTaskDraft();
    assert.equal(draft.text, before.text);
    assert.ok(!draft.contentBlocks?.length, 'the removed image must stay absent from the real owner draft');
    observed.push({ at: Date.now(), revision: draft.revision, contentBlocks: draft.contentBlocks });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const after = await composer.readTaskDraft();
  assert.equal(await page.locator('[data-context-kind="media"]:visible').count(), 0);
  assert.equal(await page.locator('[data-testid="artifact-review-surface"]:visible').count(), 0);
  assert.equal(await page.getByLabel('消息输入框').inputValue(), before.text);
  assert.ok(!calls.slice(callStart).some((call) => call.method === 'PUT' && call.body?.draft?.contentBlocks?.length));
  await page.screenshot({ path: `${evidence}/hidden-image-cleared-after-reload.png` });
  await writeFile(
    `${evidence}/hidden-image-cleared-after-reload.json`,
    JSON.stringify(
      { url: page.url(), draftApi: composer.api, mediaId, before, after, observed, calls: calls.slice(callStart) },
      null,
      2,
    ),
  );
}
