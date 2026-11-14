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
module.exports = {
  assertStartupProcess,
  occupiedDesktopPorts,
  prepareStartupServices,
  probeStartupResponse,
  stopOwnedStartupProcess,
};
const http = require('node:http');

function occupiedDesktopPorts(endpoints) {
  return Object.assign(
    new Error(`端口 ${endpoints} 上的服务无法确认属于本次启动，可能由另一套 Clowder AI 或其他程序占用。`),
    {
      code: 'DESKTOP_PORT_CONFLICT',
    },
  );
}

function assertStartupProcess(proc, label, port, logFile) {
  if (!proc?.pid) throw new Error(`${label} 进程启动失败（端口 ${port}）。请查看日志：${logFile}`);
  const exit = proc.exitCode ?? proc.signalCode;
  if (exit !== null || proc.killed)
    throw new Error(
      `${label} 进程已退出或停止（端口 ${port}，状态 ${exit ?? 'stopping'}）。请检查端口占用和日志：${logFile}`,
    );
}

function probeStartupResponse(host, port, path, startupId) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host,
        port,
        path,
        agent: false,
        headers: { 'Cache-Control': 'no-cache', 'x-clowder-desktop-probe': '1' },
      },
      (response) => {
        response.resume();
        if (!startupId || response.headers['x-clowder-desktop-startup-id'] !== startupId) {
          resolve('foreign');
        } else {
          resolve(response.statusCode >= 200 && response.statusCode < 400 ? 'ready' : 'unavailable');
        }
      },
    );
    request.setTimeout(1000, () => {
      request.destroy();
      resolve('unavailable');
    });
    request.once('error', () => resolve('unavailable'));
    request.once('close', () => resolve('unavailable'));
  });
}
