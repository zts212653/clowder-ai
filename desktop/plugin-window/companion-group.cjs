/** F336 Phase C / F317: one cat, a group of Host-managed windows under one Host controller.
 * The `panel` (the companion window: menus, chat, call, decisions, desk) always exists; a
 * `body` (the living cat) exists only in living mode. The Host registers each window with its
 * exact main-frame URL and role; every body window gets a fresh Host-minted generation.
 * - Identity: one process-wide `companion:request` handler resolves the sender against this
 *   registry. Unregistered windows (even same-origin), subframes, navigated frames and destroyed
 *   or replaced bodies resolve to null. A body may only send body.* / scene.* commands, and only
 *   when the Host gave the group a body route (an archive whose admitted line carries livingBody).
 * - Lifecycle is the whole cat's: an internal body swap never revokes media, never touches the
 *   controller or voice host and never removes the handler. A user hide or disable revokes once
 *   and hides every managed window; lock/sleep revoke once per boundary and hide the body (the
 *   panel keeps its ball-mode lock behaviour). Close destroys every managed window in one batch,
 *   and losing any managed window closes the whole cat: there is never half a cat.
 */
const BODY_FAMILY = /^(?:body|scene)\./;
const denied = (code) => ({ kind: 'error', code });

function createCompanionGroup({ ipcMain, panel, routes, onRevoke, onFailure, onClosed }) {
  const entries = new Map();
  const powerHolds = new Set();
  let bodyGeneration = 0;
  let ended = false;
  let userHidden = false;
  let disabled = false;
  const state = () => (disabled ? 'disabled' : userHidden ? 'hidden' : powerHolds.size ? 'locked' : 'shown');
  const wantsVisible = (role) => !disabled && !userHidden && (role === 'panel' || powerHolds.size === 0);
  const alive = () => !ended && !entries.get('panel').win.isDestroyed();

  function register(role, win, url, generation) {
    const entry = { role, win, webContents: win.webContents, mainFrameUrl: url, generation };
    const lose = (reason) => () => {
      if (!ended && entries.get(role) === entry) teardown(reason);
    };
    const listeners = [
      [win, 'closed', lose('window-closed')],
      [entry.webContents, 'render-process-gone', lose('renderer-gone')],
      [entry.webContents, 'unresponsive', lose('unresponsive')],
    ];
    for (const [target, name, listener] of listeners) target.on(name, listener);
    entry.unwatch = () => {
      for (const [target, name, listener] of listeners) target.removeListener(name, listener);
    };
    entries.set(role, entry);
    return entry;
  }
  function teardown(reason) {
    if (ended) return;
    ended = true;
    onFailure(reason);
    const batch = [...entries.values()];
    entries.clear();
    for (const entry of batch) entry.unwatch();
    for (const entry of batch) if (!entry.win.isDestroyed()) entry.win.destroy();
    ipcMain.removeHandler('companion:request');
    onClosed();
  }
  function resolveSender(event) {
    for (const entry of entries.values()) {
      if (
        !entry.win.isDestroyed() &&
        event?.sender === entry.webContents &&
        event.senderFrame === entry.webContents.mainFrame &&
        event.senderFrame?.url === entry.mainFrameUrl
      )
        return { role: entry.role, generation: entry.generation };
    }
    return null;
  }
  const hideUnwanted = () => {
    for (const entry of entries.values()) if (!wantsVisible(entry.role) && !entry.win.isDestroyed()) entry.win.hide();
  };
  function detachBody({ internal } = {}) {
    if (internal !== true) throw new Error('Only an internal body swap detaches the body');
    const entry = entries.get('body');
    if (!entry) return;
    entries.delete('body');
    entry.unwatch();
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }

  register('panel', panel.win, panel.url, 0);
  ipcMain.handle('companion:request', async (event, command, activated, submittedAt) => {
    const sender = resolveSender(event);
    if (!sender) return denied('permission_required');
    const bodyCommand = typeof command?.kind === 'string' && BODY_FAMILY.test(command.kind);
    // Without a body route (no livingBody line) no body command is heard at all.
    if (sender.role === 'body')
      return bodyCommand && routes.body ? routes.body(sender, command, activated) : denied('permission_required');
    if (bodyCommand) return denied('permission_required');
    return routes.panel(event, command, activated, submittedAt);
  });

  return {
    get state() {
      return state();
    },
    get closed() {
      return ended;
    },
    resolveSender,
    /** Internal swap in: at most one body; a replaced body is destroyed before the new one shows. */
    attachBody(win, url) {
      if (!alive()) throw new Error('Window closed');
      if (win.isDestroyed()) throw new Error('Body closed before attach');
      detachBody({ internal: true });
      const entry = register('body', win, url, ++bodyGeneration);
      if (wantsVisible('body')) win.showInactive();
      return entry.generation;
    },
    detachBody,
    hide() {
      if (ended) return;
      userHidden = true;
      onRevoke('hidden');
      hideUnwanted();
    },
    disable() {
      if (ended) return;
      disabled = true;
      onRevoke('revoked'); // media-stopped carries only published reasons
      hideUnwanted();
    },
    lock(reason) {
      if (ended) return;
      powerHolds.add(reason);
      onRevoke(reason);
      hideUnwanted();
    },
    unlock(reason) {
      if (ended || !powerHolds.delete(reason)) return;
      const body = entries.get('body');
      if (body && wantsVisible('body') && !body.win.isDestroyed()) body.win.showInactive();
    },
    show() {
      if (!alive()) throw new Error('Window closed');
      userHidden = false;
      for (const entry of entries.values()) if (wantsVisible(entry.role)) entry.win.showInactive();
    },
    /** The published poll value: visible only while every window the group shows is on screen. */
    poll() {
      if (!alive()) throw new Error('Window closed');
      if (userHidden || disabled) return 'hidden';
      for (const entry of entries.values()) if (wantsVisible(entry.role) && !entry.win.isVisible()) return 'hidden';
      return 'visible';
    },
    close() {
      teardown('window-closed');
    },
  };
}

module.exports = { createCompanionGroup };
