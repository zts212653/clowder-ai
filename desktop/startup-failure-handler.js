const { safeErrorMessage } = require('./update-network-diagnostics');

/** Share the visible startup failure path between first launch and window recovery. */
function createStartupFailureHandler({
  isQuitting,
  setPhase,
  dbg,
  reportStartup,
  sendSplashStatus,
  stopServices,
  showFailure,
  quitApp,
}) {
  let handling = null;
  const logUnfinished = (stage, error) =>
    dbg(`Desktop startup failure: could not ${stage}: ${safeErrorMessage(error)}`);

  return (error) => {
    if (isQuitting()) return Promise.resolve();
    if (!handling) {
      const message = safeErrorMessage(error);
      setPhase('failed');
      dbg(`Desktop startup FAILED: ${message}`);
      reportStartup('failed', message);
      sendSplashStatus('Startup failed: 请查看启动错误与日志');
      // One failure owns the shutdown: later failures share the same promise, so
      // services are stopped once and the returned promise is never orphaned.
      handling = (async () => {
        try {
          await stopServices();
        } catch (stopError) {
          logUnfinished('stop services', stopError);
        }
        try {
          await showFailure(message);
        } catch (showError) {
          logUnfinished('show the failure dialog', showError);
        }
        try {
          await quitApp();
        } catch (quitError) {
          logUnfinished('quit', quitError);
        }
      })();
    }
    return handling;
  };
}

module.exports = { createStartupFailureHandler };
