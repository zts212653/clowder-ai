const fs = require('node:fs');

function serializeProcessError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'UnknownError', message: String(error) };
}

function logRuntimeIdentity({ dbg, app, projectRoot }) {
  dbg(
    `[identity] ${JSON.stringify({
      version: app.getVersion(),
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      projectRoot,
    })}`,
  );
}

function logTrayCreated({ lifecycle, tray, app, iconPath }) {
  lifecycle('tray-created', {
    iconPath,
    iconExists: fs.existsSync(iconPath),
    trayDestroyed: Boolean(tray.isDestroyed?.()),
    appVersion: app.getVersion(),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
  });
}

function installRendererProcessDiagnostics({ webContents, lifecycle, onUnavailable }) {
  webContents.on('render-process-gone', (_event, details) => {
    lifecycle('renderer-process-gone', details);
    onUnavailable();
  });
}

function createAppLifecycleHandlers({ lifecycle, requestQuit, shutdown, getState, platform = process.platform }) {
  const state = () => getState();
  return {
    windowAllClosed() {
      lifecycle('window-all-closed', { platform, ...state() });
      if (platform !== 'win32') requestQuit('window-all-closed');
    },
    beforeQuit(event) {
      lifecycle('before-quit', state());
      shutdown.handleBeforeQuit(event);
    },
    willQuit() {
      lifecycle('will-quit', state());
    },
    quit(_event, exitCode) {
      lifecycle('app-quit', { ...state(), exitCode });
    },
    uncaughtExceptionMonitor(error) {
      lifecycle('process-uncaught-exception', serializeProcessError(error));
    },
    unhandledRejection(reason) {
      lifecycle('process-unhandled-rejection', serializeProcessError(reason));
    },
    processExit(exitCode) {
      lifecycle('process-exit', { ...state(), exitCode });
    },
  };
}

function installAppLifecycleDiagnostics({ app, lifecycle, requestQuit, shutdown, getState }) {
  const handlers = createAppLifecycleHandlers({ lifecycle, requestQuit, shutdown, getState });
  app.on('window-all-closed', handlers.windowAllClosed);
  app.on('before-quit', handlers.beforeQuit);
  app.on('will-quit', handlers.willQuit);
  app.on('quit', handlers.quit);
  process.on('uncaughtExceptionMonitor', handlers.uncaughtExceptionMonitor);
  process.on('unhandledRejection', handlers.unhandledRejection);
  process.on('exit', handlers.processExit);
  return handlers;
}

module.exports = {
  createAppLifecycleHandlers,
  installAppLifecycleDiagnostics,
  installRendererProcessDiagnostics,
  logRuntimeIdentity,
  logTrayCreated,
  serializeProcessError,
};
