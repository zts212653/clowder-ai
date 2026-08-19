// F273: main-process owner for one context-isolated update-prompt transaction.

const { safeErrorMessage } = require('./update-network-diagnostics');

const UPDATE_PROMPT_CHANNEL = 'desktop-update:prompt';
const UPDATE_PROMPT_READY_CHANNEL = 'desktop-update:ready';
const UPDATE_PROMPT_ACTION_CHANNEL = 'desktop-update:action';
const UPDATE_PROGRESS_CHANNEL = 'desktop-update:progress';
const UPDATE_SETTINGS_GET_CHANNEL = 'desktop-update:settings:get';
const UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL = 'desktop-update:settings:set-auto-check';
const PROMPT_ACTIONS = Object.freeze({
  available: new Set(['download', 'later', 'skip', 'open-release']),
  'up-to-date': new Set(['dismiss']),
  'check-failed': new Set(['dismiss', 'open-release']),
  'ready-to-install': new Set(['install', 'later']),
});
const PROMPT_PLATFORMS = new Set(['windows', 'macos']);
const RELEASES_PATH = '/zts212653/clowder-ai/releases';

function isExpectedOrigin(url, expectedOrigin) {
  if (typeof url !== 'string' || typeof expectedOrigin !== 'string') return false;
  try {
    return new URL(url).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function isTrustedReleaseUrl(url, expectedPath) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname === expectedPath
    );
  } catch {
    return false;
  }
}

function isTrustedWindow(window, trustedOrigin) {
  return (
    window &&
    !window.isDestroyed?.() &&
    !window.webContents?.isDestroyed?.() &&
    isExpectedOrigin(window.webContents?.mainFrame?.url, trustedOrigin)
  );
}

function isTrustedSender(event, window, trustedOrigin) {
  if (!isTrustedWindow(window, trustedOrigin)) return false;
  if (event?.sender !== window.webContents) return false;
  return Boolean(event.senderFrame && event.senderFrame === event.sender.mainFrame);
}

function hasVersion(payload) {
  return payload && typeof payload.version === 'string' && payload.version.length > 0;
}

function hasSelectedAsset(payload) {
  return (
    PROMPT_PLATFORMS.has(payload.platform) && typeof payload.assetName === 'string' && payload.assetName.length > 0
  );
}

function isPromptPayload(payload) {
  if (!hasVersion(payload) || !PROMPT_ACTIONS[payload.kind]) return false;
  if (payload.kind === 'up-to-date') return true;
  if (payload.kind === 'check-failed') return isTrustedReleaseUrl(payload.releaseUrl, RELEASES_PATH);
  if (!hasSelectedAsset(payload)) return false;
  if (payload.kind === 'ready-to-install') return true;
  return (
    typeof payload.currentVersion === 'string' &&
    payload.currentVersion.length > 0 &&
    isTrustedReleaseUrl(payload.releaseUrl, `${RELEASES_PATH}/tag/v${payload.version}`) &&
    typeof payload.releaseNotes === 'string' &&
    payload.releaseNotes.length <= 32_000
  );
}

function isProgressPayload(payload) {
  return (
    payload &&
    payload.phase === 'downloading' &&
    typeof payload.version === 'string' &&
    payload.version.length > 0 &&
    typeof payload.assetName === 'string' &&
    payload.assetName.length > 0 &&
    Number.isFinite(payload.progress) &&
    payload.progress >= 0 &&
    payload.progress <= 1
  );
}

class UpdatePromptController {
  constructor({
    ipcMain,
    getMainWindow,
    openExternal,
    dbg,
    trustedOrigin,
    getUpdateSettings,
    setUpdateAutoCheck,
    onRendererReady = () => {},
    setTimeout: scheduleTimeout = setTimeout,
    clearTimeout: cancelTimeout = clearTimeout,
  }) {
    this._ipcMain = ipcMain;
    this._getMainWindow = getMainWindow;
    this._openExternal = openExternal;
    this._dbg = dbg;
    this._trustedOrigin = trustedOrigin;
    this._getUpdateSettings = getUpdateSettings;
    this._setUpdateAutoCheck = setUpdateAutoCheck;
    this._onRendererReady = onRendererReady;
    this._setTimeout = scheduleTimeout;
    this._clearTimeout = cancelTimeout;
    this._rendererReady = false;
    this._pending = null;
    this._progress = null;
    this._hasProgressSnapshot = false;
    this._onReady = this._handleReady.bind(this);
    this._onAction = this._handleAction.bind(this);
    this._onGetSettings = this._handleGetSettings.bind(this);
    this._onSetAutoCheck = this._handleSetAutoCheck.bind(this);
    ipcMain.handle(UPDATE_PROMPT_READY_CHANNEL, this._onReady);
    ipcMain.on(UPDATE_PROMPT_ACTION_CHANNEL, this._onAction);
    ipcMain.handle(UPDATE_SETTINGS_GET_CHANNEL, this._onGetSettings);
    ipcMain.handle(UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL, this._onSetAutoCheck);
  }

  show(payload, { presentationTimeoutMs = null } = {}) {
    if (!isPromptPayload(payload)) return Promise.reject(new TypeError('Invalid update prompt payload'));
    if (this._pending) {
      this._dbg(`Update prompt already pending for v${this._pending.payload.version}`);
      return this._pending.promise;
    }

    const presentationReady = this._rendererReady && this._presentMainWindow();
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    this._pending = {
      payload: Object.freeze({ ...payload }),
      promise,
      resolve,
      presentationReady,
      presentationTimeoutMs:
        payload.kind === 'ready-to-install' && Number.isFinite(presentationTimeoutMs) && presentationTimeoutMs > 0
          ? presentationTimeoutMs
          : null,
      presentationTimer: null,
    };
    if (!presentationReady) this._startPresentationTimer(this._pending);
    this._sendPending();
    return promise;
  }

