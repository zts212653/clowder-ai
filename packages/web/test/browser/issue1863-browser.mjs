import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const undoShortcut = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
const redoShortcut = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y';

const evidence = path.join(os.tmpdir(), 'cat-cafe-evidence', 'issue1863-gap');
await fs.mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ignoreDefaultArgs: ['--hide-scrollbars'],
  args: ['--disable-features=OverlayScrollbar,FluentOverlayScrollbar'],
});
const context = await browser.newContext({ viewport: { width: 1180, height: 800 }, recordVideo: { dir: evidence } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto('http://127.0.0.1:4174');
await page.locator('textarea').first().waitFor();
await page.waitForTimeout(500);
console.log('body', (await page.locator('body').innerText()).slice(0, 1000));
console.log('errors', errors);
await page.screenshot({ path: path.join(evidence, '01-initial.png'), fullPage: true });
const textarea = page.locator('textarea:not([aria-hidden="true"])');
assert.equal(await textarea.count(), 1);
const linkColor = await page
  .locator('[data-link-href]')
  .first()
  .evaluate((node) => getComputedStyle(node).color);
const [red, green, blue] = linkColor.match(/[\d.]+/g).map(Number);
assert.ok(blue > red + 60 && blue > green, `Link text should be blue, received ${linkColor}`);
await textarea.locator('xpath=../..').screenshot({ path: path.join(evidence, '01-composer.png') });
console.log(
  'mirror',
  await page.locator('[data-testid="composer-link-mirror"]').evaluate((mirror) => ({
    width: mirror.clientWidth,
    height: mirror.clientHeight,
    scrollHeight: mirror.scrollHeight,
    marks: [...mirror.querySelectorAll('mark')].map((mark) => ({
      text: mark.textContent,
      href: mark.dataset.linkHref,
      rect: mark.getBoundingClientRect().toJSON(),
      color: getComputedStyle(mark).textDecorationColor,
    })),
  })),
);

const report = {
  platform: process.platform,
  shortcuts: { undoShortcut, redoShortcut },
  browser: await browser.version(),
  cases: [],
  geometry: [],
};
const marks = () =>
  page
    .locator('[data-link-href]')
    .evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent, href: node.dataset.linkHref })));
const gapSource = '说明 https\\://example.com 后';
await textarea.fill(gapSource);
const notice = page.locator('[data-testid="composer-link-notice"]');
assert.equal(await notice.count(), 1);
assert.match(await notice.innerText(), /有链接未能标出/);
await notice.locator('summary').click();
assert.deepEqual(await notice.locator('code').allTextContents(), ['https://example.com/']);
assert.equal(await textarea.inputValue(), gapSource);
await textarea.locator('xpath=../..').screenshot({ path: path.join(evidence, '06-gap-notice.png') });
await textarea.fill('说明 https\\://other.example/path 后');
assert.deepEqual(await notice.locator('code').allTextContents(), ['https://other.example/path']);
await textarea.fill('说明 https://other.example/path 后');
assert.equal(await notice.count(), 0);
await textarea.fill(gapSource);
await textarea.press('Control+Enter');
await page.locator('[data-testid="sent-messages"] a[href]').last().waitFor();
assert.equal(
  await page.locator('[data-testid="sent-messages"] a[href]').last().getAttribute('href'),
  'https://example.com/',
);
assert.equal(await textarea.inputValue(), '');
assert.equal(await notice.count(), 0);
report.cases.push('visible gap notice / exact targets update / recovery / unchanged source submission');
const url = 'https://github.com/meow-club/cat-cafe-map';
await textarea.fill(`${url}这是链接 这不是`);
await textarea.evaluate((node, offset) => node.setSelectionRange(0, offset), url.length);
await textarea.locator('xpath=../..').screenshot({ path: path.join(evidence, '05-composer-selection.png') });
const selection = await textarea.evaluate((node) => ({
  text: node.value.slice(node.selectionStart, node.selectionEnd),
  color: getComputedStyle(node, '::selection').color,
  background: getComputedStyle(node, '::selection').backgroundColor,
  caret: getComputedStyle(node).caretColor,
}));
assert.equal(selection.text, url);
assert.notEqual(selection.color, selection.background);
assert.notEqual(selection.caret, 'rgba(0, 0, 0, 0)');
report.cases.push('blue link text / native selected text and visible caret');
assert.deepEqual(
  (await marks()).map((m) => m.text),
  [`${url}这是链接`],
);
await textarea.evaluate((node, offset) => {
  node.focus();
  node.setSelectionRange(offset, offset);
}, url.length);
await page.keyboard.insertText(' ');
assert.deepEqual(
  (await marks()).map((m) => m.text),
  [url],
);
await page.screenshot({ path: path.join(evidence, '02-space.png'), fullPage: true });
await textarea.locator('xpath=../..').screenshot({ path: path.join(evidence, '02-composer-space.png') });
await page.keyboard.press(undoShortcut);
assert.deepEqual(
  (await marks()).map((m) => m.text),
  [`${url}这是链接`],
);
await page.keyboard.press(redoShortcut);
assert.deepEqual(
  (await marks()).map((m) => m.text),
  [url],
);
report.cases.push('adjacent Chinese / native insert / undo / redo');

