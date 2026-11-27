const PREPARE = 'desktop-interface-reload:prepare';

function prepareRenderer(contents, MessageChannelMain, timeoutMs) {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannelMain();
    const finish = (status) => {
      clearTimeout(timer);
      port1.close();
      resolve(status);
    };
    const timer = setTimeout(finish, timeoutMs);
    port1.once('message', ({ data }) => finish(data));
    port1.start();
    try {
      contents.postMessage(PREPARE, null, [port2]);
    } catch {
      port2.close();
      finish();
    }
  });
}

function reloadRenderer(contents, timeoutMs, retryUrl) {
  return new Promise((resolve) => {
    const finish = (loaded) => {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', loadedPage);
      contents.removeListener('did-fail-load', failedPage);
      contents.removeListener('render-process-gone', lostPage);
      contents.removeListener('destroyed', lostPage);
      resolve(loaded);
    };
    const loadedPage = () => finish(true);
    const lostPage = () => finish(false);
    const failedPage = (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) lostPage();
    };
    const timer = setTimeout(lostPage, timeoutMs);
    contents.once('did-finish-load', loadedPage);
    contents.on('did-fail-load', failedPage);
    contents.once('render-process-gone', lostPage);
    contents.once('destroyed', lostPage);
    try {
      if (retryUrl) void contents.loadURL(retryUrl).catch(lostPage);
      else contents.reloadIgnoringCache();
    } catch {
      lostPage();
    }
  });
}

function createInterfaceReloadHandler({ dialog, MessageChannelMain, prepareTimeoutMs = 5000, loadTimeoutMs = 30000 }) {
  const title = '重新加载界面';
  const blocked = {
    attachment: '还有未保存的附件。请回到对应会话处理附件，再重新加载。',
    draft: '草稿暂时无法保存。当前输入已保留，请稍后重试。',
    busy: '输入或发送尚未完成。请完成当前操作，再重新加载。',
  };
  let inProgress = false;
  const handle = async (window) => {
    if (inProgress) return;
    inProgress = true;
    try {
      if (!window || window.isDestroyed()) {
        await dialog.showMessageBox({ type: 'info', title, message: '当前没有可重新加载的 Clowder AI 窗口。' });
        return;
      }
      const contents = window.webContents;
      const url = contents.getURL();
      const status = await prepareRenderer(contents, MessageChannelMain, prepareTimeoutMs);
      if (window.isDestroyed()) return;
      if (typeof status === 'string' && Object.hasOwn(blocked, status)) {
        await dialog.showMessageBox(window, { type: 'info', title, message: blocked[status] });
        return;
      }
      if (status !== 'ready') {
        const { response } = await dialog.showMessageBox(window, {
          type: 'warning',
          title,
          message: '无法确认是否有未发送的文字或附件。重新加载可能丢失它们。',
          buttons: ['先不重载', '仍然重新加载'],
          defaultId: 0,
          cancelId: 0,
        });
        if (response !== 1 || window.isDestroyed()) return;
      }
      let loaded = await reloadRenderer(contents, loadTimeoutMs);
      while (!loaded && !window.isDestroyed()) {
        const { response } = await dialog.showMessageBox(window, {
          type: 'error',
          title,
          message: '界面重新加载失败。请稍后重试。',
          buttons: ['关闭', '重试'],
          defaultId: 1,
          cancelId: 0,
        });
        if (response !== 1 || window.isDestroyed()) return;
        loaded = await reloadRenderer(contents, loadTimeoutMs, url);
      }
    } finally {
      inProgress = false;
    }
  };
  return handle;
}

module.exports = { createInterfaceReloadHandler };
