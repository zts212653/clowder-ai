// Clowder AI Desktop — Electron main process
// Launches backend services (Redis, API, Web) then shows the web UI.

const { app, BrowserWindow, Menu, Tray, dialog, net, shell, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { resolveProjectRootFromDir } = require('./project-root');
const ServiceManager = require('./service-manager');
const UpdateManager = require('./update-manager');

// macOS install-location guard.
//
// When the user double-clicks Clowder AI.app from the mounted DMG without
// dragging it to /Applications first, every backend subprocess (Redis, API,
// Web) ends up with a cwd / loaded-module path under /Volumes/Clowder AI/...,
// which holds the DMG volume open. The user then cannot eject the DMG until
// the app is fully quit (and even then, lingering file handles or zombie
// processes can keep it locked).
//
// We refuse to launch from a read-only mounted volume. Users must drag the
// app into /Applications and launch that installed copy; launching directly
// from the DMG only shows installation instructions and exits before services
// start.
//
// This guard MUST run after app ready because Electron's dialog module is not
// available earlier. It also MUST run before the single-instance lock below:
// if another instance is already running from /Applications, the lock would
// otherwise cause this instance to exit before the guard fires — letting users
// "run" directly from the DMG without any warning, then wondering why the
// volume won't eject.
function ensureValidMacInstallLocation() {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return true;
  }

  const appPath = app.getAppPath();
  const runningFromVolume = appPath.startsWith('/Volumes/');
  const inApplications = (() => {
    try {
      return app.isInApplicationsFolder();
    } catch {
      return false;
    }
  })();

  if (!runningFromVolume && inApplications) {
    return true;
  }

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

const PROJECT_ROOT = resolveProjectRootFromDir(__dirname);
const FRONTEND_PORT = 3003;
const API_PORT = 3004;
const APP_URL = `http://localhost:${FRONTEND_PORT}`;
const QUIT_FOR_UPDATE_ARG = '--quit-for-update';
// Main process log in the user data directory alongside API + desktop logs.
// Single source of truth: service-manager.js resolveUserDataDir() reads
// electron-builder productName and handles legacy data directory migration.
const userDataRoot = ServiceManager.USER_DATA_DIR;
const mainLogDir = path.join(userDataRoot, 'data', 'logs');
try {
  fs.mkdirSync(mainLogDir, { recursive: true });
} catch {}
const DEBUG_LOG = path.join(mainLogDir, 'main.log');

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
let updater = null;
let isQuitting = false;
let quitPromise = null;

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
    // Hide to tray on manual close — but let the window close when the
    // app is quitting (Cmd+Q / OS quit / tray "Quit"). Without the
    // isQuitting guard, the close handler blocks app.quit() because
    // tray still exists → zombie Electron shell with dead services.
    if (tray && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showAboutDialog() {
  const version = app.getVersion();
  dialog
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
      if (result.response === 0) updater?.checkForUpdates({ manual: true });
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
    { label: 'Show Clowder AI', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'About', click: () => showAboutDialog() },
    { label: 'Check for Updates', click: () => updater?.checkForUpdates({ manual: true }) },
    { type: 'separator' },
    { label: 'Quit', click: () => quitApp() },
  ]);
  tray.setToolTip('Clowder AI');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow?.show());
}

async function quitApp() {
  if (!quitPromise) {
    isQuitting = true;
    updater?.stopSchedule();
    quitPromise = (async () => {
      if (services) {
        const activeServices = services;
        services = null;
        await activeServices.stopAll();
      }
      if (tray) {
        tray.destroy();
        tray = null;
      }
      app.quit();
    })();
  }
  return quitPromise;
}

function sendSplashStatus(msg) {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('splash-status', msg);
}

app.on('second-instance', (_event, commandLine) => {
  if (commandLine.includes(QUIT_FOR_UPDATE_ARG)) {
    dbg('Installer requested coordinated shutdown');
    void quitApp();
    return;
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('ready', async () => {
  dbg('app ready event fired');

  if (!ensureValidMacInstallLocation()) {
    return;
  }

  // Single instance lock — prevent multiple Clowder AI processes.
  // This runs AFTER the install-location guard so that launching from a DMG
  // always shows the warning dialog, even if another instance is already
  // running from /Applications.
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return;
  }
  if (process.argv.includes(QUIT_FOR_UPDATE_ARG)) {
    await quitApp();
    return;
  }

  createSplashWindow();
  createTray();

  // macOS: set application menu with About entry (standard mac UX)
  if (process.platform === 'darwin') {
    const appMenu = Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { label: 'About Clowder AI', click: () => showAboutDialog() },
          { label: 'Check for Updates…', click: () => updater?.checkForUpdates({ manual: true }) },
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
    ]);
    Menu.setApplicationMenu(appMenu);
  }

  services = new ServiceManager(PROJECT_ROOT, {
    frontendPort: FRONTEND_PORT,
    apiPort: API_PORT,
    onStatus: sendSplashStatus,
  });

  // F273: Initialize updater — check pending upgrade result BEFORE services
  // (spec §3.2: "main.js 早期、服务启动前检测")
  updater = new UpdateManager({
    app,
    net,
    showDialog: (opts) => dialog.showMessageBox(opts).then((r) => r.response),
    showNotification: (title, body) => {
      try {
        new Notification({ title, body }).show();
      } catch {}
    },
    setProgressBar: (p) => {
      try {
        mainWindow?.setProgressBar(p);
      } catch {}
      try {
        if (!tray) return;
        if (p >= 0 && p <= 1) tray.setToolTip(`Clowder AI — Downloading update ${Math.round(p * 100)}%`);
        else tray.setToolTip('Clowder AI');
      } catch {}
    },
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p),
    quitApp,
    stopServices: async () => {
      if (services) {
        await services.stopAll();
        services = null;
      }
    },
    startServices: async () => {
      services = new ServiceManager(PROJECT_ROOT, { frontendPort: FRONTEND_PORT, apiPort: API_PORT });
      await services.startAll();
    },
    dbg,
    userDataRoot,
    platform: process.platform,
    arch: process.arch,
  });
  const upgradeResult = await updater.checkPendingUpgrade();
  if (upgradeResult === 'quitting') return; // P1-2: installer launched — skip startAll

  try {
    dbg('startAll() called');
    await services.startAll();
    dbg('startAll() done — creating main window');
    createMainWindow();
    // F273: Start update check after services are up
    updater.startSchedule();
  } catch (err) {
    dbg(`startAll() FAILED: ${err.message}`);
    dialog.showErrorBox(
      'Clowder AI - Startup Error',
      `Failed to start services:\n${err.message}\n\nCheck logs in .cat-cafe/logs/`,
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // keep running in tray on Windows
  if (process.platform !== 'win32') quitApp();
});
app.on('before-quit', (e) => {
  // Signal close handlers to stop hiding windows to tray.
  isQuitting = true;
  updater?.stopSchedule();
  // Electron does NOT await async event handlers. Without blocking here,
  // the app exits before stopAll() finishes → orphaned node/redis processes.
  // Prevent default, run cleanup, then quit when done.
  if (services) {
    e.preventDefault();
    services.stopAll().finally(() => {
      services = null; // prevent re-entry
      if (tray) {
        tray.destroy();
        tray = null;
      }
      app.quit();
    });
  }
});
