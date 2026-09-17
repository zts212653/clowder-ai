export function startGateResourceHealthMonitor({ checkHealthy, onBridgeLost, pollMs }) {
  let bridgeLost = false;
  let stopped = false;
  let activeCheck = null;

  async function runHealthCheck() {
    let error;
    let healthy = false;
    try {
      healthy = await checkHealthy();
    } catch (caught) {
      error = caught;
    }
    if (healthy) return;
    bridgeLost = true;
    onBridgeLost(error);
  }

  function trackHealthCheck() {
    if (stopped || bridgeLost || activeCheck) return;
    const check = runHealthCheck();
    activeCheck = check;
    check.then(
      () => {
        activeCheck = null;
      },
      () => {
        activeCheck = null;
      },
    );
  }

  const timer = setInterval(trackHealthCheck, pollMs);
  timer.unref();

  return {
    get bridgeLost() {
      return bridgeLost;
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      if (activeCheck) await Promise.allSettled([activeCheck]);
    },
  };
}
