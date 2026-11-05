import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function startScrollProbeTrace(row) {
  await row.evaluate((node) => {
    const port = node.closest('[data-chat-container]');
    const column = node.closest('[data-thread-chat-reading-column]');
    const end = column.querySelector('[data-action-scroll-probe="after"]').previousElementSibling;
    const original = end.scrollIntoView;
    const trace = { writes: [], inputs: [], modal: [], end };
    window.__f322ScrollProbeTrace = trace;
    end.scrollIntoView = function (...args) {
      if (trace.writes.length < 100)
        trace.writes.push({ kind: 'end-scroll-into-view', before: port.scrollTop, stack: new Error().stack });
      return original.apply(this, args);
    };
  });
}

export async function finishScrollProbeTrace(page, out, name) {
  const trace = await page.evaluate(() => {
    const trace = window.__f322ScrollProbeTrace;
    delete trace.end.scrollIntoView;
    return { writes: trace.writes, inputs: trace.inputs, modal: trace.modal };
  });
  if (out) await writeFile(path.join(out, `${name}-scroll-writers.json`), JSON.stringify(trace, null, 2));
}

/** Native input retires the history owner's pending bottom/reflow restoration before controlled edge placement. */
export async function beginNativeReadingGesture(page, row) {
  const input = await row.evaluate((node) => {
    const port = node.closest('[data-chat-container]');
    const bounds = port.getBoundingClientRect();
    const slot = node.querySelector('[data-message-action-slot]').getBoundingClientRect();
    port.scrollTop += slot.top - (bounds.top + bounds.bottom) / 2;
    const count = window.__f322ScrollProbeTrace.inputs.length;
    const onScrollEnd = () => {
      if (window.__f322ScrollProbeTrace.inputs.length <= count) return;
      window.__f322ScrollProbeTrace.settledInputCount = count + 1;
      port.removeEventListener('scrollend', onScrollEnd);
    };
    port.addEventListener('scrollend', onScrollEnd);
    port.addEventListener(
      'wheel',
      (event) => {
        window.__f322ScrollProbeTrace.inputs.push({ trusted: event.isTrusted, deltaY: event.deltaY });
      },
      { once: true, passive: true },
    );
    return { x: bounds.left + 20, y: (bounds.top + bounds.bottom) / 2, count };
  });
  await page.mouse.move(input.x, input.y);
  await page.mouse.wheel(0, -32);
  await page.waitForFunction((count) => {
    const inputs = window.__f322ScrollProbeTrace.inputs;
    return inputs.length > count && inputs.at(-1).trusted && window.__f322ScrollProbeTrace.settledInputCount > count;
  }, input.count);
}

/** Move the real scrollport through native input so its reading owner captures each new position. */
export async function placeNativeAuthorEdge(page, row, edge) {
  const input = await row.evaluate((node, edge) => {
    const port = node.closest('[data-chat-container]');
    const bounds = port.getBoundingClientRect();
    const top = Math.max(0, bounds.top + port.clientTop);
    const bottom = Math.min(innerHeight, bounds.top + port.clientTop + port.clientHeight);
    const target = { above: top - 1, top: top + 1, middle: (top + bottom) / 2, bottom: bottom - 1, below: bottom + 1 }[
      edge
    ];
    const slot = node.querySelector('[data-message-action-slot]').getBoundingClientRect();
    return { x: bounds.left + 20, y: (top + bottom) / 2, delta: slot.top - target };
  }, edge);
  await page.mouse.move(input.x, input.y);
  await page.mouse.wheel(0, input.delta);
}

function currentScrollProbe({ id, edge }) {
  const row = document.querySelector(`[data-message-id="${id}"]`);
  const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
  if (!row || !plane) return false;
  const column = row.closest('[data-thread-chat-reading-column]');
  const port = row.closest('[data-chat-container]');
  const box = port.getBoundingClientRect();
  const top = Math.max(0, box.top + port.clientTop),
    bottom = Math.min(window.innerHeight, box.top + port.clientTop + port.clientHeight);
  const slot = row.querySelector('[data-message-action-slot]').getBoundingClientRect();
  const target = { above: top - 1, top: top + 1, middle: (top + bottom) / 2, bottom: bottom - 1, below: bottom + 1 }[
    edge
  ];
  if (Math.abs(slot.top - target) > 1) return false;
  const closed =
    getComputedStyle(plane).visibility === 'hidden' &&
    plane.hasAttribute('inert') &&
    plane.getAttribute('aria-hidden') === 'true' &&
    !plane.contains(document.activeElement);
  if (edge === 'above' || edge === 'below') return closed;
  return (
    plane.dataset.messageActionsReady === 'true' &&
    plane.dataset.messageActionsCommittedEpoch === column.dataset.messageActionsEpoch &&
    Number(plane.dataset.messageActionsAnchorTop) === slot.top &&
    Number(plane.dataset.messageActionsPortTop) === top &&
    Number(plane.dataset.messageActionsPortBottom) === bottom
  );
}

export async function waitForScrollProbe(page, id, edge, width, out, name) {
  try {
    await page.waitForFunction(currentScrollProbe, { id, edge });
  } catch (error) {
    const diagnostic = await page.evaluate(
      ({ id, edge, width }) => {
        const row = document.querySelector(`[data-message-id="${id}"]`);
        const slot = row.querySelector('[data-message-action-slot]');
        const port = row.closest('[data-chat-container]');
        const column = row.closest('[data-thread-chat-reading-column]');
        const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
        return {
          edge,
          width,
          row: row.getBoundingClientRect().toJSON(),
          slot: slot.getBoundingClientRect().toJSON(),
          column: column.getBoundingClientRect().toJSON(),
          port: port.getBoundingClientRect().toJSON(),
          clientTop: port.clientTop,
          clientHeight: port.clientHeight,
          scrollTop: port.scrollTop,
          plane: {
            dataset: { ...plane.dataset },
            style: plane.getAttribute('style'),
            inert: plane.hasAttribute('inert'),
          },
          epoch: column.dataset.messageActionsEpoch,
          owners: document.querySelectorAll(`[data-message-id="${id}"]`).length,
          writes: window.__f322ScrollProbeTrace.writes,
          inputs: window.__f322ScrollProbeTrace.inputs,
        };
      },
      { id, edge, width },
    );
    if (out) {
      await writeFile(path.join(out, `${name}-scroll-wait-failure.json`), JSON.stringify(diagnostic, null, 2));
      await page.screenshot({ path: path.join(out, `${name}-scroll-wait-failure.png`) });
    }
    throw error;
  }
}
