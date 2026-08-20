// Clowder AI Desktop — Electron main process
// Launches backend services (Redis, API, Web) then shows the web UI.

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, net, session, shell, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { resolveProjectRootFromDir } = require('./project-root');
const ServiceManager = require('./service-manager');
const {
  createRendererLinkOrigins,
  createVersionedRendererUrl,
  isAllowedRendererLink,
  isAllowedRendererDownload,
  resolveRendererLinkOrigins,
} = require('./renderer-link-policy');
const { isExpectedOrigin } = require('./update-prompt-controller');
const { safeErrorMessage, safeHost } = require('./update-network-diagnostics');
const { DESKTOP_APP_ID } = require('./app-identity');
const { createDesktopUpdateRuntime } = require('./desktop-update-runtime');
const { ensureValidMacInstallLocation } = require('./mac-install-location');
const {
  createDesktopTray,
  createManualUpdateHandler,
  installMacApplicationMenu,
  showAboutDialog,
} = require('./desktop-update-menu');

if (process.platform === 'win32') {
  app.setAppUserModelId(DESKTOP_APP_ID);
}

const PROJECT_ROOT = resolveProjectRootFromDir(__dirname);
const FRONTEND_PORT = 3003;
const API_PORT = 3004;
const APP_URL = `http://localhost:${FRONTEND_PORT}`;
const APP_ORIGIN = new URL(APP_URL).origin;
const API_ORIGIN = new URL(`http://localhost:${API_PORT}`).origin;
function createBaseRendererLinkOrigins() {
  return createRendererLinkOrigins({
    appOrigin: APP_ORIGIN,
    apiOrigin: API_ORIGIN,
    previewGatewayPort: Number.NaN,
  });
}
let rendererLinkOrigins = createBaseRendererLinkOrigins();
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
let updatePrompt = null;
let isQuitting = false;
let quitPromise = null;
const checkForUpdatesManually = createManualUpdateHandler({
  getUpdatePrompt: () => updatePrompt,
  getUpdater: () => updater,
});

async function refreshRendererLinkOrigins() {
  try {
    rendererLinkOrigins = await resolveRendererLinkOrigins({
      appOrigin: APP_ORIGIN,
      apiOrigin: API_ORIGIN,
      loadPreviewGatewayStatus: async () => {
        const response = await net.fetch(`${API_ORIGIN}/api/preview/status`, {
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      },
    });
  } catch (error) {
    rendererLinkOrigins = createBaseRendererLinkOrigins();
    dbg(`Could not resolve preview gateway origin: ${safeErrorMessage(error)}`);
  }
}

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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenu(null);
  const guardAppNavigation = (event) => {
    if (event.isMainFrame === false) return;
    if (isExpectedOrigin(event.url, APP_ORIGIN)) return;
    event.preventDefault();
    dbg(`Blocked renderer navigation outside app origin: ${safeHost(event.url)}`);
  };
  mainWindow.webContents.on('will-navigate', (event) => {
    if (event.isMainFrame !== false && isAllowedRendererDownload(event.url, API_ORIGIN)) {
      event.preventDefault();
      mainWindow.webContents.downloadURL(event.url);
      dbg(`Started trusted renderer download: ${safeHost(event.url)}`);
      return;
    }
    guardAppNavigation(event);
  });
  mainWindow.webContents.on('will-redirect', guardAppNavigation);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (!isAllowedRendererLink(parsed.href, rendererLinkOrigins)) {
        dbg(`Blocked non-HTTPS renderer link: ${parsed.protocol}`);
        return { action: 'deny' };
      }
      void shell.openExternal(url).catch((error) => dbg(`Could not open renderer link: ${safeErrorMessage(error)}`));
    } catch {
      dbg('Blocked malformed renderer link');
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-navigate', () => updatePrompt?.markRendererUnavailable());
  mainWindow.webContents.on('render-process-gone', () => updatePrompt?.markRendererUnavailable());
  mainWindow.loadURL(createVersionedRendererUrl(APP_URL, app.getVersion()));

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

async function quitApp() {
  if (!quitPromise) {
    isQuitting = true;
    updater?.stopSchedule();
    updatePrompt?.dispose();
    updatePrompt = null;
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

  if (!ensureValidMacInstallLocation({ app, dialog })) {
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
  const showAbout = () => showAboutDialog({ app, dialog, onManualUpdate: checkForUpdatesManually });
  tray = createDesktopTray({
    Menu,
    Tray,
    iconPath: path.join(__dirname, 'assets', 'icon.ico'),
    getMainWindow: () => mainWindow,
    onManualUpdate: checkForUpdatesManually,
    onQuit: () => quitApp(),
    showAbout,
  });
  installMacApplicationMenu({ app, Menu, onManualUpdate: checkForUpdatesManually, showAbout });

  services = new ServiceManager(PROJECT_ROOT, {
    frontendPort: FRONTEND_PORT,
    apiPort: API_PORT,
    onStatus: sendSplashStatus,
  });
  // F273: Initialize updater — check pending upgrade result BEFORE services
  // (spec §3.2: "main.js 早期、服务启动前检测")
  ({ updater, updatePrompt } = createDesktopUpdateRuntime({
    app,
    net,
    netSession: session.defaultSession,
    ipcMain,
    shell,
    dialog,
    Notification,
    getMainWindow: () => mainWindow,
    getTray: () => tray,
    trustedOrigin: APP_ORIGIN,
    quitApp,
    stopServices: async () => {
      const activeServices = services;
      services = null;
      rendererLinkOrigins = createBaseRendererLinkOrigins();
      if (activeServices) await activeServices.stopAll();
    },
    startServices: async () => {
      services = new ServiceManager(PROJECT_ROOT, { frontendPort: FRONTEND_PORT, apiPort: API_PORT });
      await services.startAll();
      await refreshRendererLinkOrigins();
    },
    dbg,
    userDataRoot,
    platform: process.platform,
    arch: process.arch,
  }));
  const upgradeResult = await updater.checkPendingUpgrade();
  if (upgradeResult === 'quitting') return; // P1-2: installer launched — skip startAll

  try {
    dbg('startAll() called');
    await services.startAll();
    await refreshRendererLinkOrigins();
    dbg('startAll() done — creating main window');
    createMainWindow();
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
  updatePrompt?.dispose();
  updatePrompt = null;
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
