import assert from 'node:assert/strict';
import { openWorkspaceTools } from './f307-workspace-open.mjs';

/** The actual aggregated candidate publication is opened through Chat, Home and Works, using their original origins. */
export async function verifyNativeArtworkCatalogues(page, returned, observed = []) {
  const composer = page.getByLabel('消息输入框', { exact: true });
  await composer.fill('三处入口都保留这份未发送草稿');
  const original = await composer.elementHandle();
  const check = async (origin) => {
    const dialog = page.getByRole('dialog');
    const surface = dialog.getByTestId('workspace-content-review-surface');
    await surface.getByTestId('workspace-content-review-media').waitFor();
    assert.equal(await composer.evaluate((node, original) => node === original, original), true);
    assert.equal(await composer.inputValue(), '三处入口都保留这份未发送草稿');
    assert.equal(await surface.getAttribute('data-navigation-origin'), origin);
    observed.push({ origin, body: await dialog.innerText() });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await composer.inputValue(), '三处入口都保留这份未发送草稿');
  };
  await page
    .locator(`[data-message-id="${returned.published.id}"]`)
    .getByRole('button', { name: /打开作品/ })
    .click();
  await check('chat-file-link');
  await openWorkspaceTools(page);
  await page.getByTestId('v2-workspace-home').click();
  const home = page.getByTestId('f307-workspace-home-page');
  await home.getByTestId('workspace-home-artifact-card').filter({ hasText: returned.name }).click();
  await check('workspace-home-artifact');
  await home
    .locator('section[aria-labelledby="home-works-title"]')
    .getByRole('button', { name: '全部 ›', exact: true })
    .click();
  const works = page.getByTestId('v2-works-panel');
  const search = works.getByLabel('搜索作品名称…', { exact: true });
  await search.fill(returned.name);
  await works.getByTestId('workspace-home-artifact-card').filter({ hasText: returned.name }).click();
  await check('artifact-list');
  assert.equal(await search.inputValue(), returned.name);
  return observed;
}
