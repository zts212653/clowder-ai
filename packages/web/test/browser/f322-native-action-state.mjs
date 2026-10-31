export async function waitForNativeActionMeasurement(page, id, viewport) {
  const offscreen = await page.evaluate((id) => {
    const row = document.querySelector(`[data-message-id="${id}"]`);
    const port = row?.closest('[data-chat-container]');
    if (!row || !port) return false;
    const rect = row.getBoundingClientRect(),
      bounds = port.getBoundingClientRect();
    return (
      rect.bottom <= Math.max(0, bounds.top) ||
      rect.top >= Math.min(window.innerHeight, bounds.bottom) ||
      Boolean(row.closest('[inert], [aria-hidden="true"], [hidden]'))
    );
  }, id);
  if (offscreen) {
    // Unavailable ownership is a separate condition, never reported as a completed measurement.
    await page.waitForFunction((id) => {
      const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
      return (
        plane &&
        getComputedStyle(plane).visibility === 'hidden' &&
        plane.hasAttribute('inert') &&
        plane.getAttribute('aria-hidden') === 'true' &&
        !plane.contains(document.activeElement)
      );
    }, id);
    return;
  }
  await page.waitForFunction(
    ({ id, viewport }) => {
      const row = document.querySelector(`[data-message-id="${id}"]`);
      const column = row?.closest('[data-thread-chat-reading-column]');
      const port = row?.closest('[data-chat-container]');
      const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
      if (!column || !port || !plane || window.innerWidth !== viewport) return false;
      const bounds = column.getBoundingClientRect(),
        box = port.getBoundingClientRect();
      const top = Math.max(0, box.top + port.clientTop),
        bottom = Math.min(window.innerHeight, box.top + port.clientTop + port.clientHeight);
      const left = Math.max(0, box.left + port.clientLeft),
        right = Math.min(window.innerWidth, box.left + port.clientLeft + port.clientWidth);
      return (
        plane.dataset.messageActionsReady === 'true' &&
        plane.dataset.messageActionsCommittedEpoch === column.dataset.messageActionsEpoch &&
        Number(plane.dataset.messageActionsViewport) === viewport &&
        Number(plane.dataset.messageActionsColumnWidth) === bounds.width &&
        Number(plane.dataset.messageActionsColumnLeft) === bounds.left &&
        Number(plane.dataset.messageActionsColumnRight) === bounds.right &&
        Number(plane.dataset.messageActionsPortTop) === top &&
        Number(plane.dataset.messageActionsPortBottom) === bottom &&
        Number(plane.dataset.messageActionsPortLeft) === left &&
        Number(plane.dataset.messageActionsPortRight) === right
      );
    },
    { id, viewport },
  );
}

/** A locator focus is not actionability-gated. Admit native focus in the current paint commit. */
export async function focusCommittedNativeAction(page, id, testid) {
  await page.waitForFunction(
    ({ id, testid }) => {
      const row = document.querySelector(`[data-message-id="${id}"]`);
      const column = row?.closest('[data-thread-chat-reading-column]');
      const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
      const control = plane?.querySelector(`[data-testid="${testid}"]`);
      if (!column || !plane || !control) return false;
      const slot = row.querySelector('[data-message-action-slot]').getBoundingClientRect();
      if (
        plane.dataset.messageActionsReady !== 'true' ||
        plane.dataset.messageActionsCommittedEpoch !== column.dataset.messageActionsEpoch ||
        plane.hasAttribute('inert') ||
        getComputedStyle(plane).visibility === 'hidden' ||
        Number(plane.dataset.messageActionsAnchorTop) !== slot.top ||
        Number(plane.dataset.messageActionsAnchorLeft) !== slot.left
      )
        return false;
      control.focus({ preventScroll: true });
      return document.activeElement === control;
    },
    { id, testid },
  );
}
