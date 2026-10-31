import assert from 'node:assert/strict';
import { BUSY_THREAD, cats } from './f322-chat-real-page-data.mjs';
import { measureSidebarSignalLayout } from './f322-sidebar-v2-data.mjs';

// This measurement runs inside Chromium, independent of Node and fixture-only styles.
export function measureChatProof() {
  const rect = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    const s = getComputedStyle(element);
    return {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      radius: parseFloat(s.borderRadius),
      border: parseFloat(s.borderTopWidth),
      background: s.backgroundColor,
      scroll: element.scrollWidth,
      client: element.clientWidth,
    };
  };
  const row = document.querySelector('[data-testid="chat-input-composer-row"]');
  const pane = document.querySelector('[data-testid="chat-proof-pane"]');
  const sidebar = document.querySelector('[data-shell-sidebar]');
  const context = row?.querySelector('[data-testid="chat-composer-context"]');
  const named = (labels) =>
    [...(row?.querySelectorAll('button') ?? [])].find((button) => labels.includes(button.getAttribute('aria-label')));
  const controls = [
    row?.querySelector('[aria-controls="composer-add-menu"]'),
    row?.querySelector('[data-testid="composer-project"]'),
    row?.querySelector('[data-testid="composer-routing-preview"]'),
    named(['语音输入', 'Voice input']),
    named(['发送消息', 'Send message']),
  ].map(rect);
  const busy = document.querySelector('[data-thread-id="composer-proof-1"]');
  const quiet = document.querySelector('[data-thread-id="composer-proof-3"]');
  const quietTitle = quiet?.querySelector('[role="link"]');
  const signals = busy?.querySelector('[data-testid="thread-row-signals"]');
  const working = busy?.querySelector('[data-testid="thread-row-working"]');
  const runningCat = busy?.querySelector('[data-testid="thread-running-cat"]');
  const avatars = [...(busy?.querySelectorAll('[data-testid="thread-signal-cats"] img') ?? [])].map((img) => {
    const ring = img.closest('.ring-2');
    return {
      name: img.alt,
      ring: ring ? getComputedStyle(ring).getPropertyValue('--tw-ring-color').trim() : null,
      loaded: img.complete && img.naturalWidth > 0,
    };
  });
  return {
    viewport: innerWidth,
    document: { client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
    pane: rect(pane),
    header: rect(pane?.querySelector('header')),
    sidebar: rect(sidebar),
    row: rect(row),
    textarea: rect(row?.querySelector('textarea')),
    context: rect(context),
    controls,
    signals: rect(signals),
    signalParts: [
      signals?.querySelector('[data-signal-presence]'),
      signals?.querySelector('[data-testid="thread-row-pills"]'),
    ]
      .filter(Boolean)
      .map(rect),
    busy: rect(busy),
    quiet: rect(quiet),
    quietTitle: rect(quietTitle),
    quietLineHeight: quietTitle ? parseFloat(getComputedStyle(quietTitle).lineHeight) : null,
    quietPadding: quiet
      ? parseFloat(getComputedStyle(quiet).paddingTop) + parseFloat(getComputedStyle(quiet).paddingBottom)
      : null,
    quietHasSignals: !!quiet?.querySelector('[data-testid="thread-row-signals"]'),
    working: rect(working),
    avatars,
    runningAnimation: runningCat ? getComputedStyle(runningCat).animationName : null,
    theme: document.documentElement.dataset.theme,
  };
}

/** Whole fixed facts, rather than intrinsic hidden text or a single horizontal row. */
export function assertChatSignalGeometry(layout, expectedHeight) {
  assert.equal(layout.height, expectedHeight, '20px signal rows retain their 4px gap');
  assert.ok(layout.contained && layout.noOverlap, 'fixed facts are contained and do not overlap in either dimension');
  assert.ok(layout.avatarsContained, 'every 16px avatar stays inside its roster owner');
  assert.ok(layout.namesWhole && layout.statusWhole, 'optional words are whole or hidden');
  assert.ok(layout.rightAligned, 'each badge row ends at the right edge');
  assert.ok(
    layout.badgeHeights.every((height) => height === 20),
    'badges do not shrink',
  );
  for (let i = 1; i < layout.badgeRows.length; i++) assert.equal(layout.badgeRows[i] - layout.badgeRows[i - 1], 24);
}

