export async function ensureWorkspaceOpen(
  page,
  { attempts = 5, waitMs = 1_000, readinessTimeoutMs = 30_000, actionTimeoutMs = 1_000 } = {},
) {
  const toggle = page.getByTestId('workspace-panel-toggle');
  const workbench = page.getByTestId('f307-experience-workbench');
  if (await workbench.isVisible()) return;
  await toggle.waitFor();
  const interactiveToggle = page.locator('[data-testid="workspace-panel-toggle"][data-client-interactive="true"]');
  await interactiveToggle.waitFor({ state: 'attached', timeout: readinessTimeoutMs }).catch(async () => {
    throw new Error(
      `Workspace client did not become interactive at ${page.url()}\nclient-interactive=${await page
        .getByTestId('workspace-panel-toggle')
        .getAttribute('data-client-interactive')}\naria-label=${await toggle.getAttribute('aria-label')}\nbody=${(
        await page.locator('body').innerText()
      ).slice(0, 4_000)}`,
    );
  });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await workbench.isVisible()) return;
    if ((await toggle.getAttribute('aria-label')) === '打开 Workspace' && !(await workbench.isVisible())) {
      try {
        await toggle.click({ timeout: actionTimeoutMs });
      } catch (error) {
        if (await workbench.isVisible()) return;
        throw error;
      }
    }
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

/** Open the existing catalogue through its visible user entry, keeping a warm owner mounted. */
export async function openWorkspaceTools(page) {
  await ensureWorkspaceOpen(page);
  const home = page.getByTestId('workspace-launcher-home');
  if (await home.isVisible()) return home;
  const tools = page.getByTestId('workspace-tools-content');
  if (!(await tools.isVisible())) await page.getByTestId('v2-workspace-tools').click();
  await tools.waitFor({ state: 'visible' });
  return tools;
}

export async function collapseV2Workspace(page) {
  await page.getByTestId('v2-workspace-chrome').getByLabel('更多 Workspace 操作', { exact: true }).click();
  await page
    .getByRole('menu', { name: '更多 Workspace 操作', exact: true })
    .getByRole('menuitem', { name: '收起 Workspace', exact: true })
    .click();
  await page.getByTestId('contextual-workspace-host').waitFor({ state: 'hidden' });
}
