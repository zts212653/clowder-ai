import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { selectReviewMode } from './fixtures/f309-artwork-controls.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

for (const width of [1280, 390]) {
  test(
    `F309 ${width}px: artwork and primary controls stay together without page scrolling`,
    { timeout: 90000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'f309-artwork-layout-'));
      const evidence = process.env.F309_BROWSER_EVIDENCE_DIR
        ? path.resolve(repository, process.env.F309_BROWSER_EVIDENCE_DIR)
        : root;
      await mkdir(evidence, { recursive: true });
      execFileSync(
        '/usr/bin/sips',
        [
          '-s',
          'format',
          'png',
          path.join(repository, 'docs/evidence/2026-09-09-f309-artwork-review-reference/01-overview.jpg'),
          '--out',
          path.join(root, 'review-input.png'),
        ],
        { stdio: 'pipe' },
      );
      const host = await startReviewHost(root, 'image/png');
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      t.after(async () => {
        await page.screenshot({ path: path.join(evidence, `layout-${width}-last.png`), fullPage: true });
        await browser.close();
        await host.close();
        if (evidence !== root) await rm(root, { recursive: true, force: true });
      });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(host.origin);
      await page.getByTestId('open-artifact-review').click();
      await page.locator('[data-testid="review-media-stage"] img').waitFor();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="review-media-stage"] img')?.naturalWidth > 0,
      );
      if (width >= 1024) {
        const workbench = page.getByTestId('f307-experience-workbench');
        assert.equal(
          await workbench.getAttribute('data-main-area-attention'),
          await workbench.getAttribute('data-active-surface'),
          'Opening an artwork should give it the main area.',
        );
      }
      await selectReviewMode(page, 'comment');
      const stage = await page.getByTestId('review-media-stage').boundingBox();
      const composer = await page.getByRole('textbox', { name: '新增标注意见' }).boundingBox();
      assert.ok(stage && composer);
      assert.ok(
        composer.y >= 0 && composer.y + composer.height <= 900,
        `Comment input must remain in the viewport: ${JSON.stringify(composer)}`,
      );
      assert.ok(
        stage.y >= 0 && stage.y + stage.height <= 900,
        `The complete artwork stage must remain in the viewport: ${JSON.stringify(stage)}`,
      );
      const send = await page.getByRole('button', { name: '保存评论', exact: true }).boundingBox();
      assert.ok(send && send.y + send.height <= 900, 'Sending must not require scrolling below the artwork.');
      await page.screenshot({ path: path.join(evidence, `layout-${width}-comment.png`), fullPage: true });
      await selectReviewMode(page, 'markup');
      const tools = page.getByRole('region', { name: '作品画布工具' });
      const toolsBox = await tools.boundingBox();
      assert.ok(toolsBox && toolsBox.height <= 180, 'The floating tool controls must stay compact.');
      const markupStage = await page.getByTestId('review-media-stage').boundingBox();
      assert.ok(
        markupStage && markupStage.y + markupStage.height <= 900,
        'Markup must keep the artwork in the viewport.',
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      if (width === 1280) {
        await page.reload();
        await page.locator('[data-testid="review-media-stage"] img').waitFor();
        const restoredHost = page.getByTestId('f307-experience-workbench');
        assert.equal(
          await restoredHost.getAttribute('data-main-area-attention'),
          await restoredHost.getAttribute('data-active-surface'),
          'Reload keeps the artwork as the primary task.',
        );
        await page.setViewportSize({ width: 390, height: 900 });
        await page.locator('[data-testid="review-media-stage"] img').waitFor();
        await selectReviewMode(page, 'markup');
        const restored = await page.getByTestId('review-media-stage').boundingBox();
        assert.ok(
          restored && restored.height > 240,
          `A restored desktop sidecar must not consume the mobile artwork: ${JSON.stringify(restored)}`,
        );
        const sidecar = page.getByTestId('f307-sidecar-expand');
        assert.equal(await sidecar.getAttribute('aria-expanded'), 'false');
        const retainedSidecar = await page
          .getByTestId('f307-experience-workbench')
          .getAttribute('data-sidecar-surface');
        await sidecar.click();
        await page.getByTestId('product-schedule-panel').waitFor();
        assert.equal(await sidecar.getAttribute('aria-expanded'), 'true');
        const whileExpanded = await page.getByTestId('review-media-stage').boundingBox();
        assert.ok(whileExpanded && whileExpanded.height > 100, 'Expanded context must leave the artwork usable.');
        await sidecar.click();
        assert.equal(
          await page.getByTestId('f307-experience-workbench').getAttribute('data-sidecar-surface'),
          retainedSidecar,
        );
      }
      assert.deepEqual(errors, []);
    },
  );
}
