import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadReadbackCapture } from '../fixtures/f322-readback-public-projection.mjs';
import { THREAD_ID } from './f307-real-surface-fixtures.mjs';
import { startNativeHost } from './f322-native-reply-next.mjs';
import { CARD_OTHER_THREAD_ID, createCardFixture } from './fixtures/f322-cat-profile-card.mjs';

async function verifyShellContinuity(page, initialShell, card, nameplate, results) {
  const input = page.locator('textarea').first();
  await input.fill('切换外壳仍保留的草稿');
  const main = await page.locator('main.overflow-y-auto').elementHandle();
  const composer = await input.elementHandle();
  const message = await page.locator('[data-message-id="card-idle"]').elementHandle();
  const switchShell = async (shell) => {
    // Drive the existing browser-local preference protocol without an outside
    // pointer event dismissing the card before the shell consumer can do so.
    await page.evaluate((value) => {
      localStorage.setItem('cat-cafe:shell-presentation', value);
      window.dispatchEvent(new CustomEvent('cat-cafe:shell-presentation-sync'));
    }, shell);
    await page.waitForFunction(
      (v2) => Boolean(document.querySelector('[data-testid="cat-nameplate"]')) === v2,
      shell === 'v2',
    );
    assert.equal(await page.locator('main.overflow-y-auto').evaluate((node, old) => node === old, main), true);
    assert.equal(await input.evaluate((node, old) => node === old, composer), true);
    assert.equal(
      await page.locator('[data-message-id="card-idle"]').evaluate((node, old) => node === old, message),
      true,
    );
    assert.equal(await input.inputValue(), '切换外壳仍保留的草稿');
    assert.equal(await card().count(), 0, 'shell changes do not preserve or revive an open card');
  };
  if (initialShell === 'v2') {
    await nameplate('鲸鲸').click();
    await card().waitFor();
    await switchShell('classic');
    await switchShell('v2');
  } else {
    await switchShell('v2');
    await nameplate('鲸鲸').click();
    await card().waitFor();
    await switchShell('classic');
  }
  await input.fill('');
  results.push({
    scenario: `shell-round-trip-from-${initialShell}`,
    status: 'passed',
    sameNodes: true,
    draftRetained: true,
  });
}