export async function assertChatSidebarSignals(page, busy, language, expectedHeight = 20, unread = '6') {
  const signals = busy.getByTestId('thread-row-signals');
  await signals.waitFor();
  await page.waitForFunction(
    ({ id, height }) =>
      document.querySelector(`[data-thread-id="${id}"] [data-testid="thread-row-signals"]`)?.getBoundingClientRect()
        .height === height,
    { id: await busy.getAttribute('data-thread-id'), height: expectedHeight },
  );
  const layout = await signals.evaluate(measureSidebarSignalLayout);
  assertChatSignalGeometry(layout, expectedHeight);
  assert.deepEqual(
    layout.badgeText,
    language === 'zh' ? ['草稿', '@你', `${unread} 未读`] : ['Draft', '@you', `${unread} unread`],
  );
  const status = busy.getByTestId('thread-status-text');
  const words = await busy.getByTestId('thread-status-label-content').evaluate((element) => ({
    text: element.textContent,
    visibility: getComputedStyle(element).visibility,
    width: element.getBoundingClientRect().width,
    slotWidth: element.parentElement.getBoundingClientRect().width,
  }));
  const full = language === 'zh' ? '执行中 · 7 分' : 'Running · 7 min';
  assert.equal(words.text, full, 'the entire canonical state and elapsed fact remains in the DOM');
  assert.equal(await status.getAttribute('aria-label'), full);
  assert.ok(layout.statusRecoverable, 'the visible symbol stays keyboard reachable');
  if (words.visibility === 'visible') {
    assert.ok(words.width <= words.slotWidth, 'visible status and elapsed fit whole');
  } else {
    assert.equal(words.visibility, 'hidden', 'status and elapsed hide as one unit');
    for (const method of ['focus', 'hover']) {
      await page.locator('textarea').focus();
      await status[method]();
      if (method === 'focus') {
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        assert.ok(await status.evaluate((node) => document.activeElement === node));
      }
      const tip = page.getByRole('tooltip').filter({ hasText: full });
      await tip.waitFor();
      assert.equal(await tip.innerText(), full, `${method} recovers the complete state and elapsed`);
      assert.equal((await signals.boundingBox()).height, expectedHeight, 'recovery does not change line count');
      await page.locator('textarea').hover();
      await page.locator('textarea').focus();
      await tip.waitFor({ state: 'detached' });
    }
  }
  await assertChatVirtualRows(page);
  return layout;
}

export async function assertChatSidebarRoster(page, busy, names) {
  const roster = busy.getByTestId('thread-signal-cats');
  assert.equal(await roster.locator('img').count(), 2, 'the summary shows two canonical faces');
  assert.equal(await roster.getByTestId('thread-cats-more').textContent(), `+${names.length - 1}`);
  assert.equal(await roster.getAttribute('aria-label'), names.join('、'), 'accessible roster is complete');
  const before = await busy.getByTestId('thread-row-signals').boundingBox();
  for (const method of ['focus', 'hover']) {
    await roster[method]();
    if (method === 'focus') {
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      assert.ok(await roster.evaluate((node) => document.activeElement === node));
    }
    const tip = page.getByRole('tooltip').filter({ hasText: names.at(-1) });
    await tip.waitFor();
    assert.equal(
      (await tip.innerText()).replace(/\s+/gu, ' ').trim(),
      names.join(' '),
      `${method} restores every canonical cat in order`,
    );
    assert.equal((await busy.getByTestId('thread-row-signals').boundingBox()).height, before.height);
    await page.locator('textarea').hover();
    await page.locator('textarea').focus();
    await tip.waitFor({ state: 'detached' });
  }
}

export async function assertChatVirtualRows(page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-virtual-row-key]')].every(
      (slot) =>
        Math.abs(slot.getBoundingClientRect().height - slot.firstElementChild.getBoundingClientRect().height) <= 1,
    ),
  );
  assert.ok(
    await page
      .locator('[data-virtual-row-key]')
      .evaluateAll((slots) =>
        slots.every(
          (slot, i) => !i || slots[i - 1].getBoundingClientRect().bottom <= slot.getBoundingClientRect().top + 1,
        ),
      ),
    'measured virtual slots do not overlap after reflow',
  );
}

