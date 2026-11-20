const { resolve } = require('node:path');
const { createCompanionController } = require('./companion-controller.cjs');
const { createVoiceHost } = require('./voice-host.cjs');
const { createPetWindow } = require('./pet-window.cjs');
const { createWindowMotion } = require('./window-motion.cjs');
const { createMediaRevocation } = require('./media-revocation.cjs');
const { createWindowPreferences } = require('./window-preferences.cjs');
const { createCompanionGroup } = require('./companion-group.cjs');
const { createSurfacePartition, admitSurfaceMedia } = require('./surface-partition.cjs');
const { watchPanelVisibility } = require('./panel-visibility.cjs');
const { createPanelRoute } = require('./panel-route.cjs');
const { openBodyWindow } = require('./body-window.cjs');
const { createSceneWriter } = require('./scene-writer.cjs');
const { createLivingMode } = require('./living-mode.cjs');
const { createPendingBadge } = require('./pending-badge.cjs');

const { validateLaunch, toPublishedWindowReply, conversationTarget } = require('./window-launch.cjs');
const { companionContractHas } = require('./companion-contracts.cjs');

/** Host-owned window implementation. A package supplies HTML, never main/preload code.
 * Conversation/media bridge admission is separate from opening this window.
 * One package body per executor process: main.cjs rejects a second open, and the
 * runtime owns one active desktop lease. IPC channel names are process-scoped;
 * the separate hidden Host voice document is not another package body.
 * F336: the living-cat body window is not a second open either; it joins this
 * surface's window group (companion-group.cjs) under the same Host controller.
 */
