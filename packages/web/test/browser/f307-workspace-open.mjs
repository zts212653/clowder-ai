export async function ensureWorkspaceOpen(page, { attempts = 5, waitMs = 1_000 } = {}) {
  const toggle = page.getByTestId('workspace-panel-toggle');
  const workbench = page.getByTestId('f307-experience-workbench');
  await toggle.waitFor();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await workbench.isVisible()) return;
    if ((await toggle.getAttribute('aria-label')) === '打开 Workspace') await toggle.click();
    if (
      await workbench
        .waitFor({ state: 'visible', timeout: waitMs })
        .then(() => true)
        .catch(() => false)
    ) {
      return;
    }
  }

  throw new Error(
    `Workspace did not open at ${page.url()}\naria-label=${await toggle.getAttribute('aria-label')}\nbody=${(
      await page.locator('body').innerText()
    ).slice(0, 4_000)}`,
  );
}
