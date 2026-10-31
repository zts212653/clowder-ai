import assert from 'node:assert/strict';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';

export async function verifyWorkspaceSidecarReturn(page, { threadUrl, programId, navigateShell, capture }) {
  await navigateShell(page, threadUrl);
  await ensureWorkspaceOpen(page);
  await page.getByText('能力进化', { exact: true }).first().click();
  const workspace = page.getByTestId('capability-evolution-workspace');
  await workspace.getByTestId(`capability-evolution-program-${programId}`).click();
  await workspace.getByRole('button', { name: '展开阅读 →', exact: true }).click();
  await page.getByTestId('f307-close-evolution-program').click();

  // Restore a supported F307 layout in this browser context; all owner components remain real.
  await page.evaluate(() => {
    const key = 'cat-cafe:workbench-layout-v2';
    const layout = JSON.parse(localStorage.getItem(key));
    const home = layout.surfaces.find((surface) => surface.id === 'workspace:capability-evolution');
    if (!home?.capabilities.sidecar) throw new Error('Workspace home must support an F307 sidecar');
    layout.surfaces = layout.surfaces.filter((surface) => surface.id !== home.id);
    layout.sidecar = home;
    localStorage.setItem(key, JSON.stringify(layout));
  });
  await navigateShell(page, threadUrl);
  await ensureWorkspaceOpen(page);
  const sidecar = page.getByTestId('f307-sidecar');
  await sidecar.getByRole('button', { name: '查看进展', exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 640 });
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="capability-evolution-workspace"]');
    return element && element.scrollHeight > element.clientHeight;
  });
  const homeNode = await workspace.elementHandle();
  const sidecarNode = await sidecar.elementHandle();
  const program = page.getByTestId('evolution-program-surface');
  const programNode = await program.elementHandle();
  assert(homeNode && sidecarNode && programNode);
  await workspace.evaluate((element) => {
    element.scrollTop = 110;
  });
  const projectRow = workspace.getByTestId(`capability-evolution-program-${programId}`);
  // A real multi-project list may need another scroll before its row can be clicked.
  await projectRow.scrollIntoViewIfNeeded();
  const scroll = await workspace.evaluate((element) => element.scrollTop);
  assert(scroll > 0, 'the list must actually be scrolled before opening the Program');
  await projectRow.click();
  await sidecar.getByTestId('capability-evolution-program-detail').waitFor();
  await workspace.getByRole('button', { name: '展开阅读 →', exact: true }).click();
  await page.locator('[data-presentation="main-area-attention"]').waitFor();
  await page.getByTestId('f307-close-evolution-program').click();
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('cat-cafe:workbench-layout-v2')));
  await capture(page, 'sidecar-before-return');
  await program.getByRole('button', { name: '← 全部项目', exact: true }).click();
  await sidecar.getByTestId(`capability-evolution-program-${programId}`).waitFor({ timeout: 5000 });
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem('cat-cafe:workbench-layout-v2'))),
    before,
    'returning to the list must not change the active tab, surfaces, split, or sidecar',
  );
  for (const [locator, node] of [
    [workspace, homeNode],
    [sidecar, sidecarNode],
    [program, programNode],
  ])
    assert(await locator.evaluate((element, original) => element === original, node), 'owner DOM must stay mounted');
  assert.equal(await workspace.evaluate((element) => element.scrollTop), scroll, 'the home reading position survives');
  await capture(page, 'sidecar-after-return');
  return {
    viewport: page.viewportSize(),
    sidecar: await sidecar.boundingBox(),
    workspace: await workspace.boundingBox(),
    scroll,
  };
}
