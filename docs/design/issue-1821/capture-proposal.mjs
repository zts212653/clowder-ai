import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '../../../packages/web/node_modules/playwright/index.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const proposal = path.join(directory, 'design-proposal.html');
const output = path.resolve(process.argv[2] ?? path.join(directory, 'screenshots'));
const sourceSha256 = createHash('sha256')
  .update(await readFile(proposal))
  .digest('hex');
const modern = [600, 375, 320].flatMap((width) =>
  ['light', 'dark'].flatMap((theme) =>
    ['collapsed', 'expanded'].map((state) => ({ width, theme, state, case: 'modern' })),
  ),
);
const compatibility = ['legacy', 'missing'].flatMap((sample) =>
  ['light', 'dark'].flatMap((theme) =>
    ['collapsed', 'expanded'].map((state) => ({ width: 375, theme, state, case: sample })),
  ),
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const measurements = [];
try {
  await [...modern, ...compatibility].reduce(async (previous, sample) => {
    await previous;
    const page = await browser.newPage({ viewport: { width: sample.width, height: 900 }, deviceScaleFactor: 1 });
    await page.route('http://**/*', (route) => route.abort());
    await page.route('https://**/*', (route) => route.abort());
    const url = pathToFileURL(proposal);
    Object.entries(sample).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
    await page.goto(url.href);
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const card = page.locator('[data-proposal-card]');
    assert.equal(await card.count(), 1, 'the screenshot contains one context receipt');
    const text = await card.innerText();
    if (sample.state === 'collapsed') assert.doesNotMatch(text, /thread_owned_|cat_cafe_|\bT0\b/);
    else assert.match(text, /诊断/);
    const toggle = card.locator('.briefing-toggle');
    const details = card.locator('#briefing-details');
    const expanded = sample.state === 'expanded';
    assert.equal(await toggle.getAttribute('aria-expanded'), String(expanded));
    assert.equal(await details.isVisible(), expanded);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), String(!expanded));
    assert.equal(await details.isVisible(), !expanded);
    assert.equal(new URL(page.url()).searchParams.get('state'), expanded ? 'collapsed' : 'expanded');
    await toggle.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), String(expanded));
    assert.equal(await details.isVisible(), expanded);
    await toggle.blur();
    await page.mouse.move(0, 0);
    const measurement = await card.evaluate((root) => ({
      cardWidth: root.getBoundingClientRect().width,
      cardHeight: root.getBoundingClientRect().height,
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      overflowing: [...root.querySelectorAll('*')]
        .filter(
          (element) =>
            element.getClientRects().length && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1,
        )
        .map((element) => ({ tag: element.tagName, text: element.textContent.slice(0, 80) })),
    }));
    assert.deepEqual(measurement.overflowing, [], `${JSON.stringify(sample)} must wrap its long content`);
    assert.ok(measurement.documentWidth <= measurement.viewportWidth + 1, 'the annotated page fits the viewport');
    const file = `${sample.case}-${sample.width}-${sample.theme}-${sample.state}.png`;
    await page.screenshot({ path: path.join(output, file), fullPage: true });
    const isReviewSample =
      (sample.case === 'modern' &&
        ((sample.width === 600 && sample.theme === 'light') || (sample.width === 320 && sample.theme === 'dark'))) ||
      (sample.case === 'legacy' && sample.theme === 'light' && !expanded) ||
      (sample.case === 'missing' && sample.theme === 'dark' && !expanded);
    const contextFile = isReviewSample ? `context-${file}` : undefined;
    if (contextFile) await page.locator('.stage').screenshot({ path: path.join(output, contextFile) });
    measurements.push({ ...sample, file, contextFile, interaction: 'pointer and keyboard passed', ...measurement });
    await page.close();
  }, Promise.resolve());
} finally {
  await browser.close();
}
await writeFile(path.join(output, 'measurements.json'), `${JSON.stringify({ sourceSha256, measurements }, null, 2)}\n`);
console.log(JSON.stringify({ screenshots: measurements.length, overflowing: 0, sourceSha256, output }));