async function createManagedWindow(
  electron,
  input,
  options = { request: async () => ({ kind: 'error', code: 'unavailable' }), validate: () => false },
) {
  const { url, presentation, publicCompanionV2, companionContract, bodyUrl } = validateLaunch(input);
  const { app, BrowserWindow, session, screen, ipcMain, powerMonitor, systemPreferences, shell, dialog } = electron;
  const appAssist = companionContractHas(companionContract, 'appAssist') ? options.appAssist : undefined;
  // F335 交付三：present only when the Host admitted a desk-capable archive and the API granted it.
  const desk = companionContractHas(companionContract, 'desk') ? options.desk : undefined;
  // F336 Phase C: the transparent, unfocusable living body window (tests may inject a fake).
  const createBodyWindow = options.createBodyWindow ?? ((body) => openBodyWindow(electron, body));
  const runAppAssist = (method) => {
    if (!appAssist) return Promise.resolve();
    try {
      return Promise.resolve(appAssist[method]()).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  };
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
  const partition = createSurfacePartition(session, url);
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
  // Visibility, lock and sleep are independent native boundaries. A later
  // show/reload may only restart the source after every outstanding boundary
  // has been released by its matching native event.
  const appAssistPauses = new Set(appAssist ? ['hidden'] : []);
  const pauseAppAssist = (reason) => {
    if (!appAssist || appAssistPauses.has(reason)) return Promise.resolve();
    appAssistPauses.add(reason);
    return runAppAssist('suspend');
  };
  const resumeAppAssistIfEligible = () => {
    if (!appAssist || appAssistPauses.size || win.isDestroyed() || !win.isVisible() || app?.isHidden?.() === true)
      return Promise.resolve();
    return runAppAssist('resume');
  };
  const releaseAppAssist = (reason) => {
    if (appAssist) appAssistPauses.delete(reason);
    return resumeAppAssistIfEligible();
  };
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
    callScoped: companionContractHas(companionContract, 'modern'),
    resources: options.voiceResources,
    isArmed: () => controller.armed,
    requestOffer: (sdp) => controller.request({ kind: 'offer', sdp }, false),
    publish,
    onFailure: () => controller.suspend('closed'),
    onObservation: (value) => options.onVoiceObservation?.(value),
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
  motion = createWindowMotion({
    win,
    screen,
    systemPreferences,
    isAuthorized: () =>
      preferences?.allowed() === true && !win.isDestroyed() && win.isVisible() && app?.isHidden?.() !== true,
  });
  // F336: in living mode the panel's badges (pending, stop sharing) keep Host-placed click rects (pending-badge.cjs).
  const badge = createPendingBadge({ shareShown: () => controller.screenShown });
  // Trusted Host policy receives the current native lease; no package-facing
  // command can choose an absolute desktop target or rearm a revoked call.
  const petWindow = createPetWindow({ win, screen, publish, motionLease: () => motion.current(), badge });
  preferences = createWindowPreferences({
    motion,
    setBallSize: (size) => {
      living.setBallSize(size); // the living cat's stand height follows the same trusted size
      return petWindow.setBallSize(size);
    },
    observe: (values) => living.observe(values),
  });
  // F336 U2: the living cat's newest scene is held here, in electron main, until the API acknowledges it.
  const scene = createSceneWriter({ request: (command) => options.request(command), log: options.onSceneLog });
  const revokeMedia = (reason) => {
    visibility.clear();
    if (reason === 'hidden') preferences.suspend('hidden');
    void pauseAppAssist(reason);
    controller.suspend(reason);
    void scene.flush(reason); // hide, disable, lock and sleep: what the body has goes out now
  };
  // The panel and an optional living body share this Host controller, identity and lifecycle.
  const group = createCompanionGroup({
    ipcMain,
    panel: { win, url },
    routes: {
      panel: (...request) => requestPanel(...request),
      // F336: only a launch that carries the verified body page (a livingBody line) hears body commands.
      body: bodyRoute({ bodyUrl, validate: options.validate, scene, petWindow }),
    },
    onRevoke: revokeMedia,
    onFailure: reportFailure,
    onClosed: closeCat,
  });
  // The body opens from the verified page only, and only while the owner's saved skin is the living cat.
  const living = createLivingMode({
    bodyUrl,
    presentation,
    createBodyWindow,
    group,
    petWindow,
    scene,
    screen,
    log: (line) => options.onBodyLog?.(line),
  });
  const requestPanel = createPanelRoute({
    options,
    dialog,
    win,
    group,
    controller,
    preferences,
    motion,
    petWindow,
    voice,
    desk,
    appAssist,
    companionContract,
    receiveOnlyAdmitted,
    confirmationEpoch: () => confirmationEpoch,
    flushScene: (reason) => scene.flush(reason),
    living,
    observeReply: (command, result) => badge.observe(command, result),
  });
  admitSurfaceMedia(partition, { win, url, controller });
  // Lock and sleep revoke through the group, which also takes the living body off screen.
  const unwatchPower = preferences.watchPower(powerMonitor, (reason) => group.lock(reason));
  const powerReleases = {
    'unlock-screen': () => {
      group.unlock('locked');
      void releaseAppAssist('locked');
    },
    resume: () => {
      group.unlock('suspended');
      void releaseAppAssist('suspended');
    },
  };
  for (const [event, listener] of Object.entries(powerReleases)) powerMonitor.on(event, listener);
  // The desk brings things only while the cat is actually on screen; hidden keeps them for later.
  const syncDesk = () => desk?.setVisible(!win.isDestroyed() && win.isVisible() && app?.isHidden?.() !== true);
  if (desk) for (const event of ['show', 'hide', 'blur', 'focus']) win.on(event, syncDesk);
  const visibility = watchPanelVisibility({
    win,
    app,
    revokeMedia,
    alreadyRevoked: () => group.state === 'hidden' || group.state === 'disabled',
    onHide: () => {
      preferences.suspend('hidden');
      petWindow.dismiss();
    },
    onShow: () => {
      preferences.resume('hidden');
      motion.arm();
      void releaseAppAssist('hidden');
    },
    onBlur: () => petWindow.dismiss(),
  });
  // The whole cat closes once: after the group destroyed every managed window,
  // or lost any of them (closed, renderer gone, unresponsive).
  function closeCat() {
    visibility.clear();
    void runAppAssist('close');
    motion.close();
    petWindow.close();
    living.close();
    scene.detach(); // the scene writer outlives the windows: the quit flush still writes what was reported
    controller.close();
    voice.close();
    unwatchPower();
    for (const [event, listener] of Object.entries(powerReleases)) powerMonitor.off(event, listener);
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (target !== url) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  let initialPageLoad = true;
  let pageReset = runAppAssist('reset');
  win.webContents.on('did-start-loading', () => {
    if (!initialPageLoad) pageReset = runAppAssist('reset');
  });
  win.webContents.on('did-finish-load', () => {
    if (initialPageLoad) return;
    void pageReset.then(resumeAppAssistIfEligible);
  });
  try {
    await pageReset;
    await win.loadURL(url);
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
  initialPageLoad = false;
  if (win.isDestroyed()) throw new Error('Window closed during load');
  win.showInactive();
  await releaseAppAssist('hidden');
  return {
    /** Internal Host lease, never serialized onto the renderer or pipe. */
    motionLease: () => motion.current(),
    async revokeMedia() {
      if (win.isDestroyed()) throw new Error('Window closed');
      revokeMedia('revoked');
      await captureRevocation.wait();
    },
    poll() {
      const value = group.poll();
      syncDesk();
      return value;
    },
    show() {
      group.show();
      void releaseAppAssist('hidden');
    },
    /** Internal body swap in (F336), from the verified body page only: never a hide, a close or a
     * media revocation. A replaced body first hands its latest scene to the Host writer. */
    attachBody: () => living.attach(),
    /** Internal body swap out: back to the ball inside the panel, after the scene flush. */
    detachBody: () => living.detach(),
    /** Ask the body, write at once and wait for the ACK; never rejects. Quit uses this first. */
    flushScene: (reason) => scene.flush(reason),
    /** No body to ask and nothing pending: the process may quit without waiting. */
    sceneIdle: () => scene.idle(),
    async navigate(params) {
      await shell.openExternal(conversationTarget(params), { activate: true });
    },
    /** Final close and process quit: every managed window goes in one batch. */
    close() {
      group.close();
      scene.close(); // logs a scene that is still not acknowledged
    },
  };
}
/** The body role's commands: the public schema first, then the scene writer or the pet window.
 * Without the verified body page (no livingBody line) there is no body route at all. */
function bodyRoute({ bodyUrl, validate, scene, petWindow }) {
  if (!bodyUrl) return undefined;
  return (sender, command) => {
    if (!validate(command)) return { kind: 'error', code: 'invalid_request' };
    return command.kind.startsWith('scene.') ? scene.request(sender, command) : petWindow.requestBody(sender, command);
  };
}
module.exports = { createManagedWindow, validateLaunch, toPublishedWindowReply };
