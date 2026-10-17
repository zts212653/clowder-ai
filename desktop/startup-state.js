const fs = require('node:fs');
const path = require('node:path');

/** Written before UI prompts so supervisors can observe failure without inspecting native dialogs. */
function createStartupReporter(logDir) {
  const startedAt = Date.now();
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'startup-state.json');
  return (phase, message) => {
    const state = {
      version: 1,
      pid: process.pid,
      phase,
      startedAt,
      updatedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      ...(message ? { message } : {}),
    };
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, file);
    return state;
  };
}
async function showStartupFailure({ dialog, shell, message, logDir }) {
  const result = await dialog.showMessageBox({
    type: 'error',
    title: 'Clowder AI - Startup Error',
    message: '服务启动失败',
    detail: `${message}\n\n日志目录：${logDir}`,
    buttons: ['打开日志目录', '退出'],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) await shell.openPath(logDir);
}
module.exports = { createStartupReporter, showStartupFailure };
