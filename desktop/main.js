const { app, BrowserWindow, Menu, dialog, ipcMain, net, session, shell, Notification } = require('electron');
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
const { decideWindowClose } = require('./window-close-policy');
const { createLifecycleLogger } = require('./lifecycle-diagnostics');
const appLifecycle = require('./app-lifecycle');
const {
  createNativeDesktopTrayResult,
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
const userDataRoot = ServiceManager.USER_DATA_DIR;
const dbg = createDesktopLogger(userDataRoot);
const lifecycle = createLifecycleLogger(dbg);
const startupLogDir = path.join(userDataRoot, 'data', 'logs');
const reportStartup = createStartupReporter(startupLogDir);
const startupTimeline = createStartupTimeline({ component: 'desktop', emit: dbg });
startupTimeline.mark('main-initialized');
dbg(`Electron starting. ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE}`);
dbg(`process.type=${process.type}, versions.electron=${process.versions.electron}`);
appLifecycle.logRuntimeIdentity({ dbg, app, projectRoot: PROJECT_ROOT });

let mainWindow = null;
let splashWindow = null;
let tray = null;
let services = null;
let updater = null;
let updatePrompt = null;
let isQuitting = false;
let quitSource = null;
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
  appLifecycle.installRendererProcessDiagnostics({
    webContents: mainWindow.webContents,
    lifecycle,
    onUnavailable: () => updatePrompt?.markRendererUnavailable(),
  });
  mainWindow.webContents.once('dom-ready', () => startupTimeline.mark('renderer-dom-ready'));
  mainWindow.webContents.once('did-finish-load', () => startupTimeline.mark('renderer-did-finish-load'));

  mainWindow.on('close', (e) => {
    const decision = decideWindowClose({
      platform: process.platform,
      isQuitting,
      trayAvailable: Boolean(tray),
    });
    lifecycle('window-close-requested', { ...decision, trayAvailable: Boolean(tray), isQuitting });
    if (decision.action !== 'allow') {
      e.preventDefault();
      if (decision.action === 'hide') {
        mainWindow.hide();
        lifecycle('window-close-hidden', { reason: decision.reason });
      } else {
        lifecycle('window-close-kept-visible', { reason: decision.reason });
      }
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
function requestQuit(source = 'unknown') {
  quitSource = source;
  lifecycle('quit-requested', { source });
  return shutdown.quitApp();
}

const quitApp = () => requestQuit('startup-failure');

const getLifecycleState = () => ({ isQuitting, quitSource, trayAvailable: Boolean(tray), startupPhase });
appLifecycle.installAppLifecycleDiagnostics({ app, lifecycle, requestQuit, shutdown, getState: getLifecycleState });

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
  showFailure: (message, error) => showStartupFailure({ app, dialog, shell, message, error, userDataRoot }),
  quitApp,
});

const windowRecovery = createWindowRecoveryController({
  getState: () => ({ phase: startupPhase, mainWindow, splashWindow, services, isQuitting }),
  createMainWindow,
  quitArg: QUIT_FOR_UPDATE_ARG,
  isShutdownRequest: isInstallationShutdownRequest,
  projectRoot: PROJECT_ROOT,
  getUserDataRoot: () => app.getPath('userData'),
  quitApp: () => requestQuit('window-recovery'),
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
  const gotTheLock = app.requestSingleInstanceLock(installationIdentity(PROJECT_ROOT, app.getPath('userData')));
  if (!gotTheLock) {
    await requestQuit('single-instance-lock');
    return;
  }
  lifecycle('single-instance-lock-acquired', { userDataRoot: app.getPath('userData') });
  if (process.argv.includes(QUIT_FOR_UPDATE_ARG)) {
    await requestQuit('installer');
    return;
  }

  createSplashWindow();
  lifecycle('splash-created');
  startupPhase = 'starting';
  initializeDesktopInstance(session, desktopRuntime, PROJECT_ROOT);
  lifecycle('desktop-instance-initialized', { isolated: Boolean(desktopRuntime.instanceRoot) });
  const showAbout = () => showAboutDialog({ app, dialog, onManualUpdate: checkForUpdatesManually });
  lifecycle('tray-create-requested');
  const trayResult = createNativeDesktopTrayResult({
    electron: require('electron'),
    getMainWindow: () => mainWindow,
    onManualUpdate: checkForUpdatesManually,
    onQuit: () => requestQuit('tray'),
    showAbout,
  });
  if (trayResult.status === 'created') {
    tray = trayResult.tray;
    appLifecycle.logTrayCreated({ lifecycle, tray, app, iconPath: trayResult.iconPath });
  } else {
    lifecycle('tray-create-failed', trayResult.error);
    void dialog
      .showMessageBox({
        type: 'warning',
        buttons: ['OK'],
        title: 'Clowder AI',
        message: '系统托盘不可用',
        detail: '关闭窗口时将保持窗口打开。请查看桌面日志以诊断托盘创建失败原因。',
      })
      .catch((error) => lifecycle('tray-failure-notice-failed', { message: safeErrorMessage(error) }));
  }
  installMacApplicationMenu({ app, Menu, onManualUpdate: checkForUpdatesManually, showAbout });

  services = new ServiceManager(PROJECT_ROOT, {
    frontendPort: FRONTEND_PORT,
    apiPort: API_PORT,
    redisPort: desktopRuntime.redisPort,
    onStatus: sendSplashStatus,
    pluginNetworkFetch: net.fetch.bind(net),
  });
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
    quitApp: () => requestQuit('update'),
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
        pluginNetworkFetch: net.fetch.bind(net),
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
