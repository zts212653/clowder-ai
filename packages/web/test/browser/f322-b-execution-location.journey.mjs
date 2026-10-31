import assert from 'node:assert/strict';
import { openWorkspaceTools } from './f307-workspace-open.mjs';
import { createF322BControlledFixture } from './f322-b-controlled-fixture.mjs';

async function assertCompactVerbVisible(page, verb) {
  const geometry = await page.getByTestId('execution-row-text-compact').evaluate((element, verb) => {
    const nodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = nodes.nextNode(); node !== null; node = nodes.nextNode()) {
      const start = node.textContent.toLowerCase().indexOf(verb.toLowerCase());
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + verb.length);
      const text = range.getBoundingClientRect();
      const container = element.getBoundingClientRect();
      return { left: text.left, right: text.right, containerLeft: container.left, containerRight: container.right };
    }
    return null;
  }, verb);
  assert.ok(geometry, `Missing execution verb ${verb}`);
  assert.ok(
    geometry.left >= geometry.containerLeft - 1 && geometry.right <= geometry.containerRight + 1,
    `${verb} is clipped: ${JSON.stringify(geometry)}`,
  );
}

/** Uses the original /thread page and its real messages, host, composer, record, and cancellation consumer. */
export async function runF322BExecutionLocationJourney({
  browser,
  baseUrl,
  threadId,
  fixtureForApi,
  viewport,
  language,
  coldStart = false,
}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const fixture = createF322BControlledFixture(threadId);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((language) => {
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    localStorage.setItem('cat-cafe:shell-language', language);
    localStorage.setItem('theme', language === 'en' ? 'dark' : 'light');
  }, language);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(fixture.response(url, request.method()) ?? fixtureForApi(url)),
    });
  });
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    if (coldStart) {
      const tools = await openWorkspaceTools(page);
      await tools.getByTestId('workspace-launcher-trajectory').click();
      await page.waitForFunction(() => {
        const layout = JSON.parse(localStorage.getItem('cat-cafe:workbench-layout-v2') ?? '{}');
        return (
          layout.activeSurfaceId === 'workspace:mode:trajectory' &&
          layout.surfaces?.some((surface) => surface.id === layout.activeSurfaceId)
        );
      });
      await page.getByTestId('workspace-panel-toggle').click();
      await page.waitForFunction(async (threadId) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('cat-cafe-offline');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const record = await new Promise((resolve, reject) => {
            const request = db
              .transaction('thread-workspace-state')
              .objectStore('thread-workspace-state')
              .get(threadId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          return (
            record?.rightPanelMode === 'status' &&
            record.rightPanelOpen === false &&
            record.workspaceForegroundSurfaceId === 'workspace:mode:trajectory'
          );
        } finally {
          db.close();
        }
      }, threadId);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('execution-row-locate').waitFor();
      assert.equal(
        await page.getByTestId('f307-experience-workbench').count(),
        0,
        'Workspace must be unmounted after cold open',
      );
    }
    const row = page.getByTestId('execution-row');
    const location = row.getByTestId('execution-row-locate');
    await location.waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), language === 'en' ? 'dark' : 'light');
    assert.match(await location.innerText(), /小太阳·砚砚.*GPT-6.1 Sol/);
    assert.match(await location.innerText(), language === 'zh' ? /处理中/ : /working/i);
    if (viewport.width === 390) await assertCompactVerbVisible(page, language === 'zh' ? '处理中' : 'Working');
    const bubble = page.locator(`[data-message-id="${fixture.message.id}"]`);
    await bubble.waitFor();
    const record = bubble.getByTestId('reply-record-toggle');
    assert.equal(await record.getAttribute('aria-expanded'), 'false');
    const composer = page.locator('[data-testid="chat-input-composer-row"] textarea');
    await composer.fill('这份草稿和选择不能被定位动作改掉');
    await composer.evaluate((input) => input.setSelectionRange(3, 8));
    await location.focus();
    await page.keyboard.press('Enter');
    await bubble.getByTestId('reply-record').waitFor();
    assert.equal(await record.getAttribute('aria-expanded'), 'true');
    await bubble.locator('xpath=self::*[@data-message-jump-focus="true"]').waitFor();
    assert.equal(await bubble.getAttribute('data-message-jump-focus'), 'true');
    assert.equal(await composer.inputValue(), '这份草稿和选择不能被定位动作改掉');
    assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);
    await page.screenshot({ path: `/tmp/f322-b-native-live-${viewport.width}-${language}.png` });
    fixture.setExecutions([fixture.managed]);
    await location.filter({ hasText: language === 'zh' ? '在跑' : 'running' }).waitFor({ timeout: 10_000 });
    if (viewport.width === 390)
      await assertCompactVerbVisible(page, language === 'zh' ? '在跑 全量门禁' : 'running full gate');
    await location.click();
    const detail = page.getByTestId('workspace-execution-detail');
    await detail.waitFor();
    if (coldStart) {
      const layout = await page.evaluate(() => JSON.parse(localStorage.getItem('cat-cafe:workbench-layout-v2')));
      assert.ok(
        layout.surfaces.some((surface) => surface.id === 'workspace:mode:trajectory'),
        'Original tool remains in the working set',
      );
    }
    const homeRow = detail.locator('xpath=ancestor::*[@data-testid="workspace-running-object"]');
    assert.equal(await homeRow.count(), 1, 'Details expand under the exact running row');
    assert.equal(await homeRow.getAttribute('data-execution-jump-focus'), 'true');
    await detail.getByTestId('execution-command').waitFor();
    assert.equal(await detail.getByTestId('execution-command').textContent(), 'pnpm gate # 受控样本，不会执行');
    await detail.locator('summary').click();
    assert.equal(
      await detail.locator('time').getAttribute('dateTime'),
      new Date(fixture.managed.startedAt).toISOString(),
    );
    assert.equal(await detail.getByRole('link').getAttribute('href'), `/thread/${threadId}`);
    assert.equal(await composer.inputValue(), '这份草稿和选择不能被定位动作改掉');
    await page.screenshot({ path: `/tmp/f322-b-native-command-${viewport.width}-${language}.png` });
    await homeRow.locator('.home-execution-stop button').click();
    const confirmation = page.getByRole('dialog', {
      name: language === 'zh' ? '停止小太阳·砚砚的这次执行？' : 'Stop this execution by 小太阳·砚砚?',
    });
    await confirmation.waitFor();
    assert.deepEqual(
      fixture.calls.filter((call) => call.startsWith('DELETE ')),
      [],
    );
    const dismiss = confirmation.getByRole('button', { name: language === 'zh' ? '取消' : 'Cancel', exact: true });
    assert.equal(await dismiss.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    const confirm = confirmation.getByRole('button', { name: language === 'zh' ? '停止' : 'Stop', exact: true });
    assert.equal(await confirm.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await dismiss.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await confirmation.count(), 0);
    await detail.waitFor();
    assert.deepEqual(
      fixture.calls.filter((call) => call.startsWith('DELETE ')),
      [],
    );
    await homeRow.locator('.home-execution-stop button').click();
    fixture.setExecutions([
      { ...fixture.managed, cancelability: { state: 'not_cancelable', reason: 'terminalizing' } },
    ]);
    await homeRow
      .getByText(language === 'zh' ? '正在收尾，已不可停止' : 'Finishing; can no longer stop', { exact: true })
      .waitFor();
    assert.equal(await confirmation.count(), 0);
    assert.equal(
      await homeRow.evaluate((element) => element.contains(document.activeElement)),
      true,
      'Capability loss must leave focus in this execution row',
    );
    assert.deepEqual(
      fixture.calls.filter((call) => call.startsWith('DELETE ')),
      [],
    );
    fixture.setExecutions([fixture.managed]);
    await homeRow.locator('.home-execution-stop button').click();
    await page.screenshot({ path: `/tmp/f322-b-native-stop-confirm-${viewport.width}-${language}.png` });
    await confirm.click();
    await detail
      .getByText(language === 'zh' ? '读不到这次执行的位置' : 'Cannot read the location of this execution', {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await detail.evaluate((element) => element.contains(document.activeElement)),
      true,
      'Completed cancellation must leave focus in this execution detail',
    );
    assert.deepEqual(
      fixture.calls.filter((call) => call.startsWith('DELETE ')),
      ['DELETE /api/callbacks/hold-ball/sample-hold-exact'],
    );
    await page.screenshot({ path: `/tmp/f322-b-native-execution-${viewport.width}-${language}.png` });
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: `/tmp/f322-b-native-failure-${viewport.width}-${language}.png` });
    throw error;
  } finally {
    await context.close();
  }
}
