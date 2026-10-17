// Clowder AI Desktop — Electron main process
// Launches backend services (Redis, API, Web) then shows the web UI.
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, net, session, shell, Notification } = require('electron');
const path = require('node:path');
const { resolveProjectRootFromDir } = require('./project-root');
const { installationIdentity, isInstallationShutdownRequest } = require('./installation-lifecycle');
const ServiceManager = require('./service-manager');
const { createStartupReporter, showStartupFailure } = require('./startup-state');
const { createStartupTimeline } = require('./startup-timing');
const { showVisibleRenderer } = require('./visible-renderer');
const { installRendererNavigation } = require('./renderer-navigation');
const {
  resolveDesktopRuntime,
  initializeDesktopInstance,
  createDesktopLogger,
  prepareDesktopInstance,
} = require('./runtime-config');
const {
  createRendererLinkOrigins,
  createVersionedRendererUrl,
  resolveRendererLinkOrigins,
} = require('./renderer-link-policy');
const { safeErrorMessage } = require('./update-network-diagnostics');
const { createStartupFailureHandler } = require('./startup-failure-handler');
const { createShutdownController } = require('./shutdown-controller');
const { DESKTOP_APP_ID } = require('./app-identity');
const { createDesktopUpdateRuntime } = require('./desktop-update-runtime');
const { ensureValidMacInstallLocation } = require('./mac-install-location');
const { createWindowRecoveryController } = require('./window-recovery');
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
const desktopRuntime = resolveDesktopRuntime();
const FRONTEND_PORT = desktopRuntime.frontendPort;
const API_PORT = desktopRuntime.apiPort;
prepareDesktopInstance(app, desktopRuntime);
const APP_URL = `http://localhost:${FRONTEND_PORT}`;
const APP_ORIGIN = new URL(APP_URL).origin;
const API_ORIGIN = new URL(`http://localhost:${API_PORT}`).origin;
const createBaseRendererLinkOrigins = () =>
  createRendererLinkOrigins({
    appOrigin: APP_ORIGIN,
    apiOrigin: API_ORIGIN,
    previewGatewayPort: Number.NaN,
  });
let rendererLinkOrigins = createBaseRendererLinkOrigins();
const QUIT_FOR_UPDATE_ARG = '--quit-owned-installation';
// Main process log in the user data directory alongside API + desktop logs.
// electron-builder productName and handles legacy data directory migration.
const userDataRoot = ServiceManager.USER_DATA_DIR;
const dbg = createDesktopLogger(userDataRoot);
const startupLogDir = path.join(userDataRoot, 'data', 'logs');
const reportStartup = createStartupReporter(startupLogDir);
const startupTimeline = createStartupTimeline({ component: 'desktop', emit: dbg });
startupTimeline.mark('main-initialized');

dbg(`Electron starting. ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE}`);
dbg(`process.type=${process.type}, versions.electron=${process.versions.electron}`);

let mainWindow = null;
let splashWindow = null;
let tray = null;
let services = null;
let updater = null;
let updatePrompt = null;
let isQuitting = false;
let startupPhase = 'booting';
const startupController = new AbortController();
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
      additionalArguments: [`--cat-cafe-api-origin=${API_ORIGIN}`],
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.center();
}

async function createMainWindow() {
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
      additionalArguments: [`--cat-cafe-api-origin=${API_ORIGIN}`, `--cat-cafe-app-origin=${APP_ORIGIN}`],
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenu(null);
  installRendererNavigation({
    window: mainWindow,
    appOrigin: APP_ORIGIN,
    apiOrigin: API_ORIGIN,
    getLinkOrigins: () => rendererLinkOrigins,
    shell,
    dbg,
  });
  mainWindow.webContents.on('did-navigate', () => updatePrompt?.markRendererUnavailable());
  mainWindow.webContents.on('render-process-gone', () => updatePrompt?.markRendererUnavailable());
  mainWindow.webContents.once('dom-ready', () => startupTimeline.mark('renderer-dom-ready'));
  mainWindow.webContents.once('did-finish-load', () => startupTimeline.mark('renderer-did-finish-load'));

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
  return startupTimeline.runPhase('renderer-visible', () =>
    showVisibleRenderer({
      window: mainWindow,
      url: createVersionedRendererUrl(APP_URL, app.getVersion()),
      signal: startupController.signal,
      onVisible: () => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        mainWindow.show();
      },
    }),
  );
}

