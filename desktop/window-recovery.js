/**
 * Decide how a second launch should recover the visible desktop surface.
 * This pure decision keeps startup/splash/ready behavior testable without
 * importing Electron. It never starts a second service owner.
 */
function resolveWindowRecoveryAction({ phase, hasMainWindow, hasSplashWindow, isQuitting }) {
  if (isQuitting || phase === 'quitting') return 'ignore';
  if (hasMainWindow) return 'focus-main';
  if (phase !== 'ready') return hasSplashWindow ? 'show-splash' : 'ignore';
  return 'recreate-main';
}

function createWindowRecoveryController({
  getState,
  createMainWindow,
  quitArg,
  isShutdownRequest,
  projectRoot,
  getUserDataRoot,
  quitApp,
  dbg,
  onRecoveryError,
}) {
  let mainWindowCreation = null;
  const focusWindow = (window) => {
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  };
  const recreateMainWindowIfReady = async () => {
    const state = getState();
    if (state.isQuitting || state.phase !== 'ready' || !state.services) return;
    if (focusWindow(state.mainWindow)) return;
    if (!mainWindowCreation)
      mainWindowCreation = createMainWindow().finally(() => {
        mainWindowCreation = null;
      });
    try {
      await mainWindowCreation;
    } catch (error) {
      onRecoveryError?.(error);
    }
  };
  const handleSecondInstance = (commandLine, identity) => {
    if (commandLine.includes(quitArg)) {
      if (!isShutdownRequest(identity, projectRoot, getUserDataRoot())) return;
      dbg('Installer requested coordinated shutdown');
      void quitApp();
      return;
    }
    const state = getState();
    const action = resolveWindowRecoveryAction({
      phase: state.phase,
      hasMainWindow: Boolean(state.mainWindow && !state.mainWindow.isDestroyed()),
      hasSplashWindow: Boolean(state.splashWindow && !state.splashWindow.isDestroyed()),
      isQuitting: state.isQuitting,
    });
    dbg(`Second instance recovery action: ${action}`);
    if (action === 'focus-main') focusWindow(state.mainWindow);
    else if (action === 'show-splash') focusWindow(state.splashWindow);
    else if (action === 'recreate-main') void recreateMainWindowIfReady();
  };
  return { handleSecondInstance };
}

module.exports = { resolveWindowRecoveryAction, createWindowRecoveryController };
