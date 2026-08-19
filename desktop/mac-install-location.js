// Prevent packaged macOS services from pinning a mounted installer DMG.

function ensureValidMacInstallLocation({ app, dialog }) {
  if (process.platform !== 'darwin' || !app.isPackaged) return true;

  const appPath = app.getAppPath();
  const runningFromVolume = appPath.startsWith('/Volumes/');
  const inApplications = (() => {
    try {
      return app.isInApplicationsFolder();
    } catch {
      return false;
    }
  })();

  if (!runningFromVolume && inApplications) return true;

  dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
    title: 'Clowder AI',
    message: 'Clowder AI must be installed before it can open',
    detail:
      'Running directly from the install disk image is not supported. Drag Clowder AI.app to the Applications folder, then open it from Applications.',
  });

  app.quit();
  setImmediate(() => process.exit(0));
  return false;
}

module.exports = { ensureValidMacInstallLocation };
