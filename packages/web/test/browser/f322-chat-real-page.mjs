import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAnnotationIncomingContinuity } from './annotation-incoming-continuity.journey.mjs';
import { runChatFlicker } from './f322-chat-flicker.journey.mjs';
import { runChatHistoryControls } from './f322-chat-history-controls.journey.mjs';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { runChatReadingColumnJourney } from './f322-chat-reading-column.mjs';
import { buildChatProof, origin } from './fixtures/f322-chat-real-page-build.mjs';
import {
  BUSY_THREAD,
  CURRENT_THREAD,
  cats,
  DRAFT,
  GROUP_ID,
  GROUP_TITLE,
  PROJECT_PATH,
} from './fixtures/f322-chat-real-page-data.mjs';
import {
  assertChatSidebarRoster,
  assertChatSidebarSignals,
  assertCrowdedChatSidebar,
} from './fixtures/f322-chat-real-page-metrics.mjs';

// Real ThreadSidebar/ThreadItem/AttentionCluster, header, composer/context, stores,
// HTTP client and theme. Only Next navigation and HTTP/provider transport are boundaries.
// Every URL is intercepted: this suite cannot connect to runtime, services or Redis.
const evidenceDir = process.env.F322_CHAT_EVIDENCE_DIR ?? path.join(os.tmpdir(), `f322-chat-real-page-${process.pid}`);
export async function runChatRealPageJourney(t, browser) {
  mkdirSync(evidenceDir, { recursive: true });
  const built = await buildChatProof();
  await t.test('confirmed counts and bottom geometry stay stable across refresh, late media and typing', () =>
    runChatFlicker(browser, built, path.join(evidenceDir, 'flicker')),
  );
  await t.test('latest control stays clear of message records and shares the works total', () =>
    runChatHistoryControls(browser, built, path.join(evidenceDir, 'history-controls')),
  );
  await t.test('annotation survives incoming messages while typing', () =>
    runAnnotationIncomingContinuity(browser, built, path.join(evidenceDir, 'annotation-continuity')),
  );
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const measurements = [];
  try {
    const harness = createChatProofHarness(context, built, evidenceDir, measurements);
    const { openProof, closeProof, capture } = harness;
    const memberRows = (page) => page.locator('[data-attention-cluster-member] [data-thread-id]');
    const groupToggle = (page) => page.locator(`[data-attention-cluster="group:${GROUP_ID}"] button[aria-controls]`);
    const threadMutations = (api) =>
      api.requests.filter((request) => request.method !== 'GET' && /^\/api\/threads\/[^/]+$/.test(request.path));
    const memberMutations = (api) =>
      api.requests.filter(
        (request) => request.path.endsWith('/thread-attention/groups') || request.path.includes('/members/'),
      );

    for (const [width, base, sidebar] of [
      [1440, 'light', true],
      [700, 'dark', true],
      [320, 'light', false],
    ]) {
      for (const language of ['zh', 'en']) {
        await t.test(`real composer and sidebar: ${width}px ${base} ${language}`, async () => {
          const proof = await openProof({ width, base, language, sidebar });
          const { page } = proof;
          try {
            const m = await capture(page, `${width}-${base}-${language}`);
            assert.equal(m.theme, base);
            if (sidebar) {
              assert.equal(m.sidebar.width, 300, 'the fixture host supplies the real sidebar width');
              if (width === 700) assert.equal(m.pane.width, 400);
            }
            assert.ok(m.document.scroll <= m.document.client + 1);
            for (const part of [m.pane, m.header, m.row, m.context])
              assert.ok(part.scroll <= part.client + 1, 'no horizontal overflow');
            assert.ok(m.controls.every(Boolean), '+ / project / recipient preview / mic / send all exist');
            assert.ok(m.textarea.bottom <= m.controls[0].y + 1, 'text sits above the controls');
            for (let i = 1; i < m.controls.length; i++)
              assert.ok(m.controls[i - 1].right <= m.controls[i].x + 1, 'controls do not overlap');
            const send = m.controls[4];
            assert.equal(send.width, send.height);
            assert.ok(send.radius >= send.width / 2, 'send is circular');
            assert.equal(m.row.border, 1, 'composer uses a hairline');
            assert.equal(await page.locator('header [data-testid="thread-cat-pill"]').count(), 0);
            assert.equal(await page.locator('[data-conversation-view-current="group"]').count(), 1);
            if (sidebar) {
              assert.equal(await memberRows(page).count(), 4);
              const busy = page.locator(`[data-thread-id="${BUSY_THREAD}"]`);
              for (const id of ['thread-row-working', 'thread-row-draft', 'thread-row-mention', 'thread-row-unread'])
                assert.equal(await busy.getByTestId(id).count(), 1);
              await assertChatSidebarSignals(page, busy, language);
              await assertChatSidebarRoster(page, busy, ['Astra', 'Sol']);
              assert.deepEqual(
                m.avatars.map((cat) => cat.name),
                ['Astra', 'Sol'],
              );
              assert.ok(m.avatars.every((cat, index) => cat.loaded && cat.ring === cats[index].color.primary));
              assert.ok(m.signals.scroll <= m.signals.client + 1, 'all status signals fit');
              assert.equal(
                m.busy.height,
                m.signals.height + 56,
                'two-line title, padding and intrinsic status height compose the row',
              );
              assert.equal(m.quiet.height, 32, 'quiet row matches its virtual slot');
            }
          } finally {
            await closeProof(proof);
          }
        });
      }
    }

    await t.test(
      'single-cat view projects proven bodies, keeps the group reading anchor, and shares one preference',
      async () => {
        const proof = await openProof({ width: 1440, base: 'light', language: 'zh', sidebar: true, surface: true });
        const { page, api } = proof;
        const visibleMessageIds = () =>
          page
            .locator('[data-thread-chat-reading-column] [data-message-id]')
            .evaluateAll((nodes) => [
              ...new Set(nodes.map((node) => node.getAttribute('data-message-id')).filter(Boolean)),
            ]);
        try {
          await page.locator('[data-message-id="reading-cat"]').waitFor();
          const scroll = page.locator('[data-chat-container]');
          await scroll.dispatchEvent('wheel', { deltaY: -120 });
          const groupTop = await scroll.evaluate((element) => {
            element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 180);
            element.dispatchEvent(new Event('scroll'));
            return element.scrollTop;
          });
          assert.ok(groupTop > 0, 'the controlled long conversation must provide a non-bottom group reading position');

          const toggle = page.getByTestId('conversation-view-menu-toggle');
          await toggle.click();
          const menu = page.getByTestId('conversation-view-menu');
          await menu.waitFor();
          assert.equal(await menu.locator('[data-conversation-cat]').count(), 3);
          assert.equal(await menu.locator('[data-conversation-cat="codex-astra"]').isDisabled(), false);
          assert.equal(await menu.locator('[data-conversation-cat="codex61-sol"]').isDisabled(), false);
          assert.equal(await menu.locator('[data-conversation-cat="codex6-luna"]').isDisabled(), true);
          assert.match(await menu.locator('[data-conversation-cat="codex-astra"]').textContent(), /发给它的和它说的/);
          assert.match(
            await menu.locator('[data-conversation-cat="codex6-luna"]').textContent(),
            /还没有可确认的对话记录/,
          );

          await menu.locator('[data-conversation-cat="codex-astra"]').click();
          await page.locator('[data-single-cat-conversation-timeline]').waitFor();
          assert.deepEqual(await visibleMessageIds(), ['reading-human', 'reading-whisper', 'reading-cat']);
          assert.equal(await page.locator('[data-conversation-execution="reading-cat"]').count(), 1);
          assert.equal(await page.locator('[data-conversation-input-evidence="read"]').count(), 2);
          assert.equal(await page.locator('[data-conversation-read-receipt]').count(), 2);
          assert.equal(await page.locator('[data-message-id="sol-response"]').count(), 0);
          await page.locator('[data-conversation-read-receipt]').first().scrollIntoViewIfNeeded();
          await capture(page, '1440-single-cat-astra-read-receipts');

          await scroll.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
            element.dispatchEvent(new Event('scroll'));
          });
          await toggle.click();
          await page.locator('[data-conversation-cat="codex61-sol"]').click();
          await page.locator('[data-conversation-pending]').waitFor();
          assert.deepEqual(await visibleMessageIds(), ['sol-human', 'sol-response', 'sol-queued']);
          assert.match(
            await page.locator('[data-conversation-unconfirmed-divider]').first().textContent(),
            /未确认读到/,
          );
          assert.match(await page.locator('[data-conversation-pending]').textContent(), /还在排队/);
          assert.equal(await page.locator('[data-message-id="reading-cat"]').count(), 0);

          await page.evaluate(() => window.__f322Chat.language('en'));
          assert.match(
            await page.locator('[data-conversation-unconfirmed-divider]').first().textContent(),
            /Read not confirmed/,
          );
          assert.equal(await page.locator('textarea').inputValue(), DRAFT);
          await capture(page, '1440-single-cat-sol-en');

          await toggle.click();
          await page.locator('[data-conversation-view="group"]').click();
          await page.waitForFunction(
            (top) => Math.abs(document.querySelector('[data-chat-container]')?.scrollTop - top) <= 2,
            groupTop,
          );
          assert.deepEqual(await visibleMessageIds(), [
            'reading-human',
            'reading-whisper',
            'reading-cat',
            'sol-human',
            'sol-response',
            'sol-queued',
          ]);
          assert.equal(await page.locator('textarea').inputValue(), DRAFT);
          assert.equal(
            await page.locator('[data-message-id="reading-cat"]').count(),
            1,
            'streaming body returns whole',
          );

          assert.deepEqual(
            api.requests
              .filter((request) => request.method === 'PUT' && request.path === '/api/config/conversation-view')
              .map((request) => request.body.view),
            [{ mode: 'cat', catId: 'codex-astra' }, { mode: 'cat', catId: 'codex61-sol' }, { mode: 'group' }],
          );

          await page.evaluate(() => window.__f322Chat.presentation('classic'));
          assert.equal(await page.getByTestId('conversation-view-menu-toggle').count(), 0);
          assert.deepEqual(await visibleMessageIds(), [
            'reading-human',
            'reading-whisper',
            'reading-cat',
            'sol-human',
            'sol-response',
            'sol-queued',
          ]);
        } finally {
          await closeProof(proof);
        }
      },
    );

    await t.test('single-cat view remains readable at 390px in dark English', async () => {
      const proof = await openProof({ width: 390, base: 'dark', language: 'en', sidebar: false, surface: true });
      const { page } = proof;
      try {
        await page.locator('[data-message-id="reading-cat"]').waitFor();
        await page.getByTestId('conversation-view-menu-toggle').click();
        const menu = page.getByTestId('conversation-view-menu');
        const box = await menu.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
        assert.match(await menu.locator('[data-conversation-cat="codex-astra"]').textContent(), /Messages sent/);
        await menu.locator('[data-conversation-cat="codex61-sol"]').click();
        await page.locator('[data-conversation-pending]').waitFor();
        assert.match(
          await page.locator('[data-conversation-unconfirmed-divider]').first().textContent(),
          /Read not confirmed/,
        );
        assert.equal(
          await page.locator('[data-chat-container]').evaluate((element) => element.scrollWidth <= element.clientWidth),
          true,
        );
        await capture(page, '390-dark-single-cat-sol-en');
      } finally {
        await closeProof(proof);
      }
    });

    await t.test(
      'twelve busy cats, elapsed time, draft, mention and capped unread remain distinct in 300px',
      async () => {
        await assertCrowdedChatSidebar(harness, memberRows, groupToggle, memberMutations);
        const negative = await openProof({ width: 320, sidebar: false });
        await negative.page.evaluate(() => fetch('/api/f322-unexpected-write-negative', { method: 'POST' }));
        assert.deepEqual(negative.unexpected, ['POST /api/f322-unexpected-write-negative']);
        await assert.rejects(
          () => closeProof(negative),
          { code: 'ERR_ASSERTION' },
          'strict closeProof rejects an unexpected write',
        );
      },
    );

    await t.test(
      'project path is exact and copy-only; preferred send cat remains distinct from the group view',
      async () => {
        const proof = await openProof({ width: 320, sidebar: false });
        const { page, api } = proof;
        try {
          await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
          const project = page.getByTestId('composer-project');
          assert.equal(await project.getAttribute('aria-label'), `项目: ${PROJECT_PATH}`);
          await project.click();
          assert.equal(await page.getByTestId('composer-project-full-path').textContent(), PROJECT_PATH);
          await page.getByRole('button', { name: '复制路径', exact: true }).click();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), PROJECT_PATH);
          assert.equal(threadMutations(api).length, 0);
          assert.equal(await page.evaluate(() => window.__f322Chat.currentProject()), '/wrong/global-workspace');
          await page.keyboard.press('Escape');
          assert.equal(await project.evaluate((el) => document.activeElement === el), true);
          assert.equal(
            await page.getByTestId('chat-composer-context').getByTestId('thread-cat-pill').count(),
            0,
            'the old preferred-cat pill stays out of the composer row',
          );
          assert.equal(await page.getByTestId('composer-routing-preview').count(), 1);
          await page.locator('button[aria-controls="composer-add-menu"]').click();
          const preferred = page.getByTestId('composer-preferred-cat-section');
          await preferred.waitFor();
          assert.match(await preferred.innerText(), /这条对话 · 没 @ 时先找谁/);
          assert.match(await preferred.innerText(), /只在还没有猫回过话时用上/);
          await preferred.getByTestId('composer-preferred-cat-toggle').click();
          const selected = preferred.getByTestId('composer-preferred-cat-codex61-sol');
          assert.equal(
            await preferred.getByTestId('composer-preferred-cat-default').getAttribute('aria-pressed'),
            'true',
          );
          assert.equal(
            await preferred.getByTestId('composer-preferred-cat-codex-astra').evaluate((el) => el.style.cssText),
            '',
          );
          await selected.click();
          await page.waitForFunction(
            () =>
              document
                .querySelector('[data-testid="composer-preferred-cat-codex61-sol"]')
                ?.getAttribute('aria-pressed') === 'true',
          );
          await capture(page, '320-cat-selector');
          assert.deepEqual(
            threadMutations(api).map((request) => request.body),
            [{ preferredCats: ['codex61-sol'] }],
          );
          await page.keyboard.press('Escape');
          await page.getByTestId('composer-add-menu').waitFor({ state: 'detached' });
          assert.equal(
            await page.locator('textarea').inputValue(),
            DRAFT,
            'preferred configuration does not insert a recipient mention',
          );
          assert.equal(api.sent.length, 0);
          assert.equal(
            api.requests.filter((request) => request.method !== 'GET' && request.path.endsWith('/conversation-view'))
              .length,
            0,
          );
          assert.equal(await page.locator('[data-conversation-view-current="group"]').count(), 1);
          await page.getByTestId('conversation-view-menu-toggle').click();
          assert.equal(await page.locator('[data-conversation-view="group"]').getAttribute('aria-checked'), 'true');
          assert.equal(await page.locator('[data-conversation-cat="codex61-sol"]').isDisabled(), true);
        } finally {
          await closeProof(proof);
        }
      },
    );

    await t.test(
      'four-row preview reveals seven real members, then collapses without member writes or navigation',
      async () => {
        const proof = await openProof({ width: 700, base: 'dark' });
        const { page, api } = proof;
        try {
          const members = [...api.preferences.groups[0].threadIds];
          assert.equal(await memberRows(page).count(), 4);
          await page.getByRole('button', { name: '其余 7 个对话', exact: true }).click();
          await page.waitForFunction(
            () => document.querySelectorAll('[data-attention-cluster-member] [data-thread-id]').length === 11,
          );
          assert.equal(
            await page.evaluate(() =>
              document.activeElement?.closest('[data-thread-id]')?.getAttribute('data-thread-id'),
            ),
            'composer-proof-4',
          );
          assert.equal(await page.evaluate(() => window.__f322Chat.selectedThread()), CURRENT_THREAD);
          assert.equal(
            api.requests.filter((request) => request.method !== 'GET' && request.path.includes('thread-attention'))
              .length,
            0,
          );
          await groupToggle(page).click();
          await page.waitForFunction(
            () => document.querySelectorAll('[data-attention-cluster-member] [data-thread-id]').length === 0,
          );
          await groupToggle(page).click();
          await page.getByRole('button', { name: '其余 7 个对话', exact: true }).waitFor();
          assert.equal(await memberRows(page).count(), 4);
          assert.deepEqual(api.preferences.groups[0].threadIds, members);
          assert.equal(memberMutations(api).filter((request) => request.method !== 'GET').length, 0);
          assert.ok(
            api.requests
              .filter((request) => request.method === 'PUT')
              .every((request) => Object.keys(request.body).every((key) => ['anchor', 'open'].includes(key))),
          );
          await capture(page, '700-group-reopened');
        } finally {
          await closeProof(proof);
        }
      },
    );

    await t.test(
      'draft, focus, selection and IME survive language and classic switches on the same textarea',
      async () => {
        const proof = await openProof();
        const { page, api } = proof;
        try {
          const input = page.locator('textarea');
          await input.fill('还没发送的草稿');
          await input.press('End');
          const imeSession = await page.context().newCDPSession(page);
          await imeSession.send('Input.imeSetComposition', { text: '中文', selectionStart: 1, selectionEnd: 2 });
          const original = await input.evaluate((el) => {
            window.__inputBefore = el;
            return [true, true, el.selectionStart, el.selectionEnd, el.value];
          });
          for (const presentation of ['classic', 'v2']) {
            await page.evaluate((next) => {
              window.__f322Chat.language('en');
              window.__f322Chat.presentation(next);
            }, presentation);
            await page.waitForFunction(
              (next) =>
                document.querySelector('[data-composer-presentation]')?.getAttribute('data-composer-presentation') ===
                next,
              presentation,
            );
            assert.deepEqual(
              await input.evaluate((el) => [
                el === window.__inputBefore,
                document.activeElement === el,
                el.selectionStart,
                el.selectionEnd,
                el.value,
              ]),
              original,
            );
            await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
            assert.equal(api.sent.length, 0);
            if (presentation === 'classic') {
              assert.equal(await page.getByTestId('chat-composer-context').count(), 0);
              assert.equal(await page.locator('header [data-testid="thread-cat-pill"]').count(), 1);
              await capture(page, '1440-classic-retained-draft');
            }
          }
          await imeSession.send('Input.insertText', { text: '中文' });
          await imeSession.detach();
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
          await input.press('End');
          await input.press('Shift+Enter');
          assert.equal(api.sent.length, 0);
          await input.press('Enter');
          await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
          assert.equal(api.sent.length, 1);
        } finally {
          await closeProof(proof);
        }
      },
    );

    await t.test(
      'full titles remain available by hover and keyboard; reduced motion stops the running cat',
      async () => {
        const proof = await openProof({ width: 700, base: 'dark' });
        const { page } = proof;
        try {
          const title = page.locator(`[data-thread-id="${BUSY_THREAD}"] [role="link"]`);
          const fullTitle = await title.textContent();
          await title.hover();
          await page.getByRole('tooltip').waitFor();
          assert.ok((await page.getByRole('tooltip').innerText()).includes(fullTitle));
          await page.keyboard.press('Escape');
          await page.keyboard.press('Tab');
          await groupToggle(page).focus();
          await page.getByRole('tooltip').waitFor();
          assert.ok((await page.getByRole('tooltip').innerText()).includes(GROUP_TITLE));
          await page.keyboard.press('Escape');
          await page.emulateMedia({ reducedMotion: 'reduce' });
          const metrics = await capture(page, '700-reduced-motion');
          assert.equal(metrics.runningAnimation, 'none');
        } finally {
          await closeProof(proof);
        }
      },
    );
    await runChatReadingColumnJourney(t, harness);
  } finally {
    await context.close();
    writeFileSync(path.join(evidenceDir, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
  }
}
