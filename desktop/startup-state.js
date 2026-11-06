const fs = require('node:fs');
const path = require('node:path');
const { requestMemoryFallbackOnce } = require('./memory-fallback-consent');

/** Written before UI prompts so supervisors can observe failure without inspecting native dialogs. */
function createStartupReporter(logDir) {
  const startedAt = Date.now();
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'startup-state.json');
  return (phase, message, diagnostics) => {
    const state = {
      version: 1,
      pid: process.pid,
      phase,
      startedAt,
      updatedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      ...(message ? { message } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    };
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, file);
    return state;
  };
}
async function showStartupFailure({ app, dialog, shell, message, logDir, error, userDataRoot }) {
  const resolvedLogDir = logDir ?? path.join(userDataRoot, 'data', 'logs');
  // Memory storage is a degraded mode, so it is offered only when the failure
  // itself says consent is possible, and the choice applies to a single launch.
  const canUseMemory = Boolean(error?.recovery?.allowMemoryOnce && app && userDataRoot);
  const portConflict = Boolean(app && error?.code === 'DESKTOP_PORT_CONFLICT');
  const buttons = portConflict
    ? ['打开日志目录', '已关闭占用方，重启桌面版', '退出桌面版，保留原服务']
    : canUseMemory
      ? ['打开日志目录', '仅本次使用内存存储并重启', '退出']
      : ['打开日志目录', '退出'];
  const detail = [
    message,
    ...(portConflict ? ['如需启动本次桌面版，请先确认占用方并正常退出，再重启桌面版。'] : []),
    `日志目录：${resolvedLogDir}`,
    ...(canUseMemory ? ['临时内存存储只对本次启动生效：重启后历史与队列不会保留。'] : []),
  ].join('\n\n');
  const result = await dialog.showMessageBox({
    type: 'error',
    title: 'Clowder AI - Startup Error',
    message: '服务启动失败',
    detail,
    buttons,
    defaultId: portConflict ? buttons.length - 1 : 0,
    cancelId: buttons.length - 1,
  });
  if (result.response === 0) {
    await shell.openPath(resolvedLogDir);
    return 'quit';
  }
  if ((canUseMemory || portConflict) && result.response === 1) {
    if (canUseMemory) requestMemoryFallbackOnce(userDataRoot);
    app.relaunch();
    app.exit(0);
    return 'relaunch';
  }
  return 'quit';
}
module.exports = { createStartupReporter, showStartupFailure };
