import assert from 'node:assert/strict';

const CATEGORY_TOKENS = [
  '--content-category-object',
  '--content-category-rubric',
  '--content-category-measurement',
  '--content-category-diagnosis',
];

async function readCategoryTokenColors(page) {
  return page.evaluate((tokenNames) => {
    return tokenNames.map((tokenName) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${tokenName})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
  }, CATEGORY_TOKENS);
}

export async function verifyPreparationVisualContract({ page, workspace, tabs }) {
  const tabVisuals = await tabs.evaluateAll((nodes) =>
    nodes.map((node) => {
      const icon = node.querySelector('[data-preparation-section-icon]');
      const hint = node.querySelector('[data-preparation-category-hint]');
      const status = node.querySelector('[data-preparation-section-state]');
      if (!(icon instanceof HTMLElement && hint instanceof HTMLElement && status instanceof HTMLElement)) {
        throw new Error('preparation tab visual contract is incomplete');
      }
      return {
        category: node.getAttribute('data-preparation-category'),
        backgroundColor: getComputedStyle(node).backgroundColor,
        hint: hint.textContent,
        iconCount: icon.querySelectorAll('svg[aria-hidden="true"]').length,
        iconColor: getComputedStyle(icon).color,
        state: status.getAttribute('data-preparation-section-state'),
        stateDot: getComputedStyle(status, '::before').backgroundColor,
      };
    }),
  );
  assert.deepEqual(
    tabVisuals.map((value) => value.category),
    ['object', 'rubric', 'measurement', 'diagnosis'],
  );
  assert.deepEqual(
    tabVisuals.map((value) => value.hint),
    ['范围与可改边界', '判法、反例与裁判', 'GT 来源与实验条件', '事实、未知与竞争解释'],
  );
  assert(tabVisuals.every((value) => value.iconCount === 1));

  const categoryTokenColors = await readCategoryTokenColors(page);
  assert.equal(new Set(categoryTokenColors).size, 4, 'content categories need four canonical design tokens');
  assert.deepEqual(
    tabVisuals.map((value) => value.iconColor),
    categoryTokenColors,
    'category icons must consume the canonical content-category roles',
  );
  assert.equal(new Set(tabVisuals.map((value) => value.backgroundColor)).size, 4, 'soft fields need four surfaces');
  const statusColors = new Set(tabVisuals.map((value) => value.stateDot));
  assert.deepEqual(
    tabVisuals.map((value) => value.iconColor).filter((color) => statusColors.has(color)),
    [],
    'content-category roles must not reuse runtime status colours',
  );
  assert(statusColors.size >= 3, 'working, submitted and needs-update states need independent semantic markers');

  const panelTones = [];
  const selectedSurfaces = [];
  for (const tab of await tabs.all()) {
    await tab.click();
    const section = await tab.getAttribute('data-preparation-section');
    assert.equal(await workspace.getAttribute('data-active-section'), section);
    selectedSurfaces.push(await tab.evaluate((element) => getComputedStyle(element).backgroundColor));
    panelTones.push(
      await workspace
        .locator('.evolution-preparation-submission')
        .evaluate((element) => getComputedStyle(element).borderTopColor),
    );
  }
  assert.equal(new Set(panelTones).size, 4, 'the selected category needs to carry into its reading panel');
  assert.equal(new Set(selectedSurfaces).size, 4, 'the active soft field must retain its category identity');
  return { tabVisuals, panelTones, selectedSurfaces };
}

export async function readFlatPreparationSurface(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderLeftWidth: style.borderLeftWidth,
      borderRightWidth: style.borderRightWidth,
      borderRadius: style.borderRadius,
    };
  });
}

export function assertFlatPreparationSurface(surface, label) {
  assert.deepEqual(
    surface,
    {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderLeftWidth: '0px',
      borderRightWidth: '0px',
      borderRadius: '0px',
    },
    `${label} must be a hairline section inside one surface, not a nested card`,
  );
}
