import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWorkspaceV3Fixture, WORKSPACE_SAMPLE_THREAD } from './f322-b-workspace-v3-fixture.mjs';

export function registerComposerFocusJourneys(getSuite) {
  for (const theme of ['light', 'dark']) {
    test(`F322 composer single frame ${theme}`, async () => {
      const suite = getSuite();
      const output = process.env.F322_FOCUS_EVIDENCE_DIR ?? '/tmp/f322-composer-focus';
      await mkdir(output, { recursive: true });
      const context = await suite.browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript((theme) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', 'en');
        localStorage.setItem('theme', theme);
      }, theme);
      const fixture = createWorkspaceV3Fixture();
      const page = await context.newPage();
      const errors = [];
      let failure;
      let focusProbe;
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/api/**', (route) => fixture.answer(route));
      try {
        await page.goto(new URL(`/thread/${WORKSPACE_SAMPLE_THREAD}`, suite.baseUrl).href);
        const field = page.getByTestId('chat-input-composer-row').locator('textarea');
        const card = page.getByTestId('chat-input-composer-row');
        const execution = page.getByTestId('execution-row');
        await execution.waitFor();
        const wrapper = await execution.evaluate((el) => ({
          border: getComputedStyle(el).borderTopWidth,
          background: getComputedStyle(el).backgroundColor,
          radius: getComputedStyle(el).borderTopLeftRadius,
        }));
        assert.deepEqual(wrapper, { border: '0px', background: 'rgba(0, 0, 0, 0)', radius: '0px' });
        const surface = execution.getByTestId('execution-row-surface');
        const surfaceBox = await surface.boundingBox();
        const cardBox = await card.boundingBox();
        assert.ok(Math.abs(surfaceBox.x - cardBox.x) < 1 && Math.abs(surfaceBox.width - cardBox.width) < 1);
        assert.notEqual(await surface.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
        const initialBorder = await card.evaluate((el) => getComputedStyle(el).borderTopColor);
        await field.fill('Controlled draft — preserve text and selection');
        await field.click();
        await field.evaluate((el) => el.setSelectionRange(3, 8));
        focusProbe = await field.evaluate((el) => ({
          outline: getComputedStyle(el).outline,
          focusVisible: el.matches(':focus-visible'),
          shell: el.closest('[data-shell]')?.getAttribute('data-shell'),
          classes: el.className,
          matching: Array.from(document.styleSheets).flatMap((sheet) => {
            try {
              return Array.from(sheet.cssRules)
                .filter((rule) => rule.selectorText && el.matches(rule.selectorText) && rule.style.outline)
                .map((rule) => rule.cssText);
            } catch {
              return [];
            }
          }),
        }));
        assert.equal(await field.evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
        assert.equal(await card.evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
        assert.notEqual(await card.evaluate((el) => getComputedStyle(el).borderTopColor), initialBorder);
        await page.screenshot({ path: `${output}/${theme}-pointer.png` });
        await field.press('Shift+Tab');
        await page.keyboard.press('Tab');
        assert.equal(await field.evaluate((el) => el === document.activeElement), true);
        assert.equal(await field.evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
        assert.equal(await card.evaluate((el) => getComputedStyle(el).outlineStyle), 'solid');
        assert.equal(await card.evaluate((el) => getComputedStyle(el).outlineWidth), '2px');
        await page.screenshot({ path: `${output}/${theme}-keyboard.png` });
        await field.press('Tab');
        const lowerButton = await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          ring: document.activeElement && getComputedStyle(document.activeElement).outlineWidth,
          ringStyle: document.activeElement && getComputedStyle(document.activeElement).outlineStyle,
        }));
        assert.equal(lowerButton.tag, 'BUTTON');
        assert.equal(lowerButton.ringStyle, 'solid');
        assert.equal(lowerButton.ring, '2px');
        assert.equal(await card.evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
        assert.equal(await field.inputValue(), 'Controlled draft — preserve text and selection');
        await page.getByTestId('workspace-panel-toggle').click();
        assert.equal(await card.evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
        assert.deepEqual(errors, []);
      } catch (error) {
        failure = { message: error.message, stack: error.stack };
        throw error;
      } finally {
        await writeFile(
          `${output}/${theme}-calls.json`,
          JSON.stringify({ failure, focusProbe, errors, calls: fixture.calls }, null, 2),
        );
        await page.screenshot({ path: `${output}/${theme}-final.png` }).catch(() => {});
        await context.close();
      }
    });
  }
}
