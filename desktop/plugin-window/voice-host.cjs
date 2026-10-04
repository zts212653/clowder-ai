const { randomUUID } = require('node:crypto');
const denied = (code) => ({ kind: 'error', code });

/** A separate permission principal: only Host-owned bytes can request audio. */
function createVoiceHost(electron, { resources, isArmed, requestOffer, publish, onFailure, callScoped = false }) {
  const { BrowserWindow, session, ipcMain } = electron;
  let window,
    opening,
    preparation,
    connecting,
    ended = false,
    generation = 0,
    sequence = 0;
  let microphoneMuted = false,
    speakerMuted = false;
  let callId;
  let activeMode = null,
    admittedMode = null,
    mediaFailed = false;
  const pending = new Map();
  const currentSender = (event) =>
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame?.url === resources?.voiceUrl;
  function stop() {
    ++generation;
    callId = undefined;
    activeMode = null;
    admittedMode = null;
    mediaFailed = false;
    preparation = undefined;
    connecting?.cancel();
    connecting = undefined;
    opening = undefined;
    const previous = window;
    window = undefined;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.resolve(denied('cancelled'));
    }
    pending.clear();
    if (previous && !previous.isDestroyed()) previous.destroy();
  }
  async function connect(activated, mode) {
    if (activated !== true || !preparation) return denied('permission_required');
    const ready = preparation;
    preparation = undefined;
    const current = generation;
    let cancel;
    const cancelled = new Promise((resolve) => {
      cancel = () => resolve(denied('cancelled'));
    });
    const operation = { cancel };
    connecting = operation;
    const timer = setTimeout(() => {
      if (connecting === operation) {
        stop();
        onFailure();
      }
    }, 60000);
    try {
      const result = await Promise.race([ready, cancelled]);
      if (current !== generation || ended) return denied('cancelled');
      if (result.kind !== 'state' || result.phase !== 'ready' || !isArmed()) return denied('permission_required');
      admittedMode = mode;
      const privateCommand = { kind: 'audio.connect', microphoneMuted, speakerMuted };
      if (mode === 'receive_only') privateCommand.mode = mode;
      const reply = await dispatch(privateCommand);
      if (current !== generation || ended) return denied('cancelled');
      if (mediaFailed) return denied('unavailable');
      if (reply.kind === 'ok') activeMode = mode;
      return reply;
    } finally {
      clearTimeout(timer);
      if (connecting === operation) connecting = undefined;
    }
  }
  ipcMain.handle('companion:media-offer', async (event, sdp) => {
    if (!currentSender(event) || !isArmed()) return denied('permission_required');
    if (
      typeof sdp !== 'string' ||
      sdp.length > 128000 ||
      !sdp.startsWith('v=0') ||
      !/^m=audio /m.test(sdp) ||
      /^m=video /m.test(sdp)
    )
      return denied('invalid_request');
    const current = generation;
    const reply = await requestOffer(sdp).catch(() => denied('unavailable'));
    if (current !== generation || !currentSender(event) || !isArmed()) return denied('cancelled');
    if (callScoped && reply.kind === 'answer') {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(reply.callId ?? ''))
        return denied('unavailable');
      callId = reply.callId;
    }
    return reply;
  });
  const onReply = (event, id, reply) => {
    if (!currentSender(event)) return;
    const call = pending.get(id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(id);
    call.resolve(reply?.kind === 'ok' ? { kind: 'ok' } : denied('unavailable'));
  };
  const onEvent = (event, value) => {
    if (currentSender(event) && isArmed()) {
      if (callScoped && !callId) return;
      if (value?.type === 'error') {
        mediaFailed = true;
        activeMode = null;
      }
      publish(callScoped ? { ...value, callId } : value);
    }
  };
  ipcMain.on('companion:voice-reply', onReply);
  ipcMain.on('companion:voice-event', onEvent);

  async function open() {
    if (!resources) throw new Error('Host media resources unavailable');
    const partition = session.fromPartition(`companion-voice-${randomUUID()}`, { cache: false });
    const win = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      webPreferences: {
        session: partition,
        preload: resources.voicePreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    window = win;
    const audioAllowed = (contents, permission, mediaTypes) =>
      window === win &&
      !ended &&
      !win.isDestroyed() &&
      contents === win.webContents &&
      contents.getURL() === resources.voiceUrl &&
      isArmed() &&
      admittedMode !== 'receive_only' &&
      permission === 'media' &&
      Array.isArray(mediaTypes) &&
      mediaTypes.length === 1 &&
      mediaTypes[0] === 'audio';
    partition.setPermissionCheckHandler((contents, permission, _origin, details = {}) =>
      audioAllowed(contents, permission, [details.mediaType]),
    );
    partition.setPermissionRequestHandler((contents, permission, callback, details = {}) =>
      callback(details.isMainFrame !== false && audioAllowed(contents, permission, details.mediaTypes)),
    );
    partition.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    partition.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) =>
      callback({ cancel: !(details.url === resources.voiceUrl && ['GET', 'HEAD'].includes(details.method)) }),
    );
    partition.on('will-download', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-redirect', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    const failed = () => {
      if (window === win) {
        stop();
        onFailure();
      }
    };
    win.webContents.on('render-process-gone', failed);
    win.webContents.on('unresponsive', failed);
    win.on('closed', failed);
    const loadingDeadline = setTimeout(failed, 10000);
    try {
      await win.loadURL(resources.voiceUrl);
    } finally {
      clearTimeout(loadingDeadline);
    }
    if (window !== win || win.isDestroyed()) throw new Error('Host voice closed during load');
    return win;
  }
  async function dispatch(command) {
    const current = generation;
    opening ??= open();
    let win;
    try {
      win = await opening;
    } catch {
      if (current === generation) stop();
      return denied('unavailable');
    }
    if (ended || current !== generation || !isArmed()) return denied('cancelled');
    if (pending.size >= 16) return denied('busy');
    return new Promise((resolve) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        stop();
        onFailure();
      }, 30000);
      pending.set(id, { resolve, timer });
      win.webContents.send('companion:voice-command', id, command);
    });
  }
  return {
    mode: () => activeMode,
    prepare(readiness) {
      if (ended) return;
      stop();
      // Readiness is not microphone authority. A separate, fresh user activation
      // must submit audio.connect; Host then owns the bounded wait for this result.
      preparation = Promise.resolve(readiness).catch(() => denied('unavailable'));
    },
    stop,
    async request(command, activated = false) {
      if (ended) return denied('cancelled');
      if (command.kind === 'audio.close') {
        stop();
        return { kind: 'ok' };
      }
      if (command.kind === 'audio.microphone') {
        if (admittedMode === 'receive_only') return denied('permission_required');
        microphoneMuted = command.muted;
      } else if (command.kind === 'audio.speaker') speakerMuted = command.muted;
      else if (command.kind === 'audio.connect') {
        if (command.mode !== undefined && command.mode !== 'receive_only') return denied('invalid_request');
        return connect(activated, command.mode ?? 'duplex');
      } else return denied('invalid_request');
      return opening ? dispatch(command) : { kind: 'ok' };
    },
    close() {
      if (ended) return;
      ended = true;
      stop();
      ipcMain.removeHandler('companion:media-offer');
      ipcMain.off('companion:voice-reply', onReply);
      ipcMain.off('companion:voice-event', onEvent);
    },
  };
}
module.exports = { createVoiceHost };
