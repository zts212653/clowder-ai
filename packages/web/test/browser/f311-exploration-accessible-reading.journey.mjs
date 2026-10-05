import assert from 'node:assert/strict';
import { refIdentity } from '@cat-cafe/shared';

export async function chooseExplorationVersion(work, version) {
  const picker = work.getByLabel('选择阅读版本', { exact: true });
  if (await picker.isVisible()) await picker.selectOption({ label: version });
  else {
    await work.getByLabel('版本来源', { exact: true }).selectOption('public_archive');
    await work.getByRole('button', { name: `阅读 ${version}`, exact: true }).click();
  }
  await work.getByRole('heading', { name: version, exact: true }).waitFor();
}
export async function chooseExplorationComparison(work, value) {
  const picker = work.locator('.exploration-run-picker');
  if ((await picker.getAttribute('open')) === null) await picker.locator('summary').click();
  await work.getByLabel('选择对照实验', { exact: true }).selectOption(value);
}
export async function chooseExplorationRun(work, run) {
  const picker = work.locator('.exploration-run-picker');
  if ((await picker.getAttribute('open')) === null) await picker.locator('summary').click();
  await work.getByLabel('选择本版实验', { exact: true }).selectOption(refIdentity(run.experimentRef));
  await picker.locator('summary').getByText(run.title, { exact: true }).waitFor();
}

export async function corruptStoredExplorationSibling(page) {
  await page.evaluate(() => {
    const key = 'f311-exploration-requests-v1';
    const saved = JSON.parse(localStorage.getItem(key));
    saved.state.records['unrelated-malformed-request'] = { clientMessageId: 'invalid-id' };
    localStorage.setItem(key, JSON.stringify(saved));
  });
}

export async function verifyNarrowCurrentAdoption(work, catalog) {
  const current = catalog.nodes.find(
    (node) => node.kind === 'owner_version' && node.title === '官方 walking ONNX baseline',
  );
  assert(current, 'the real owner publishes the currently adopted walking baseline');
  await work.getByLabel('选择阅读版本', { exact: true }).selectOption(refIdentity(current.nodeRef));
  await work.getByRole('button', { name: '改动与依据', exact: true }).click();
  await work.locator('.exploration-adoption > summary').click();
  assert((await work.getByRole('status', { name: '当前沿用', exact: true }).innerText()).includes(current.title));
  await chooseExplorationVersion(work, 'v3');
  await work.getByRole('button', { name: '结果与案例', exact: true }).click();
}

export async function verifyStableExplorationTitle(page) {
  const title = page.locator('.evolution-title');
  const before = await title.evaluate((element) => getComputedStyle(element).fontSize);
  await page.getByRole('tab', { name: '更改历史', exact: true }).click();
  assert.equal(
    await title.evaluate((element) => getComputedStyle(element).fontSize),
    before,
    'page title must not resize on a reading tab switch',
  );
  await page.getByRole('tab', { name: '探索工作面', exact: true }).click();
}

export async function accessibleExplorationNode(work, summary) {
  const node = work.getByRole('button', { name: '阅读 v3', exact: true });
  await node.waitFor({ timeout: 5000 });
  assert.equal(await node.getAttribute('title'), summary);
  return node;
}

export async function verifyNarrowExplorationEvidence(work, page) {
  const disclosure = work.locator('.exploration-version-nav');
  assert.equal(
    await disclosure.getAttribute('data-map-open'),
    'false',
    'the narrow default prioritizes the selected experiment',
  );
  await work.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const result = work.getByRole('heading', { name: '实验结果与反例', exact: true });
  const bounds = await result.boundingBox();
  assert(
    bounds && bounds.y + bounds.height <= page.viewportSize().height,
    `the selected result must fit the first narrow reading viewport: ${JSON.stringify(bounds)}`,
  );
  const observed = await work.locator('.exploration-counts strong').first().boundingBox();
  assert(
    observed && observed.y + observed.height <= page.viewportSize().height,
    `the actual observed count must be readable in the same viewport: ${JSON.stringify(observed)}`,
  );
}
