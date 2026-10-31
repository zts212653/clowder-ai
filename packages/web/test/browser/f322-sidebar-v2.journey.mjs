import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { buildChatProof } from './fixtures/f322-chat-real-page-build.mjs';
import { BUSY_THREAD, GROUP_ID } from './fixtures/f322-chat-real-page-data.mjs';
import {
  measureSidebarGroupHierarchy,
  measureSidebarSignalLayout,
  setupSidebarProof,
} from './fixtures/f322-sidebar-v2-data.mjs';

async function assertGroupHierarchy(sidebar) {
  const hierarchy = await sidebar.evaluate(measureSidebarGroupHierarchy);
  assert.ok(hierarchy.headers > 0);
  assert.ok(hierarchy.members > 0, 'expanded Group hierarchy includes real member rows');
  assert.ok(hierarchy.columns && hierarchy.outerColumns, 'Group icons/names share the outer Thread pin/title columns');
  assert.ok(hierarchy.memberColumns, 'the whole member row is indented 20px');
  assert.ok(hierarchy.framed, 'each virtual Group segment keeps its hairline sides and 10px end corners');
  assert.ok(hierarchy.lifted, 'Group fill is brighter than the Sidebar frame in both themes');
  assert.equal(hierarchy.rail, 0, 'Group blocks replace the vertical tree rail');
}

