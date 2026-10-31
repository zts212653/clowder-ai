import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test as nativeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { buildWorkspaceMenuPage, menuOrigin, routeWorkspaceMenuAssets } from './fixtures/f322-workspace-menu-build.mjs';

const evidence = process.env.F322_MENU_EVIDENCE_DIR ?? '/tmp/cat-cafe-evidence/f322-workspace-menu';
const menuCases = ['zh', 'en'].flatMap((language) => ['tabs', 'workspace', 'file'].map((menu) => ({ language, menu })));
export function registerWorkspaceMenuTests(getSharedBrowser) {
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
          const trigger =
            menu === 'tabs'
              ? page.getByTestId('v2-more-tabs')
              : menu === 'workspace'
                ? page.getByTestId('v2-workspace-chrome').locator('summary').last()
                : page.getByTestId('v2-file-chrome').locator('summary');
          await trigger.click();
          await page.locator('[data-v2-workspace-menu]:visible').waitFor({ timeout: 1000 });
          const measurement = await trigger.evaluate((node) => {
            const details = node.closest('details');
            const controls = node.getAttribute('aria-controls');
            const panel = controls ? document.getElementById(controls) : details.querySelector(':scope > div');
            const host = document.querySelector('[data-testid="workspace-menu-host"]');
            const rect = panel.getBoundingClientRect(),
              bounds = host.getBoundingClientRect();
            const points = [
              [rect.left + 4, rect.top + 4],
              [rect.right - 4, Math.min(rect.bottom - 4, innerHeight - 4)],
            ];
            return {
              panel: rect.toJSON(),
              host: bounds.toJSON(),
              viewport: { width: innerWidth, height: innerHeight },
              pointsVisible: points.map(([x, y]) => panel.contains(document.elementFromPoint(x, y))),
            };
          });
          await writeFile(path.join(evidence, `${name}.json`), JSON.stringify(measurement, null, 2));
          await page.screenshot({ path: path.join(evidence, `${name}.png`) });
          assert.ok(
            measurement.panel.left >= measurement.host.left && measurement.panel.right <= measurement.host.right,
            'the entire menu must fit its Workspace width',
          );
          assert.ok(
            measurement.panel.top >= 0 && measurement.panel.bottom <= measurement.viewport.height,
            'the menu must flip or scroll into the visible viewport',
          );
          assert.deepEqual(
            measurement.pointsVisible,
            [true, true],
            'panel pixels must escape ancestor clipping and remain hit-testable',
          );
          await page.keyboard.press('Escape');
          assert.equal(await trigger.evaluate((node) => node.closest('details').open), false);
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
    function menuTrigger(page, menu) {
      return menu === 'tabs'
        ? page.getByTestId('v2-more-tabs')
        : menu === 'workspace'
          ? page.getByTestId('v2-workspace-chrome').locator('summary').last()
          : page.getByTestId('v2-file-chrome').locator('summary');
    }
    async function assertPopupVisible(trigger) {
      await trigger.page().locator('[data-v2-workspace-menu]:visible').waitFor({ timeout: 1000 });
      const result = await trigger.evaluate((node) => {
        const popup = document.getElementById(node.getAttribute('aria-controls'));
        const r = popup.getBoundingClientRect();
        const host = document.querySelector('[data-testid="workspace-menu-host"]').getBoundingClientRect();
        return {
          rect: r.toJSON(),
          host: host.toJSON(),
          viewport: { width: innerWidth, height: innerHeight },
          hits: [
            [r.left + 4, r.top + 4],
            [r.right - 4, r.bottom - 4],
          ].map(([x, y]) => popup.contains(document.elementFromPoint(x, y))),
        };
      });
      assert.ok(
        result.rect.left >= Math.max(0, result.host.left) &&
          result.rect.right <= Math.min(result.viewport.width, result.host.right),
      );
      assert.ok(result.rect.top >= 0 && result.rect.bottom <= result.viewport.height);
      assert.deepEqual(result.hits, [true, true]);
      return result;
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
            assert.equal(
              await trigger.evaluate((node) =>
                document.getElementById(node.getAttribute('aria-controls')).contains(document.activeElement),
              ),
              true,
            );
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
            assert.equal(await trigger.evaluate((node) => node.closest('details').open), false);
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
      test(`${language} scrolling Workspace repositions the open file menu`, async () => {
        await menuScenario(language, `${language}-scroll-file`, 'pane=400&left=0&top=300&scroll=1', async (page) => {
          const trigger = menuTrigger(page, 'file');
          await trigger.click();
          const before = await assertPopupVisible(trigger);
          await page.mouse.move(950, 650);
          await page.mouse.wheel(0, 80);
          await page.waitForFunction(() => document.querySelector('[data-testid="menu-scroll-host"]').scrollTop > 0);
          await page.waitForTimeout(50);
          const after = await assertPopupVisible(trigger);
          assert.ok(after.rect.top < before.rect.top, 'popup follows the scrolling trigger');
          await writeFile(
            path.join(evidence, `${language}-scroll-file.json`),
            JSON.stringify({ before, after }, null, 2),
          );
          const edit = page.getByTitle('编辑文件', { exact: true });
          await edit.click();
          assert.equal(await page.getByTestId('action-result').getAttribute('data-action'), 'edit');
          await page.keyboard.press('Escape');
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
          await page.locator('[data-v2-workspace-menu]:visible').waitFor({ timeout: 1000 });
          const visible = () =>
            trigger.evaluate((node) => {
              const popup = document.getElementById(node.getAttribute('aria-controls'));
              return ['.v2-file-menu-view', '.v2-file-menu-listen'].map(
                (selector) => popup.querySelector(selector).getBoundingClientRect().height > 0,
              );
            });
          assert.deepEqual(await visible(), [true, true], 'narrow Workspace actions remain in More');
          const readable = await page
            .getByTitle('切换渲染与源码')
            .last()
            .evaluate((node) => {
              const button = getComputedStyle(node),
                popup = getComputedStyle(node.closest('[data-v2-workspace-menu]'));
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
        });
      });
    }
    for (const { language, menu } of menuCases) {
      test(`${language} ${menu} closes when Workspace is hidden`, async () => {
        await menuScenario(language, `${language}-${menu}-hidden`, 'pane=320&left=0&top=12', async (page) => {
          const trigger = menuTrigger(page, menu);
          await trigger.click();
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
