import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Read-only native input/ownership observations; no event is synthesized or state altered. */
export async function beginActionOwnerDiagnostics(page) {
  await page.evaluate(() => {
    const diagnostics = { phases: [], events: [] };
    window.__f322ActionOwnerDiagnostics = diagnostics;
    for (const type of ['focusin', 'focusout', 'keydown', 'keyup', 'scroll'])
      document.addEventListener(
        type,
        (event) => {
          if (diagnostics.events.length >= 100) return;
          diagnostics.events.push({
            type,
            at: performance.now(),
            key: event.key,
            target: event.target?.dataset?.testid ?? event.target?.tagName,
          });
        },
        true,
      );
  });
}

export async function recordSheetPhase(page, id, phase) {
  await page.evaluate(
    ({ id, phase }) => {
      const row = document.querySelector(`[data-message-id="${id}"]`);
      const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
      const port = row.closest('[data-chat-container]');
      const active = document.activeElement;
      window.__f322ActionOwnerDiagnostics.phases.push({
        phase,
        at: performance.now(),
        slot: row.querySelector('[data-message-action-slot]').getBoundingClientRect().toJSON(),
        port: port.getBoundingClientRect().toJSON(),
        scrollTop: port.scrollTop,
        dataset: { ...plane.dataset },
        active: { tag: active?.tagName, testid: active?.dataset?.testid },
        sheets: [...document.querySelectorAll('[data-message-action-owned]')].map((node) => ({
          testid: node.dataset.testid,
          state: node.dataset.messageActionState,
          visibility: getComputedStyle(node).visibility,
          inert: node.hasAttribute('inert'),
        })),
        history: window.__f322ScrollProbeTrace
          ? {
              writes: window.__f322ScrollProbeTrace.writes,
              inputs: window.__f322ScrollProbeTrace.inputs,
            }
          : null,
      });
    },
    { id, phase },
  );
}

export async function saveActionOwnerDiagnostics(page, out, name) {
  if (out)
    await writeFile(
      path.join(out, `${name}-phases.json`),
      JSON.stringify(await page.evaluate(() => window.__f322ActionOwnerDiagnostics), null, 2),
    );
}
