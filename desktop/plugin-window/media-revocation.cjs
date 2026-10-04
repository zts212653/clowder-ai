/** Wait for destruction of the old surface document, which may own screen tracks. */
function reloadForMediaRevocation(win) {
  if (win.isDestroyed()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const contents = win.webContents;
    let timer;
    const clear = () => {
      clearTimeout(timer);
      contents.removeListener('dom-ready', finished);
      contents.removeListener('render-process-gone', finished);
      win.removeListener('closed', finished);
    };
    const finished = () => {
      clear();
      resolve();
    };
    contents.once('dom-ready', finished);
    contents.once('render-process-gone', finished);
    win.once('closed', finished);
    timer = setTimeout(() => {
      clear();
      reject(new Error('Surface media revocation unconfirmed'));
    }, 2000);
    try {
      contents.reload();
    } catch (error) {
      clear();
      reject(error);
    }
  });
}
function createMediaRevocation(win) {
  let current = Promise.resolve();
  let unconfirmed = false;
  const reload = () => {
    const attempt = reloadForMediaRevocation(win);
    current = attempt;
    unconfirmed = false;
    void attempt.catch(() => {
      // A retired reload cannot invalidate a newer revocation attempt.
      if (current === attempt) unconfirmed = true;
    });
  };
  return {
    reload,
    wait() {
      // The failed caller remains rejected; a later operation needs fresh proof.
      if (unconfirmed) reload();
      return current;
    },
  };
}
module.exports = { createMediaRevocation, reloadForMediaRevocation };
