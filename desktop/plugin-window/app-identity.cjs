const { existsSync } = require('node:fs');
const { join } = require('node:path');

const COMPANION_ICON_PNG = join(__dirname, 'assets', 'yanyan-companion.png');
const COMPANION_ICON_ICNS = join(__dirname, 'assets', 'yanyan-companion.icns');

async function configureCompanionAppIdentity(app, { platform = process.platform } = {}) {
  app.setName('Clowder Companion');
  if (platform !== 'darwin') return;
  await app.whenReady();
  if (!existsSync(COMPANION_ICON_PNG) || !existsSync(COMPANION_ICON_ICNS))
    throw new Error('companion icon resources unavailable');
  if (!app.dock?.setIcon) throw new Error('companion Dock identity unavailable');
  app.dock.setIcon(COMPANION_ICON_PNG);
}

module.exports = {
  COMPANION_ICON_ICNS,
  COMPANION_ICON_PNG,
  configureCompanionAppIdentity,
};
