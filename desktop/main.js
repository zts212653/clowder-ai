// Cat Cafe Desktop — Electron main process
// Launches backend services (Redis, API, Web) then shows the web UI.

const { app, BrowserWindow, Menu, Tray, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveProjectRootFromDir } = require('./project-root');
const ServiceManager = require('./service-manager');

// Single instance lock — prevent multiple Cat Cafe processes
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

const PROJECT_ROOT = resolveProjectRootFromDir(__dirname);
const FRONTEND_PORT = 3003;
const API_PORT = 3004;
const APP_URL = `http://localhost:${FRONTEND_PORT}`;
const DEBUG_LOG = path.join(process.env.TEMP || os.tmpdir(), 'cat-cafe-main.log');

function dbg(msg) {
  const line = `[main ${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG, line);
  } catch {}
}

dbg(`Electron starting. ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE}`);
dbg(`process.type=${process.type}, versions.electron=${process.versions.electron}`);

let mainWindow = null;
let splashWindow = null;
let tray = null;
let services = null;

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 320,
    frame: false,
    resizable: false,
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.center();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Clowder AI',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.loadURL(APP_URL);

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  try {
    tray = new Tray(iconPath);
  } catch {
    return; // icon missing — skip tray
  }
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Cat Cafe', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => quitApp() },
  ]);
  tray.setToolTip('Clowder AI');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow?.show());
}

async function quitApp() {
  if (services) {
    await services.stopAll();
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.quit();
}

function sendSplashStatus(msg) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-status', msg);
  }
}

app.on('second-instance', () => {
  // Another instance tried to launch — bring the existing window to front
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('ready', async () => {
  dbg('app ready event fired');
  createSplashWindow();
  createTray();

  services = new ServiceManager(PROJECT_ROOT, {
    frontendPort: FRONTEND_PORT,
    apiPort: API_PORT,
    onStatus: sendSplashStatus,
  });

  try {
    dbg('startAll() called');
    await services.startAll();
    dbg('startAll() done — creating main window');
    createMainWindow();
  } catch (err) {
    dbg(`startAll() FAILED: ${err.message}`);
    dialog.showErrorBox(
      'Cat Cafe - Startup Error',
      `Failed to start services:\n${err.message}\n\nCheck logs in .cat-cafe/logs/`,
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // keep running in tray on Windows
  if (process.platform !== 'win32') quitApp();
});

app.on('before-quit', async () => {
  if (services) await services.stopAll();
});