/** Real Next / ChatContainer / composer. Mock API is isolated to this browser context, never a human session. */
export async function runCatProfileCardJourney(browser, out) {
  if (out) await mkdir(out, { recursive: true });
  const host = await startNativeHost();
  const results = [];
  try {
    await host.ready();
    results.push({ scenario: 'instance', url: host.url, cwd: process.cwd() });
    for (const scenario of [
      { name: 'desktop', width: 1440, theme: 'light', language: 'zh', shell: 'v2' },
      { name: 'mobile', width: 390, theme: 'light', language: 'zh', shell: 'v2' },
      { name: 'dark', width: 1440, theme: 'dark', language: 'en', shell: 'v2' },
      { name: 'classic', width: 1440, theme: 'light', language: 'zh', shell: 'classic' },
    ]) {
      const context = await browser.newContext({
        viewport: { width: scenario.width, height: 900 },
        hasTouch: scenario.name === 'mobile',
      });
      const page = await context.newPage();
      const errors = [];
      const fixture = createCardFixture(loadReadbackCapture().traces[0].api);
      const en = scenario.language === 'en';
      const title = (name) => (en ? `Meet ${name}` : `看猫 · ${name}`);
      const card = (name = '鲸鲸') => page.getByRole('dialog', { name: title(name), exact: true });
      const nameplate = (name) => page.getByTestId('cat-nameplate-name').filter({ hasText: name }).first();
      const capture = async (name, target) => {
        if (!out) return;
        await page.screenshot({ path: path.join(out, `${name}-page.png`) });
        if (target) await target.screenshot({ path: path.join(out, `${name}-card.png`) });
      };
      try {
        page.on('pageerror', (error) => errors.push(error.message));
        await context.addInitScript((s) => {
          localStorage.setItem('cat-cafe:shell-presentation', s.shell);
          localStorage.setItem('cat-cafe:shell-language', s.language);
          localStorage.setItem('theme', s.theme);
        }, scenario);
        await page.routeWebSocket('**/socket.io/**', (socket) => {
          const sid = `cat-card-${scenario.name}`;
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
        await page.route('**/api/**', async (route) => {
          const response = fixture.response(route.request());
          await route.fulfill({
            status: response.status ?? 200,
            contentType: 'application/json',
            body: JSON.stringify(response.body),
          });
        });
        await page.route('**/card-avatars/*.png', async (route) => {
          const name = new URL(route.request().url()).pathname.split('/').pop();
          const source = path.join(process.env.CAT_CARD_AVATAR_DIR ?? '/tmp/cat-profile-card-proof', name);
          const fallback = path.resolve('public/avatars/default.png');
          await route.fulfill({ contentType: 'image/png', body: readFileSync(existsSync(source) ? source : fallback) });
        });
        await page.goto(`${host.url}/thread/${THREAD_ID}?shell=${scenario.shell}`, { waitUntil: 'networkidle' });
        await page.locator('[data-message-id="card-idle"]').waitFor();
        if (scenario.name === 'desktop') {
          const main = await page.locator('main.overflow-y-auto').elementHandle();
          await nameplate('鲸鲸').click();
          await card().waitFor();
          // Dispatch only click so outside-pointer dismissal cannot mask a stale selection.
          await page.locator(`[data-thread-id="${CARD_OTHER_THREAD_ID}"]`).dispatchEvent('click');
          await page.waitForURL(`**/thread/${CARD_OTHER_THREAD_ID}**`);
          await page.locator('[data-message-id="card-other-idle"]').waitFor();
          assert.equal(await card().count(), 0, 'navigation closes the old card');
          assert.equal(await page.locator('main.overflow-y-auto').evaluate((node, old) => node === old, main), true);
          await nameplate('鲸鲸').click();
          await card().getByRole('button', { name: '@ 它', exact: true }).click();
          assert.equal(await page.locator('textarea').first().inputValue(), '@deepseek-flash ');
          await page.locator(`[data-thread-id="${THREAD_ID}"]`).dispatchEvent('click');
          await page.waitForURL(`**/thread/${THREAD_ID}**`);
          await page.locator('[data-message-id="card-idle"]').waitFor();
          assert.equal(await card().count(), 0, 'returning does not resurrect the old card');
          assert.equal(await page.locator('main.overflow-y-auto').evaluate((node, old) => node === old, main), true);
          results.push({ scenario: 'thread-switch', status: 'passed', sameScrollNode: true, newComposerMention: true });
        }
        const collapse = page.getByTestId('sidebar-collapse');
        if (await collapse.isVisible()) await collapse.click();
        if (scenario.name === 'desktop' || scenario.name === 'classic') {
          await verifyShellContinuity(page, scenario.shell, card, nameplate, results);
        }
        if (scenario.shell === 'classic') {
          assert.equal(await page.getByTestId('cat-nameplate').count(), 0);
          assert.equal(await page.getByRole('dialog').count(), 0);
          results.push({ scenario: scenario.name, status: 'passed' });
          continue;
        }
        await nameplate('鲸鲸').hover();
        assert.equal(await card().count(), 0, 'hover does not open the card');
        const avatar = page.locator('[data-message-id="card-idle"] [data-testid="cat-nameplate-avatar"] button');
        await avatar.click();
        await card().waitFor();
        await card()
          .getByText(en ? 'Available' : '可用', { exact: true })
          .waitFor();
        await card().evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
        const bounds = await card().boundingBox();
        const avatarBounds = await card()
          .getByRole('button', { name: en ? "View 鲸鲸's original image" : '查看鲸鲸的原图' })
          .boundingBox();
        assert.equal(Math.round(bounds.width), scenario.width < 640 ? scenario.width : 340);
        assert.equal(Math.round(avatarBounds.width), scenario.width < 640 ? 84 : 96);
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 900.5, 'the whole card fits the actual viewport');
        assert.ok(
          await card().evaluate((node) => node.scrollWidth <= node.clientWidth),
          'footer and content fit the card',
        );
        results.push({ scenario: scenario.name, bounds, avatarBounds });
        await capture(`${scenario.name}-idle`, card());
        if (scenario.name === 'mobile') {
          const handle = card().getByRole('button', { name: '收起小卡' });
          const r = await handle.boundingBox();
          await page.mouse.move(r.x + r.width / 2, r.y + 12);
          await page.mouse.down();
          await page.mouse.move(r.x + r.width / 2, r.y + 100, { steps: 8 });
          await page.mouse.up();
          await card().waitFor({ state: 'hidden' });
          await nameplate('鲸鲸').click();
          await card().waitFor();
          await page.mouse.click(10, 80);
          await card().waitFor({ state: 'hidden' });
          assert.deepEqual(errors, []);
          results.push({ scenario: scenario.name, status: 'passed' });
          continue;
        }
        await card()
          .getByRole('button', { name: en ? "View 鲸鲸's original image" : '查看鲸鲸的原图' })
          .click();
        const original = page.getByRole('dialog', { name: en ? "鲸鲸's original image" : '鲸鲸的原图', exact: true });
        await original.waitFor();
        assert.match(await original.locator('img').getAttribute('src'), /jingjing\.png$/);
        await page.keyboard.press('Escape');
        await original.waitFor({ state: 'hidden' });
        await card().waitFor();
        await page.keyboard.press('Escape');
        await card().waitFor({ state: 'hidden' });
        const input = page.locator('textarea').first();
        await input.fill('前半段 后半段');
        await input.evaluate((node) => node.setSelectionRange(4, 4));
        await nameplate('鲸鲸').click();
        await card().waitFor();
        await card()
          .getByRole('button', { name: en ? '@ Mention' : '@ 它', exact: true })
          .click();
        assert.equal(await input.inputValue(), '前半段 @deepseek-flash 后半段');
        assert.equal(await input.evaluate((node) => node.selectionStart), '前半段 @deepseek-flash '.length);
        assert.equal(await input.evaluate((node) => node === document.activeElement), true);
        await nameplate('鲸鲸').click();
        await card().waitFor();
        await card()
          .getByRole('button', { name: en ? 'View this cat' : '只看它的回话', exact: true })
          .click();
        await card().waitFor({ state: 'hidden' });
        assert.deepEqual(fixture.writes.at(-1), {
          threadId: THREAD_ID,
          view: { mode: 'cat', catId: 'deepseek-flash' },
        });
        assert.equal(await page.locator('[data-message-id="card-working"]').count(), 0);
        await page.reload({ waitUntil: 'networkidle' });
        assert.equal(
          await page.locator('[data-message-id="card-working"]').count(),
          0,
          'existing owner restores saved cat view',
        );
        fixture.resetView();
        await page.reload({ waitUntil: 'networkidle' });
        await nameplate('宪宪').click();
        await card('宪宪').waitFor();
        await card('宪宪')
          .getByText(en ? /Replying here/ : /正在这条对话里回复/)
          .waitFor();
        await capture(`${scenario.name}-working`, card('宪宪'));
        await card('宪宪')
          .getByRole('button', { name: en ? 'View activity ›' : '看它在干什么 ›' })
          .click();
        await card('宪宪').waitFor({ state: 'hidden' });
        assert.equal(
          await page
            .locator('[data-message-id="card-working"]')
            .getByTestId('reply-record-toggle')
            .getAttribute('aria-expanded'),
          'true',
        );
        await nameplate('鲸鲸').click();
        await card().waitFor();
        await card()
          .getByRole('button', { name: en ? 'Settings ›' : '设置 ›', exact: true })
          .click();
        await page.waitForURL('**/settings?**');
        assert.equal(new URL(page.url()).searchParams.get('cat'), 'deepseek-flash');
        assert.equal(new URL(page.url()).searchParams.get('s'), 'members');
        assert.deepEqual(errors, []);
        results.push({ scenario: scenario.name, status: 'passed' });
      } catch (error) {
        if (out) {
          await capture(`${scenario.name}-failed`);
          await writeFile(path.join(out, `${scenario.name}-failed.txt`), await page.locator('body').innerText());
        }
        throw error;
      } finally {
        await context.close();
      }
    }
  } finally {
    await host.close();
    if (out) await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  }
}
