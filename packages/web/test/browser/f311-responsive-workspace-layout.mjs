export async function waitForResponsiveWorkspaceLayout(page, layout, viewportWidth) {
  await layout.waitFor({ state: 'visible' });
  const element = await layout.elementHandle();
  if (!element) throw new Error('responsive workspace layout element is unavailable');
  try {
    await page.waitForFunction(
      ([node, minimum]) => node.isConnected && node.clientWidth >= minimum,
      [element, Math.min(viewportWidth, 320)],
    );
  } finally {
    await element.dispose();
  }
}
