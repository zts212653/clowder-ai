import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadReadbackCapture } from '../fixtures/f322-readback-public-projection.mjs';
import {
  beginActionOwnerDiagnostics,
  recordSheetPhase,
  saveActionOwnerDiagnostics,
} from './f322-action-owner-diagnostics.mjs';
import { focusCommittedNativeAction, waitForNativeActionMeasurement } from './f322-native-action-state.mjs';
import { readbackResponse, startNativeHost } from './f322-native-reply-next.mjs';
import {
  beginNativeActionFrames,
  finishNativeActionFrames,
  saveNativeActionFailure,
} from './f322-native-reply-reading.mjs';
import {
  beginNativeReadingGesture,
  finishScrollProbeTrace,
  placeNativeAuthorEdge,
  startScrollProbeTrace,
  waitForScrollProbe,
} from './f322-native-scroll-probe-state.mjs';
import { verifySelectionDuringPeerGrowth } from './f322-selection-pending.journey.mjs';

const sheetCases = [
  { name: 'retained-compact', overflow: false, offscreen: false },
  { name: 'retained-overflow', overflow: true, offscreen: false },
  { name: 'clipped-compact', overflow: false, offscreen: true },
  { name: 'clipped-overflow', overflow: true, offscreen: true },
];

async function openOwnedRow(browser, host, trace, user, width) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    localStorage.setItem('cat-cafe:shell-language', 'zh');
    localStorage.setItem('theme', 'light');
  });
  const page = await context.newPage();
  const message = user
    ? {
        ...trace.api,
        from: { kind: 'user', userId: trace.userId },
        type: 'user',
        catId: undefined,
        extra: undefined,
        content: '用户完整消息。',
      }
    : trace.api;
  await page.route('**/api/**', async (route) => {
    const response = readbackResponse(route.request(), trace, message);
    await route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
  await page.goto(`${host.url}/thread/${trace.threadId}?shell=v2`, { waitUntil: 'networkidle' });
  const row = page.locator(`[data-message-id="${message.id}"]`).last();
  await row.waitFor();
  const collapse = page.getByTestId('sidebar-collapse');
  if (await collapse.isVisible()) {
    await collapse.click();
    await collapse.waitFor({ state: 'hidden' });
  }
  await row.scrollIntoViewIfNeeded();
  await waitForNativeActionMeasurement(page, message.id, width);
  return { context, page, row, id: message.id };
}

async function recordCase(browser, host, trace, results, out, name, user, width, execute) {
  const owned = await openOwnedRow(browser, host, trace, user, width);
  try {
    await beginActionOwnerDiagnostics(owned.page);
    await beginNativeActionFrames(owned.page, owned.id);
    await execute(owned);
    await finishNativeActionFrames(owned.page, out, name);
    results.push({ name, status: 'passed' });
    if (out) await owned.page.screenshot({ path: path.join(out, `${name}-passed.png`) });
  } catch (error) {
    results.push({ name, status: 'failed', error: String(error) });
    if (out) {
      await saveNativeActionFailure(owned.page, out, name);
      await owned.page.screenshot({ path: path.join(out, `${name}-failed.png`) });
      await writeFile(path.join(out, `${name}-dom.txt`), await owned.page.locator('body').innerText());
    }
  } finally {
    await saveActionOwnerDiagnostics(owned.page, out, name);
    await owned.context.close();
  }
}

async function addEdgeSpacers(row) {
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
}

async function hideOpenSheet({ page, row, id }, overflow, offscreen, out, name) {
  const history = page.locator('[data-thread-chat-history]');
  if (offscreen) {
    await addEdgeSpacers(row);
    await startScrollProbeTrace(row);
    await beginNativeReadingGesture(page, row);
    await placeNativeAuthorEdge(page, row, 'middle');
    await waitForScrollProbe(page, id, 'middle', 300, out, name);
  }
  await recordSheetPhase(page, id, 'before-initial-focus');
  await focusCommittedNativeAction(page, id, 'message-actions-compact-trigger');
  await recordSheetPhase(page, id, 'after-initial-focus');
  await page.keyboard.press('Enter');
  await recordSheetPhase(page, id, 'after-initial-enter');
  const compact = page.getByTestId('message-actions-compact-sheet');
  await compact.waitFor();
  await recordSheetPhase(page, id, 'initial-sheet-open');
  if (overflow) {
    await compact.getByRole('button', { name: '更多消息操作', exact: true }).focus();
    await page.keyboard.press('Enter');
  }
  const surface = overflow ? page.getByRole('menu', { name: '更多消息操作', exact: true }) : compact;
  await surface.waitFor();
  const handle = await surface.elementHandle();
  await surface.locator('button').first().focus();
  if (offscreen) {
    // The modal backdrop correctly receives wheel input. Resize the actual
    // viewport to clip its author while the sheet remains open instead.
    await page.setViewportSize({ width: 300, height: 350 });
    await page.waitForFunction((id) => {
      const row = document.querySelector(`[data-message-id="${id}"]`);
      const port = row.closest('[data-chat-container]').getBoundingClientRect();
      const slot = row.querySelector('[data-message-action-slot]').getBoundingClientRect();
      return slot.top < port.top || slot.top > port.bottom;
    }, id);
  } else {
    await history.evaluate((node) => {
      node.setAttribute('inert', '');
      node.setAttribute('aria-hidden', 'true');
    });
  }
  await page.waitForFunction((id) => {
    const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
    return plane.style.visibility === 'hidden' && plane.hasAttribute('inert');
  }, id);
  // A transient pending gate is not a retired owner. Observe the chosen close path before restoring it.
  await page.waitForFunction((node) => !node.isConnected, handle);
  assert.equal(await surface.isVisible(), false, `${overflow ? 'overflow' : 'compact'} sheet retains hidden ownership`);
  assert.equal(
    await handle.evaluate((node) => node.contains(document.activeElement)),
    false,
    'retired sheet retained focus',
  );
  await recordSheetPhase(page, id, 'retired');
  await history.evaluate((node) => {
    node.removeAttribute('inert');
    node.removeAttribute('aria-hidden');
  });
  if (offscreen) {
    await page.setViewportSize({ width: 300, height: 1000 });
    await beginNativeReadingGesture(page, row);
    await placeNativeAuthorEdge(page, row, 'middle');
    await waitForScrollProbe(page, id, 'middle', 300, out, name);
  }
  await waitForNativeActionMeasurement(page, id, 300);
  await recordSheetPhase(page, id, 'before-recovered-focus');
  await focusCommittedNativeAction(page, id, 'message-actions-compact-trigger');
  await recordSheetPhase(page, id, 'after-recovered-focus');
  await page.keyboard.press('Enter');
  await recordSheetPhase(page, id, 'after-recovered-enter');
  await compact.waitFor();
  if (overflow) {
    await compact.getByRole('button', { name: '更多消息操作', exact: true }).focus();
    await page.keyboard.press('Enter');
  }
  await surface.waitFor();
  await surface.locator('button').last().focus();
  assert(await surface.evaluate((node) => node.contains(document.activeElement)), 'recovered sheet is not focusable');
  await page.keyboard.press('Escape');
  await surface.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    (id) => document.querySelector(`[data-message-actions-owner="${id}"] button`) === document.activeElement,
    id,
  );
  if (offscreen) await finishScrollProbeTrace(page, out, name);
}

