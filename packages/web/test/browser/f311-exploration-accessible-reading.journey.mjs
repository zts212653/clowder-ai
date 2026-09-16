import assert from 'node:assert/strict';
import { refIdentity } from '@cat-cafe/shared';

export async function chooseExplorationVersion(work, version) {
  const sourceTab = work.getByRole('button', { name: '公开归档', exact: true });
  await sourceTab.waitFor();
  if ((await sourceTab.getAttribute('aria-pressed')) === 'false') await sourceTab.click();
  await work.getByLabel('选择阅读版本', { exact: true }).selectOption({ label: version });
  await work.getByRole('heading', { name: `正在阅读 ${version}`, exact: true }).waitFor();
}
export async function chooseExplorationRun(work, run) {
  await work.getByLabel('选择本版实验', { exact: true }).selectOption(refIdentity(run.experimentRef));
  await work.getByRole('region', { name: '实验案例与覆盖', exact: true }).waitFor();
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
  await work.getByRole('button', { name: '本项目版本', exact: true }).click();
  await work.getByLabel('选择阅读版本', { exact: true }).selectOption(refIdentity(current.nodeRef));
  const badge = work.locator('.exploration-selection-heading [data-current-adoption="true"]');
  await badge.waitFor({ state: 'visible' });
  assert.equal(await badge.textContent(), '当前沿用');
  await chooseExplorationVersion(work, 'v3');
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
  const escaped = summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const node = work.getByRole('button', { name: new RegExp(`阅读.*v3.*${escaped}.*3 轮实验.*公开归档`) });
  await node.waitFor({ timeout: 5000 });
  return node;
}

export async function verifyNarrowExplorationEvidence(work, page) {
  const disclosure = work.locator('details.exploration-lineage-disclosure');
  assert.equal(
    await disclosure.evaluate((element) => element.open),
    false,
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
