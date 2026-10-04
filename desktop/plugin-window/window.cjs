const { randomUUID } = require('node:crypto');
const { resolve } = require('node:path');
const { createCompanionController } = require('./companion-controller.cjs');
const { createVoiceHost } = require('./voice-host.cjs');
const { createPetWindow } = require('./pet-window.cjs');
const { createWindowMotion } = require('./window-motion.cjs');
const { inspectF221 } = require('./f221-inspection.cjs');
const { createMediaRevocation } = require('./media-revocation.cjs');
const { createWindowPreferences } = require('./window-preferences.cjs');
const { createCompanionDisable } = require('./companion-disable.cjs');

const { validateLaunch, toPublishedWindowReply } = require('./window-launch.cjs');

/** Host-owned window implementation. A package supplies HTML, never main/preload code.
 * Conversation/media bridge admission is separate from opening this window.
 * One package body per executor process: main.cjs rejects a second open, and the
 * runtime owns one active desktop lease. IPC channel names are process-scoped;
 * the separate hidden Host voice document is not another package body.
 */
async function createManagedWindow(
  electron,
  input,
  options = { request: async () => ({ kind: 'error', code: 'unavailable' }), validate: () => false },
) {
  const { url, presentation, publicCompanionV2, companionContract } = validateLaunch(input);
  const { app, BrowserWindow, session, screen, ipcMain, powerMonitor, systemPreferences, shell, dialog } = electron;
  // The trusted Host admits only the exact published archive. The installed
  // public command validator is a second fence for this optional state.
  let receiveOnlyAdmitted = false;
  try {
    receiveOnlyAdmitted =
      publicCompanionV2 &&
      Boolean(options.voiceResources?.voiceUrl && options.voiceResources?.voicePreload) &&
      options.validate?.({ kind: 'audio.connect', mode: 'receive_only' }) === true;
  } catch {
    // A missing or incompatible public contract never advertises native media.
  }
  const partition = session.fromPartition(`companion-${randomUUID()}`, { cache: false });
  const surfaceOrigin = new URL(url).origin;
  // This ephemeral partition is only a snapshot renderer. Signalling stays on
  // private IPC; ordinary requests must never reach another Host or the Internet.
  partition.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let allowed = false;
    try {
      const target = new URL(details.url);
      allowed =
        ((target.protocol === 'http:' && target.origin === surfaceOrigin && !target.username && !target.password) ||
          (target.protocol === 'blob:' &&
            target.origin === surfaceOrigin &&
            ['image', 'media'].includes(details.resourceType)) ||
          (target.protocol === 'data:' && ['image', 'font'].includes(details.resourceType))) &&
        ['GET', 'HEAD'].includes(details.method);
    } catch {
      // Invalid and non-snapshot requests stay closed.
    }
    callback({ cancel: !allowed });
  });
  partition.on('will-download', (event) => event.preventDefault());
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    ...presentation,
    title: '猫猫球',
    show: false,
    resizable: false,
    hasShadow: false,
    x: Math.max(area.x, area.x + area.width - presentation.width - 24),
    y: Math.max(area.y, area.y + area.height - presentation.height - 24),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: resolve(__dirname, 'preload.cjs'),
      session: partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  let firstFailure;
  const reportFailure = (reason) => {
    if (firstFailure) return;
    firstFailure = reason;
    try {
      options.onFailure?.(reason);
    } catch {
      // Diagnostic transport cannot prevent media revocation or window cleanup.
    }
  };
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  let motion;
  let preferences;
  let confirmationEpoch = 0;
  const captureRevocation = createMediaRevocation(win);
  const publish = (event) => {
    if (
      event?.kind === 'audio' &&
      event.role === 'user' &&
      ['turn-created', 'transcript', 'turn-done'].includes(event.type)
    )
      confirmationEpoch++;
    if (event.kind === 'media-stopped') {
      confirmationEpoch++;
      voice.stop();
    }
    if (!win.isDestroyed()) win.webContents.send('companion:event', event);
  };
  const voice = createVoiceHost(electron, {
    callScoped: ['0.1.0-beta.23', '0.1.0-beta.24'].includes(companionContract),
    resources: options.voiceResources,
    isArmed: () => controller.armed,
    requestOffer: (sdp) => controller.request({ kind: 'offer', sdp }, false),
    publish,
    onFailure: () => controller.suspend('closed'),
  });
  const controller = createCompanionController({
    request: options.request,
    publish,
    resize: (expanded) => {
      const before = win.getBounds();
      const area = screen.getDisplayMatching(before).workArea;
      const width = expanded ? Math.max(380, presentation.width) : presentation.width;
      const height = expanded ? Math.max(590, presentation.height) : presentation.height;
      win.setBounds({
        x: Math.max(area.x, Math.min(before.x + before.width - width, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(before.y + before.height - height, area.y + area.height - height)),
        width,
        height,
      });
    },
    // After any screen grant, even package code ignoring stop cannot retain a
    // MediaStream. Voice-only revocation destroys the separate Host document.
    stopCapture: () => captureRevocation.reload(),
  });
  const isSurface = (event) =>
    !win.isDestroyed() &&
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame &&
    event.senderFrame?.url === url;
  motion = createWindowMotion({
    win,
    screen,
    systemPreferences,
    isAuthorized: () =>
      preferences?.allowed() === true && !win.isDestroyed() && win.isVisible() && app?.isHidden?.() !== true,
  });
  // Trusted Host policy receives the current native lease; no package-facing
  // command can choose an absolute desktop target or rearm a revoked call.
  const petWindow = createPetWindow({ win, screen, publish, motionLease: () => motion.current() });
  preferences = createWindowPreferences({ motion, setBallSize: (size) => petWindow.setBallSize(size) });
  let inspectingF221 = false;
  let hideConfirmation;
  const clearHideConfirmation = () => {
    if (hideConfirmation) clearTimeout(hideConfirmation);
    hideConfirmation = undefined;
  };
  const revokeMedia = (reason) => {
    clearHideConfirmation();
    if (reason === 'hidden') preferences.suspend('hidden');
    controller.suspend(reason);
  };
  const requestController = (command, activated) => {
    if (command.kind === 'view.resize') motion.revoke('resize');
    const preparing = command.kind === 'prepare' && activated === true && !controller.armed;
    const ticket = preferences.begin(command, activated === true);
    const reply = controller
      .request(command, activated === true)
      .then((result) => {
        preferences.accept(ticket, result);
        result = toPublishedWindowReply(result, companionContract);
        return receiveOnlyAdmitted && result.kind === 'state'
          ? { ...result, audio: { supportedModes: ['duplex', 'receive_only'], activeMode: voice.mode() } }
          : result;
      })
      .catch(() => {
        const result = { kind: 'error', code: 'unavailable' };
        preferences.accept(ticket, result);
        return result;
      });
    if (preparing) voice.prepare(reply);
    return reply;
  };
  const confirmDisable = createCompanionDisable({
    dialog,
    win,
    current: () => (win.isDestroyed() ? null : confirmationEpoch),
    disable: () => controller.request({ kind: 'companion.disable' }, true),
    begin: () => preferences.begin({ kind: 'companion.disable' }, true),
    settle: (ticket, result) => preferences.accept(ticket, result),
  });
  ipcMain.handle('companion:request', async (event, command, activated) => {
    if (!isSurface(event)) return { kind: 'error', code: 'permission_required' };
    if (command?.kind === 'f221.confirm-trial') return { kind: 'error', code: 'invalid_request' };
    if (!options.validate(command)) return { kind: 'error', code: 'invalid_request' };
    if (command.kind === 'companion.disable') return confirmDisable(activated);
    if (command.kind === 'audio.connect' && command.mode === 'receive_only' && !receiveOnlyAdmitted)
      return { kind: 'error', code: 'invalid_request' };
    if (command.kind === 'f221.inspect') {
      if (activated !== true) return { kind: 'error', code: 'permission_required' };
      if (inspectingF221) return { kind: 'error', code: 'busy' };
      inspectingF221 = true;
      const stagedEpoch = confirmationEpoch;
      try {
        return await inspectF221({
          dialog,
          win,
          read: () => controller.request(command, false),
          confirm: (nonce, action) => controller.request({ kind: 'f221.confirm-trial', nonce, action }, false),
          current: () => !win.isDestroyed() && confirmationEpoch === stagedEpoch,
        });
      } catch {
        return { kind: 'decision-trial', status: 'unavailable' };
      } finally {
        inspectingF221 = false;
      }
    }
    // A deliberate hide revokes media before the window disappears, even on
    // platforms where BrowserWindow does not emit a matching hide event.
    if (command.kind === 'view.hide' && activated === true) revokeMedia('hidden');
    const presentationReply = petWindow.request(command, activated === true);
    if (presentationReply) {
      preferences.presentation(command, presentationReply);
      return presentationReply;
    }
    if (command.kind.startsWith('audio.')) return voice.request(command, activated === true);
    return requestController(command, activated);
  });
  partition.setPermissionCheckHandler(
    (contents, permission, origin) =>
      contents === win.webContents &&
      !win.isDestroyed() &&
      contents.getURL() === url &&
      origin === new URL(url).origin &&
      permission === 'display-capture' &&
      controller.display(permission),
  );
  partition.setPermissionRequestHandler((contents, permission, callback, details = {}) =>
    callback(
      contents === win.webContents &&
        !win.isDestroyed() &&
        contents.getURL() === url &&
        details.isMainFrame !== false &&
        controller.display(permission, details.mediaTypes),
    ),
  );
  partition.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: true });
  const unwatchPower = preferences.watchPower(powerMonitor, revokeMedia);
  win.on('hide', () => {
    preferences.suspend('hidden');
    petWindow.dismiss();
    // Electron can emit hide during a macOS Space handoff while the pet is
    // still visible on all workspaces and the app itself was not hidden.
    // Visibility flags cannot prove the cat is present in the current Space.
    // Preserve media only if Electron actually shows it again within this bound.
    if (!win.isVisibleOnAllWorkspaces() || !win.isVisible() || app?.isHidden?.() === true) {
      revokeMedia('hidden');
      return;
    }
    clearHideConfirmation();
    hideConfirmation = setTimeout(() => {
      hideConfirmation = undefined;
      if (!win.isDestroyed()) controller.suspend('hidden');
    }, 1000);
    hideConfirmation.unref?.();
  });
  win.on('show', () => {
    if (win.isVisible() && app?.isHidden?.() !== true) {
      clearHideConfirmation();
      preferences.resume('hidden');
      motion.arm();
    }
  });
  win.on('blur', () => {
    petWindow.dismiss();
    // Command-H can blur this window without delivering a window hide event.
    if (app?.isHidden?.() === true) revokeMedia('hidden');
  });
  win.on('closed', () => {
    reportFailure('window-closed');
    clearHideConfirmation();
    motion.close();
    petWindow.close();
    controller.close();
    voice.close();
    ipcMain.removeHandler('companion:request');
    unwatchPower();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (target !== url) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', () => {
    reportFailure('renderer-gone');
    if (!win.isDestroyed()) win.destroy();
  });
  win.webContents.on('unresponsive', () => {
    reportFailure('unresponsive');
    if (!win.isDestroyed()) win.destroy();
  });
  try {
    await win.loadURL(url);
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
  if (win.isDestroyed()) throw new Error('Window closed during load');
  win.showInactive();
  return {
    /** Internal Host lease, never serialized onto the renderer or pipe. */
    motionLease: () => motion.current(),
    async revokeMedia() {
      if (win.isDestroyed()) throw new Error('Window closed');
      revokeMedia('revoked');
      await captureRevocation.wait();
    },
    poll() {
      if (win.isDestroyed()) throw new Error('Window closed');
      return win.isVisible() ? 'visible' : 'hidden';
    },
    show() {
      if (win.isDestroyed()) throw new Error('Window closed');
      win.showInactive();
    },
    async navigate(params) {
      if (!params || Object.keys(params).join(',') !== 'url') throw new Error('Invalid conversation navigation');
      const target = new URL(params.url);
      if (
        !['http:', 'https:'].includes(target.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
        !/^\/thread\/[^/?#]+$/.test(target.pathname) ||
        target.username ||
        target.password ||
        target.search ||
        target.hash
      )
        throw new Error('Invalid conversation navigation');
      await shell.openExternal(target.href);
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
module.exports = { createManagedWindow, validateLaunch, toPublishedWindowReply };
