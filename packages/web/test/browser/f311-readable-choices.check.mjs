import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { readableChoiceBodies } from './f311-readable-choices.bodies.mjs';

const directory = process.env.F311_EVIDENCE_DIR ?? '/tmp/cat-cafe-evidence/f311-readable-choices';
const origin = 'http://127.0.0.1:5321';
const api = 'http://127.0.0.1:3322';
const bodies = await readableChoiceBodies();
for (const item of bodies.duck.items) {
  const previous = bodies.previous.items.find((candidate) => candidate.itemId === item.itemId);
  for (const key of ['scope', 'decision', 'modifiability', 'sourceRefs', 'existingWork'])
    assert.deepEqual(item[key], previous[key]);
  assert.deepEqual(item.recommendation.basisRefs, previous.recommendation.basisRefs);
}
const { programs } = await (await fetch(`${api}/api/capability-evolution/programs`)).json();
const target = (program) =>
  `${origin}/thread/thread-f311-workspace-contract?evolutionProgram=${encodeURIComponent(program.program.programId)}&evolutionView=judgment`;
const browser = await chromium.launch({ headless: true });
const report = { mode: 'isolated-design-proposal', protectedFields: '8/8 unchanged', cases: [] };
await mkdir(directory, { recursive: true });
try {
  for (const width of [1440, 416, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1100 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const result = { width, errors: [], failedRequests: [], checks: [] };
    report.cases.push(result);
    page.on('pageerror', (error) =>
      result.errors.push({ name: error.name, message: error.message, stack: error.stack }),
    );
    const protocol = await context.newCDPSession(page);
    await protocol.send('Runtime.enable');
    await protocol.send('Debugger.enable');
    protocol.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      result.exceptionDetails = exceptionDetails;
    });
    protocol.on('Debugger.scriptFailedToParse', async (script) => {
      result.failedScript = script;
      const source = await protocol.send('Debugger.getScriptSource', { scriptId: script.scriptId }).catch(() => null);
      if (source) await writeFile(`${directory}/parse-failure-${width}.js`, source.scriptSource);
    });
    page.on('requestfailed', (request) =>
      result.failedRequests.push({ url: request.url(), failure: request.failure() }),
    );
    try {
      await page.goto(target(programs[0]), { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '准备', exact: true }).click();
      const rows = page.locator('[data-preparation-item]:visible');
      const item = page.locator('[data-preparation-item="state-control"]:visible');
      await item.waitFor();
      assert.equal(await rows.count(), 8);
      result.objectOrder = await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.preparationItem));
      const summary = item.locator(':scope > summary');
      assert(
        (await summary.innerText()).includes(
          bodies.duck.items.find((candidate) => candidate.itemId === 'state-control').recommendation.reason,
        ),
      );
      assert(!(await summary.innerText()).includes('35dfed11'));
      assert(
        (await page.locator('[data-preparation-item="onnx-policies"]:visible > summary').innerText()).includes('Model'),
      );
      result.checks.push('concept-object-reasons-before-expansion');
      result.geometry = await rows.evaluateAll((nodes) =>
        nodes.map((element) => ({
          id: element.dataset.preparationItem,
          client: element.clientWidth,
          scroll: element.scrollWidth,
        })),
      );
      assert(result.geometry.every((entry) => entry.scroll <= entry.client + 1));
      await page.screenshot({ path: `${directory}/entry-${width}.png` });
      await rows.first().evaluate((node) => node.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: `${directory}/choices-${width}.png` });
      await summary.click();
      await item.locator('.evolution-preparation-object-sources button').first().click();
      await page.getByText('两点只读核实结果', { exact: false }).first().waitFor();
      if (width === 416) await page.screenshot({ path: `${directory}/source-416.png` });
      await page.goBack();
      await item.waitFor();
      assert.equal(await item.getAttribute('open'), '');
      result.afterSourceReturnUrl = page.url();
      await page.reload();
      await item.waitFor();
      assert.equal(await item.getAttribute('open'), '');
      result.checks.push('source-return-and-refresh-keep-expansion');
      await page.locator('[data-preparation-section="success_contract"]:visible').click();
      const criterion = page.locator('[data-preparation-criterion]:visible').first();
      await criterion.locator(':scope > summary').click();
      const criterionId = await criterion.getAttribute('data-preparation-criterion');
      await criterion
        .getByRole('button', { name: /查看 GT 来源/ })
        .first()
        .click();
      await page.locator('[data-gt-source-key="physical-record"]:visible').waitFor();
      await page.getByRole('button', { name: /^返回规约/ }).click();
      assert.equal(
        await page.locator(`[data-preparation-criterion="${criterionId}"]:visible`).getAttribute('open'),
        '',
      );
      result.checks.push('criterion-gt-return');
      await page.goto(target(programs[1]), { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '准备', exact: true }).click();
      await page.locator('[data-preparation-item="search-method"]:visible').waitFor();
      assert.equal(await rows.count(), 5);
      const texts = await rows.allTextContents();
      assert(texts.every((text) => text.includes('尚未决定')));
      assert(!texts.join('').includes('类别尚未提交'));
      await rows.first().evaluate((node) => node.scrollIntoView({ block: 'start' }));
      if (width === 416) await page.screenshot({ path: `${directory}/memory-416.png` });
      result.checks.push('memory-five-undecided-optional-category');
      assert.deepEqual(result.errors, []);
    } catch (error) {
      result.failure = error.message;
      result.failureUrl = page.url();
      result.visibleText = (await page.locator('body').innerText()).slice(0, 6000);
      await page.screenshot({ path: `${directory}/failure-${width}.png` });
      throw error;
    } finally {
      await context.close();
    }
  }
  report.previewEvidence = await (await fetch(`${api}/preview-evidence`)).json();
  // Reading a message asks the real shell to mark it read. The isolated fixture rejects
  // that POST too; observing an attempted write is not evidence that a write occurred.
  assert(
    report.previewEvidence.writes.every(
      ({ method, path }) => method === 'POST' && /^\/api\/threads\/[^/]+\/read\/latest$/u.test(path),
    ),
  );
  const denied = await fetch(`${api}/api/threads/thread-f311-workspace-contract/read/latest`, { method: 'POST' });
  assert.equal(denied.status, 405);
  report.writeFence = { status: denied.status, programMutationRequests: 0 };
} finally {
  await browser.close();
  await writeFile(`${directory}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.cases.map(({ width, checks, failure }) => ({ width, checks, failure }))));
}