await textarea.evaluate((node, offset) => node.setSelectionRange(offset, offset + 1), url.length);
await page.keyboard.press('Shift+Enter');
assert.deepEqual(
  (await marks()).map((m) => m.text),
  [url],
);
report.cases.push('replace boundary with native newline');

const long =
  Array.from({ length: 25 }, (_, i) => `${i}: https://example.com/${'long-path-'.repeat(12)}中文 说明`).join('\n') +
  '\n';
await textarea.fill(long);
for (const width of [1180, 760, 390]) {
  await page.setViewportSize({ width, height: 800 });
  await page.waitForTimeout(250);
  const geometry = await textarea.evaluate((node) => {
    const mirror = node.parentElement.querySelector('[data-testid="composer-link-mirror"]');
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
    return {
      width: node.clientWidth,
      scrollbarWidth: node.offsetWidth - node.clientWidth,
      textHeight: node.scrollHeight,
      mirrorHeight: mirror.scrollHeight,
      scrollTop: node.scrollTop,
      mirrorScrollTop: mirror.scrollTop,
      windowWidth: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  report.geometry.push(geometry);
  assert.equal(geometry.textHeight, geometry.mirrorHeight, JSON.stringify(geometry));
  assert.equal(geometry.scrollTop, geometry.mirrorScrollTop, JSON.stringify(geometry));
  assert.equal(geometry.overflow, false);
}
await page.screenshot({ path: path.join(evidence, '03-scroll-narrow.png'), fullPage: true });
await textarea.locator('xpath=../..').screenshot({ path: path.join(evidence, '03-composer-narrow.png') });
report.cases.push('long URL / internal scrollbar / trailing newline / three widths');

await page.setViewportSize({ width: 1180, height: 800 });
await textarea.fill(url);
await textarea.press('End');
const cdp = await context.newCDPSession(page);
await cdp.send('Input.imeSetComposition', { text: '这是说明', selectionStart: 4, selectionEnd: 4 });
assert.equal(await page.locator('[data-testid="composer-link-mirror"]').getAttribute('data-active'), 'false');
assert.notEqual(await textarea.evaluate((node) => getComputedStyle(node).color), 'rgba(0, 0, 0, 0)');
await cdp.send('Input.insertText', { text: '这是说明' });
assert.equal(await page.locator('[data-testid="composer-link-mirror"]').getAttribute('data-active'), 'true');
assert.equal(await textarea.inputValue(), `${url}这是说明`);
assert.deepEqual(
  (await marks()).map((m) => m.text),
  [`${url}这是说明`],
);
report.cases.push('Chromium native composition via CDP (not physical Windows IME candidate UI)');
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));

for (const source of [
  'https://example.com/中文?q=甲，乙',
  '[说明](https://example.com/中文)',
  '[说明][ref]\n\n[ref]: https://example.com/中文',
  '`https://example.com/中文`',
  'www.example.com',
  '公式 \\(https://example.com\\) 后',
  '```\nhttps://example.com\n```',
]) {
  await textarea.fill(source);
  const expected = (await marks()).map((m) => m.href);
  const count = await page.locator('[data-testid="sent-messages"] > div').count();
  await textarea.press('Control+Enter');
  await page.waitForTimeout(150);
  const messages = page.locator('[data-testid="sent-messages"] > div');
  assert.equal(await messages.count(), count + 1);
  const actual = await messages
    .last()
    .locator('a[href]')
    .evaluateAll((nodes) => nodes.filter((node) => /^https?:/.test(node.href)).map((node) => node.href));
  assert.deepEqual(actual, expected, source);
  report.cases.push(`actual component submission/render: ${source}`);
}
await page.reload();
await textarea.waitFor();
assert.ok((await page.locator('[data-testid="sent-messages"] a[href]').count()) > 0);
await page.getByRole('button', { name: '明暗切换' }).click();
await page.waitForTimeout(200);
await textarea.fill(`${url}这是链接 这不是`);
report.dark = await page
  .locator('[data-link-href]')
  .first()
  .evaluate((node) => ({
    theme: document.documentElement.dataset.theme,
    color: getComputedStyle(node).color,
  }));
console.log('dark link', report.dark);
assert.equal(report.dark.theme, 'dark');
assert.notEqual(report.dark.color, linkColor);
await page.screenshot({ path: path.join(evidence, '04-dark.png'), fullPage: true });
await textarea.locator('xpath=../..').screenshot({ path: path.join(evidence, '04-composer-dark.png') });
await page.getByRole('button', { name: '切换经典' }).click();
assert.equal(await page.locator('[data-testid="composer-link-mirror"]').count(), 0);
report.cases.push('persisted demo messages / dark theme / classic has no new marker');
assert.deepEqual(errors, []);
report.unverified = [
  'physical Windows IME candidate selection',
  'macOS',
  'full product API/thread creation and backend persistence',
];
await fs.writeFile(path.join(evidence, 'browser-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
await context.close();
await browser.close();
