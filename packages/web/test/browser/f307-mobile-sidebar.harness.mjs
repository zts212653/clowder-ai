export async function closeMobileSidebarIfOpen(page, { timeout = 30_000 } = {}) {
  const hideSidebar = page.getByRole('button', { name: 'Hide sidebar' });
  if ((await hideSidebar.count()) === 0) return false;

  const backdrop = page.locator('[aria-hidden="true"][class*="console-overlay-backdrop"]').last();
  await backdrop.waitFor({ state: 'visible', timeout });
  const bounds = await backdrop.boundingBox();
  if (!bounds) throw new Error('Mobile sidebar backdrop became visible without actionable geometry');
  await backdrop.click({
    position: {
      x: Math.max(1, bounds.width - 16),
      y: Math.max(1, Math.min(100, bounds.height - 16)),
    },
    timeout,
  });
  await page.getByRole('button', { name: 'Show sidebar' }).waitFor({ state: 'visible', timeout });
  return true;
}
