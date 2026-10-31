import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/** Geometry for one trusted native pointer lifetime; RAF samples retain the preceding restore diagnostics. */
export async function probeDocumentReceiptClick(page, host, messageId, evidenceFile) {
  await page.evaluate((id) => {
    const probe = {
      samples: [],
      started: performance.now(),
      frame: null,
      pressed: false,
      pointerDown: null,
      pointerUp: null,
      pointerId: null,
      pointerDownCount: 0,
      pointerUpCount: 0,
    };
    const rectOf = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const snapshot = () => {
      const root = [...document.querySelectorAll('[data-message-id]')].find((node) => node.dataset.messageId === id);
      const button = root?.querySelector('button[aria-label="打开对照"]');
      const boundary = button?.closest('[data-message-viewport-boundary]');
      const rows = [...document.querySelectorAll('[data-message-viewport-boundary]')];
      const previous = rows[rows.indexOf(boundary) - 1];
      const ancestors = [];
      for (let node = button?.parentElement; node; node = node.parentElement) {
        const css = getComputedStyle(node);
        if (node.scrollHeight > node.clientHeight || css.contentVisibility !== 'visible' || css.transform !== 'none')
          ancestors.push({
            tag: node.tagName,
            top: node.scrollTop,
            height: node.clientHeight,
            contentHeight: node.scrollHeight,
            contentVisibility: css.contentVisibility,
            transform: css.transform,
          });
      }
      return {
        elapsed: performance.now() - probe.started,
        beforePointerDown: !probe.pressed,
        rect: rectOf(button),
        boundary: rectOf(boundary),
        previous: rectOf(previous),
        ancestors,
        boundaryDisplay: boundary ? getComputedStyle(boundary).display : null,
        previousDisplay: previous ? getComputedStyle(previous).display : null,
      };
    };
    probe.onDown = (event) => {
      const root = [...document.querySelectorAll('[data-message-id]')].find((node) => node.dataset.messageId === id);
      const button = root?.querySelector('button[aria-label="打开对照"]');
      if (!event.isTrusted || !button?.contains(event.target)) return;
      probe.pointerDownCount += 1;
      probe.pointerDown = snapshot();
      probe.pointerId = event.pointerId;
      probe.pressed = true;
    };
    probe.onUp = (event) => {
      if (!event.isTrusted || !probe.pointerDown || event.pointerId !== probe.pointerId) return;
      probe.pointerUpCount += 1;
      probe.pointerUp = snapshot();
    };
    document.addEventListener('pointerdown', probe.onDown, true);
    document.addEventListener('pointerup', probe.onUp, true);
    const sample = () => {
      probe.samples.push(snapshot());
      if (probe.samples.length < 1800) probe.frame = requestAnimationFrame(sample);
    };
    probe.frame = requestAnimationFrame(sample);
    window.__f309ReceiptClickProbe = probe;
  }, messageId);
  let observation;
  try {
    await host.getByRole('button', { name: '打开对照' }).click();
  } finally {
    observation = await page.evaluate(() => {
      const probe = window.__f309ReceiptClickProbe;
      cancelAnimationFrame(probe.frame);
      document.removeEventListener('pointerdown', probe.onDown, true);
      document.removeEventListener('pointerup', probe.onUp, true);
      delete window.__f309ReceiptClickProbe;
      return {
        samples: probe.samples,
        pointerDown: probe.pointerDown,
        pointerUp: probe.pointerUp,
        pointerId: probe.pointerId,
        pointerDownCount: probe.pointerDownCount,
        pointerUpCount: probe.pointerUpCount,
        presentation: localStorage.getItem('cat-cafe:shell-presentation') ?? 'classic',
      };
    });
    await writeFile(evidenceFile, `${JSON.stringify({ messageId, appUrl: page.url(), ...observation }, null, 2)}\n`);
  }
  assert.equal(observation.presentation, 'classic', 'this regression exercises adjacent production classic rows');
  const first = observation.pointerDown;
  const second = observation.pointerUp;
  assert.ok(first && second, 'the native action has a matched trusted pointerdown and pointerup');
  assert.equal(observation.pointerDownCount, 1, 'the probe records exactly one native press');
  assert.equal(observation.pointerUpCount, 1, 'the probe records exactly one matching native release');
  for (const endpoint of [first, second]) {
    assert.equal(endpoint.boundaryDisplay, 'flow-root');
    assert.equal(endpoint.previousDisplay, 'flow-root');
  }
  for (const rect of ['rect', 'boundary', 'previous']) {
    assert.ok(first[rect] && second[rect], 'both adjacent message boundaries remain mounted');
    assert.ok(Math.abs(first[rect].y - second[rect].y) < 0.1, `${rect} origin moved during the native click`);
    assert.ok(
      Math.abs(first[rect].height - second[rect].height) < 0.1,
      `${rect} height changed during the native click`,
    );
  }
}
