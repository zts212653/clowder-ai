import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadReadbackCapture } from '../fixtures/f322-readback-public-projection.mjs';
import { THREAD_ID } from './f307-real-surface-fixtures.mjs';
import { startNativeHost } from './f322-native-reply-next.mjs';
import { CARD_OTHER_THREAD_ID, createCardFixture } from './fixtures/f322-cat-profile-card.mjs';

/** The real AppShell, header, sidebar, drawer and commands; API writes stay inside this browser context. */
export async function runThreadSettingsJourney(browser, out) {
  if (out) await mkdir(out, { recursive: true });
  const host = await startNativeHost();
  const results = [
    { cwd: process.cwd(), url: host.url, boundary: 'real Next UI; isolated API fixtures; no runtime or user session' },
  ];
  try {
    await host.ready();
    for (const scenario of [
      { name: 'desktop', width: 1440, theme: 'light', shell: 'v2' },
      { name: 'mobile', width: 390, theme: 'light', shell: 'v2' },
      { name: 'dark', width: 1440, theme: 'dark', shell: 'v2' },
      { name: 'classic', width: 1440, theme: 'light', shell: 'classic' },
    ]) {
      const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 } });
      const page = await context.newPage();
      const fixture = createCardFixture(loadReadbackCapture().traces[0].api);
      const threads = [THREAD_ID, CARD_OTHER_THREAD_ID].map((id, index) => ({
        id,
        title: index ? '另一条对话的设置' : '对话设置 · 两个入口，同一面板',
        projectPath: '/project/cat-cafe',
        preferredCats: ['opus55'],
        labels: [],
        backlogItemId: 'feature-completed',
        pinned: false,
        lastActiveAt: Date.now() - 60000,
      }));
      const writes = [],
        errors = [];
      let rejectNextSave = false;
      const panel = page.getByTestId('thread-settings-panel');
      const trigger = page.getByTestId('thread-settings-toggle');
      const row = (id = THREAD_ID) => page.locator(`[data-thread-id="${id}"]`).first();
      const capture = async (name) => {
        if (out) await page.screenshot({ path: path.join(out, `${name}.png`) });
      };
      const saveField = async (field) => {
        const response = page.waitForResponse(
          (reply) =>
            new URL(reply.url()).pathname === `/api/threads/${THREAD_ID}` &&
            reply.request().method() === 'PATCH' &&
            Object.hasOwn(reply.request().postDataJSON(), field),
        );
        await panel.getByRole('button', { name: '保存', exact: true }).click();
        assert.equal((await response).ok(), true);
        await panel.getByRole('button', { name: '保存', exact: true }).waitFor({ state: 'visible' });
      };
      try {
        page.on('pageerror', (error) => errors.push(error.message));
        await context.addInitScript((s) => {
          localStorage.setItem('cat-cafe:shell-presentation', s.shell);
          localStorage.setItem('cat-cafe:shell-language', 'zh');
          localStorage.setItem('theme', s.theme);
        }, scenario);
        await page.routeWebSocket('**/socket.io/**', (socket) => {
          const sid = `thread-settings-${scenario.name}`;
          socket.send(`0${JSON.stringify({ sid, upgrades: [], pingInterval: 300000, pingTimeout: 200000 })}`);
          socket.onMessage((packet) => {
            const text = String(packet);
            if (text.startsWith('40')) socket.send(`40${JSON.stringify({ sid })}`);
            if (!text.startsWith('42')) return;
            const bracket = text.indexOf('['),
              ack = text.slice(2, bracket);
            const [event, room] = JSON.parse(text.slice(bracket));
            if (event === 'join_room' && ack) socket.send(`43${ack}${JSON.stringify([{ ok: true, room }])}`);
          });
        });
        await page.route('**/card-avatars/*.png', (route) => route.abort());
        await page.route('**/api/**', async (route) => {
          const request = route.request(),
            url = new URL(request.url());
          let response;
          const thread = threads.find((item) => url.pathname === `/api/threads/${item.id}`);
          if (thread) {
            if (request.method() === 'PATCH') {
              const patch = request.postDataJSON();
              writes.push({ threadId: thread.id, patch });
              if (rejectNextSave) {
                rejectNextSave = false;
                response = { status: 503, body: { error: 'fixture rejection' } };
              } else Object.assign(thread, patch);
            }
            response ??= { body: thread };
          } else if (url.pathname === '/api/threads') response = { body: { threads } };
          else if (url.pathname === '/api/labels')
            response = { body: [{ id: 'settings-label', name: '统一设置', color: '#8b6fd6', createdAt: 1 }] };
          else if (url.pathname === '/api/backlog/items')
            response = {
              body: {
                items: [
                  { id: 'feature-completed', title: '对话界面的统一', status: 'done' },
                  { id: 'feature-active', title: '守望猫与对话目标', status: 'open' },
                  { id: 'feature-cancelled', title: '已取消的 Feature', status: 'cancelled' },
                ],
              },
            };
          else response = fixture.response(request);
          await route.fulfill({
            status: response.status ?? 200,
            contentType: 'application/json',
            body: JSON.stringify(response.body),
          });
        });
        await page.goto(`${host.url}/thread/${THREAD_ID}?shell=${scenario.shell}`, { waitUntil: 'networkidle' });
        await page.locator('[data-message-id="card-idle"]').waitFor();
        if (scenario.shell === 'classic') {
          assert.equal(await trigger.count(), 0);
          await row().getByRole('button', { name: '更多操作', exact: true }).click();
          await page.getByRole('menuitem', { name: '对话设置', exact: true }).click();
          await panel.waitFor();
          assert.equal(await panel.locator('[data-settings-group]').count(), 0);
          assert.equal(await panel.getByRole('button', { name: /关联 Feature/ }).count(), 0);
          assert.deepEqual(await panel.locator('section > button .font-semibold').allTextContents(), [
            '对话目标',
            'Codex 运行状态',
            '默认猫猫',
            '思考档位',
            '速度档位',
            '标签管理',
          ]);
          await capture('classic-sidebar');
        } else {
          await trigger.click();
          await panel.waitFor();
          assert.equal(await panel.count(), 1);
          assert.equal(await page.getByTestId('thread-metadata-menu').count(), 0);
          assert.deepEqual(await panel.locator('section > button .font-semibold').allTextContents(), [
            '对话目标',
            '默认猫猫',
            '思考档位',
            '速度档位',
            'Codex 运行状态',
            '标签管理',
            '关联 Feature',
          ]);
          assert.equal(await panel.locator('input[type="checkbox"]').count(), 0);
          const headerBounds = await panel.boundingBox();
          assert.equal(Math.round(headerBounds.width), scenario.width < 768 ? scenario.width - 16 : 400);
          assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
          if (scenario.width < 768) {
            // The mobile header stays visible above its sheet: exercise an actual mouse press twice.
            await trigger.click();
            await panel.waitFor({ state: 'hidden' });
            assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
            await trigger.click();
            await panel.waitFor();
          }
          await capture(`${scenario.name}-header`);
          if (scenario.name === 'desktop') {
            await panel.getByRole('button', { name: /默认猫猫/ }).click();
            await panel.getByRole('button', { name: /鲸鲸/ }).click();
            await saveField('preferredCats');
            assert.deepEqual(writes.at(-1), {
              threadId: THREAD_ID,
              patch: { preferredCats: ['opus55', 'deepseek-flash'] },
            });
            await panel.getByRole('button', { name: /标签管理/ }).click();
            await panel.getByRole('checkbox', { name: '统一设置' }).check();
            await saveField('labels');
            assert.deepEqual(writes.at(-1), { threadId: THREAD_ID, patch: { labels: ['settings-label'] } });
          }
          await page.keyboard.press('Escape');
          await panel.waitFor({ state: 'hidden' });
          assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
          if (scenario.width < 768) {
            await trigger.click();
            await panel.getByRole('button', { name: /关联 Feature/ }).click();
            await panel.getByTestId('thread-feature-select').waitFor();
            await panel.getByTestId('thread-feature-select').scrollIntoViewIfNeeded();
            await capture('mobile-feature');
          } else {
            await row().getByRole('button', { name: '更多操作', exact: true }).click();
            await page.getByRole('menuitem', { name: '对话设置', exact: true }).click();
            await panel.waitFor();
            assert.deepEqual(await panel.boundingBox(), headerBounds);
            await capture(`${scenario.name}-sidebar`);
            // The desktop drawer covers the header control; return with Escape, then use the actual entry again.
            await page.keyboard.press('Escape');
            await panel.waitFor({ state: 'hidden' });
            await trigger.click();
            await panel.waitFor();
            assert.equal(await panel.count(), 1);
            await panel.getByRole('button', { name: /关联 Feature/ }).click();
            const select = panel.getByTestId('thread-feature-select');
            await select.waitFor();
            assert.equal(await select.inputValue(), 'feature-completed');
            assert.deepEqual(
              await select.locator('option').evaluateAll((options) => options.map((option) => option.value)),
              ['', 'feature-completed', 'feature-active'],
            );
            await capture(`${scenario.name}-feature`);
            if (scenario.name === 'desktop') {
              await select.selectOption('feature-active');
              await page.waitForFunction(
                () => !document.querySelector('[data-testid="thread-feature-select"]')?.disabled,
              );
              await panel.getByRole('button', { name: '关闭对话设置' }).click();
              await trigger.click();
              await panel.getByRole('button', { name: /关联 Feature/ }).click();
              assert.equal(await select.inputValue(), 'feature-active', 'reopening reads the saved association');
              rejectNextSave = true;
              await select.selectOption('');
              await panel.getByRole('alert').waitFor();
              assert.equal(await select.inputValue(), 'feature-active');
              await capture('desktop-save-error');
              await select.selectOption('');
              await page.waitForFunction(
                () => !document.querySelector('[data-testid="thread-feature-select"]')?.disabled,
              );
              assert.equal(threads[0].backlogItemId, null);
              await page.keyboard.press('Escape');
              const scrollNode = await page.locator('main.overflow-y-auto').elementHandle();
              await trigger.click();
              await row(CARD_OTHER_THREAD_ID).dispatchEvent('click');
              await page.waitForURL(`**/thread/${CARD_OTHER_THREAD_ID}**`);
              await page.locator('[data-message-id="card-other-idle"]').waitFor();
              assert.equal(await panel.count(), 0);
              assert.equal(
                await page.locator('main.overflow-y-auto').evaluate((node, old) => node === old, scrollNode),
                true,
              );
              await row(THREAD_ID).dispatchEvent('click');
              await page.waitForURL(`**/thread/${THREAD_ID}**`);
              assert.equal(await panel.count(), 0, 'returning does not resurrect the old panel');
              await row(CARD_OTHER_THREAD_ID).getByRole('button', { name: '更多操作', exact: true }).click();
              await page.getByRole('menuitem', { name: '对话设置', exact: true }).click();
              await panel.getByText(threads[1].title, { exact: true }).waitFor();
              await panel.getByRole('button', { name: /关联 Feature/ }).click();
              await select.selectOption('feature-active');
              await page.waitForFunction(
                () => !document.querySelector('[data-testid="thread-feature-select"]')?.disabled,
              );
              assert.deepEqual(writes.at(-1), {
                threadId: CARD_OTHER_THREAD_ID,
                patch: { backlogItemId: 'feature-active' },
              });
              assert.equal(
                threads[0].backlogItemId,
                null,
                'editing another row does not write the current conversation',
              );
            }
          }
        }
        assert.deepEqual(errors, []);
        results.push({ scenario: scenario.name, status: 'passed', writes });
      } catch (error) {
        await capture(`${scenario.name}-failure`);
        results.push({ scenario: scenario.name, status: 'failed', error: error.message, writes, errors });
        throw error;
      } finally {
        await context.close();
      }
    }
  } finally {
    await host.close();
    if (out) await writeFile(path.join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  }
}
