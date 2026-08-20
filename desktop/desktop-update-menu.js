// Desktop tray and application-menu wiring for updater entry points.

function presentWindow(window) {
  if (!window || window.isDestroyed?.()) return;
  if (window.isMinimized?.()) window.restore();
  window.show();
  window.focus?.();
}

function createManualUpdateHandler({ getUpdatePrompt, getUpdater }) {
  return () => {
    if (getUpdatePrompt()?.presentPending()) return 'presented';
    void getUpdater()?.checkForUpdates({ manual: true });
    return 'started';
  };
}

function showAboutDialog({ app, dialog, onManualUpdate }) {
  const version = app.getVersion();
  void dialog
    .showMessageBox({
      type: 'info',
      buttons: ['Check for Updates', 'OK'],
      defaultId: 1,
      cancelId: 1,
      title: 'About Clowder AI',
      message: `Clowder AI v${version}`,
      detail: [
        'Multi-Agent Collaboration Platform',
        '',
        `Version: ${version}`,
        `Electron: ${process.versions.electron}`,
        `Node: ${process.versions.node}`,
        '',
        'License: AGPL-3.0',
        'https://github.com/zts212653/clowder-ai',
      ].join('\n'),
    })
    .then((result) => {
      if (result.response === 0) onManualUpdate();
    });
}

function createDesktopTray({ Menu, Tray, iconPath, getMainWindow, onManualUpdate, onQuit, showAbout }) {
  let tray;
  try {
    tray = new Tray(iconPath);
  } catch {
    return null;
  }
  tray.setToolTip('Clowder AI');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Clowder AI', click: () => presentWindow(getMainWindow()) },
      { type: 'separator' },
      { label: 'About', click: showAbout },
      { label: 'Check for Updates', click: onManualUpdate },
      { type: 'separator' },
      { label: 'Quit', click: onQuit },
    ]),
  );
  tray.on('double-click', () => presentWindow(getMainWindow()));
  return tray;
}

function installMacApplicationMenu({ app, Menu, onManualUpdate, showAbout }) {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { label: 'About Clowder AI', click: showAbout },
          { label: 'Check for Updates…', click: onManualUpdate },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ]),
  );
}

module.exports = {
  createDesktopTray,
  createManualUpdateHandler,
  installMacApplicationMenu,
  showAboutDialog,
};
