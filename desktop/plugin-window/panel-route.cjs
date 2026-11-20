const { inspectF221 } = require('./f221-inspection.cjs');
const { createCompanionDisable } = require('./companion-disable.cjs');
const { toPublishedWindowReply } = require('./window-launch.cjs');

/** The panel role's command routing, moved unchanged from window.cjs's `companion:request`
 * handler. The window group has already resolved the sender to the registered panel main
 * frame and kept body.* / scene.* commands away from it; everything below is today's path. */
function createPanelRoute({
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
  confirmationEpoch,
  flushScene,
  living,
  observeReply = () => {},
}) {
  let inspectingF221 = false;
  let pendingSettings;
  const requestController = (command, activated) => {
    if (command.kind === 'view.resize') motion.revoke('resize');
    const preparing = command.kind === 'prepare' && activated === true && !controller.armed;
    const ticket = preferences.begin(command, activated === true);
    const reply = controller
      .request(command, activated === true)
      .then((result) => {
        preferences.accept(ticket, result);
        observeReply(command, result);
        if (command.kind === 'settings.update' && command.field === 'skin' && result.kind !== 'error')
          living.choose(command.value);
        result = toPublishedWindowReply(living.drawn(result), companionContract);
        if (appAssist && result.kind === 'state') result = { ...result, appAssist: appAssist.snapshot() };
        if (desk && result.kind === 'state') result = { ...result, desk: desk.snapshot() };
        return receiveOnlyAdmitted && result.kind === 'state'
          ? { ...result, audio: { supportedModes: ['duplex', 'receive_only'], activeMode: voice.mode() } }
          : result;
      })
      .catch(() => {
        const result = { kind: 'error', code: 'unavailable' };
        preferences.accept(ticket, result);
        observeReply(command, result);
        return result;
      });
    if (command.kind === 'settings.read') pendingSettings = reply;
    if (preparing) voice.prepare(reply);
    return reply;
  };
  const confirmDisable = createCompanionDisable({
    dialog,
    win,
    current: () => (win.isDestroyed() ? null : confirmationEpoch()),
    // F336: the API ends this run once it disables; the living cat's scene goes out first.
    disable: async () => {
      await flushScene('disable');
      return controller.request({ kind: 'companion.disable' }, true);
    },
    begin: () => preferences.begin({ kind: 'companion.disable' }, true),
    settle: (ticket, result) => {
      preferences.accept(ticket, result);
      // A confirmed disable takes the whole cat off screen and revokes once.
      if (result.kind === 'companion-lifecycle' && result.action === 'disable' && result.outcome === 'disabled')
        group.disable();
    },
  });
  return async function requestPanel(event, command, activated, submittedAt) {
    if (command?.kind === 'f221.confirm-trial') return { kind: 'error', code: 'invalid_request' };
    if (!options.validate(command)) return { kind: 'error', code: 'invalid_request' };
    if (
      command.kind === 'text' &&
      typeof command.clientMessageId === 'string' &&
      /^[^\s\u0000-\u001f\u007f]{1,256}$/.test(command.clientMessageId) &&
      Number.isSafeInteger(submittedAt) &&
      Math.abs(Date.now() - submittedAt) <= 5000
    )
      options.onTextSubmission?.({
        stage: 'client_text_sent',
        observedAt: submittedAt,
        clientMessageId: command.clientMessageId,
      });
    if (command.kind === 'companion.disable') return confirmDisable(activated);
    if (command.kind === 'audio.connect' && command.mode === 'receive_only' && !receiveOnlyAdmitted)
      return { kind: 'error', code: 'invalid_request' };
    if (command.kind === 'f221.inspect') {
      if (activated !== true) return { kind: 'error', code: 'permission_required' };
      if (inspectingF221) return { kind: 'error', code: 'busy' };
      inspectingF221 = true;
      const stagedEpoch = confirmationEpoch();
      try {
        return await inspectF221({
          dialog,
          win,
          read: () => controller.request(command, false),
          confirm: (nonce, action) => controller.request({ kind: 'f221.confirm-trial', nonce, action }, false),
          current: () => !win.isDestroyed() && confirmationEpoch() === stagedEpoch,
        });
      } catch {
        return { kind: 'decision-trial', status: 'unavailable' };
      } finally {
        inspectingF221 = false;
      }
    }
    // A deliberate hide revokes media once before every managed window disappears,
    // even on platforms where BrowserWindow does not emit a matching hide event.
    if (command.kind === 'view.hide' && activated === true) group.hide();
    if (command.kind === 'view.layout') {
      // The shipped renderer reads settings before its initial layout. Settle
      // the newest read first so its CSS size and this reply share coordinates.
      let observed;
      do {
        observed = pendingSettings;
        await observed;
      } while (observed !== pendingSettings);
      if (group.resolveSender(event)?.role !== 'panel') return { kind: 'error', code: 'permission_required' };
    }
    const presentationReply = petWindow.request(command, activated === true);
    if (presentationReply) {
      preferences.presentation(command, presentationReply);
      return presentationReply;
    }
    if (command.kind.startsWith('audio.')) return voice.request(command, activated === true);
    if (desk && ['desk.settle', 'desk.thumbnail.read', 'desk.avatar.read'].includes(command.kind))
      return desk.request(command);
    return appAssist
      ? appAssist.request(command, (forwarded) => requestController(forwarded, activated))
      : requestController(command, activated);
  };
}

module.exports = { createPanelRoute };
