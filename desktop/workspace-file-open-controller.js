// Main-process owner for opening a validated Workspace HTML entry point in
// the user's default browser. The renderer never supplies an absolute path.

const WORKSPACE_OPEN_HTML_CHANNEL = 'desktop-workspace:open-html';

function isExpectedOrigin(url, expectedOrigin) {
  if (typeof url !== 'string' || typeof expectedOrigin !== 'string') return false;
  try {
    return new URL(url).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function isTrustedSender(event, window, trustedOrigin) {
  if (!window || window.isDestroyed?.() || window.webContents?.isDestroyed?.()) return false;
  if (!isExpectedOrigin(window.webContents?.mainFrame?.url, trustedOrigin)) return false;
  if (event?.sender !== window.webContents) return false;
  return Boolean(event.senderFrame && event.senderFrame === event.sender.mainFrame);
}

function isWorkspaceHtmlTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
  if (Object.keys(target).length !== 2) return false;
  if (typeof target.worktreeId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(target.worktreeId)) return false;
  if (typeof target.path !== 'string' || target.path.length === 0 || target.path.length > 4096) return false;
  if (target.path.includes('\\') || target.path.startsWith('/') || /^[a-z]:/i.test(target.path)) return false;
  const segments = target.path.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..') && /\.html?$/i.test(target.path);
}

function isAbsoluteHtmlPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768 || value.includes('\0')) return false;
  const isAbsolute = value.startsWith('/') || /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\');
  return isAbsolute && /\.html?$/i.test(value);
}

class WorkspaceFileOpenController {
  constructor({ ipcMain, getMainWindow, fetch, openPath, dbg, trustedOrigin, apiOrigin }) {
    this._ipcMain = ipcMain;
    this._getMainWindow = getMainWindow;
    this._fetch = fetch;
    this._openPath = openPath;
    this._dbg = dbg;
    this._trustedOrigin = trustedOrigin;
    this._apiOrigin = apiOrigin;
    this._onOpenHtml = this._handleOpenHtml.bind(this);
    ipcMain.handle(WORKSPACE_OPEN_HTML_CHANNEL, this._onOpenHtml);
  }

  async _handleOpenHtml(event, target) {
    if (!isTrustedSender(event, this._getMainWindow(), this._trustedOrigin)) {
      this._dbg('Rejected Workspace HTML open IPC: untrusted sender');
      throw new Error('Untrusted Workspace HTML sender');
    }
    if (!isWorkspaceHtmlTarget(target)) {
      this._dbg('Rejected Workspace HTML open IPC: invalid target');
      throw new TypeError('Invalid Workspace HTML target');
    }

    let response;
    try {
      response = await this._fetch(`${this._apiOrigin}/api/workspace/resolve-openable-file`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: {
          'content-type': 'application/json',
          'x-cat-cafe-user': 'default-user',
        },
        body: JSON.stringify(target),
      });
    } catch {
      this._dbg('Workspace HTML resolver request failed');
      throw new Error('Could not open Workspace HTML');
    }
    if (!response?.ok) {
      this._dbg(`Workspace HTML resolver rejected target: HTTP ${response?.status ?? 'unknown'}`);
      throw new Error('Could not open Workspace HTML');
    }

    let result;
    try {
      result = await response.json();
    } catch {
      this._dbg('Workspace HTML resolver returned malformed JSON');
      throw new Error('Could not open Workspace HTML');
    }
    if (!isAbsoluteHtmlPath(result?.absolutePath)) {
      this._dbg('Workspace HTML resolver returned an invalid path');
      throw new Error('Invalid Workspace HTML resolver response');
    }

    let openError;
    try {
      openError = await this._openPath(result.absolutePath);
    } catch {
      this._dbg('Workspace HTML open failed in the operating system');
      throw new Error('Could not open Workspace HTML');
    }
    if (openError) {
      this._dbg('Workspace HTML open was refused by the operating system');
      throw new Error('Could not open Workspace HTML');
    }
    return { ok: true };
  }

  dispose() {
    this._ipcMain.removeHandler(WORKSPACE_OPEN_HTML_CHANNEL);
  }
}

module.exports = {
  WorkspaceFileOpenController,
  WORKSPACE_OPEN_HTML_CHANNEL,
};
