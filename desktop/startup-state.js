const fs = require('node:fs');
const path = require('node:path');
const { requestMemoryFallbackOnce } = require('./memory-fallback-consent');

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
async function showStartupFailure({ app, dialog, shell, message, logDir, error, userDataRoot }) {
  const resolvedLogDir = logDir ?? path.join(userDataRoot, 'data', 'logs');
  // Memory storage is a degraded mode, so it is offered only when the failure
  // itself says consent is possible, and the choice applies to a single launch.
  const canUseMemory = Boolean(error?.recovery?.allowMemoryOnce && app && userDataRoot);
  const buttons = canUseMemory ? ['打开日志目录', '仅本次使用内存存储并重启', '退出'] : ['打开日志目录', '退出'];
  const detail = [
    message,
    `日志目录：${resolvedLogDir}`,
    ...(canUseMemory ? ['临时内存存储只对本次启动生效：重启后历史与队列不会保留。'] : []),
  ].join('\n\n');
  const result = await dialog.showMessageBox({
    type: 'error',
    title: 'Clowder AI - Startup Error',
    message: '服务启动失败',
    detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (result.response === 0) {
    await shell.openPath(resolvedLogDir);
    return 'quit';
  }
  if (canUseMemory && result.response === 1) {
    requestMemoryFallbackOnce(userDataRoot);
    app.relaunch();
    app.exit(0);
    return 'relaunch';
  }
  return 'quit';
}
module.exports = { createStartupReporter, showStartupFailure };
