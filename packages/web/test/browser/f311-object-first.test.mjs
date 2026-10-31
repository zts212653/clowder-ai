import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort } from './f290-runtime-journey.harness.mjs';
import { objectFirstDuckBody, objectRelevance } from './f311-object-first-bodies.mjs';
import { startObjectFirstPreview } from './f311-object-first-preview.fixture.mjs';
import { CONTRACT_THREAD_ID } from './f311-workspace-browser.harness.mjs';

const evidenceDir = process.env.F311_EVIDENCE_DIR;
const report = { mode: 'isolated-object-first', cases: [] };
let fixture;
let browser;
let origin;

before(
  async () => {
    const webPort = await availablePort();
    // Exercise the real non-loopback API-origin classification used by Hub previews.
    origin = `http://f311-preview.localhost:${webPort}`;
    fixture = await startObjectFirstPreview({ webPort, browserApiUrl: origin });
    browser = await chromium.launch({ headless: true });
    if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  },
  { timeout: 210_000 },
);

after(async () => {
  await browser?.close();
  await fixture?.close();
  if (evidenceDir) await writeFile(`${evidenceDir}/object-first-report.json`, `${JSON.stringify(report, null, 2)}\n`);
});

test('the submitted object map survives the real preparation service readback intact', async () => {
  const body = await objectFirstDuckBody();
  const current = fixture.duck.preparation.sections.object_map.current;
  assert.equal(current.status, 'submitted');
  assert.deepEqual(current.submission.body, body);
});

test(
  'fresh shells hydrate and read distinct object relevance across direct Program routes',
  { timeout: 150_000 },
  async () => {
    for (const width of [320, 416]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      const result = { width, errors: [], requestsFailed: [], checks: [] };
      report.cases.push(result);
      page.on('pageerror', (error) => result.errors.push(error.message));
      page.on('requestfailed', (request) =>
        result.requestsFailed.push({ url: request.url(), error: request.failure()?.errorText }),
      );
      try {
        const target = (projection) => {
          const url = new URL(`/thread/${CONTRACT_THREAD_ID}`, origin);
          url.searchParams.set('evolutionProgram', projection.program.programId);
          url.searchParams.set('evolutionView', 'judgment');
          return url.href;
        };
        await page.goto(target(fixture.duck), { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: '准备', exact: true }).click({ timeout: 30_000 });
        const item = page.locator('[data-preparation-item="state-control"]:visible');
        await item.locator(':scope > summary').click();
        const reason = objectRelevance.items.find((entry) => entry.itemId === 'state-control').why;
        await item.getByText(reason, { exact: true }).waitFor();
        result.geometry = await item.evaluate((element) => ({
          width: element.clientWidth,
          scroll: element.scrollWidth,
        }));
        assert(result.geometry.scroll <= result.geometry.width + 1);
        result.checks.push('fresh-duck-relevance');
        if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/updated-duck-${width}.png` });
        await page.goto(target(fixture.memory), { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: '记忆检索 · 迁移阅读反例', exact: true }).waitFor();
        await page.getByRole('button', { name: '准备', exact: true }).click();
        const rows = page.locator('[data-preparation-item]:visible');
        await page.locator('[data-preparation-item="search-method"]:visible').waitFor();
        assert.equal(await rows.count(), 5);
        const text = await rows.allTextContents();
        assert(text.every((value) => value.includes('尚未决定')));
        assert(!text.join('').includes('类别尚未提交'));
        result.checks.push('direct-memory-route-five-undecided');
        assert.deepEqual(
          result.errors.filter((error) => /hydrat/i.test(error)),
          [],
        );
        result.checks.push('no-hydration-errors');
      } catch (error) {
        result.failure = error.message;
        result.visibleText = (await page.locator('body').innerText()).slice(0, 4_000);
        if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/failure-${width}.png` });
        throw error;
      } finally {
        await context.close();
      }
    }
  },
);
