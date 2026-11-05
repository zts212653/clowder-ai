import assert from 'node:assert/strict';
import path from 'node:path';

/** Private author dogfood: adopted original covers, with a browser-only network interruption. */
export async function verifyAdoptedCovers({ page, sidebar, evidence, record }) {
  await sidebar.getByRole('combobox', { name: '故事线或素材', exact: true }).selectOption('assets');
  const covers = record.context.assets.filter((row) => row.asset.kind === '封面');
  assert.equal(covers.length, 2);
  const group = sidebar.locator('details').filter({ hasText: covers[0].asset.name });
  if (!(await group.evaluate((node) => node.open))) await group.locator('summary').click();
  const observations = [];
  for (const [index, row] of covers.entries()) {
    const url = await group.getByRole('link', { name: row.asset.name, exact: true }).getAttribute('href');
    const absolute = new URL(url, page.url()).href;
    const failOnce = (route) => route.abort('failed');
    if (index === 0) await page.route(absolute, failOnce, { times: 1 });
    try {
      const toggle = group.getByRole('button', { name: `预览 ${row.asset.name}`, exact: true });
      await toggle.click();
      const image = group.getByRole('img', { name: row.asset.name, exact: true });
      if (index === 0) {
        const error = group.getByRole('alert');
        await error.waitFor();
        assert.ok((await error.innerText()).includes('这份素材暂时无法预览'));
        assert.equal(await image.count(), 0);
        await page.screenshot({ path: path.join(evidence, 'material-original-network-error.png'), fullPage: true });
        await error.getByRole('button', { name: '重试预览', exact: true }).click();
      }
      await image.waitFor();
      await image.evaluate((node) => node.decode());
      assert.equal(await image.getAttribute('src'), url, 'Retry retains the exact authorized metadata URL');
      const dimensions = await image.evaluate((node) => ({ width: node.naturalWidth, height: node.naturalHeight }));
      assert.deepEqual(dimensions, index === 0 ? { width: 1920, height: 1080 } : { width: 1080, height: 1440 });
      observations.push({
        name: row.asset.name,
        metadataRevision: record.metadataRevision,
        ...dimensions,
        networkRetry: index === 0,
      });
      await page.screenshot({ path: path.join(evidence, `adopted-cover-${index}.png`), fullPage: true });
      await toggle.click();
      assert.equal(await image.count(), 0);
    } finally {
      await page.unroute(absolute, failOnce);
    }
  }
  return observations;
}
