import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const OLD_WEB_REVISION = 'a'.repeat(40);
const NEW_SERVER_REVISION = 'b'.repeat(40);
const GROUP_FIRST_TITLE = '这是一条足够长的分组交互卡标题，用来证明转发动作不会遮住可读内容';

function overlapArea(first, second) {
  return (
    Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x)) *
    Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y))
  );
}

async function findFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  server.close();
  await once(server, 'close');
  return address.port;
}

async function waitForPage(url, server, output) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited before readiness:\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still compiling or has not opened its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}:\n${output.join('')}`);
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function assertLongRosterPickerLayout(page, surface, triggerTestId) {
  await page.getByTestId(triggerTestId).click();
  const panel = page.locator(`[data-transfer-surface="${surface}"]`);
  await panel.waitFor();
  const catScroller = panel.getByTestId('transfer-picker-cat-scroll');
  const note = panel.getByRole('textbox', { name: '转发留言（可选）' });

  const overflow = await catScroller.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert.ok(
    overflow.scrollHeight > overflow.clientHeight,
    `${surface} fixture must exercise an independently scrolling cat roster`,
  );

  await catScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  const metrics = await panel.evaluate((element) => {
    const catScroll = element.querySelector('[data-testid="transfer-picker-cat-scroll"]');
    const noteField = element.querySelector('textarea[aria-label="转发留言（可选）"]');
    const fixedFooter = element.querySelector('[data-testid="transfer-picker-footer"]');
    const alert = fixedFooter?.querySelector('[role="alert"]');
    if (!catScroll || !noteField || !fixedFooter || !alert) {
      throw new Error('F294 transfer picker fixture did not render');
    }
    const panelRect = element.getBoundingClientRect();
    const noteRect = noteField.getBoundingClientRect();
    const footerRect = fixedFooter.getBoundingClientRect();
    const alertRect = alert.getBoundingClientRect();
    return {
      panel: { top: panelRect.top, bottom: panelRect.bottom },
      catScroll: {
        scrollTop: catScroll.scrollTop,
        maxScrollTop: catScroll.scrollHeight - catScroll.clientHeight,
      },
      note: { top: noteRect.top, bottom: noteRect.bottom },
      footer: { top: footerRect.top, bottom: footerRect.bottom },
      alert: { top: alertRect.top, bottom: alertRect.bottom },
    };
  });

  assert.ok(metrics.catScroll.scrollTop > 0, `${surface} cat roster did not scroll`);
  assert.ok(
    Math.abs(metrics.catScroll.scrollTop - metrics.catScroll.maxScrollTop) <= 1,
    `${surface} cat roster did not reach its end`,
  );
  assert.ok(
    metrics.note.top >= metrics.panel.top && metrics.note.bottom <= metrics.panel.bottom,
    `${surface} note left the visible panel after roster scroll`,
  );
  assert.ok(
    metrics.alert.top >= metrics.footer.top && metrics.alert.bottom <= metrics.footer.bottom,
    `${surface} failure feedback left the fixed footer`,
  );
  assert.ok(
    metrics.footer.top >= metrics.panel.top && metrics.footer.bottom <= metrics.panel.bottom,
    `${surface} footer left the picker panel`,
  );
  assert.ok(metrics.footer.bottom <= 800, `${surface} footer left the supported viewport`);

  await note.focus();
  assert.equal(await note.evaluate((element) => document.activeElement === element), true);
  await panel.getByRole('button', { name: '取消', exact: true }).click();
}

test(
  'selection toolbar fits the 360px viewport chat canvas without clipping 44px targets',
  { timeout: 90_000 },
  async () => {
    const port = await findFreePort();
    const output = [];
    const server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_ENV: 'development',
        CAT_CAFE_WEB_BUILD_REVISION: OLD_WEB_REVISION,
        CAT_CAFE_DEPLOYMENT_REVISION_REQUIRED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => output.push(chunk.toString()));
    server.stderr.on('data', (chunk) => output.push(chunk.toString()));

    let browser;
    let releaseRuntimeHealth;
    const runtimeHealthRelease = new Promise((resolve) => {
      releaseRuntimeHealth = resolve;
    });
    try {
      const url = `http://127.0.0.1:${port}/dev/f294-selection-toolbar-preview`;
      await waitForPage(url, server, output);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
      await page.route('**/api/health', async (route) => {
        await runtimeHealthRelease;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok', deploymentRevision: NEW_SERVER_REVISION }),
        });
      });
      await page.route('**/api/ready', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
      });
      await page.route('**/api/session', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      });
      await page.route('**/api/cats', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ cats: [{ roster: { available: true } }] }),
        });
      });
      await page.goto(url, { waitUntil: 'networkidle' });

      const metrics = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="chat-canvas"]');
        const toolbar = document.querySelector('[data-testid="message-selection-toolbar"]');
        const actions = document.querySelector('[data-testid="message-selection-actions"]');
        const cancel = document.querySelector('button[aria-label="取消"]');
        const actionButtons = Array.from(actions?.querySelectorAll('button') ?? []);
        if (!canvas || !toolbar || !actions || !cancel) throw new Error('F294 layout fixture did not render');
        return {
          canvas: { clientWidth: canvas.clientWidth, scrollWidth: canvas.scrollWidth },
          toolbar: { clientWidth: toolbar.clientWidth, scrollWidth: toolbar.scrollWidth },
          actions: { clientWidth: actions.clientWidth, scrollWidth: actions.scrollWidth },
          cancelRight: cancel.getBoundingClientRect().right,
          targets: actionButtons.map((button) => {
            const rect = button.getBoundingClientRect();
            return { label: button.getAttribute('aria-label'), height: rect.height, width: rect.width };
          }),
        };
      });

      assert.equal(metrics.canvas.clientWidth, 308, '52px ActivityBar should leave a 308px chat canvas');
      assert.ok(
        metrics.toolbar.scrollWidth <= metrics.toolbar.clientWidth,
        `toolbar overflowed: scrollWidth=${metrics.toolbar.scrollWidth}, clientWidth=${metrics.toolbar.clientWidth}`,
      );
      assert.ok(
        metrics.actions.scrollWidth <= metrics.actions.clientWidth,
        `action dock overflowed: scrollWidth=${metrics.actions.scrollWidth}, clientWidth=${metrics.actions.clientWidth}`,
      );
      assert.ok(metrics.cancelRight <= 360, `Cancel ended outside the viewport at x=${metrics.cancelRight}`);
      assert.equal(metrics.targets.length, 5);
      for (const target of metrics.targets) {
        assert.ok(target.width >= 44, `${target.label} target width was ${target.width}px`);
        assert.ok(target.height >= 44, `${target.label} target height was ${target.height}px`);
      }

      const selectedText = 'exact selected fragment';
      await page.evaluate((text) => {
        const segment = document.querySelector('[data-context-quote-segment-id="stdout"]');
        const textNode = segment?.firstChild;
        if (!textNode?.textContent) throw new Error('CLI source segment did not render');
        const start = textNode.textContent.indexOf(text);
        if (start < 0) throw new Error('CLI selection fixture text missing');
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, start + text.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      }, selectedText);
      const quoteTrigger = page.getByTestId('message-selection-add-to-chat');
      await quoteTrigger.waitFor();
      const quoteTriggerBox = await quoteTrigger.boundingBox();
      assert.ok(quoteTriggerBox, 'CLI quote trigger did not render');
      assert.ok(quoteTriggerBox.width >= 44, `CLI quote target width was ${quoteTriggerBox.width}px`);
      assert.ok(quoteTriggerBox.height >= 44, `CLI quote target height was ${quoteTriggerBox.height}px`);
      await quoteTrigger.click();
      await page.getByTestId('context-annotation-forward').click();
      const cliForwardDialog = page.getByRole('dialog', { name: '转发到' });
      await cliForwardDialog.waitFor();
      await cliForwardDialog.getByRole('button', { name: '取消', exact: true }).click();

      await page.mouse.move(350, 790);
      const richBlock = page.locator('[data-rich-block-id="decision-card"]');
      const richForward = page.getByRole('button', { name: '转发富块：决策摘要' });
      const restingRichAction = await richForward.evaluate((element) => {
        const dock = element.closest('[data-testid="rich-block-forward-actions"]');
        if (!dock) throw new Error('Rich Block forward action dock did not render');
        const style = getComputedStyle(dock);
        const rect = dock.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          hitInsideDock: hit instanceof Node && dock.contains(hit),
          visibleLabel: element.textContent.trim(),
          hasIcon: Boolean(element.querySelector('svg')),
        };
      });
      assert.equal(restingRichAction.opacity, '0', 'Rich Block forwarding must not paint at rest');
      assert.equal(restingRichAction.pointerEvents, 'none', 'resting Rich Block forwarding must not intercept clicks');
      assert.equal(restingRichAction.hitInsideDock, false, 'resting Rich Block forwarding must fail hit-testing');
      assert.equal(restingRichAction.visibleLabel, '', 'Rich Block forwarding should use the compact icon treatment');
      assert.equal(restingRichAction.hasIcon, true, 'Rich Block forwarding needs a recognizable icon');

      await richForward.focus();
      await page.waitForFunction(() => {
        const dock = document.querySelector(
          '[data-rich-block-id="decision-card"] [data-testid="rich-block-forward-actions"]',
        );
        return dock && getComputedStyle(dock).opacity === '1';
      });
      assert.equal(
        await richForward.evaluate((element) => document.activeElement === element),
        true,
        'keyboard focus must reach the Rich Block forward action',
      );
      await richForward.blur();
      await page.mouse.move(350, 790);
      await page.waitForFunction(() => {
        const dock = document.querySelector(
          '[data-rich-block-id="decision-card"] [data-testid="rich-block-forward-actions"]',
        );
        return dock && getComputedStyle(dock).opacity === '0';
      });

      await richBlock.hover();
      await richForward.waitFor({ state: 'visible' });
      await page.waitForFunction(() => {
        const dock = document.querySelector(
          '[data-rich-block-id="decision-card"] [data-testid="rich-block-forward-actions"]',
        );
        return dock && getComputedStyle(dock).opacity === '1';
      });
      const hoveredRichAction = await richForward.evaluate((element) => {
        const dock = element.closest('[data-testid="rich-block-forward-actions"]');
        if (!dock) throw new Error('Rich Block forward action dock did not render');
        const style = getComputedStyle(dock);
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          hitInsideButton: hit instanceof Node && element.contains(hit),
        };
      });
      assert.equal(hoveredRichAction.opacity, '1', 'hover must reveal Rich Block forwarding');
      assert.equal(hoveredRichAction.pointerEvents, 'auto', 'hovered Rich Block forwarding must accept clicks');
      assert.equal(
        hoveredRichAction.hitInsideButton,
        true,
        'hovered Rich Block forwarding must hit-test to its button',
      );

      const richForwardBox = await richForward.boundingBox();
      assert.ok(richForwardBox, 'Rich Block forward action did not render');
      assert.ok(richForwardBox.width >= 44, `Rich Block target width was ${richForwardBox.width}px`);
      assert.ok(richForwardBox.height >= 44, `Rich Block target height was ${richForwardBox.height}px`);
      await richForward.click();
      await page.getByRole('dialog', { name: '转发到' }).waitFor();

      assert.equal(await page.locator('[data-testid="f294-rich-target"] iframe').count(), 0);
      assert.equal(
        await page.getByRole('button', { name: '不会触发原回调', exact: true }).count(),
        0,
        'forwarded interactive evidence must not keep an executable option',
      );
      assert.equal(await page.evaluate(() => globalThis.__f294Unsafe), undefined);

      const cliTargetText = await page.locator('[data-testid="f294-cli-target"]').innerText();
      assert.match(cliTargetText, /exact selected fragment/);
      assert.doesNotMatch(cliTargetText, /neighboring execution detail|neighboring secret/);

      await page.getByRole('dialog', { name: '转发到' }).getByRole('button', { name: '取消', exact: true }).click();

      await page.mouse.move(350, 790);
      const richGroup = page.locator('[data-testid="f294-rich-group-source"] [data-rich-block-group-id]');
      const groupActions = richGroup.getByTestId('rich-block-forward-actions');
      const groupDock = richGroup.getByTestId('rich-block-forward-action-dock');
      const firstGroupForward = richGroup.getByRole('button', { name: `转发富块：${GROUP_FIRST_TITLE}` });
      const secondGroupForward = richGroup.getByRole('button', { name: '转发富块：第二张分组交互卡' });
      const restingGroupAction = await groupActions.evaluate((element) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, pointerEvents: style.pointerEvents };
      });
      assert.equal(restingGroupAction.opacity, '0', 'grouped Rich Block forwarding must not paint at rest');
      assert.equal(
        restingGroupAction.pointerEvents,
        'none',
        'grouped Rich Block forwarding must not intercept clicks at rest',
      );

      await firstGroupForward.focus();
      await page.waitForFunction(() => {
        const dock = document.querySelector(
          '[data-testid="f294-rich-group-source"] [data-testid="rich-block-forward-actions"]',
        );
        return dock && getComputedStyle(dock).opacity === '1';
      });
      assert.equal(
        await firstGroupForward.evaluate((element) => document.activeElement === element),
        true,
        'keyboard focus must reveal a grouped Rich Block forward action',
      );
      await firstGroupForward.blur();
      await page.mouse.move(350, 790);
      await page.waitForFunction(() => {
        const dock = document.querySelector(
          '[data-testid="f294-rich-group-source"] [data-testid="rich-block-forward-actions"]',
        );
        return dock && getComputedStyle(dock).opacity === '0';
      });

      await richGroup.hover();
      await page.waitForFunction(() => {
        const dock = document.querySelector(
          '[data-testid="f294-rich-group-source"] [data-testid="rich-block-forward-actions"]',
        );
        return dock && getComputedStyle(dock).opacity === '1';
      });
      const [groupDockBox, groupTitleBox, groupControlBox] = await Promise.all([
        groupDock.boundingBox(),
        page.getByText(GROUP_FIRST_TITLE, { exact: true }).boundingBox(),
        richGroup.getByRole('button', { name: '保留首张卡的选项', exact: true }).boundingBox(),
      ]);
      assert.ok(groupDockBox && groupTitleBox && groupControlBox, 'grouped Rich Block geometry did not render');
      assert.equal(
        overlapArea(groupDockBox, groupTitleBox),
        0,
        'grouped forward actions must not cover the first title',
      );
      assert.equal(
        overlapArea(groupDockBox, groupControlBox),
        0,
        'grouped forward actions must not cover the first interactive control',
      );
      for (const action of [firstGroupForward, secondGroupForward]) {
        const box = await action.boundingBox();
        assert.ok(box, 'grouped Rich Block forward action did not render');
        assert.ok(box.width >= 44, `grouped Rich Block target width was ${box.width}px`);
        assert.ok(box.height >= 44, `grouped Rich Block target height was ${box.height}px`);
      }
      await secondGroupForward.click();
      const groupedPicker = page.getByRole('dialog', { name: '转发到' });
      await groupedPicker.waitFor();
      await groupedPicker.getByRole('button', { name: '取消', exact: true }).click();

      await assertLongRosterPickerLayout(page, 'bottom-sheet', 'f294-transfer-picker-bottom-sheet');
      await assertLongRosterPickerLayout(page, 'modal', 'f294-transfer-picker-modal');

      const runtimeHealthRequest = page.waitForRequest('**/api/health');
      await page.getByTestId('f294-simulate-runtime-update').click();
      await runtimeHealthRequest;
      const runtimeProbe = page.getByTestId('f294-runtime-deployment-probe');
      const multiSelectForward = runtimeProbe.getByRole('button', { name: '转发', exact: true });
      assert.equal(
        await multiSelectForward.isDisabled(),
        true,
        'multi-select forwarding must be disabled while deployment revision is unverified',
      );
      await multiSelectForward.evaluate((element) => element.click());
      assert.equal(
        await page.getByTestId('f294-runtime-multiselect-attempts').textContent(),
        '0',
        'initial verification must not run the multi-select forward action',
      );

      releaseRuntimeHealth();
      const updateDialog = page.getByTestId('runtime-update-required');
      await updateDialog.waitFor();
      assert.equal(
        await multiSelectForward.isDisabled(),
        true,
        'multi-select forwarding must remain disabled after a deployment mismatch',
      );
      await multiSelectForward.evaluate((element) => element.click());
      assert.equal(
        await page.getByTestId('f294-runtime-multiselect-attempts').textContent(),
        '0',
        'deployment mismatch must not run the multi-select forward action',
      );
      const reloadButton = updateDialog.getByRole('button', { name: '刷新页面' });
      assert.equal(
        await reloadButton.evaluate((element) => document.activeElement === element),
        true,
        'runtime update guard did not move focus to its only recovery action',
      );
      await page.locator('[data-context-quote-segment-id="runtime-stdout"]').scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        const segment = document.querySelector('[data-context-quote-segment-id="runtime-stdout"]');
        const textNode = segment?.firstChild;
        if (!textNode?.textContent) throw new Error('runtime CLI source did not render');
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await page.getByTestId('message-selection-add-to-chat').evaluate((element) => element.click());
      assert.equal(
        await page.getByTestId('context-annotation-forward').count(),
        0,
        'the real old-document CLI route must not expose its direct forward action',
      );
      assert.equal(
        await page.getByTestId('context-annotation-save').count(),
        1,
        'the local Add to Chat action should remain available for recovery after reload',
      );
      assert.equal(
        await page.getByRole('dialog', { name: '转发到' }).count(),
        0,
        'old document must not expose a writable quote-forward picker when its first health revision is newer',
      );
      assert.equal(
        await page.getByTestId('f294-runtime-submit-attempts').textContent(),
        '0',
        'old document must not submit the selected quote before forcing a reload',
      );
      const updateBounds = await updateDialog.boundingBox();
      assert.deepEqual(
        updateBounds && {
          x: Math.round(updateBounds.x),
          y: Math.round(updateBounds.y),
          width: Math.round(updateBounds.width),
          height: Math.round(updateBounds.height),
        },
        { x: 0, y: 0, width: 360, height: 800 },
        'runtime update guard did not cover the supported narrow viewport',
      );
      await reloadButton.click();
      await page.getByTestId('f294-reload-requested').waitFor();

      const touchContext = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true });
      try {
        await touchContext.route('**/api/health', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'ok', deploymentRevision: OLD_WEB_REVISION }),
          });
        });
        await touchContext.route('**/api/ready', async (route) => {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
        });
        await touchContext.route('**/api/session', async (route) => {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        });
        await touchContext.route('**/api/cats', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ cats: [{ roster: { available: true } }] }),
          });
        });
        const touchPage = await touchContext.newPage();
        await touchPage.goto(url, { waitUntil: 'networkidle' });
        const touchForward = touchPage.getByRole('button', { name: '转发富块：决策摘要' });
        const touchAction = await touchForward.evaluate((element) => {
          const dock = element.closest('[data-testid="rich-block-forward-actions"]');
          if (!dock) throw new Error('touch Rich Block forward action dock did not render');
          const style = getComputedStyle(dock);
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return {
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            hitInsideButton: hit instanceof Node && element.contains(hit),
          };
        });
        assert.equal(touchAction.opacity, '1', 'touch-only users must keep Rich Block forwarding visible');
        assert.equal(touchAction.pointerEvents, 'auto', 'touch-only Rich Block forwarding must accept taps');
        assert.equal(touchAction.hitInsideButton, true, 'touch-only Rich Block forwarding must hit-test to its button');
        await touchForward.tap();
        const touchPicker = touchPage.getByRole('dialog', { name: '转发到' });
        await touchPicker.waitFor();
        await touchPicker.getByRole('button', { name: '取消', exact: true }).tap();

        const touchGroup = touchPage.locator('[data-testid="f294-rich-group-source"] [data-rich-block-group-id]');
        const touchGroupActions = touchGroup.getByTestId('rich-block-forward-actions');
        const touchGroupDock = touchGroup.getByTestId('rich-block-forward-action-dock');
        const touchSecondForward = touchGroup.getByRole('button', { name: '转发富块：第二张分组交互卡' });
        const [touchGroupDockBox, touchGroupTitleBox, touchGroupControlBox] = await Promise.all([
          touchGroupDock.boundingBox(),
          touchPage.getByText(GROUP_FIRST_TITLE, { exact: true }).boundingBox(),
          touchGroup.getByRole('button', { name: '保留首张卡的选项', exact: true }).boundingBox(),
        ]);
        assert.ok(
          touchGroupDockBox && touchGroupTitleBox && touchGroupControlBox,
          'touch grouped Rich Block geometry did not render',
        );
        const touchGroupStyle = await touchGroupActions.evaluate((element) => {
          const style = getComputedStyle(element);
          return { opacity: style.opacity, pointerEvents: style.pointerEvents };
        });
        assert.equal(touchGroupStyle.opacity, '1', 'touch grouped Rich Block forwarding must remain visible');
        assert.equal(touchGroupStyle.pointerEvents, 'auto', 'touch grouped Rich Block forwarding must accept taps');
        assert.equal(
          overlapArea(touchGroupDockBox, touchGroupTitleBox),
          0,
          'touch grouped forward actions must not cover the first title',
        );
        assert.equal(
          overlapArea(touchGroupDockBox, touchGroupControlBox),
          0,
          'touch grouped forward actions must not cover the first interactive control',
        );
        await touchSecondForward.tap();
        await touchPage.getByRole('dialog', { name: '转发到' }).waitFor();
      } finally {
        await touchContext.close();
      }
    } finally {
      await browser?.close();
      await stopServer(server);
    }
  },
);
