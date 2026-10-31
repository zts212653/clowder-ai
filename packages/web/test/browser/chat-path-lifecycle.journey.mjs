import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function verifyPathLifecycle({ page, base, source, evidence }) {
  await page.goto(`${base}/thread/${source.lifecycleThread.id}?shell=v2`);
  const message = page.locator(`[data-message-id="${source.lifecycle.id}"]`).first();
  await message.scrollIntoViewIfNeeded();
  const parent = message.locator('[data-chat-reference-kind=file]').filter({ hasText: 'index.md' });
  const archive = message.locator('[data-chat-reference-kind=file]').filter({ hasText: 'archive.7z' });
  await parent.waitFor();
  await archive.waitFor();
  await message.locator('[data-chat-reference-kind=missing]').filter({ hasText: 'gone.md' }).waitFor();
  await parent.locator('button').first().click();
  const viewer = page.locator('[data-testid="workspace-file-viewer"]:visible');
  await viewer.getByText('Same admitted root.', { exact: false }).waitFor();
  await message.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(evidence, 'parent-and-alias-existing.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await rm(path.join(source.root, 'docs/archive.7z'));
  await archive.scrollIntoViewIfNeeded();
  await page.waitForTimeout(31000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await message.locator('[data-chat-reference-kind=missing]').filter({ hasText: 'archive.7z' }).waitFor();
  assert.equal(await message.locator('[data-chat-reference-kind=file]').count(), 1);
  const result = await message.innerText();
  await writeFile(
    path.join(evidence, 'path-lifecycle.json'),
    JSON.stringify({ thread: source.lifecycleThread.id, message: source.lifecycle.id, result }, null, 2),
  );
  await page.screenshot({
    path: path.join(evidence, 'parent-and-alias-deleted.png'),
    fullPage: true,
    animations: 'disabled',
  });
}
