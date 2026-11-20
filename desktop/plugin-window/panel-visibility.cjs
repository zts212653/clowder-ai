/** The panel window's native visibility boundary (moved from window.cjs; ball-mode
 * semantics unchanged). Native hides the Host did not ask for decide here whether the
 * cat really left the screen; a hide the group itself performed was already revoked. */
function watchPanelVisibility({ win, app, revokeMedia, alreadyRevoked, onHide, onShow, onBlur }) {
  let hideConfirmation;
  const clear = () => {
    if (hideConfirmation) clearTimeout(hideConfirmation);
    hideConfirmation = undefined;
  };
  win.on('hide', () => {
    onHide();
    // A group hide or disable revoked once before it hid every managed window.
    if (alreadyRevoked()) return;
    // Electron can emit hide during a macOS Space handoff while the pet is
    // still visible on all workspaces and the app itself was not hidden.
    // isVisible may briefly become false between native hide/show during that
    // handoff. Actual app hiding or losing all-workspaces placement still
    // revokes immediately; an explicit view.hide already revoked before IPC.
    // Ambiguous native hides require a real show within the existing bound.
    if (!win.isVisibleOnAllWorkspaces() || app?.isHidden?.() === true) {
      revokeMedia('hidden');
      return;
    }
    clear();
    hideConfirmation = setTimeout(() => {
      hideConfirmation = undefined;
      if (!win.isDestroyed()) revokeMedia('hidden');
    }, 1000);
    hideConfirmation.unref?.();
  });
  win.on('show', () => {
    if (win.isVisible() && app?.isHidden?.() !== true) {
      clear();
      onShow();
    }
  });
  win.on('blur', () => {
    onBlur();
    // Command-H can blur this window without delivering a window hide event.
    if (app?.isHidden?.() === true) revokeMedia('hidden');
  });
  return { clear };
}

module.exports = { watchPanelVisibility };