/** Actual DOM counterexamples ensure containment/overlap checks cannot silently disappear. */
export async function assertChatSignalNegatives(busy, expectedHeight) {
  const signals = busy.getByTestId('thread-row-signals');
  const badge = signals.locator('[data-signal-badge]').last();
  const original = await badge.getAttribute('style');
  try {
    await badge.evaluate((node) => {
      node.style.transform = 'translateX(500px)';
    });
    const outside = await signals.evaluate(measureSidebarSignalLayout);
    assert.equal(outside.contained, false);
    assert.throws(() => assertChatSignalGeometry(outside, expectedHeight), /fixed facts/);
    await badge.evaluate((node) => {
      const faces = node
        .closest('[data-testid="thread-row-signals"]')
        .querySelector('[data-signal-fixed="faces"]')
        .getBoundingClientRect();
      const box = node.getBoundingClientRect();
      node.style.transform = `translate(${faces.left - box.left + 500}px, ${faces.top - box.top}px)`;
    });
    const overlap = await signals.evaluate(measureSidebarSignalLayout);
    assert.equal(overlap.noOverlap, false);
    assert.throws(() => assertChatSignalGeometry(overlap, expectedHeight), /fixed facts/);
  } finally {
    await badge.evaluate(
      (node, style) => (style === null ? node.removeAttribute('style') : node.setAttribute('style', style)),
      original,
    );
  }
  assertChatSignalGeometry(await signals.evaluate(measureSidebarSignalLayout), expectedHeight);
}

export async function assertCrowdedChatSidebar(harness, memberRows, groupToggle, memberMutations) {
  const names = [...cats.map((cat) => cat.displayName), ...Array.from({ length: 9 }, (_, i) => `Partner ${i + 4}`)];
  for (const language of ['zh', 'en']) {
    const proof = await harness.openProof({ width: 700, base: 'dark', language, crowded: true, resizable: true });
    const { page } = proof;
    try {
      const busy = page.locator(`[data-thread-id="${BUSY_THREAD}"]`);
      for (const width of [300, 240, 160, 300]) {
        const sidebar = page.locator('[data-shell-sidebar="v2"]');
        const previous = (await sidebar.boundingBox()).width;
        if (previous !== width) {
          const handle = page.getByRole('separator', { name: '侧栏分隔条' });
          const box = await handle.boundingBox();
          await page.mouse.move(box.x + 2, 250);
          await page.mouse.down();
          await page.mouse.move(box.x + 2 + width - previous, 250, { steps: 8 });
          await page.mouse.up();
        }
        const expected = width === 300 ? 20 : width === 240 ? 44 : 68;
        await assertChatSidebarSignals(page, busy, language, expected, '99+');
        await assertChatSidebarRoster(page, busy, names);
        const m = await harness.capture(page, `700-crowded-${language}-${width}`);
        assert.equal(m.sidebar.width, width);
        assert.equal(m.busy.height, expected + 56);
        assert.equal(m.quietHasSignals, false, 'quiet rows do not acquire a signal line');
        assert.ok(
          [1, 2].includes(m.quietTitle.height / m.quietLineHeight),
          'quiet titles keep the accepted two-line limit',
        );
        assert.equal(m.quiet.height, m.quietTitle.height + m.quietPadding, 'quiet row height follows its actual title');
        await groupToggle(page).click();
        await memberRows(page).first().waitFor({ state: 'detached' });
        const group = await page.getByTestId('group-status-line').evaluate(measureSidebarSignalLayout);
        assertChatSignalGeometry(group, group.split === 'true' ? 20 + group.badgeRows.length * 24 : 20);
        await assertChatVirtualRows(page);
        await groupToggle(page).click();
        await busy.waitFor();
        await assertChatSidebarSignals(page, busy, language, expected, '99+');
        if (language === 'en' && width === 160) await assertChatSignalNegatives(busy, expected);
      }
      assert.equal(memberMutations(proof.api).filter((request) => request.method !== 'GET').length, 0);
    } finally {
      await harness.closeProof(proof);
    }
  }
}