  presentPending() {
    if (!this._pending || !this._presentMainWindow()) return false;
    if (this._rendererReady) {
      this._pending.presentationReady = true;
      this._clearPresentationTimer(this._pending);
    }
    this._sendPending();
    return true;
  }

  _presentMainWindow() {
    const window = this._getMainWindow();
    if (!isTrustedWindow(window, this._trustedOrigin)) return false;
    if (window.isMinimized?.()) window.restore();
    window.show?.();
    window.focus?.();
    return true;
  }

  markRendererUnavailable() {
    this._rendererReady = false;
    if (!this._pending) return;
    this._pending.presentationReady = false;
    this._startPresentationTimer(this._pending);
  }

  _handleReady(event) {
    if (!isTrustedSender(event, this._getMainWindow(), this._trustedOrigin)) {
      this._dbg('Rejected update prompt IPC: untrusted ready sender');
      return null;
    }
    const beginsReadinessEpoch = !this._rendererReady;
    this._rendererReady = true;
    this._dbg('Accepted update renderer readiness');
    if (beginsReadinessEpoch) {
      try {
        this._onRendererReady();
      } catch (error) {
        this._dbg(`Update renderer readiness callback failed: ${safeErrorMessage(error)}`);
      }
    }
    if (this._pending) {
      this._pending.presentationReady = this._presentMainWindow();
      if (this._pending.presentationReady) this._clearPresentationTimer(this._pending);
    }
    this._sendProgress();
    return this._pending?.payload ?? null;
  }

  _handleAction(event, message) {
    const pending = this._pending;
    if (
      !pending ||
      !isTrustedSender(event, this._getMainWindow(), this._trustedOrigin) ||
      !message ||
      message.version !== pending.payload.version ||
      !PROMPT_ACTIONS[pending.payload.kind]?.has(message.action)
    ) {
      this._dbg('Rejected update prompt IPC: sender, version, or action mismatch');
      return;
    }

    if (message.action === 'open-release') {
      void Promise.resolve(this._openExternal(pending.payload.releaseUrl)).catch((error) => {
        this._dbg(`Could not open update release page: ${safeErrorMessage(error)}`);
      });
      return;
    }

    this._finishPending(pending, message.action);
  }

  async _handleGetSettings(event) {
    if (!isTrustedSender(event, this._getMainWindow(), this._trustedOrigin)) {
      throw new Error('Untrusted desktop update settings sender');
    }
    const settings = await this._getUpdateSettings();
    if (!settings || typeof settings.autoCheck !== 'boolean') {
      throw new TypeError('Invalid desktop update settings');
    }
    return { autoCheck: settings.autoCheck };
  }

  async _handleSetAutoCheck(event, enabled) {
    if (!isTrustedSender(event, this._getMainWindow(), this._trustedOrigin)) {
      throw new Error('Untrusted desktop update settings sender');
    }
    if (typeof enabled !== 'boolean') throw new TypeError('autoCheck must be a boolean');
    const settings = await this._setUpdateAutoCheck(enabled);
    if (!settings || typeof settings.autoCheck !== 'boolean') {
      throw new TypeError('Invalid desktop update settings');
    }
    return { autoCheck: settings.autoCheck };
  }

  _sendPending() {
    const window = this._getMainWindow();
    if (!this._rendererReady || !this._pending || !isTrustedWindow(window, this._trustedOrigin)) return;
    window.webContents.send(UPDATE_PROMPT_CHANNEL, this._pending.payload);
  }

  setProgress(progress) {
    if (progress !== null && !isProgressPayload(progress)) {
      throw new TypeError('Invalid desktop update progress');
    }
    this._progress = progress === null ? null : Object.freeze({ ...progress });
    this._hasProgressSnapshot = true;
    this._sendProgress();
  }

  _sendProgress() {
    const window = this._getMainWindow();
    if (!this._rendererReady || !this._hasProgressSnapshot || !isTrustedWindow(window, this._trustedOrigin)) return;
    window.webContents.send(UPDATE_PROGRESS_CHANNEL, this._progress);
  }

  _startPresentationTimer(pending) {
    if (!pending.presentationTimeoutMs || pending.presentationTimer) return;
    pending.presentationTimer = this._setTimeout(() => {
      if (this._pending !== pending || pending.presentationReady) return;
      this._dbg(`Rendered install prompt did not remain available for v${pending.payload.version}`);
      this._finishPending(pending, undefined);
    }, pending.presentationTimeoutMs);
  }

  _clearPresentationTimer(pending) {
    if (!pending.presentationTimer) return;
    this._clearTimeout(pending.presentationTimer);
    pending.presentationTimer = null;
  }

  _finishPending(pending, action) {
    if (this._pending !== pending) return;
    this._pending = null;
    this._clearPresentationTimer(pending);
    pending.resolve(action);
  }

  dispose() {
    this._rendererReady = false;
    this._ipcMain.removeListener(UPDATE_PROMPT_ACTION_CHANNEL, this._onAction);
    this._ipcMain.removeHandler(UPDATE_PROMPT_READY_CHANNEL);
    this._ipcMain.removeHandler(UPDATE_SETTINGS_GET_CHANNEL);
    this._ipcMain.removeHandler(UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL);
    if (this._pending) this._finishPending(this._pending, 'later');
  }
}

module.exports = {
  isExpectedOrigin,
  UpdatePromptController,
  UPDATE_PROMPT_CHANNEL,
  UPDATE_PROMPT_READY_CHANNEL,
  UPDATE_PROMPT_ACTION_CHANNEL,
  UPDATE_PROGRESS_CHANNEL,
  UPDATE_SETTINGS_GET_CHANNEL,
  UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL,
};
