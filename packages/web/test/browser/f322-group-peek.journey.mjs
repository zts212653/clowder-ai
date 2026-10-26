import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { buildChatProof } from './fixtures/f322-chat-real-page-build.mjs';
import { GROUP_ID } from './fixtures/f322-chat-real-page-data.mjs';
import { setupSidebarProof } from './fixtures/f322-sidebar-v2-data.mjs';

/** Deterministic production components and CSS; the HTTP fixture is explicitly not Alpha/runtime data. */
export async function runGroupPeekJourney(t, browser) {
  const evidence = process.env.F322_GROUP_PEEK_EVIDENCE_DIR ?? path.join(os.tmpdir(), 'f322-group-peek-proof');
  mkdirSync(evidence, { recursive: true });
  const built = await buildChatProof();
  for (const base of ['light', 'dark'])
    for (const language of ['zh', 'en']) {
      await t.test(`collapsed Group peek: ${base} ${language}`, async () => {
        const context = await browser.newContext();
        const harness = createChatProofHarness(context, built, evidence, [], (api) => {
          setupSidebarProof(api);
          api.preferences.open[`group:${GROUP_ID}`] = false;
          api.threads.forEach((row) => {
            row.unreadCount = 0;
            row.hasUserMention = false;
          });
          for (let i = 1; i <= 5; i++) api.threads[i].unreadCount = i;
          api.threads[1].hasUserMention = true;
          api.decisions.push({
            decisionRef: 'f306.runtime_interaction:peek',
            kind: 'judgment',
            summary: 'Choose',
            linkedNeedsMe: [],
            choiceRequest: {
              interactionId: 'peek',
              revision: 1,
              requesterCatId: 'codex61-sol',
              createdAt: 1,
              title: 'Choose',
              questions: [{ id: 'pick', header: 'Choice', question: 'Which?' }],
              cardRef: { threadId: api.threads[2].id, messageId: 'm', blockId: 'b' },
            },
          });
        });
        const proof = await harness.openProof({ base, language, resizable: true });
        const { page, api } = proof;
        const group = page.locator(`[data-attention-cluster="group:${GROUP_ID}"]`);
        const rows = group.locator('[data-peek-reason]');
        try {
          await rows.first().waitFor();
          assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.peekReason)), [
            'decision',
            'mention',
            'unread',
          ]);
          const unreadThreadId = await rows.last().getAttribute('data-thread-id');
          const unreadCount = api.threads.find((thread) => thread.id === unreadThreadId).unreadCount;
          assert.deepEqual(
            await rows.getByTestId('group-peek-label').allTextContents(),
            language === 'zh'
              ? ['等你决定', '@你', `${unreadCount} 未读`]
              : ['To decide', '@you', `${unreadCount} unread`],
          );
          // One browser case proves both consumers refresh from the personal view;
          // the pure reader tests cover pagination and unavailable snapshots.
          if (base === 'light' && language === 'zh') {
            const read = await page.evaluate(() =>
              fetch('/api/concierge/work/decisions?view=unified&offset=0&limit=20&personalView=visible').then((r) =>
                r.json(),
              ),
            );
            const coordinate = read.items[0].preferenceCoordinate;
            const refresh = async (event) => {
              const response = page.waitForResponse((res) => {
                const url = new URL(res.url());
                return (
                  url.pathname === '/api/concierge/work/decisions' &&
                  url.searchParams.get('personalView') === 'visible' &&
                  !url.searchParams.has('includeUserMentions')
                );
              });
              await page.evaluate((name) => window.dispatchEvent(new Event(name)), event);
              const snapshot = await (await response).json();
              assert.equal(snapshot.personalView.preferenceRevision, api.decisionPreferences.revision);
              return snapshot;
            };
            api.decisionPreferences.ignored.add(coordinate.version);
            api.decisionPreferences.revision++;
            assert.equal((await refresh('cat-cafe:ignored-item-preferences-updated')).items.length, 0);
            await group
              .getByTestId('group-count')
              .filter({ hasText: /^5 条要看$/ })
              .waitFor();
            await group.locator('[data-peek-reason="decision"]').waitFor({ state: 'detached' });
            await page.screenshot({ path: path.join(evidence, 'personal-ignored-collapsed.png') });
            await group.locator('button[aria-controls]').click();
            assert.equal(await page.getByTestId('thread-row-pending-decision').count(), 0);
            assert.ok((await page.getByTestId('thread-row-unread').count()) > 0, 'independent unread signals remain');
            api.decisionPreferences.ignored.clear();
            api.decisionPreferences.revision++;
            await refresh('cat-cafe:ignored-item-preferences-updated');
            await page.getByTestId('thread-row-pending-decision').waitFor();
            api.decisionPreferences.ignored.add(coordinate.version);
            api.decisionPreferences.revision++;
            assert.equal((await refresh('cat-cafe:ignored-item-preferences-updated')).items.length, 0);
            assert.equal(
              await group.getByTestId('group-count').textContent(),
              String(api.preferences.groups.find((g) => g.id === GROUP_ID).threadIds.length),
            );
            await page.getByTestId('thread-row-pending-decision').waitFor({ state: 'detached' });
            api.decisions[0].choiceRequest.revision++;
            await refresh('cat-cafe:runtime-interaction-updated');
            await page.getByTestId('thread-row-pending-decision').waitFor();
            await group.locator('button[aria-controls]').click();
            await group.locator('[data-peek-reason="decision"]').waitFor();
            const personalReads = api.requests.filter((r) => r.path === '/api/concierge/work/decisions');
            assert.ok(personalReads.length > 4);
            assert.ok(personalReads.every((r) => new URLSearchParams(r.search).get('personalView') === 'visible'));
            writeFileSync(
              path.join(evidence, 'personal-visibility.json'),
              JSON.stringify(
                {
                  ignoredCoordinate: coordinate,
                  ignoredAndRestored: true,
                  newerVersionVisible: true,
                  rowAndCollapsed: true,
                  independentUnreadPreserved: true,
                  personalReads,
                },
                null,
                2,
              ),
            );
          }
          const contrast = await group
            .getByTestId('group-peek-label')
            .first()
            .evaluate((label) => {
              const context = document.createElement('canvas').getContext('2d');
              const color = (value) => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = value;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data];
              };
              const luminance = (rgb) =>
                rgb
                  .slice(0, 3)
                  .map((v) => {
                    const s = v / 255;
                    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                  })
                  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
              let parent = label.parentElement;
              while (parent && color(getComputedStyle(parent).backgroundColor)[3] === 0) parent = parent.parentElement;
              const foreground = color(getComputedStyle(label).color);
              const background = color(getComputedStyle(parent).backgroundColor);
              const a = luminance(foreground),
                b = luminance(background);
              return { foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
            });
          assert.ok(contrast.ratio >= 4.5, `decision text contrast ${JSON.stringify(contrast)}`);
          assert.equal(
            await group.getByTestId('group-count').textContent(),
            language === 'zh' ? '5 条要看' : '5 to see',
          );
          assert.equal(
            await group.getByTestId('group-peek-more').textContent(),
            language === 'zh' ? '还有 2 条 · 展开' : '2 more · Expand',
          );
          const measurements = [];
          for (const width of [300, 240, 160, 300]) {
            const sidebar = page.locator('[data-shell-sidebar="v2"]');
            const current = await sidebar.evaluate((node) => node.getBoundingClientRect().width);
            if (current !== width) {
              const handle = await page.getByRole('separator', { name: '侧栏' }).boundingBox();
              await page.mouse.move(handle.x + 2, 250);
              await page.mouse.down();
              await page.mouse.move(handle.x + 2 + width - current, 250, { steps: 8 });
              await page.mouse.up();
            }
            await page.waitForFunction(
              (width) => document.querySelector('[data-shell-sidebar="v2"]').getBoundingClientRect().width === width,
              width,
            );
            await page.waitForFunction(() =>
              [...document.querySelectorAll('[data-virtual-row-key]')].every(
                (slot) =>
                  Math.abs(
                    slot.getBoundingClientRect().height - slot.firstElementChild.getBoundingClientRect().height,
                  ) <= 1,
              ),
            );
            const geometry = await group.evaluate((node) => {
              const bounds = node.getBoundingClientRect();
              const entries = [...node.querySelectorAll('[data-peek-reason]')];
              return {
                count: entries.length,
                noOverflow: node.scrollWidth <= node.clientWidth,
                contained: entries.every(
                  (entry) =>
                    entry.getBoundingClientRect().left >= bounds.left &&
                    entry.getBoundingClientRect().right <= bounds.right,
                ),
                distinct: entries.every(
                  (entry, i) =>
                    !i || entry.getBoundingClientRect().top >= entries[i - 1].getBoundingClientRect().bottom,
                ),
                accessible: entries.every((entry) => entry.getAttribute('aria-label').includes(' · ')),
                titlesHaveWidth: entries.every(
                  (entry) => entry.querySelector('[data-testid="group-peek-title"]').getBoundingClientRect().width > 0,
                ),
              };
            });
            if (!geometry.noOverflow) {
              const details = await group.evaluate((node) => {
                const b = node.getBoundingClientRect();
                return {
                  bounds: { left: b.left, right: b.right, width: b.width },
                  client: node.clientWidth,
                  scroll: node.scrollWidth,
                  children: [...node.querySelectorAll('*')]
                    .map((e) => {
                      const r = e.getBoundingClientRect(),
                        s = getComputedStyle(e);
                      return {
                        tag: e.tagName,
                        test: e.getAttribute('data-testid'),
                        class: e.className,
                        text: e.textContent.slice(0, 100),
                        left: r.left,
                        right: r.right,
                        width: r.width,
                        client: e.clientWidth,
                        scroll: e.scrollWidth,
                        overflow: s.overflow,
                        display: s.display,
                        whiteSpace: s.whiteSpace,
                      };
                    })
                    .filter((e) => e.right > b.right || e.scroll > e.client),
                };
              });
              writeFileSync(
                path.join(evidence, `${base}-${language}-${width}-overflow.json`),
                JSON.stringify(details, null, 2),
              );
              await page.screenshot({ path: path.join(evidence, `${base}-${language}-${width}-overflow.png`) });
            }
            assert.deepEqual(geometry, {
              count: 3,
              noOverflow: true,
              contained: true,
              distinct: true,
              accessible: true,
              titlesHaveWidth: true,
            });
            measurements.push({ width, ...geometry });
          }
          await page.screenshot({ path: path.join(evidence, `${base}-${language}-five.png`) });
          await group.getByTestId('group-peek-more').click();
          assert.equal(await group.getAttribute('data-expanded'), 'true');
          await group.locator('button[aria-controls]').click();
          await group.locator('button[aria-haspopup="menu"]').click();
          const toggle = page.getByRole('menuitemcheckbox');
          assert.equal(await toggle.getAttribute('aria-checked'), 'true');
          await toggle.click();
          await rows.first().waitFor({ state: 'detached' });
          await page.reload();
          await page.getByTestId('chat-proof-ready').waitFor({ state: 'attached' });
          await page.evaluate((base) => window.__f322Chat.theme(base), base);
          await page.evaluate(() => window.__f322Chat.applied());
          assert.equal(await rows.count(), 0);
          assert.equal(api.preferences.collapsedPeek[`group:${GROUP_ID}`], false);
          assert.equal(
            await group.getByTestId('group-count').textContent(),
            language === 'zh' ? '5 条要看' : '5 to see',
          );
          await page.screenshot({ path: path.join(evidence, `${base}-${language}-off.png`) });
          writeFileSync(
            path.join(evidence, `${base}-${language}.json`),
            JSON.stringify({ measurements, preference: api.preferences.collapsedPeek }, null, 2),
          );
        } finally {
          await harness.closeProof(proof);
          await context.close();
        }
      });
    }
}
