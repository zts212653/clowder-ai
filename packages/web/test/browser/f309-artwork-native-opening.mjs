import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { digest } from './f309-artwork-lightbox-native-fixture.mjs';

/** Hold the actual owner media response so preview/owner handoff is deterministic. */
export async function openNativeArtwork(page, original, fixture, kind) {
  const pattern = '**/api/workspace/content-reviews/*/media?**';
  let release;
  const delayed = kind === 'png';
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const holdMedia = async (route) => {
    // Match openDocumentSession's explicit isolated owner routing, including its synthetic session issuer.
    const url = new URL(route.request().url());
    const upstream = `${fixture.owner.api}${url.pathname}${url.search}`;
    const response = await route.fetch({ url: upstream });
    const bytes = await response.body();
    fixture.openingResponse = {
      upstream,
      status: response.status(),
      mime: response.headers()['content-type'],
      sha256: digest(bytes),
    };
    await pending;
    await route.fulfill({ response, body: bytes });
  };
  if (delayed) await page.route(pattern, holdMedia);
  const dialog = page.getByRole('dialog', { name: fixture.filename, exact: true });
  const surface = dialog.getByTestId('workspace-content-review-surface');
  try {
    await original.getByTestId('file-block-cover').click();
    await surface.getByTestId(kind === 'gif' ? 'gif-frame-media' : 'workspace-content-review-media').waitFor();
    if (delayed) {
      await dialog.getByTestId('artwork-chat-preview').waitFor();
      const circleCount = await dialog.getByRole('button', { name: '圈选', exact: true }).count();
      assert.equal(circleCount, 0, 'The hidden original must not invite a gesture on the Chat preview');
      assert.equal(await dialog.getByRole('button', { name: '下载', exact: true }).count(), 1);
      fixture.opening = { delayedOriginal: true, previewVisible: true, circleCount };
    }
  } finally {
    release();
    if (delayed) await page.unrouteAll({ behavior: 'wait' });
  }
  await dialog.getByTestId('artwork-chat-preview').waitFor({ state: 'hidden' });
  assert.equal(await surface.locator('[data-content-opening-state="blocked"]').count(), 0, await surface.innerText());
  if (delayed) {
    assert.equal(fixture.openingResponse.status, 200);
    assert.equal(fixture.openingResponse.mime, fixture.source.mime);
    assert.equal(fixture.openingResponse.sha256, digest(fixture.original));
    fixture.opening.originalPresented = true;
  }
  return { dialog, surface };
}

/** Narrow artwork headers put these same actions in the visible overflow menu. */
export async function nativeArtworkAction(page, dialog, name) {
  const direct = dialog.getByRole('button', { name, exact: true });
  if (await direct.isVisible()) return direct;
  await dialog.getByRole('button', { name: '作品更多操作', exact: true }).click();
  return page.getByRole('menu', { name: '作品更多操作', exact: true }).getByRole('menuitem', { name, exact: true });
}

/** Exercise FileActions and inspect the file Chromium actually saved. */
export async function downloadNativeOriginal(page, dialog, fixture, kind) {
  const action = await nativeArtworkAction(page, dialog, '下载');
  const [response, download] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().resourceType() === 'fetch' &&
        response.headers()['content-type']?.split(';')[0] === fixture.source.mime,
    ),
    page.waitForEvent('download'),
    action.click(),
  ]);
  assert.equal(await download.failure(), null);
  const filename = download.suggestedFilename();
  assert.ok(filename.endsWith(`.${kind}`), filename);
  const file = await download.path();
  assert.ok(file);
  const saved = await readFile(file);
  const result = {
    filename,
    status: response.status(),
    mime: response.headers()['content-type'],
    url: response.url(),
    sha256: digest(saved),
    bytes: saved.length,
  };
  assert.equal(result.status, 200);
  assert.equal(result.mime, fixture.source.mime);
  assert.equal(new URL(result.url).searchParams.get('display'), null);
  assert.equal(result.sha256, digest(fixture.original));
  assert.equal(digest(await response.body()), result.sha256);
  return result;
}
