// Owns the single coordinated shutdown path shared by quitApp() and the
// Electron `before-quit` event. Electron does not await async event handlers,
// so `before-quit` blocks exit until services stop; quitApp() is idempotent and
// always reaches the same stop-order (schedule → services → tray → app.quit()).

const { safeErrorMessage } = require('./update-network-diagnostics');

function createShutdownController({
  app,
  startupController,
  getServices,
  setServices,
  getTray,
  setTray,
  getUpdater,
  getUpdatePrompt,
  setUpdatePrompt,
  setQuitting,
  setPhase,
  dbg,
}) {
  let quitPromise = null;
  let quitCompleted = false;

  function beginShutdown() {
    setQuitting(true);
    setPhase('quitting');
    startupController.abort(new Error('Desktop startup cancelled'));
    getUpdater()?.stopSchedule();
    getUpdatePrompt()?.dispose();
    setUpdatePrompt(null);
  }

  async function stopServices() {
    const activeServices = getServices();
    if (!activeServices) return;
    try {
      await activeServices.stopAll();
    } catch (error) {
      dbg(`Service shutdown failed: ${safeErrorMessage(error)}`);
    } finally {
      if (getServices() === activeServices) setServices(null);
    }
  }

  function destroyTray() {
    const activeTray = getTray();
    setTray(null);
    activeTray?.destroy();
  }

  function quitApp() {
    if (!quitPromise) {
      beginShutdown();
      quitPromise = (async () => {
        await stopServices();
        destroyTray();
        quitCompleted = true;
        app.quit();
      })();
    }
    return quitPromise;
  }

  function handleBeforeQuit(event) {
    beginShutdown();
    // No owned services means nothing to drain; let Electron exit normally.
    // Once the coordinated quit has finished, app.quit() is the terminal event.
    if (quitCompleted || (!getServices() && !quitPromise)) return quitPromise;
    // Block the quit, drain services, then re-issue quitApp's terminal app.quit().
    event.preventDefault();
    quitPromise =
      quitPromise ??
      (async () => {
        await stopServices();
        destroyTray();
        quitCompleted = true;
        app.quit();
      })();
    return quitPromise;
  }

  return { quitApp, handleBeforeQuit };
}

module.exports = { createShutdownController };
