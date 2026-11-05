import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  beginNativeActionFrames,
  finishNativeActionFrames,
  waitForNativeActionMeasurement,
} from './f322-native-reply-reading.mjs';
import {
  beginNativeReadingGesture,
  finishScrollProbeTrace,
  placeNativeAuthorEdge,
  startScrollProbeTrace,
  waitForScrollProbe,
} from './f322-native-scroll-probe-state.mjs';

function assertScrollportObservation(observation, name, width, edge) {
  const contained =
    observation.control.top >= observation.portTop - 1 && observation.control.bottom <= observation.portBottom + 1;
  const disabled = observation.visibility === 'hidden' && observation.inert;
  assert(contained || disabled, `${name} ${width}/${edge}: scrollport escape ${JSON.stringify(observation)}`);
  if (edge === 'above' || edge === 'below') {
    assert(disabled && !observation.focused, `${name}: clipped author cannot expose a focused portal`);
  }
  if (edge === 'middle') assert(!disabled && observation.focused, `${name}: a visible author retains its action`);
}

async function enterReadingState(page, width) {
  const collapse = page.getByTestId('sidebar-collapse');
  if (width === 300 && (await collapse.isVisible())) {
    await collapse.click();
    await collapse.waitFor({ state: 'hidden' });
  }
}

async function verifyCoarseDrawerHit(page, id, width, out, name) {
  if (width !== 300 || !(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) return;
  await page.getByTestId('header-sidebar-expand').click();
  await page.getByTestId('sidebar-collapse').waitFor({ state: 'visible' });
  await waitForNativeActionMeasurement(page, id, width);
  const hit = await page.evaluate((id) => {
    const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
    const control = plane.firstElementChild.getBoundingClientRect();
    const center = [control.left + control.width / 2, control.top + control.height / 2];
    const original = plane.style.zIndex;
    plane.style.zIndex = '60'; // Controlled replay of the captured original property, immediately restored.
    const originalExposesAction = plane.contains(document.elementFromPoint(...center));
    plane.style.zIndex = original;
    const currentOccludesAction = !plane.contains(document.elementFromPoint(...center));
    const hit = { originalExposesAction, currentOccludesAction, currentZ: original, control: control.toJSON() };
    window.__f322ScrollProbeTrace.modal.push(hit);
    return hit;
  }, id);
  assert(hit.originalExposesAction, 'the original z60 property exposes the captured drawer hit failure');
  assert(hit.currentOccludesAction, 'the existing mobile drawer/backdrop keeps its hit plane above message actions');
  if (out) await page.screenshot({ path: path.join(out, `${name}-drawer-blocked.png`) });
  await enterReadingState(page, width);
  return true;
}

/** Controlled scroll range in the actual Next history; message content and its author slot stay real. */
export async function verifyNativeScrollport(page, row, out, name) {
  const id = await row.getAttribute('data-message-id');
  await row.evaluate((node) => {
    const column = node.closest('[data-thread-chat-reading-column]');
    for (const side of ['before', 'after']) {
      const spacer = document.createElement('div');
      spacer.dataset.actionScrollProbe = side;
      spacer.style.height = '1200px';
      if (side === 'before') column.prepend(spacer);
      else column.append(spacer);
    }
  });
  const observations = [];
  await beginNativeActionFrames(page, id);
  await startScrollProbeTrace(row);
  try {
    for (const width of [1440, 300]) {
      await page.setViewportSize({ width, height: 1000 });
      await enterReadingState(page, width);
      await beginNativeReadingGesture(page, row);
      if (await verifyCoarseDrawerHit(page, id, width, out, name)) await beginNativeReadingGesture(page, row);
      for (const edge of ['above', 'top', 'middle', 'bottom', 'below']) {
        await placeNativeAuthorEdge(page, row, edge);
        await waitForScrollProbe(page, id, edge, width, out, name);
        const observation = await page.evaluate((id) => {
          const row = document.querySelector(`[data-message-id="${id}"]`);
          const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
          const portNode = row.closest('[data-chat-container]');
          const port = portNode.getBoundingClientRect();
          const control = plane.firstElementChild.getBoundingClientRect();
          const slot = row.querySelector('[data-message-action-slot]').getBoundingClientRect();
          const button = plane.querySelector('button');
          button.focus({ preventScroll: true });
          return {
            slotTop: slot.top,
            portTop: Math.max(0, port.top + portNode.clientTop),
            portBottom: Math.min(window.innerHeight, port.top + portNode.clientTop + portNode.clientHeight),
            control: control.toJSON(),
            visibility: plane.style.visibility,
            inert: plane.hasAttribute('inert'),
            focused: button === document.activeElement,
            coarse: matchMedia('(pointer: coarse)').matches,
          };
        }, id);
        observations.push({ width, edge, ...observation });
        assertScrollportObservation(observation, name, width, edge);
        if (edge === 'middle') {
          if (out) await page.screenshot({ path: path.join(out, `${name}-${width}-scroll-middle.png`) });
        }
      }
    }
  } finally {
    await finishScrollProbeTrace(page, out, name);
    await finishNativeActionFrames(page, out, `${name}-scroll`);
    await row.evaluate((node) =>
      node
        .closest('[data-thread-chat-reading-column]')
        .querySelectorAll('[data-action-scroll-probe]')
        .forEach((spacer) => {
          spacer.remove();
        }),
    );
    if (out) await writeFile(path.join(out, `${name}-scrollport.json`), JSON.stringify(observations, null, 2));
    await row.scrollIntoViewIfNeeded();
  }
}
