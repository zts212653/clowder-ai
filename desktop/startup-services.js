/** Observe both independent startup tasks; cancel waiters before surfacing a failure. */
async function prepareStartupServices({ api, web, controller }) {
  const tasks = [api, web].map((start) =>
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return start(controller.signal);
    }),
  );
  try {
    await Promise.all(tasks);
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(tasks);
    throw error;
  }
}

/** Keep ownership until the failed child is confirmed exited, before replacing it. */
async function stopOwnedStartupProcess(proc, kill, timeoutMs = 5000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  let timer;
  let onExit;
  const exited = new Promise((resolve, reject) => {
    onExit = resolve;
    proc.once('exit', onExit);
    timer = setTimeout(() => reject(new Error('Failed API process did not exit before retry')), timeoutMs);
  });
  try {
    await Promise.all([Promise.resolve().then(kill), exited]);
  } finally {
    clearTimeout(timer);
    proc.removeListener('exit', onExit);
  }
}
module.exports = { prepareStartupServices, stopOwnedStartupProcess };
