import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test as nativeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { registerFileMenuViewportJourneys } from './f309-file-menu-viewport.mjs';
import { assertMenuClosed, assertPopupVisible, menuPanel, menuTrigger } from './f322-workspace-menu-observations.mjs';
import { buildWorkspaceMenuPage, menuOrigin, routeWorkspaceMenuAssets } from './fixtures/f322-workspace-menu-build.mjs';

const evidence = process.env.F322_MENU_EVIDENCE_DIR ?? '/tmp/cat-cafe-evidence/f322-workspace-menu';
const menuCases = ['zh', 'en'].flatMap((language) => ['tabs', 'workspace', 'file'].map((menu) => ({ language, menu })));
export function registerWorkspaceMenuTests(getSharedBrowser) {
  registerFileMenuViewportJourneys();
  return describe('Workspace menu: visible placement and original actions', () => {
    let browser, built;
    const test = (name, action) => nativeTest(`Workspace menu: ${name}`, action);
    before(async () => {
      await mkdir(evidence, { recursive: true });
      built = await buildWorkspaceMenuPage();
      browser = getSharedBrowser ? getSharedBrowser() : await chromium.launch({ headless: true });
      assert.ok(browser);
    });
    after(async () => {
      if (!getSharedBrowser) await browser?.close();
      await writeFile(
        path.join(evidence, 'browser-cleanup.json'),
        JSON.stringify({ browserClosed: !getSharedBrowser, sharedBrowser: Boolean(getSharedBrowser) }),
      );
    });
    for (const { language, menu } of menuCases) {
      test(`${language} ${menu} menu stays visible and Escape returns to its trigger`, async () => {
        const context = await browser.newContext({ viewport: { width: 1000, height: 720 } });
        const page = await context.newPage();
        const errors = [],
          unexpected = [];
        page.setDefaultTimeout(10000);
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript((lang) => {
          localStorage.setItem('cat-cafe:shell-presentation', 'v2');
          localStorage.setItem('cat-cafe:shell-language', lang);
        }, language);
        await page.route('**/*', (route) => routeWorkspaceMenuAssets(route, built, unexpected));
        const name = `${language}-${menu}`;
        try {
          // The production chrome is inside the same overflow-clipped width boundary as Workspace.
          // Its host is deliberately low and narrow: a fixed right-aligned child cannot fit.
          await page.goto(`${menuOrigin}/?pane=320&left=180&top=470`, { waitUntil: 'domcontentloaded' });
          const trigger = menuTrigger(page, menu);
          await trigger.click();
          const measurement = await assertPopupVisible(trigger);
          await writeFile(path.join(evidence, `${name}.json`), JSON.stringify(measurement, null, 2));
          await page.screenshot({ path: path.join(evidence, `${name}.png`) });
          await page.keyboard.press('Escape');
          await assertMenuClosed(trigger);
          assert.equal(await trigger.evaluate((node) => document.activeElement === node), true);
          assert.deepEqual(errors, []);
          assert.deepEqual(unexpected, []);
        } finally {
          await writeFile(
            path.join(evidence, `${name}-lifecycle.json`),
            JSON.stringify({ errors, unexpected }, null, 2),
          );
          await context.close();
        }
      });
    }
    async function menuScenario(language, name, query, action) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 720 } });
      const page = await context.newPage();
      const errors = [],
        unexpected = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(
        (lang) => {
          localStorage.setItem('cat-cafe:shell-presentation', lang.shell);
          localStorage.setItem('cat-cafe:shell-language', lang.language);
        },
        { language, shell: query.includes('shell=classic') ? 'classic' : 'v2' },
      );
      await page.route('**/*', (route) => routeWorkspaceMenuAssets(route, built, unexpected));
      try {
        await page.goto(`${menuOrigin}/?${query}`, { waitUntil: 'domcontentloaded' });
        await action(page);
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, []);
      } finally {
        await page.screenshot({ path: path.join(evidence, `${name}.png`) });
        await writeFile(path.join(evidence, `${name}-lifecycle.json`), JSON.stringify({ errors, unexpected }, null, 2));
        await context.close();
      }
    }
    for (const language of ['zh', 'en']) {
      for (const menu of ['tabs', 'workspace', 'file']) {
        test(`${language} ${menu} stays visible at both edges and through live resize`, async () => {
          const name = `${language}-${menu}-edges-resize`;
          await menuScenario(language, name, 'pane=400&left=580&top=610', async (page) => {
            const trigger = menuTrigger(page, menu);
            await trigger.focus();
            await page.keyboard.press('Enter');
            await page.waitForTimeout(50);
            const before = await assertPopupVisible(trigger);
            await page.screenshot({ path: path.join(evidence, `${name}-open.png`) });
            assert.equal(await menuPanel(trigger).evaluate((node) => node.contains(document.activeElement)), true);
            await page.getByTestId('workspace-menu-host').evaluate((node) => {
              node.style.width = '320px';
              node.style.left = '0px';
              node.style.top = '12px';
            });
            await page.setViewportSize({ width: 320, height: 720 });
            await page.waitForTimeout(50);
            const after = await assertPopupVisible(trigger);
            await page.screenshot({ path: path.join(evidence, `${name}-resized.png`) });
            await writeFile(path.join(evidence, `${name}.json`), JSON.stringify({ before, after }, null, 2));
            await page.mouse.click(310, 650);
            await assertMenuClosed(trigger);
          });
        });
      }
      test(`${language} named Workspace actions keep pinned views and use the layout owner`, async () => {
        await menuScenario(language, `${language}-bulk-actions`, 'pane=320&left=180&top=470&pinned=1', async (page) => {
          const trigger = menuTrigger(page, 'workspace');
          await trigger.click();
          await page.getByTestId('v2-close-other-tabs').click();
          assert.equal(await page.getByTestId('action-result').getAttribute('data-surface-count'), '2');
          assert.equal(await page.getByTestId('action-result').getAttribute('data-pinned-count'), '1');
          assert.equal(await trigger.evaluate((node) => node.closest('details').open), false);
          await trigger.click();
          await page.getByTestId('v2-close-all-tabs').click();
          assert.equal(await page.getByTestId('action-result').getAttribute('data-surface-count'), '1');
          assert.equal(await page.getByTestId('action-result').getAttribute('data-pinned-count'), '1');
          assert.equal(await page.getByTestId('action-result').getAttribute('data-recently-closed'), '5');
        });
      });
      test(`${language} named management stays in the positioned menu and keeps the original action`, async () => {
        await menuScenario(
          language,
          `${language}-named-management`,
          'pane=320&left=180&top=610&pinned=1',
          async (page) => {
            const trigger = menuTrigger(page, 'workspace');
            await trigger.click();
            const popup = await assertPopupVisible(trigger);
            await page.screenshot({ path: path.join(evidence, `${language}-named-management-open.png`) });
            const control = page.getByTestId('v2-close-other-tabs');
            const bounds = await control.boundingBox();
            assert.ok(
              bounds &&
                bounds.x >= popup.rect.left &&
                bounds.x + bounds.width <= popup.rect.right &&
                bounds.y + bounds.height <= popup.rect.bottom,
            );
            await control.click();
            assert.equal(await page.getByTestId('action-result').getAttribute('data-surface-count'), '2');
            assert.equal(await page.getByTestId('action-result').getAttribute('data-pinned-count'), '1');
            assert.equal(await trigger.evaluate((node) => node.closest('details').open), false);
            await trigger.click();
            await assertPopupVisible(trigger);
            await page.waitForFunction(
              (id) => document.getElementById(id)?.contains(document.activeElement),
              await trigger.getAttribute('aria-controls'),
            );
            await page.keyboard.press('Escape');
            assert.equal(
              await trigger.evaluate((node) => !node.closest('details').open && document.activeElement === node),
              true,
            );
          },
        );
      });
    }

    for (const language of ['zh', 'en']) {
      test(`${language} a tall overflow menu scrolls every tab into the viewport`, async () => {
        await menuScenario(language, `${language}-tall-tabs`, 'pane=320&left=0&top=12&count=36', async (page) => {
          const trigger = menuTrigger(page, 'tabs');
          await trigger.click();
          const lastClose = page.locator('[data-v2-workspace-menu]:visible').getByTestId('v2-close-tab').last();
          await lastClose.scrollIntoViewIfNeeded();
          await assertPopupVisible(trigger);
          await lastClose.click();
          assert.equal(await page.getByTestId('action-result').getAttribute('data-surface-count'), '35');
          await menuTrigger(page, 'workspace').click();
          await page.getByTestId('v2-close-all-tabs').click();
          assert.equal(await page.getByTestId('action-result').getAttribute('data-surface-count'), '0');
        });
      });
      test(`${language} scrolling Workspace keeps the open file actions reachable`, async () => {
        await menuScenario(language, `${language}-scroll-file`, 'pane=400&left=0&top=300&scroll=1', async (page) => {
          const trigger = menuTrigger(page, 'file');
          await trigger.click();
          const before = await assertPopupVisible(trigger);
          await page.mouse.move(950, 650);
          await page.mouse.wheel(0, 80);
          await page.waitForFunction(() => document.querySelector('[data-testid="menu-scroll-host"]').scrollTop > 0);
          await page.waitForTimeout(50);
          const after = await assertPopupVisible(trigger);
          assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
          await menuPanel(trigger).getByText('docs/menu.md', { exact: true }).first().waitFor();
          await writeFile(
            path.join(evidence, `${language}-scroll-file.json`),
            JSON.stringify({ before, after }, null, 2),
          );
          await menuPanel(trigger).locator('.file-toolbar-menu-listen button').click();
          assert.equal(await page.getByTestId('action-result').getAttribute('data-action'), 'listen');
          await assertMenuClosed(trigger);
          const edit = page.getByTitle(language === 'zh' ? '编辑文件' : 'Edit file', { exact: true });
          await edit.click();
          assert.equal(await page.getByTestId('action-result').getAttribute('data-action'), 'edit');
          await trigger.click();
          await page.keyboard.press('Escape');
          await assertMenuClosed(trigger);
          assert.equal(await trigger.evaluate((node) => document.activeElement === node), true);
        });
      });
      test(`${language} classic keeps its original tab/control owner`, async () => {
        await menuScenario(
          language,
          `${language}-classic`,
          'pane=400&left=0&top=12&shell=classic&pinned=1',
          async (page) => {
            assert.equal(await page.getByTestId('v2-workspace-chrome').count(), 0);
            assert.equal(await page.getByTestId('f307-tab-actions').count(), 1);
            await page.getByTestId('f307-manage-surfaces').click();
            await page.getByTestId('f307-close-other-surfaces').click();
            assert.equal(await page.getByTestId('action-result').getAttribute('data-surface-count'), '2');
            assert.equal(await page.getByTestId('action-result').getAttribute('data-pinned-count'), '1');
          },
        );
      });
    }
    for (const language of ['zh', 'en']) {
      test(`${language} file popup keeps the original responsive controls`, async () => {
        await menuScenario(language, `${language}-responsive-file`, 'pane=320&left=0&top=12', async (page) => {
          const trigger = menuTrigger(page, 'file');
          await trigger.click();
          await menuPanel(trigger).waitFor();
          const visible = () =>
            menuPanel(trigger).evaluate((popup) => {
              return ['.file-toolbar-menu-view', '.file-toolbar-menu-listen'].map(
                (selector) => popup.querySelector(selector).getBoundingClientRect().height > 0,
              );
            });
          assert.deepEqual(await visible(), [true, true], 'narrow Workspace actions remain in More');
          const readable = await page
            .getByTitle(language === 'zh' ? '切换渲染与源码' : 'Switch rendered view and source')
            .last()
            .evaluate((node) => {
              const button = getComputedStyle(node),
                popup = getComputedStyle(node.closest('[role=menu]'));
              const background =
                button.backgroundColor === 'rgba(0, 0, 0, 0)' ? popup.backgroundColor : button.backgroundColor;
              return { foreground: button.color, background };
            });
          assert.notEqual(readable.foreground, readable.background, 'the active rendering label must remain readable');
          await page.getByTestId('workspace-menu-host').evaluate((node) => {
            node.style.width = '800px';
          });
          await page.waitForTimeout(50);
          assert.deepEqual(await visible(), [false, false], 'wide Workspace keeps these actions in the toolbar');
          for (let step = 0; step < 12; step++) {
            await page.keyboard.press('ArrowDown');
            const focus = await menuPanel(trigger).evaluate((node) => {
              const active = document.activeElement;
              const rect = active.getBoundingClientRect();
              return { owned: node.contains(active), width: rect.width, height: rect.height };
            });
            assert.ok(focus.owned && focus.width > 0 && focus.height > 0, 'arrows never focus hidden overflow actions');
          }
          await page.keyboard.press('Escape');
          await assertMenuClosed(trigger);
          assert.equal(await trigger.evaluate((node) => document.activeElement === node), true);
          await page.locator('.file-toolbar-view button').click();
          assert.equal(await page.getByTestId('action-result').getAttribute('data-action'), 'render');
          await page.locator('.file-toolbar-listen button').click();
          assert.equal(await page.getByTestId('action-result').getAttribute('data-action'), 'listen');
        });
      });
    }
    for (const { language, menu } of menuCases) {
      test(`${language} ${menu} closes when Workspace is hidden`, async () => {
        await menuScenario(language, `${language}-${menu}-hidden`, 'pane=320&left=0&top=12', async (page) => {
          const trigger = menuTrigger(page, menu);
          await trigger.click();
          if (menu === 'file') {
            const row = await page.getByTestId('content-file-toolbar').elementHandle();
            await page.getByTestId('fixture-surface-hide').evaluate((button) => button.click());
            await menuPanel(trigger).waitFor({ state: 'detached' });
            await page.getByTestId('fixture-surface-show').evaluate((button) => button.click());
            await trigger.waitFor();
            await assertMenuClosed(trigger);
            assert.equal(
              await row.evaluate((node) => node === document.querySelector('[data-testid="content-file-toolbar"]')),
              true,
            );
            return;
          }
          await page.getByTestId('workspace-menu-host').evaluate((node) => {
            node.style.display = 'none';
          });
          await page.waitForFunction(() =>
            Array.from(document.querySelectorAll('details')).every((node) => !node.open),
          );
          assert.equal(await page.locator('[data-v2-workspace-menu]:visible').count(), 0);
        });
      });
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) registerWorkspaceMenuTests();
