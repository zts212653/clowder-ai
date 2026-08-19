// Owns the Electron dependency wiring between UpdateManager and its renderer controller.

const UpdateManager = require('./update-manager');
const { UpdatePromptController } = require('./update-prompt-controller');
const { safeErrorMessage } = require('./update-network-diagnostics');

function createDesktopUpdateRuntime({
  app,
  net,
  netSession,
  ipcMain,
  shell,
  dialog,
  Notification,
  getMainWindow,
  getTray,
  dbg,
  trustedOrigin,
  userDataRoot,
  platform,
  arch,
  quitApp,
  stopServices,
  startServices,
}) {
  let updater;
  const updatePrompt = new UpdatePromptController({
    ipcMain,
    getMainWindow,
    openExternal: (url) => shell.openExternal(url),
    dbg,
    trustedOrigin,
    getUpdateSettings: () => updater.getSettings(),
    setUpdateAutoCheck: (enabled) => updater.setAutoCheck(enabled),
    onRendererReady: () => updater?.startSchedule(),
  });

  updater = new UpdateManager({
    app,
    net,
    netSession,
    showUpdatePrompt: (prompt, options) => updatePrompt.show(prompt, options),
    showDialog: (opts) => dialog.showMessageBox(opts).then((result) => result.response),
    showNotification: (title, body) => {
      try {
        new Notification({ title, body }).show();
      } catch {}
    },
    setProgressBar: (progress, context) => {
      try {
        getMainWindow()?.setProgressBar(progress);
      } catch {}
      try {
        const tray = getTray();
        if (tray) {
          if (progress >= 0 && progress <= 1) {
            tray.setToolTip(`Clowder AI — Downloading update ${Math.round(progress * 100)}%`);
          } else {
            tray.setToolTip('Clowder AI');
          }
        }
      } catch {}
      try {
        updatePrompt.setProgress(
          progress >= 0 && context
            ? {
                phase: 'downloading',
                version: context.version,
                assetName: context.assetName,
                progress,
              }
            : null,
        );
      } catch (error) {
        dbg(`Could not project update progress: ${safeErrorMessage(error)}`);
      }
    },
    openExternal: (url) => shell.openExternal(url),
    openPath: (targetPath) => shell.openPath(targetPath),
    quitApp,
    stopServices,
    startServices,
    dbg,
    userDataRoot,
    platform,
    arch,
  });

  return { updater, updatePrompt };
}

module.exports = { createDesktopUpdateRuntime };
