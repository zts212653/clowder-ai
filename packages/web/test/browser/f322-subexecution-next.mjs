import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readbackResponse, startNativeHost } from './f322-native-reply-next.mjs';
import { contrast, measureSubexecutionRecord } from './fixtures/f322-reply-layers-metrics.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function snapshot(page, out, name) {
  if (out) await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
}

async function keyboardToggle(page, button) {
  await button.focus();
  assert.equal(await button.evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press('Enter');
}

async function measureChildren(row) {
  return row.evaluate(measureSubexecutionRecord);
}

function assertGeometry(measure, name) {
  assert.equal(measure.line.height, 22, `${name}: one changing last line`);
  assert.equal(measure.motherRail, '3px', `${name}: mother owns the rail`);
  assert.equal(
    measure.groupClient,
    Math.min(576, measure.columnClient - 36),
    `${name}: child record keeps reading width`,
  );
  for (const key of ['column', 'row', 'group']) {
    assert.ok(
      measure[`${key}Scroll`] <= measure[`${key}Client`] + 1,
      `${name}: ${key} scroll containment ${JSON.stringify(measure)}`,
    );
  }
  for (const child of measure.children) {
    assert.ok(child.scroll <= child.client + 1, `${name}: ${child.id} contained`);
    assert.ok(child.button.height >= 44, `${name}: ${child.id} 44px keyboard/pointer target`);
    assert.ok(
      child.rect.left >= measure.column.left && child.rect.right <= measure.column.right + 1,
      `${name}: ${child.id} within reading column`,
    );
    assert.equal(child.rail, '0px', `${name}: no separate child rail`);
    assert.ok(contrast(child.color, child.surface) >= 4.5, `${name}: ${child.id} mother-theme badge contrast`);
  }
  const siblings = measure.children.filter((child) => child.id !== 'child-bounds');
  assert.ok(
    Math.max(...siblings.map((child) => child.state.left)) - Math.min(...siblings.map((child) => child.state.left)) <=
      1,
    `${name}: status column aligned`,
  );
  assert.ok(
    Math.max(...siblings.map((child) => child.duration.left)) -
      Math.min(...siblings.map((child) => child.duration.left)) <=
      1,
    `${name}: duration column aligned`,
  );
}

function assertVisual(measure, width, name) {
  for (const child of measure.children) {
    assert.equal(child.nameWeight, '500', `${name}: name weight`);
    assert.equal(child.stateFont, '12px', `${name}: status font`);
    assert.equal(child.durationFont, '12px', `${name}: duration font`);
    const peer = width > 420 ? child.task : child.state;
    assert.ok(
      Math.abs(child.name.y + child.name.height / 2 - peer.y - peer.height / 2) <= 1,
      `${name}: badge centered ${JSON.stringify(child)}`,
    );
    for (const detail of child.details) {
      assert.equal(detail.font, '12px', `${name}: report label font`);
      assert.equal(detail.weight, '500', `${name}: report label weight`);
      assert.equal(detail.border, '1px', `${name}: detail guide`);
      assert.equal(detail.gap, '6px', `${name}: detail spacing`);
    }
  }
  for (const part of measure.headerParts) {
    assert.equal(part.whiteSpace, 'nowrap', `${name}: keep each summary fact together`);
    assert.ok(part.rect.width <= measure.groupClient + 1, `${name}: summary segment contained`);
  }
  if (width <= 420) {
    assert.deepEqual(
      measure.counters.map((part) => [part.kind, part.text]),
      [
        ['running', '2'],
        ['failed', '1'],
        ['interrupted', '1'],
      ],
      `${name}: all attention counts painted`,
    );
    for (const part of measure.counters) {
      assert.ok(
        part.rect.left >= measure.line.left && part.rect.right <= Math.min(part.parent.right, measure.line.right) + 1,
        `${name}: complete count paint ${JSON.stringify(part)}`,
      );
    }
  }
}

async function selectChild(page, row) {
  const text = row.locator('[data-subexecution-id="child-reviews"] [data-subexecution-message-phase]').first();
  await text.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node.lastElementChild);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  assert.equal(
    await page.getByTestId('message-selection-add-to-chat').count(),
    0,
    'child prose cannot become a mother-content quote',
  );
  await page.keyboard.press('ControlOrMeta+c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '子代理原进展 11。');
  await page.evaluate(() => {
    window.getSelection().removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
}

async function exerciseChildren(page, row, language, out, name) {
  assert.equal(await row.locator('[data-agent-role="root"]').count(), 0);
  assert.equal(await row.getByTestId('subexecution-activity').count(), 0);
  const toggle = row.getByTestId('reply-record-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await keyboardToggle(page, toggle);
  const group = row.getByTestId('reply-subexecutions');
  await group.waitFor();
  assert.equal(await group.evaluate((node) => node.closest('[data-testid="reply-record"]') !== null), true);
  assert.equal(await group.getAttribute('data-quote-exclude'), 'true');
  assert.equal(await group.locator('[data-subexecution-id]').count(), 6);
  assert.doesNotMatch(await group.innerText(), /\/root\/|depth |主 agent|子 agent/);
  const nested = group.locator('[data-subexecution-id="child-bounds"]');
  assert.equal(
    await nested.evaluate((node) => node.closest('[data-subexecution-container="child-schema"]') !== null),
    true,
  );
  const active = group.locator('[data-subexecution-id="child-reviews"]');
  await keyboardToggle(page, active.locator('button').first());
  assert.match(await active.innerText(), /子代理原进展 11/);
  assert.doesNotMatch(await active.innerText(), /子代理原进展 1。/);
  const history = active.locator('[data-subexecution-history-toggle]');
  assert.match(await history.innerText(), /10/);
  await keyboardToggle(page, history);
  for (let i = 1; i <= 11; i++) assert.match(await active.innerText(), new RegExp(`子代理原进展 ${i}。`));
  await keyboardToggle(page, history);
  if (out) {
    await row.getByTestId('native-reply-answer').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `${name}-latest-progress.png`), fullPage: true });
  }
  const schema = group.locator('[data-subexecution-id="child-schema"]');
  await keyboardToggle(page, schema.locator('button').first());
  assert.match(await schema.innerText(), /子代理字段核对完成/);
  assert.equal(await schema.locator('[data-subexecution-message-phase="final_answer"]').count(), 1);
  const unknown = group.locator('[data-subexecution-id="child-unknown"]');
  await keyboardToggle(page, unknown.locator('button').first());
  assert.equal(await unknown.locator('[data-subexecution-message-phase="unknown"]').count(), 1);
  assert.match(await unknown.innerText(), language === 'zh' ? /消息阶段未确认/ : /Message phase unconfirmed/);
  assert.equal(await unknown.locator('[data-subexecution-duration]').innerText(), '—');
  await selectChild(page, row);
}

async function visit(browser, host, data, out, measures, shell, theme, language) {
  const name = `${shell}-${theme}-${language}`;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  let trace = data.traces[0],
    message = trace.api;
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await context.addInitScript(
      ({ shell, theme, language }) => {
        localStorage.setItem('cat-cafe:shell-presentation', shell);
        localStorage.setItem('cat-cafe:shell-language', language);
        localStorage.setItem('theme', theme);
      },
      { shell, theme, language },
    );
    await page.route('**/api/**', async (route) => {
      const response = readbackResponse(route.request(), trace, message);
      await route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
    });
    await page.goto(`${host.url}/thread/${trace.threadId}?shell=${shell}`, { waitUntil: 'networkidle' });
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
    let row = page.locator(`[data-message-id="${message.id}"]`).last();
    await row.waitFor();
    const collapse = page.getByTestId('sidebar-collapse');
    if (await collapse.isVisible()) {
      await collapse.click();
      await collapse.waitFor({ state: 'hidden' });
    }
    if (shell === 'classic') {
      assert.equal(await row.getByTestId('reply-subexecutions').count(), 0);
      assert.equal(await row.getByTestId('subexecution-activity').count(), 1);
      assert.equal(await row.locator('[data-agent-role="root"]').count(), 1);
      await snapshot(page, out, name);
      return;
    }
    await row.getByTestId('native-reply-answer').waitFor();
    assert.doesNotMatch(await row.getByTestId('native-reply-answer').innerText(), /子代理/);
    await snapshot(page, out, `${name}-collapsed`);
    await exerciseChildren(page, row, language, out, name);
    for (const width of [1440, 420, 300, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const measure = await measureChildren(row);
      measures.push({ name, width, ...measure });
      assertGeometry(measure, `${name}-${width}`);
      assertVisual(measure, width, `${name}-${width}`);
      await snapshot(page, out, `${name}-${width}`);
    }
    const ownTools = row.getByTestId('reply-own-tools').getByRole('button').first();
    await keyboardToggle(page, ownTools);
    assert.equal(await row.locator('[data-testid^="reply-record-tool-"]').count(), 1);
    assert.match(await row.getByTestId('reply-record').innerText(), /检查.*日志/s);
    await page.reload({ waitUntil: 'networkidle' });
    row = page.locator(`[data-message-id="${message.id}"]`).last();
    assert.match(
      await row.getByTestId('reply-subexecution-summary').innerText(),
      language === 'zh' ? /子代理 6/ : /Subagents 6/,
    );
    message = trace.draft.api;
    await page.reload({ waitUntil: 'networkidle' });
    row = page.locator(`[data-message-id="${message.id}"]`).last();
    assert.match(
      await row.getByTestId('reply-subexecution-summary').innerText(),
      language === 'zh' ? /子代理 6/ : /Subagents 6/,
    );
    const draftToggle = row.getByTestId('reply-record-toggle');
    if ((await draftToggle.getAttribute('aria-expanded')) !== 'true') await keyboardToggle(page, draftToggle);
    await page.setViewportSize({ width: 300, height: 1000 });
    if (await collapse.isVisible()) {
      await collapse.click();
      await collapse.waitFor({ state: 'hidden' });
    }
    await row.getByTestId('reply-last-line').scrollIntoViewIfNeeded();
    const draftMeasure = await measureChildren(row);
    measures.push({ name: `${name}-draft`, width: 300, ...draftMeasure });
    assertGeometry(draftMeasure, `${name}-draft-300`);
    assertVisual(draftMeasure, 300, `${name}-draft-300`);
    await snapshot(page, out, `${name}-draft-300`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    trace = data.traces[1];
    message = trace.api;
    await page.goto(`${host.url}/thread/${trace.threadId}?shell=v2`, { waitUntil: 'networkidle' });
    row = page.locator(`[data-message-id="${message.id}"]`).last();
    assert.equal(
      await row.getByTestId('reply-subexecution-summary').innerText(),
      language === 'zh' ? '子代理 1 · 都完成了' : 'Subagents 1 · All finished',
    );
    await keyboardToggle(page, row.getByTestId('reply-record-toggle'));
    await snapshot(page, out, `${name}-all-completed`);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (out) {
      await page.screenshot({ path: path.join(out, `${name}-failure.png`), fullPage: true });
      await writeFile(path.join(out, `${name}-failure-dom.txt`), await page.locator('body').innerText());
    }
    throw error;
  } finally {
    await context.close();
  }
}

/** Actual Next host replay of bounded controlled frames persisted by the real Redis Draft/formal/GET pipeline. */
export async function runSubexecutionNextJourney(browser, evidenceDir) {
  const source =
    process.env.F322_SUBEXECUTION_READBACK_FILE ??
    path.join(repo, 'docs/evidence/2026-10-08-f322-subagent-replies/readback/stations.json');
  const data = JSON.parse(await readFile(source, 'utf8'));
  assert.equal(data.redisPort, 6398);
  assert.equal(data.traces.length, 2);
  // Preserve the archived capture; project its legacy cat identity only in the served DTO.
  for (const trace of data.traces) {
    for (const message of [trace.api, trace.draft?.api].filter(Boolean)) {
      assert.equal(message.type, 'assistant');
      assert.equal(typeof message.catId, 'string');
      if (message.from) assert.deepEqual(message.from, { kind: 'agent', catId: message.catId });
      else message.from = { kind: 'agent', catId: message.catId };
    }
  }
  const out = evidenceDir ? path.join(evidenceDir, 'subexecution-next') : undefined;
  if (out) await mkdir(out, { recursive: true });
  const host = await startNativeHost();
  const measures = [];
  try {
    await host.ready();
    for (const shell of ['v2', 'classic'])
      for (const theme of ['light', 'dark'])
        for (const language of ['zh', 'en']) {
          await visit(browser, host, data, out, measures, shell, theme, language);
        }
  } finally {
    await host.close();
    if (out) await writeFile(path.join(out, 'measurements.json'), `${JSON.stringify(measures, null, 2)}\n`);
  }
}
