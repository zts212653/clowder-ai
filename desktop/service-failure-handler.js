// Native feedback remains available when the Web or API process has already died.
function createServiceFailureHandler({ dialog, getState, requestQuit, dbg }) {
  return ({ name, code, signal }) => {
    if (getState().isQuitting) return;
    dbg(`Desktop service exited unexpectedly: ${name} code=${code} signal=${signal}`);
    void dialog
      .showMessageBox({
        type: 'error',
        title: 'Clowder AI',
        message: '后台服务已停止',
        detail: `${name} 服务意外退出，当前窗口可能无法继续操作。请完全退出 Clowder AI 后重新打开。关闭窗口可能仅隐藏到托盘。应用不会自动重启服务或改用内存存储。`,
        buttons: ['退出应用', '稍后处理'],
        defaultId: 1,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0 && !getState().isQuitting) return requestQuit('service-failure');
      })
      .catch((error) => dbg(`Could not show service failure or quit: ${error.message}`));
  };
}

module.exports = { createServiceFailureHandler };