async function openEdgeMenus({ page, row, id }, out, name) {
  await addEdgeSpacers(row);
  await startScrollProbeTrace(row);
  await beginNativeReadingGesture(page, row);
  const observations = [];
  try {
    for (const edge of ['top', 'bottom']) {
      await placeNativeAuthorEdge(page, row, edge);
      await waitForScrollProbe(page, id, edge, 1440, out, name);
      const plane = page.locator(`[data-message-actions-owner="${id}"]`);
      await plane.getByRole('button', { name: '更多消息操作', exact: true }).focus();
      await page.keyboard.press('Enter');
      const menu = page.getByRole('menu', { name: '更多消息操作', exact: true });
      await menu.waitFor();
      await waitForNativeActionMeasurement(page, id, 1440);
      await menu.locator('button').last().focus();
      const snapshot = await menu.evaluate((node) => {
        const plane = node.closest('[data-message-actions-owner]');
        const row = document.querySelector(`[data-message-id="${plane.dataset.messageActionsOwner}"]`);
        const port = row.closest('[data-chat-container]');
        const column = row.closest('[data-thread-chat-reading-column]');
        const bounds = port.getBoundingClientRect(),
          col = column.getBoundingClientRect(),
          rect = node.getBoundingClientRect();
        return {
          slotTop: row.querySelector('[data-message-action-slot]').getBoundingClientRect().top,
          rect: rect.toJSON(),
          left: Math.max(0, bounds.left + port.clientLeft, col.left),
          right: Math.min(innerWidth, bounds.left + port.clientLeft + port.clientWidth, col.right),
          top: Math.max(0, bounds.top + port.clientTop),
          bottom: Math.min(innerHeight, bounds.top + port.clientTop + port.clientHeight),
        };
      });
      observations.push({ edge, ...snapshot });
      if (out) await page.screenshot({ path: path.join(out, `${name}-${edge}.png`) });
      assert(
        snapshot.rect.left >= snapshot.left &&
          snapshot.rect.right <= snapshot.right &&
          snapshot.rect.top >= snapshot.top &&
          snapshot.rect.bottom <= snapshot.bottom,
        `${edge} More escapes safeRect: ${JSON.stringify(snapshot)}`,
      );
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
    }
  } finally {
    await finishScrollProbeTrace(page, out, name);
    if (out) await writeFile(path.join(out, `${name}-edges.json`), JSON.stringify(observations, null, 2));
  }
}

