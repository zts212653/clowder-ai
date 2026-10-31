import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertActionFrame } from './f322-action-frame-contract.mjs';

export { waitForNativeActionMeasurement } from './f322-native-action-state.mjs';

export async function beginNativeActionFrames(page, id) {
  await page.evaluate((id) => {
    const state = { active: true, frames: [] };
    window.__f322NativeActionFrames = state;
    const sample = () => {
      if (!state.active || state.frames.length >= 500) return;
      const row = document.querySelector(`[data-message-id="${id}"]`);
      const column = row?.closest('[data-thread-chat-reading-column]');
      const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
      if (row && column && plane) {
        const bounds = column.getBoundingClientRect();
        const portNode = column.closest('[data-chat-container]');
        const port = portNode.getBoundingClientRect();
        const slot = row.querySelector('[data-message-action-slot]').getBoundingClientRect();
        state.frames.push({
          viewport: window.innerWidth,
          rowClient: row.clientWidth,
          rowScroll: row.scrollWidth,
          portClient: portNode.clientWidth,
          portScroll: portNode.scrollWidth,
          slotWidth: slot.width,
          slotHeight: slot.height,
          measuredViewport: plane.dataset.messageActionsViewport,
          measuredColumn: plane.dataset.messageActionsColumnWidth,
          visibility: getComputedStyle(plane).visibility,
          ready: plane.dataset.messageActionsReady,
          committedEpoch: plane.dataset.messageActionsCommittedEpoch ?? null,
          latestEpoch: column.dataset.messageActionsEpoch,
          ariaHidden: plane.getAttribute('aria-hidden'),
          activeDescendant: plane.contains(document.activeElement),
          inert: plane.hasAttribute('inert'),
          surfaces: [...document.querySelectorAll(`[data-message-action-owned="${id}"]`)].map((node) => ({
            source: node.dataset.messageActionSource,
            state: node.dataset.messageActionState,
            rect: node.getBoundingClientRect().toJSON(),
            visibility: getComputedStyle(node).visibility,
            inert: node.hasAttribute('inert'),
            ariaHidden: node.getAttribute('aria-hidden'),
            activeDescendant: node.contains(document.activeElement),
          })),
          controls: [
            ...plane.querySelectorAll(
              '[data-testid="message-actions-toolbar"], [data-testid="message-actions-compact-trigger"], [data-message-actions-menu]',
            ),
          ].map((node) => {
            const box = node.getBoundingClientRect();
            return {
              kind: node.dataset.testid ?? 'expanded-menu',
              visibility: getComputedStyle(node).visibility,
              left: box.left,
              right: box.right,
              columnLeft: bounds.left,
              columnRight: bounds.right,
              top: box.top,
              bottom: box.bottom,
              portLeft: Math.max(0, port.left + portNode.clientLeft),
              portRight: Math.min(window.innerWidth, port.left + portNode.clientLeft + portNode.clientWidth),
              portTop: Math.max(0, port.top + portNode.clientTop),
              portBottom: Math.min(window.innerHeight, port.top + portNode.clientTop + portNode.clientHeight),
            };
          }),
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, id);
}

export async function verifyNativeHistoryOwner(page, id) {
  const history = page.locator('[data-thread-chat-history]');
  // Controlled input at the real retained-history DOM seam, not a claim that the F307 toggle itself was exercised.
  await history.evaluate((node) => {
    node.setAttribute('inert', '');
    node.setAttribute('aria-hidden', 'true');
  });
  await page.waitForFunction((id) => {
    const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
    return plane?.hasAttribute('inert') && plane.style.visibility === 'hidden';
  }, id);
  const plane = page.locator(`[data-message-actions-owner="${id}"]`);
  assert(
    await plane
      .locator('button')
      .first()
      .evaluate((node) => {
        node.focus();
        return node !== document.activeElement;
      }),
    'the retained hidden history cannot expose focusable portal actions',
  );
  await history.evaluate((node) => {
    node.removeAttribute('inert');
    node.removeAttribute('aria-hidden');
  });
  await page.waitForFunction((id) => {
    const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
    return plane && !plane.hasAttribute('inert') && plane.style.visibility === 'visible';
  }, id);
}

export async function finishNativeActionFrames(page, out, name) {
  const frames = await page.evaluate(() => {
    window.__f322NativeActionFrames.active = false;
    return window.__f322NativeActionFrames.frames;
  });
  if (out) await writeFile(path.join(out, `${name}-action-frames.json`), JSON.stringify(frames, null, 2));
  assert(frames.length > 0, `${name}: actual action frames must be observed`);
  for (const frame of frames) assertActionFrame(frame, name);
}

export async function observeNativeReading(page, row, out, name, measurements) {
  const id = await row.getAttribute('data-message-id');
  const paint = page.locator(`[data-message-actions-owner="${id}"]`);
  const actions = (await paint.count())
    ? await paint.evaluate((node) => {
        const row = document.querySelector(`[data-message-id="${node.dataset.messageActionsOwner}"]`);
        const column = row.closest('[data-thread-chat-reading-column]');
        const bounds = column.getBoundingClientRect();
        const port = column.closest('[data-chat-container]').getBoundingClientRect();
        return [
          ...node.querySelectorAll(
            '[data-testid="message-actions-toolbar"], [data-testid="message-actions-compact-trigger"], [data-message-actions-menu]',
          ),
        ].map((control) => {
          const rect = control.getBoundingClientRect();
          return {
            id: control.dataset.testid,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            columnLeft: bounds.left,
            columnRight: bounds.right,
            insideRow: row.contains(control),
            measuredViewport: node.dataset.messageActionsViewport,
            viewport: window.innerWidth,
            measuredColumn: node.dataset.messageActionsColumnWidth,
            ready: node.dataset.messageActionsReady,
            style: node.style.cssText,
            inert: node.hasAttribute('inert'),
            visibility: node.style.visibility,
            scrollportLeft: Math.max(0, port.left + column.closest('[data-chat-container]').clientLeft),
            scrollportRight: Math.min(
              window.innerWidth,
              port.left +
                column.closest('[data-chat-container]').clientLeft +
                column.closest('[data-chat-container]').clientWidth,
            ),
            scrollportTop: Math.max(0, port.top + column.closest('[data-chat-container]').clientTop),
            scrollportBottom: Math.min(
              window.innerHeight,
              port.top +
                column.closest('[data-chat-container]').clientTop +
                column.closest('[data-chat-container]').clientHeight,
            ),
          };
        });
      })
    : [];
  for (const action of actions) {
    assert(!action.insideRow, `${name}: action paint must leave message scroll geometry`);
    assert(
      action.left >= action.columnLeft - 1 && action.right <= action.columnRight + 1,
      `${name}: even hidden action paint is contained ${JSON.stringify(action)}`,
    );
    assert(
      (action.top >= action.scrollportTop - 1 && action.bottom <= action.scrollportBottom + 1) ||
        (action.visibility === 'hidden' && action.inert),
      `${name}: action paint escapes the chat scrollport ${JSON.stringify(action)}`,
    );
  }
  const values = await row.evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    overflow: [...node.querySelectorAll('*')]
      .filter((item) => item.getBoundingClientRect().right > node.getBoundingClientRect().right + 1)
      .map((item) => ({
        tag: item.tagName,
        testid: item.getAttribute('data-testid'),
        cls: item.className,
        text: item.textContent?.slice(0, 100),
        right: item.getBoundingClientRect().right,
        parentRight: item.parentElement?.getBoundingClientRect().right,
        width: item.getBoundingClientRect().width,
        scrollWidth: item.scrollWidth,
        clientWidth: item.clientWidth,
      })),
    answer: node.querySelector('[data-testid="native-reply-answer"]')?.textContent,
    process: [...node.querySelectorAll('[data-reply-output-kind="process"]')].map((element) => element.textContent),
  }));
  assert(values.scrollWidth <= values.clientWidth + 1, `${name}: host overflow ${JSON.stringify(values)}`);
  measurements.push({ name, ...values, actions });
  if (out) await page.screenshot({ path: path.join(out, `${name}.png`) });
}

export async function saveNativeActionFailure(page, out, name) {
  const state = await page.evaluate(() => {
    const frames = window.__f322NativeActionFrames;
    if (frames) frames.active = false;
    return {
      viewport: window.innerWidth,
      planes: [...document.querySelectorAll('[data-message-actions-owner]')].map((node) => ({
        owner: node.dataset.messageActionsOwner,
        ready: node.dataset.messageActionsReady,
        measuredViewport: node.dataset.messageActionsViewport,
        measuredColumn: node.dataset.messageActionsColumnWidth,
        style: node.style.cssText,
        controls: [...node.children].map((child) => ({
          id: child.dataset.testid,
          rect: child.getBoundingClientRect().toJSON(),
        })),
      })),
      frames: frames?.frames ?? [],
    };
  });
  await writeFile(path.join(out, `${name}-action-failure.json`), JSON.stringify(state, null, 2));
}

export async function runNarrowUserActionJourney(open) {
  for (const [width, viewportWidth] of [
    [216, 300],
    [336, 420],
  ]) {
    const { page, errors, unexpected } = await open({ width, viewportWidth, base: 'light' });
    const row = page.locator('[data-message-id="c-user"]');
    await row.scrollIntoViewIfNeeded();
    const before = await row.boundingBox();
    await row.hover();
    const paint = page.locator('[data-message-actions-owner="c-user"]');
    const trigger = paint.getByTestId('message-actions-compact-trigger');
    await trigger.waitFor();
    await page.waitForFunction((id) => {
      const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
      return plane?.style.visibility === 'visible' && !plane.hasAttribute('inert');
    }, 'c-user');
    await trigger.focus();
    assert(
      await trigger.evaluate((node) => node === document.activeElement),
      'the measured compact owner accepts keyboard focus',
    );
    const box = await trigger.boundingBox();
    const column = await page.getByTestId('column').boundingBox();
    assert.equal(box.width, 44);
    assert.equal(box.height, 44);
    assert(box.x >= column.x && box.x + box.width <= column.x + column.width);
    await page.keyboard.press('Enter');
    const sheet = page.getByTestId('message-actions-compact-sheet');
    await sheet.waitFor();
    assert((await sheet.getByRole('button').count()) >= 4, 'existing user actions remain reachable');
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    await page.waitForFunction((id) => {
      const plane = document.querySelector(`[data-message-actions-owner="${id}"]`);
      const column = document.querySelector(`[data-message-id="${id}"]`)?.closest('[data-thread-chat-reading-column]');
      return (
        plane?.dataset.messageActionsReady === 'true' &&
        plane.dataset.messageActionsCommittedEpoch === column?.dataset.messageActionsEpoch &&
        plane.querySelector('button') === document.activeElement
      );
    }, 'c-user');
    assert(await trigger.evaluate((node) => node === document.activeElement));
    const after = await row.boundingBox();
    assert.equal(after.y, before.y);
    assert.equal(after.height, before.height);
    assert(await row.evaluate((node) => node.scrollWidth <= node.clientWidth));
    const slot = await row.locator('[data-message-action-slot]').boundingBox();
    assert.equal(slot.width, 0);
    assert.equal(slot.height, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    await page.close();
  }
}
