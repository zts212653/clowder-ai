import assert from 'node:assert/strict';

/** Walk the real Home navigation on either a direct page or an embedded Client. */
export async function openChannelFromCollectiveHome(surface, channelId) {
  await surface.getByTestId('collective-home').waitFor({ state: 'visible' });
  const mobileNavigation = surface.getByTestId('collective-home-navigation');
  if (await mobileNavigation.isVisible()) await mobileNavigation.click();
  await surface.getByRole('navigation', { name: '频道', exact: true }).getByText(channelId, { exact: true }).click();
  await surface.getByRole('heading', { name: `# ${channelId}`, exact: true }).waitFor();
  assert.equal(await surface.getByTestId('collective-home').count(), 0);
}
