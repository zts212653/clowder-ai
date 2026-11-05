// Isolated renderer acceptance only: no ServiceManager, tray, agents or existing profile.
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

app.setPath('userData', process.env.ISSUE1829_PROFILE);
ipcMain.handle('desktop-update:ready', () => undefined);
app.on('before-quit', () => {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.destroy();
  });
});
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, '../preload.js'),
      additionalArguments: [
        `--cat-cafe-api-origin=${process.env.ISSUE1829_API_ORIGIN}`,
        `--cat-cafe-app-origin=${process.env.ISSUE1829_APP_ORIGIN}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.setMenu(null);
  window.webContents.on('will-prevent-unload', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  // The driver installs error and performance observers before navigation.
  window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