const shutdown = createShutdownController({
  app,
  startupController,
  getServices: () => services,
  setServices: (value) => (services = value),
  getTray: () => tray,
  setTray: (value) => (tray = value),
  getUpdater: () => updater,
  getUpdatePrompt: () => updatePrompt,
  setUpdatePrompt: (value) => (updatePrompt = value),
  setQuitting: (value) => (isQuitting = value),
  setPhase: (phase) => (startupPhase = phase),
  dbg,
});
const quitApp = shutdown.quitApp;

function sendSplashStatus(msg) {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('splash-status', msg);
}

const handleStartupFailure = createStartupFailureHandler({
  isQuitting: () => isQuitting,
  setPhase: (phase) => (startupPhase = phase),
  dbg,
  reportStartup,
  sendSplashStatus,
  stopServices: async () => {
    const activeServices = services;
    services = null;
    if (activeServices) await activeServices.stopAll();
  },
  showFailure: (message) => showStartupFailure({ dialog, shell, message, logDir: startupLogDir }),
  quitApp,
});

const windowRecovery = createWindowRecoveryController({
  getState: () => ({ phase: startupPhase, mainWindow, splashWindow, services, isQuitting }),
  createMainWindow,
  quitArg: QUIT_FOR_UPDATE_ARG,
  isShutdownRequest: isInstallationShutdownRequest,
  projectRoot: PROJECT_ROOT,
  getUserDataRoot: () => app.getPath('userData'),
  quitApp: () => quitApp(),
  dbg,
  onRecoveryError: (error) => void handleStartupFailure(error),
});
app.on('second-instance', (_event, commandLine, _workingDirectory, identity) =>
  windowRecovery.handleSecondInstance(commandLine, identity),
);

app.on('ready', async () => {
  startupTimeline.mark('electron-ready');
  dbg('app ready event fired');

  if (!ensureValidMacInstallLocation({ app, dialog })) {
    return;
  }

  // Single instance lock — prevent multiple Clowder AI processes.
  // This runs AFTER the install-location guard so that launching from a DMG
  // always shows the warning dialog, even if another instance is already
  // running from /Applications.
  const gotTheLock = app.requestSingleInstanceLock(installationIdentity(PROJECT_ROOT, app.getPath('userData')));
  if (!gotTheLock) {
    app.quit();
    return;
  }
  if (process.argv.includes(QUIT_FOR_UPDATE_ARG)) {
    await quitApp();
    return;
  }

  createSplashWindow();
  startupPhase = 'starting';
  initializeDesktopInstance(session, desktopRuntime, PROJECT_ROOT);
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
    redisPort: desktopRuntime.redisPort,
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
      services = new ServiceManager(PROJECT_ROOT, {
        frontendPort: FRONTEND_PORT,
        apiPort: API_PORT,
        redisPort: desktopRuntime.redisPort,
      });
      await services.startAll();
      await refreshRendererLinkOrigins();
    },
    dbg,
    userDataRoot,
    platform: process.platform,
    arch: process.arch,
  }));
  const upgradeResult = await updater.checkPendingUpgrade();
  if (upgradeResult === 'quitting' || isQuitting) return; // Installer/quit must not start services later.

  try {
    dbg('startAll() called');
    reportStartup('starting');
    await services.startAll();
    startupTimeline.mark('services-ready');
    await startupTimeline.runPhase('preview-origin', () => refreshRendererLinkOrigins());
    startupController.signal.throwIfAborted();
    dbg('startAll() done — creating main window');
    await createMainWindow();
    startupController.signal.throwIfAborted();
    startupPhase = 'ready';
    reportStartup('ready');
  } catch (err) {
    await handleStartupFailure(err);
  }
});

app.on('window-all-closed', () => {
  // keep running in tray on Windows
  if (process.platform !== 'win32') quitApp();
});
app.on('before-quit', (event) => shutdown.handleBeforeQuit(event));