async function changeAuthorWithoutResize({ page, row, id }, out) {
  await row.hover();
  await page.evaluate(() => document.fonts.ready);
  const snapshot = () =>
    page.evaluate((id) => {
      const row = document.querySelector(`[data-message-id="${id}"]`),
        plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
      const column = row.closest('[data-thread-chat-reading-column]'),
        port = row.closest('[data-chat-container]');
      return {
        row: row.getBoundingClientRect().toJSON(),
        column: column.getBoundingClientRect().toJSON(),
        port: port.getBoundingClientRect().toJSON(),
        slot: row.querySelector('[data-message-action-slot]').getBoundingClientRect().toJSON(),
        plane: plane.getBoundingClientRect().toJSON(),
        epoch: column.dataset.messageActionsEpoch,
        committed: plane.dataset.messageActionsCommittedEpoch,
      };
    }, id);
  const before = await snapshot();
  await row.getByTestId('cat-nameplate-name').evaluate((node) => {
    node.firstChild.nodeValue = '缅因小猫';
    node.title = '缅因小猫';
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await snapshot();
  if (out) await writeFile(path.join(out, 'author-text-translation.json'), JSON.stringify({ before, after }, null, 2));
  assert.equal(after.row.width, before.row.width);
  assert.equal(after.row.height, before.row.height);
  assert.equal(after.column.width, before.column.width);
  assert.equal(after.port.width, before.port.width);
  assert.notEqual(after.slot.left, before.slot.left);
  assert.notEqual(after.epoch, before.epoch, 'author text did not invalidate the current epoch');
  assert.equal(after.committed, after.epoch);
  assert(Math.abs(after.plane.left - after.slot.right) <= 1, 'paint stopped following the real author slot');
}

export async function runActionOwnerNextJourney(browser, evidenceDir) {
  const source = loadReadbackCapture();
  const trace = source.traces[0],
    results = [];
  const out =
    process.env.F322_ACTION_OWNER_EVIDENCE_DIR ??
    (evidenceDir ? path.join(evidenceDir, 'action-owner-next') : undefined);
  if (out) await mkdir(out, { recursive: true });
  const host = await startNativeHost();
  try {
    await host.ready();
    for (const { name, offscreen, overflow } of sheetCases)
      await recordCase(browser, host, trace, results, out, name, false, 300, (owned) =>
        hideOpenSheet(owned, overflow, offscreen, out, name),
      );
    for (const user of [false, true])
      await recordCase(browser, host, trace, results, out, `more-${user ? 'user' : 'assistant'}`, user, 1440, (owned) =>
        openEdgeMenus(owned, out, `more-${user ? 'user' : 'assistant'}`),
      );
    await recordCase(browser, host, trace, results, out, 'author-translation', false, 1440, (owned) =>
      changeAuthorWithoutResize(owned, out),
    );
    await recordCase(browser, host, trace, results, out, 'selection-peer-growth', false, 1440, (owned) =>
      verifySelectionDuringPeerGrowth(owned, out),
    );
  } finally {
    await host.close();
    if (out) await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  }
  assert.deepEqual(
    results.filter((result) => result.status === 'failed'),
    [],
    'real action owner regressions',
  );
}