export async function runSidebarV2Journey(t, browser) {
  const evidence = process.env.F322_SIDEBAR_EVIDENCE_DIR ?? path.join(os.tmpdir(), 'f322-sidebar-v2-proof');
  mkdirSync(evidence, { recursive: true });
  const built = await buildChatProof();
  writeFileSync(path.join(evidence, 'built.json'), JSON.stringify(built));
  for (const crowded of [false, true])
    for (const base of ['light', 'dark'])
      for (const language of ['zh', 'en'])
        await t.test(`v2 sidebar real components: ${base} ${language} ${crowded ? '12 cats' : '2 cats'}`, async () => {
          const context = await browser.newContext({ reducedMotion: crowded ? 'reduce' : 'no-preference' });
          const harness = createChatProofHarness(context, built, evidence, [], setupSidebarProof);
          const proof = await harness.openProof({ base, language, crowded, resizable: true });
          const { page } = proof;
          try {
            const sidebar = page.locator('[data-shell-sidebar="v2"]');
            const busy = page.locator(`[data-thread-id="${BUSY_THREAD}"]`);
            await busy.getByTestId('thread-row-working').waitFor();
            await assertGroupHierarchy(sidebar);
            assert.equal(
              await sidebar.getByTestId('group-pinned').count(),
              0,
              'member pins do not imply Group pinning',
            );
            const titleTimes = await sidebar.getByTestId('thread-row-time').allTextContents();
            assert.ok(titleTimes.length > 0);
            assert.ok(
              titleTimes.every((time) =>
                language === 'en' ? /^(just now|\d+ (min|h|d))$/.test(time) : /^(刚刚|\d+[分时天])$/.test(time),
              ),
              'title-line activity time follows the shell language',
            );
            assert.equal(await busy.locator('[data-testid="thread-signal-cats"] img').count(), 2);
            assert.equal(await busy.getByTestId('thread-cats-more').textContent(), crowded ? '+11' : '+1');
            async function executionLine(width = 300) {
              await assertGroupHierarchy(sidebar);
              const signals = busy.getByTestId('thread-row-signals');
              const expected = width === 300 ? 20 : width === 240 ? 44 : 68;
              await page.waitForFunction(
                (height) =>
                  document
                    .querySelector('[data-thread-id="composer-proof-1"] [data-testid="thread-row-signals"]')
                    ?.getBoundingClientRect().height === height,
                expected,
              );
              const layout = await signals.evaluate(measureSidebarSignalLayout);
              assert.equal(layout.height, expected, 'fixed facts use 20px lines with 4px gaps');
              assert.ok(layout.contained && layout.noOverlap, 'all fixed facts stay in their owners without overlap');
              assert.ok(layout.avatarsContained, 'every avatar stays 16px inside its roster');
              assert.ok(
                layout.namesWhole && layout.statusWhole,
                'optional words are whole or hidden in both languages',
              );
              assert.ok(layout.rightAligned && layout.badgeHeights.every((height) => height === 20));
              for (let i = 1; i < layout.badgeRows.length; i++)
                assert.equal(layout.badgeRows[i] - layout.badgeRows[i - 1], 24);
              assert.ok(layout.badgeText[2].includes(language === 'zh' ? '未读' : 'unread'));
              assert.ok(layout.statusRecoverable, 'the visible status symbol remains focusable');
              assert.equal(
                layout.statusLabel,
                (await busy.getByTestId('thread-working-label').textContent()) +
                  (await busy.getByTestId('thread-working-duration').textContent()),
                'the full state and elapsed fact remain recoverable',
              );
              await busy.getByTestId('thread-status-text').focus();
              if (!layout.statusVisible) {
                await page.locator('textarea').focus();
                await busy.getByTestId('thread-status-text').focus();
                // A resize is pointer input. Enter via real keys, as the canonical real-page consumer does.
                await page.keyboard.press('Tab');
                await page.keyboard.press('Shift+Tab');
                assert.ok(await busy.getByTestId('thread-status-text').evaluate((el) => document.activeElement === el));
                const recovery = page.getByRole('tooltip').filter({ hasText: layout.statusLabel });
                await recovery.waitFor();
                assert.equal(await recovery.innerText(), layout.statusLabel);
                await page.locator('textarea').focus();
                await recovery.waitFor({ state: 'detached' });
              }
              assert.equal((await signals.boundingBox()).height, expected, 'focus never changes the line count');
              await page.keyboard.press('Escape');
              assert.equal(
                await busy.getByTestId('thread-working-duration').textContent(),
                crowded ? (language === 'zh' ? ' · 2 天' : ' · 2 d') : language === 'zh' ? ' · 1 小时' : ' · 1 h',
              );
            }
            await executionLine();
            const title = busy.locator('[role="link"]');
            const titleStyle = await title.evaluate((el) => ({
              font: getComputedStyle(el).fontSize,
              weight: getComputedStyle(el).fontWeight,
              height: el.getBoundingClientRect().height,
            }));
            assert.equal(titleStyle.font, '14px');
            assert.equal(titleStyle.weight, '600');
            assert.ok(titleStyle.height <= 40);
            const groupStyle = await page
              .getByTestId('group-header-v2')
              .first()
              .locator('button[aria-controls] > span.truncate')
              .evaluate((el) => ({ font: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight }));
            assert.deepEqual(groupStyle, { font: '14px', weight: '600' });
            assert.equal(
              await busy.getByTestId('thread-running-cat').evaluate((el) => getComputedStyle(el).animationName),
              crowded ? 'none' : 'cat-bounce',
            );
            for (const id of ['thread-row-mention', 'thread-row-unread', 'thread-row-draft'])
              assert.equal(await busy.getByTestId(id).count(), 1);
            const shortTitle = sidebar.locator('[data-thread-id="composer-proof-3"] [role="link"]');
            await shortTitle.hover();
            await page.waitForTimeout(650);
            assert.equal(await page.getByRole('tooltip').count(), 0, 'a readable title has no metadata card');
            await busy.getByRole('button', { name: '更多操作', exact: true }).hover();
            await page.getByRole('tooltip').waitFor();
            await title.hover();
            await page.waitForTimeout(250);
            assert.equal(await page.getByRole('tooltip').count(), 0, 'a title does not join the icon warm run');
            const titleTip = page.getByRole('tooltip').filter({ hasText: await title.innerText() });
            await titleTip.waitFor();
            assert.equal(await titleTip.innerText(), await title.innerText());
            assert.equal(await titleTip.evaluate((el) => getComputedStyle(el).pointerEvents), 'none');
            const tipBounds = await titleTip.boundingBox(),
              sideBounds = await sidebar.boundingBox();
            assert.ok(tipBounds.x >= sideBounds.x + sideBounds.width, 'title recovery stays outside the sidebar');
            await page.screenshot({
              path: path.join(evidence, `${base}-${language}-${crowded ? '12cats' : '2cats'}-300-title-tip.png`),
            });
            const shortBounds = await shortTitle.boundingBox();
            await page.mouse.click(shortBounds.x + 5, shortBounds.y + 5);
            await titleTip.waitFor({ state: 'detached', timeout: 250 });
            await page.waitForFunction(() => new URL(location.href).pathname === '/thread/composer-proof-3');
            assert.equal(new URL(page.url()).pathname, '/thread/composer-proof-3', 'the next row receives the click');
            assert.equal(await titleTip.count(), 0, 'leaving the title closes its original recovery card');
            await page.goBack();
            await page.evaluate(() => window.__f322Chat.applied());
            await busy.getByRole('button', { name: '更多操作', exact: true }).click();
            await page.getByRole('menuitem', { name: '对话设置', exact: true }).click();
            assert.equal(
              await page.getByTestId('thread-project-path').locator('p').last().innerText(),
              proof.api.threads[1].projectPath,
            );
            await page.getByRole('button', { name: '关闭对话设置', exact: true }).click();
            await page.screenshot({
              path: path.join(evidence, `${base}-${language}-${crowded ? '12cats' : '2cats'}-300.png`),
            });
            async function geometry() {
              return page.evaluate(() => {
                const rows = [...document.querySelectorAll('[data-virtual-row-key]')].map((slot) => ({
                  slot: slot.getBoundingClientRect(),
                  content: slot.firstElementChild.getBoundingClientRect(),
                }));
                return rows.every(
                  ({ slot, content }, i) =>
                    Math.abs(slot.height - content.height) <= 1 && (!i || rows[i - 1].slot.bottom <= slot.top + 1),
                );
              });
            }
            await page.waitForFunction(() =>
              [...document.querySelectorAll('[data-virtual-row-key]')].every(
                (slot) =>
                  Math.abs(
                    slot.getBoundingClientRect().height - slot.firstElementChild.getBoundingClientRect().height,
                  ) <= 1,
              ),
            );
            assert.ok(await geometry(), 'virtual slots match every measured wrapped row');
            const labelTrigger = page.getByTestId('sidebar-label-filter-trigger');
            await labelTrigger.click();
            const menu = page.getByTestId('sidebar-label-filter-menu');
            assert.equal(await menu.locator('[role="menuitemradio"]').count(), 20);
            await menu.locator('[data-label-id="label-17"]').click();
            assert.match(await labelTrigger.innerText(), /Label 17/);
            await labelTrigger.click();
            assert.equal(await menu.locator('[data-menu-check]').count(), 1);
            await page.keyboard.press('Escape');
            assert.equal(await menu.count(), 0);
            assert.equal(await labelTrigger.evaluate((el) => el === document.activeElement), true);
            await page.locator(`[data-attention-cluster="group:${GROUP_ID}"] button[aria-controls]`).click();
            const filteredGroups = await sidebar
              .locator('[data-attention-cluster]')
              .evaluateAll((els) => els.map((el) => el.dataset.attentionCluster).sort());
            await page.evaluate(() => window.__f322Chat.presentation('classic'));
            const classicGroups = await page
              .locator('[data-attention-cluster]')
              .evaluateAll((els) => els.map((el) => el.dataset.attentionCluster).sort());
            assert.deepEqual(filteredGroups, classicGroups, 'label filtering retains the existing full-group closure');
            assert.match(await page.getByTestId('sidebar-label-filter-trigger').getAttribute('class'), /border-b-2/);
            await page.evaluate(() => window.__f322Chat.presentation('v2'));
            await page.locator(`[data-attention-cluster="group:${GROUP_ID}"] button[aria-controls]`).click();
            await page.getByTestId('sidebar-view-menu').click();
            await page.getByTestId('sidebar-tab-favorites').click();
            const visibleIds = await sidebar
              .locator('[data-thread-id]')
              .evaluateAll((els) => els.map((el) => el.dataset.threadId));
            assert.ok(
              visibleIds.length > 0 &&
                visibleIds.every((id) => proof.api.threads.find((row) => row.id === id)?.labels.includes('label-17')),
            );
            await page.getByTestId('sidebar-label-filter-clear').click();
            await page.getByTestId('sidebar-view-menu').click();
            await page.getByTestId('sidebar-tab-pinned').click();
            const handle = page.getByRole('separator', { name: '侧栏分隔条' });
            const rect = await handle.boundingBox();
            await page.mouse.move(rect.x + 2, 250);
            await page.mouse.down();
            await page.mouse.move(rect.x - 58, 250, { steps: 4 });
            await page.mouse.up();
            assert.equal(await sidebar.evaluate((el) => el.getBoundingClientRect().width), 240);
            await executionLine(240);
            const identity = busy.getByTestId('thread-signal-cats');
            await identity.hover();
            await page.getByRole('tooltip').filter({ hasText: '小太阳·砚砚' }).waitFor();
            if (crowded) {
              const rosterText = await page.getByRole('tooltip').innerText();
              for (let index = 4; index <= 12; index++) assert.ok(rosterText.includes(`Partner ${index}`));
            }
            await page.screenshot({
              path: path.join(evidence, `${base}-${language}-${crowded ? '12cats' : '2cats'}-240-status.png`),
            });
            const narrower = await handle.boundingBox();
            await page.mouse.move(narrower.x + 2, 250);
            await page.mouse.down();
            await page.mouse.move(narrower.x - 78, 250, { steps: 8 });
            await page.mouse.up();
            assert.equal(await sidebar.evaluate((el) => el.getBoundingClientRect().width), 160);
            await executionLine(160);
            assert.ok(
              await sidebar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
              'narrow sidebar has no horizontal overflow',
            );
            assert.ok(
              await busy
                .getByTestId('thread-row-signals')
                .evaluate((el) => [...el.children].every((part) => part.scrollWidth <= part.clientWidth + 1)),
              'narrow status and badges retain their own space',
            );
            assert.ok(
              await busy.getByTestId('thread-signal-cats').evaluate((roster) => {
                const bounds = roster.getBoundingClientRect();
                return [...roster.querySelectorAll('img')].every((avatar) => {
                  const rect = avatar.getBoundingClientRect();
                  return rect.width >= 16 && rect.left >= bounds.left && rect.right <= bounds.right + 1;
                });
              }),
              'every cat avatar stays visible at 160px',
            );
            await page.screenshot({
              path: path.join(evidence, `${base}-${language}-${crowded ? '12cats' : '2cats'}-160-status.png`),
            });
            await labelTrigger.click();
            const bounds = await menu.boundingBox(),
              side = await sidebar.boundingBox();
            assert.ok(
              bounds.x >= side.x && bounds.x + bounds.width <= side.x + side.width + 1,
              'menu stays inside the 160px sidebar',
            );
            assert.equal(await menu.locator('[role="menuitemradio"]').count(), 20);
            await page.screenshot({
              path: path.join(evidence, `${base}-${language}-${crowded ? '12cats' : '2cats'}-160-labels.png`),
            });
            await page.keyboard.press('Escape');
            assert.ok(await geometry());
            await page.locator(`[data-attention-cluster="group:${GROUP_ID}"] button[aria-controls]`).click();
            const group = page.locator(`[data-attention-cluster="group:${GROUP_ID}"]`);
            assert.equal(await group.getByTestId('group-running-cat').count(), 1);
            assert.equal(await group.locator('[data-testid="thread-signal-cats"] img').count(), 2);
            assert.equal(
              await group.getByTestId('group-working-label').textContent(),
              `${crowded ? 12 : 2}${language === 'zh' ? ' 只在干活' : ' working'}`,
            );
            const groupLines = await group.evaluate((el) => ({
              title: el.querySelector('[data-testid="group-title-line"]').getBoundingClientRect(),
              status: el.querySelector('[data-testid="group-status-line"]').getBoundingClientRect(),
            }));
            assert.ok(groupLines.status.top >= groupLines.title.bottom, 'collapsed group has the same two-line rhythm');
            assert.equal(
              await group.getByTestId('group-mention').count(),
              0,
              'collapsed header does not duplicate shortcut mentions',
            );
            assert.equal(
              await group.getByTestId('group-unread').count(),
              0,
              'collapsed header has one attention count',
            );
            const summary = await group.getByTestId('group-status-line').evaluate(measureSidebarSignalLayout);
            assert.ok(summary.contained && summary.noOverlap && summary.avatarsContained && summary.statusWhole);
            assert.deepEqual(
              summary.badgeRows,
              [],
              'collapsed status carries presence; attention labels belong to shortcuts',
            );
            await page.locator(`[data-attention-cluster="group:${GROUP_ID}"] button[aria-controls]`).click();
            const grow = await handle.boundingBox();
            await page.mouse.move(grow.x + 2, 250);
            await page.mouse.down();
            await page.mouse.move(grow.x + 142, 250, { steps: 8 });
            await page.mouse.up();
            assert.equal(await sidebar.evaluate((el) => el.getBoundingClientRect().width), 300);
            await executionLine();
            assert.ok(await geometry(), 'virtual rows recover on width growth');
          } finally {
            await harness.closeProof(proof);
            await context.close();
          }
        });
}
