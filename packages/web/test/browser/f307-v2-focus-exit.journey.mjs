import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { routeFocusExitFixtures } from './fixtures/f307-v2-focus-exit.mjs';

// Registered in the existing canonical F307 journey; shares its actual Next server and browser.
// Domain/preview content alone is fixture HTTP, with the real F307 focus/full-window owners.
const evidence = process.env.F322_FOCUS_EVIDENCE_DIR ?? '/tmp/cat-cafe-evidence/f322-focus-exit';
const copies = {
  zh: {
    theme: 'light',
    frameTitle: '页面预览',
    focusCurrent: '专注当前工具',
    fullWindow: '整窗',
    exitFullWindow: '退出整窗',
    focusText: /退出专注.*Esc.*整窗/,
  },
  en: {
    theme: 'dark',
    frameTitle: 'Page preview',
    focusCurrent: 'Focus current tool',
    fullWindow: 'Full window',
    exitFullWindow: 'Exit full window',
    focusText: /Exit focus.*Esc.*Full window/,
  },
};

export function registerV2FocusExitJourneys(getSuite) {
  for (const language of ['zh', 'en']) {
    const copy = copies[language];
    test(
      `v2 ${language}: persistent focus exit, iframe and full-window round trips`,
      { timeout: 120_000 },
      async () => {
        await mkdir(evidence, { recursive: true });
        const { browser, baseUrl } = getSuite();
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await context.addInitScript(
          ({ language, theme }) => {
            localStorage.clear();
            localStorage.setItem('cat-cafe:shell-language', language);
            localStorage.setItem('theme', theme);
          },
          { language, theme: copy.theme },
        );
        await routeFocusExitFixtures(context);
        const page = await context.newPage();
        try {
          await page.goto(`${baseUrl}?shell=v2`, { waitUntil: 'domcontentloaded' });
          await ensureWorkspaceOpen(page);
          await page.getByTestId('v2-workspace-tools').click();
          await page.getByTestId('workspace-launcher-dev-browser').click();
          const address = page.getByPlaceholder('localhost:3000');
          const previewUrl = 'http://localhost:5334/browser-owner-probe';
          await address.fill(previewUrl);
          await address.press('Enter');
          const frameTitle = copy.frameTitle;
          const frame = page.frameLocator(`iframe[title="${frameTitle}"]`);
          const ownerInput = frame.getByRole('textbox', { name: '预览页草稿' });
          await ownerInput.fill('iframe draft survives focus');
          await frame.getByRole('button', { name: '下一步' }).click();
          // Place the fixture's real action at the tool's top-right edge to check the parent overlay's hit region.
          await frame.locator('#move').evaluate((button) => {
            Object.assign(button.style, { position: 'fixed', top: '0', right: '0', margin: '0' });
          });
          const composer = page.locator('[data-guide-id="chat.input"] textarea');
          const chatDraft = `聊天草稿 ${language}`;
          await composer.fill(chatDraft);
          const workbench = page.getByTestId('f307-experience-workbench');
          const surfaceId = await workbench.getAttribute('data-active-surface');
          const surface = workbench.locator(`[data-surface-id="${surfaceId}"]`);
          const iframe = page.locator(`iframe[title="${frameTitle}"]`);
          await iframe.evaluate((node) => {
            window.__focusExitFrame = node;
          });
          const enter = async () => {
            await page
              .getByTestId('v2-workspace-chrome')
              .locator('[data-testid="v2-workspace-actions"] summary')
              .last()
              .click();
            await page.getByRole('menuitem', { name: copy.focusCurrent, exact: true }).click();
          };
          const assertFocused = async () => assert.equal(await workbench.getAttribute('data-focus-surface'), surfaceId);
          const assertReturned = async (moves = '2') => {
            assert.equal(await workbench.getAttribute('data-focus-surface'), '');
            assert.equal(await workbench.getAttribute('data-active-surface'), surfaceId);
            assert(await iframe.evaluate((node) => node === window.__focusExitFrame && node.isConnected));
            assert.equal(await ownerInput.inputValue(), 'iframe draft survives focus');
            assert.equal(await frame.locator('#moves').textContent(), moves);
            assert.equal(await composer.inputValue(), chatDraft);
          };
          // The topbar is deliberately absent in focus mode. Exercise its new full-window
          // entry in normal Workspace, then keep the original focus-control round trips.
          const host = page.getByTestId('thread-chat-host');
          const workspaceActions = page
            .getByTestId('v2-workspace-chrome')
            .locator('[data-testid="v2-workspace-actions"] summary')
            .last();
          await workspaceActions.click();
          await page.getByRole('menuitemcheckbox', { name: copy.fullWindow, exact: true }).click();
          await page.waitForFunction(
            () =>
              document.querySelector('[data-testid="thread-chat-host"]')?.getAttribute('data-presentation') ===
              'artifact-full-window',
          );
          assert(await iframe.evaluate((node) => node === window.__focusExitFrame && node.isConnected));
          assert.equal(await ownerInput.inputValue(), 'iframe draft survives focus');
          assert.equal(await composer.inputValue(), chatDraft);
          await page.screenshot({ path: path.join(evidence, `${language}-menu-full-window.png`) });
          await workspaceActions.click();
          const fullWindow = page.getByRole('menuitemcheckbox', { name: copy.fullWindow, exact: true });
          assert.equal(await fullWindow.getAttribute('aria-checked'), 'true');
          await fullWindow.click();
          assert.equal(await host.getAttribute('data-presentation'), 'conversation');
          await assertReturned('1');
          await enter();
          await page.mouse.move(5, 100);
          await page.waitForTimeout(3100);
          const controls = page.getByTestId('workspace-focus-controls');
          assert(await controls.isVisible());
          assert.equal((await controls.boundingBox()).height, 24);
          assert.equal(await page.locator('html').getAttribute('data-theme'), copy.theme);
          assert.match(await controls.textContent(), copy.focusText);
          await ownerInput.click();
          assert(await iframe.evaluate((node) => document.activeElement === node), 'iframe must actually own focus');
          await page.keyboard.press('Escape');
          await assertFocused();
          assert(await controls.isVisible());
          await page.screenshot({ path: path.join(evidence, `${language}-iframe-focus.png`) });
          await frame.getByRole('button', { name: '下一步' }).click();
          assert.equal(
            await frame.locator('#moves').textContent(),
            '2',
            'the label must not cover the tool corner action',
          );
          await page.getByTestId('workspace-focus-exit').click();
          await assertReturned();

          await enter();
          await page.getByTestId('workspace-focus-exit').focus();
          await page.keyboard.press('Escape');
          await assertReturned();

          for (const exitMethod of ['click', 'Escape']) {
            await enter();
            await page.getByTestId('workspace-focus-full-window').click();
            await page.waitForFunction(
              () =>
                document.querySelector('[data-testid="thread-chat-host"]')?.getAttribute('data-presentation') ===
                'artifact-full-window',
            );
            await ownerInput.click();
            const leave = page.getByTestId('workspace-focus-exit');
            assert.equal(await leave.getAttribute('aria-label'), copy.exitFullWindow);
            if (exitMethod === 'click') await leave.click();
            else {
              await leave.focus();
              await page.keyboard.press('Escape');
            }
            assert.equal(await host.getAttribute('data-presentation'), 'conversation');
            await assertFocused();
            await page.getByTestId('workspace-focus-exit').click();
            await assertReturned();
          }

          // The desktop split keeps its exit available even when the Workspace itself is only 280px wide.
          await enter();
          await workbench.evaluate((node) => {
            node.style.width = '280px';
            node.style.flex = '0 0 280px';
          });
          await page.mouse.move(5, 100);
          await page.waitForTimeout(3100);
          const paneBox = await surface.boundingBox();
          const controlsBox = await controls.boundingBox();
          assert(controlsBox.x >= paneBox.x && controlsBox.x + controlsBox.width <= paneBox.x + paneBox.width);
          assert.equal(controlsBox.height, 24);
          assert(await page.getByTestId('workspace-focus-full-window').isVisible());
          await frame.getByRole('button', { name: '下一步' }).click({ position: { x: 10, y: 10 }, timeout: 3000 });
          assert.equal(
            await frame.locator('#moves').textContent(),
            '3',
            'the narrow label must not cover the tool corner action',
          );
          await page.screenshot({ path: path.join(evidence, `${language}-narrow-focus.png`) });
          await page.getByTestId('workspace-focus-exit').click();
          assert.equal(await workbench.getAttribute('data-focus-surface'), '');
          assert.equal(await workbench.getAttribute('data-active-surface'), surfaceId);
          assert(await iframe.evaluate((node) => node === window.__focusExitFrame && node.isConnected));
          assert.equal(await ownerInput.inputValue(), 'iframe draft survives focus');
          assert.equal(await composer.inputValue(), chatDraft);
        } catch (error) {
          await page.screenshot({ path: path.join(evidence, `${language}-failure.png`) });
          throw error;
        } finally {
          await context.close();
        }
      },
    );
  }
}
