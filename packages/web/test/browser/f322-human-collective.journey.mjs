import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

/**
 * F322 B segment 1 (human message), shared-room half — the Collective Client's conversation in a real browser.
 *
 * The REAL `ChannelConversationFlow` / `ChannelMessage` / `TopicMessage` with the Client's own stylesheets (loaded in
 * `main.tsx`'s order), on a column the width of the reading column (720) and of the Studio chat bar (400). The viewer, the
 * presentation (`?presentation=v2|classic`, or none: the host said nothing) and light / dark (`:root.dark`, the Client's own
 * rule) are driven the way the frame is driven. Host silent = the classic layout (Opus 5.5's contract 2026-10-01: the room
 * follows the Café that opens it, whose own default is classic); the new presentation is asked for with `?presentation=v2`. No service, account or Redis is involved.
 *
 * Set HUMAN_COLLECTIVE_EVIDENCE_DIR to also write the screenshots and the measurement table the PR cites.
 */
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(webRoot, 'test/browser/fixtures');
const origin = 'https://f322-human-collective.test';
const evidenceDir = process.env.HUMAN_COLLECTIVE_EVIDENCE_DIR;
const measurements = [];
let browser, script, css;
const startedIn = process.cwd();

before(async () => {
  process.chdir(webRoot);
  const result = await build({
    root: webRoot,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: [{ find: '@', replacement: path.join(webRoot, 'src') }] },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(fixtureRoot, 'f322-human-collective.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  const entry = outputs.find((item) => item.type === 'chunk' && item.isEntry);
  assert.ok(entry);
  script = entry.code;
  css = outputs
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  process.chdir(startedIn);
  await browser?.close();
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
  }
});

/**
 * @param viewer a humanId, '' for "the viewer is not known", undefined for the fixture's default viewer.
 * @param presentation 'v2' (default here: most cells measure the new presentation), 'classic', or null for "the host said
 *   nothing" (no parameter on the frame URL).
 */
async function open({ width = 720, scheme = 'light', viewer, presentation = 'v2', scale = 1 } = {}) {
  const context = await browser.newContext({
    viewport: { width: Math.max(width + 40, 480), height: 1500 },
    deviceScaleFactor: scale,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors = [];
  const unexpected = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  await page.route('**/*', async (handler) => {
    const url = new URL(handler.request().url());
    if (url.origin !== origin) {
      unexpected.push(handler.request().url());
      return handler.abort();
    }
    if (url.pathname === '/proof.js') return handler.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/proof.css') return handler.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname.startsWith('/api/')) {
      unexpected.push(handler.request().url());
      return handler.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    return handler.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
    });
  });
  const query = new URLSearchParams({ w: String(width) });
  if (viewer !== undefined) query.set('viewer', viewer);
  if (presentation) query.set('presentation', presentation);
  await page.goto(`${origin}/?${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-event-id="own-cat"]');
  await page.evaluate((s) => window.__collective.setScheme(s), scheme);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return { page, context, errors, unexpected };
}

/** Everything is measured inside the page, so colours are resolved by the browser itself. */
function measureInPage() {
  return (selector) => {
    const article = document.querySelector(selector);
    if (!article) return { missing: true };
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = (value) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrast = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const resolve = (cssValue) => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = cssValue;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return rgba(value);
    };
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
    };
    const column = document.querySelector('[data-testid="column"]');
    // What really sits behind something: the nearest ancestor with a painted background.
    const backdrop = (el) => {
      for (let up = el.parentElement; up; up = up.parentElement) {
        const color = rgba(getComputedStyle(up).backgroundColor);
        if (color[3] > 0.99) return color;
      }
      return rgba('#fff');
    };
    const articleStyle = getComputedStyle(article);
    const out = {
      selector,
      author: article.getAttribute('data-author'),
      article: rect(article),
      contentRight: article.getBoundingClientRect().right - parseFloat(articleStyle.paddingRight),
      contentLeft: article.getBoundingClientRect().left + parseFloat(articleStyle.paddingLeft),
      column: rect(column),
      hasAvatarColumn: article.querySelector('.avatar-button') !== null,
      hasHeaderMeta: article.querySelector('.message-meta') !== null,
      names: Array.from(article.querySelectorAll('strong')).map((el) => el.textContent),
      scrollOverflowX: article.scrollWidth > article.clientWidth + 1,
      times: Array.from(article.querySelectorAll('time')).map((el) => ({
        text: el.textContent,
        className: el.className,
        fontSize: getComputedStyle(el).fontSize,
        rect: rect(el),
      })),
    };
    const contentLimit = out.contentRight;
    const clips = (el) => ['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(el).overflowX);
    out.escapes = [];
    for (const el of article.querySelectorAll('*')) {
      // The hover toolbar is an absolutely positioned overlay on the card edge (transparent at rest) in every presentation.
      if (el.closest('.message-actions')) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.right <= contentLimit + 0.5) continue;
      let clipped = false;
      for (let up = el.parentElement; up && up !== article; up = up.parentElement) {
        if (clips(up)) {
          clipped = true;
          break;
        }
      }
      if (!clipped)
        out.escapes.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(box.right)}`,
        );
    }
    const bubble = article.querySelector('.message-bubble');
    if (bubble) {
      const style = getComputedStyle(bubble);
      const fill = rgba(style.backgroundColor);
      out.bubble = {
        rect: rect(bubble),
        fill,
        fillCss: style.backgroundColor,
        opacity: style.opacity,
        radii: [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ],
        textAlign: style.textAlign,
        overflow: style.overflow,
        paddingLeft: parseFloat(style.paddingLeft),
      };
      out.resolvedSurface = resolve('var(--human-surface)');
      const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode && !textNode.textContent.trim()) textNode = walker.nextNode();
      if (textNode) {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const lines = new Map();
        for (const box of range.getClientRects())
          lines.set(Math.round(box.top), Math.min(lines.get(Math.round(box.top)) ?? Infinity, box.left));
        out.lineStarts = Array.from(lines.values()).map((x) => Math.round(x * 10) / 10);
        out.textContrast = Number(contrast(rgba(getComputedStyle(textNode.parentElement).color), fill).toFixed(2));
      }
    }
    const plate = article.querySelector('.human-nameplate');
    if (plate) {
      const name = plate.querySelector('strong');
      const avatar = plate.querySelector('.avatar');
      const plateStyle = getComputedStyle(plate);
      const nameStyle = getComputedStyle(name);
      out.plate = {
        tag: plate.tagName.toLowerCase(),
        rect: rect(plate),
        paddingLeft: plateStyle.paddingLeft,
        paddingRight: plateStyle.paddingRight,
        topRadius: plateStyle.borderTopLeftRadius,
        bottomRadius: plateStyle.borderBottomLeftRadius,
        backgroundImage: plateStyle.backgroundImage,
        avatar: avatar ? rect(avatar) : null,
        name: {
          text: name.textContent,
          fontSize: nameStyle.fontSize,
          fontWeight: nameStyle.fontWeight,
          rect: rect(name),
        },
      };
      // Name legibility against what is really behind its glyph box: the plate's gradient over the page behind it.
      const surface = resolve('var(--human-surface)');
      const page = backdrop(plate);
      const fg = rgba(nameStyle.color);
      const range = document.createRange();
      range.selectNodeContents(name);
      const glyphs = range.getBoundingClientRect();
      const plateRect = plate.getBoundingClientRect();
      const t0 = Math.max(0, Math.min(1, (glyphs.top - plateRect.top) / plateRect.height));
      const t1 = Math.max(0, Math.min(1, (glyphs.bottom - plateRect.top) / plateRect.height));
      let min = Infinity;
      for (let i = 0; i <= 20; i++) {
        const t = t0 + ((t1 - t0) * i) / 20;
        const bg = [0, 1, 2].map((k) => surface[k] * (1 - t) + page[k] * t);
        min = Math.min(min, contrast(fg, bg));
      }
      out.plate.contrastMin = Number(min.toFixed(2));
    }
    return out;
  };
}

const measure = (page, selector) => page.evaluate(measureInPage(), selector);
const byEvent = (id) => `.channel-flow [data-event-id="${id}"]`;
const shot = async (page, name) => {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  await page.locator('[data-testid="column"]').screenshot({ path: path.join(evidenceDir, name) });
};

test('your own message: one right-aligned 12px block, no avatar, no name, the blank on the left', async () => {
  const { page, context, errors, unexpected } = await open();
  for (const id of ['own-short', 'own-run-a', 'own-run-b', 'own-run-c']) {
    const m = await measure(page, byEvent(id));
    assert.equal(m.author, 'self', `${id}: yours`);
    assert.equal(m.hasAvatarColumn, false, `${id}: no avatar`);
    assert.equal(m.hasHeaderMeta, false, `${id}: no header`);
    assert.deepEqual(m.names, [], `${id}: no name anywhere`);
    assert.deepEqual(m.bubble.radii, ['12px', '12px', '12px', '12px'], `${id}: one whole block`);
    assert.equal(m.bubble.textAlign, 'left');
    assert.equal(m.bubble.opacity, '1');
    assert.equal(m.bubble.fill[3], 1, `${id}: opaque`);
    assert.deepEqual(m.bubble.fill, m.resolvedSurface, `${id}: the human colour`);
    assert.ok(Math.abs(m.bubble.rect.r - m.contentRight) < 0.6, `${id}: right edge is the column's content edge`);
    const content = m.contentRight - m.contentLeft;
    assert.ok(m.bubble.rect.w <= content * 0.8 + 0.6, `${id}: at most about 80% (${m.bubble.rect.w} of ${content})`);
    assert.ok(m.bubble.rect.x - m.contentLeft >= content * 0.2 - 0.6, `${id}: the blank on the left`);
    assert.deepEqual(m.escapes.slice(0, 3), [], `${id}: nothing painted past the content edge`);
    assert.equal(m.scrollOverflowX, false);
  }
  const short = await measure(page, byEvent('own-short'));
  assert.ok(short.bubble.rect.w < (short.contentRight - short.contentLeft) * 0.4, 'a short message hugs its text');
  const long = await measure(page, byEvent('own-run-b'));
  assert.ok(
    long.lineStarts.length >= 2 && long.lineStarts.every((x) => Math.abs(x - long.lineStarts[0]) < 1),
    'left-aligned lines',
  );
  await shot(page, 'v2-light-720.png');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await context.close();
});

test('a run of your own messages shows its time once, under the last one, in the caption style', async () => {
  const { page, context } = await open();
  const times = {};
  for (const id of ['own-short', 'own-run-a', 'own-run-b', 'own-run-c'])
    times[id] = (await measure(page, byEvent(id))).times;
  assert.equal(times['own-short'].length, 1, 'alone in its run: shows its time');
  assert.equal(times['own-run-a'].length, 0, 'first of a run: none');
  assert.equal(times['own-run-b'].length, 0, 'middle of a run: none');
  assert.equal(times['own-run-c'].length, 1, 'last of the run: shows it');
  for (const id of ['own-short', 'own-run-c']) {
    const m = await measure(page, byEvent(id));
    assert.equal(m.times[0].fontSize, '12px');
    assert.ok(m.times[0].rect.y >= m.bubble.rect.b - 0.5, `${id}: under the block`);
    assert.ok(Math.abs(m.times[0].rect.r - m.bubble.rect.r) < 1, `${id}: aligned to the block's right edge`);
  }
  await context.close();
});

test('another person: on the left under a 26px nameplate in the human colour, with the time beside it', async () => {
  const { page, context } = await open();
  for (const id of ['other-1', 'same-name']) {
    const m = await measure(page, byEvent(id));
    assert.equal(m.author, 'other-human', id);
    assert.equal(m.bubble, undefined, `${id}: not a bubble`);
    assert.equal(m.plate.tag, 'button', `${id}: the plate opens the member card`);
    assert.equal(m.plate.rect.h, 26);
    assert.equal(m.plate.paddingLeft, '8px');
    assert.equal(m.plate.paddingRight, '10px');
    assert.equal(m.plate.topRadius, '8px');
    assert.equal(m.plate.bottomRadius, '0px');
    assert.match(m.plate.backgroundImage, /linear-gradient\(/);
    assert.equal(m.plate.avatar.w, 16);
    assert.equal(m.plate.avatar.h, 16);
    assert.equal(m.plate.name.fontSize, '13px');
    assert.equal(m.plate.name.fontWeight, '600');
    assert.equal(m.times.length, 1);
    assert.ok(m.times[0].rect.x >= m.plate.rect.r, `${id}: the time is beside the plate`);
    assert.equal(m.times[0].fontSize, '12px');
  }
  const same = await measure(page, byEvent('same-name'));
  assert.equal(same.plate.name.text, '阿宪', 'the sender is the original event, not the viewer');
  await context.close();
});

test('the viewer is not known: nothing is yours, the message is on the left, named', async () => {
  const { page, context } = await open({ viewer: '' });
  const m = await measure(page, byEvent('own-short'));
  assert.equal(m.author, 'other-human');
  assert.equal(m.bubble, undefined);
  assert.equal(m.plate.name.text, '阿宪');
  assert.equal(await page.locator('.channel-flow [data-author="self"]').count(), 0);
  await shot(page, 'v2-light-unknown-viewer-720.png');
  await context.close();
});

test('cats are untouched, including your own', async () => {
  const { page, context } = await open();
  for (const id of ['own-cat', 'other-cat']) {
    const m = await measure(page, byEvent(id));
    assert.equal(m.author, null, `${id}: not a human presentation`);
    assert.equal(m.hasAvatarColumn, true, `${id}: avatar column`);
    assert.equal(m.hasHeaderMeta, true, `${id}: header with name and origin`);
    assert.ok(m.names.length >= 1);
  }
  await context.close();
});

test('the host said nothing, or classic: the layout it always was, whoever the viewer is', async () => {
  // `null` = no parameter on the frame URL (what an existing user gets today); 'classic' = the explicit link/acceptance entry.
  for (const [presentation, viewer] of [
    [null, undefined],
    [null, ''],
    ['classic', undefined],
    ['classic', ''],
  ]) {
    const { page, context } = await open({ presentation, viewer });
    for (const id of ['own-short', 'other-1', 'own-cat']) {
      const m = await measure(page, byEvent(id));
      assert.equal(m.author, null, `${id}: no new presentation`);
      assert.equal(m.hasAvatarColumn, true, `${id}: avatar column`);
      assert.equal(m.hasHeaderMeta, true, `${id}: header`);
      assert.equal(m.bubble, undefined);
      assert.equal(m.plate, undefined);
    }
    if (presentation === null && viewer === undefined) await shot(page, 'classic-light-720.png');
    await context.close();
  }
});

// The Client keeps its light tokens in both OS colour schemes (only `color-scheme` flips); the human colour has one
// definition, and the probe checks it stays readable whichever scheme the frame is in.
for (const scheme of ['light', 'dark']) {
  test(`legibility ≥ 4.5:1 — OS scheme ${scheme}: text on your block, and the name on another person's plate`, async () => {
    const { page, context } = await open({ scheme });
    for (const id of ['own-short', 'own-run-b']) {
      const m = await measure(page, byEvent(id));
      measurements.push({ scheme, id, kind: 'text on your block', contrast: m.textContrast });
      assert.ok(m.textContrast >= 4.5, `${scheme} ${id}: text ${m.textContrast} < 4.5`);
    }
    for (const id of ['other-1', 'same-name']) {
      const m = await measure(page, byEvent(id));
      measurements.push({ scheme, id, kind: 'name on the plate', contrast: m.plate.contrastMin });
      assert.ok(m.plate.contrastMin >= 4.5, `${scheme} ${id}: name ${m.plate.contrastMin} < 4.5`);
    }
    if (scheme === 'dark') await shot(page, 'v2-os-dark-720.png');
    await context.close();
  });
}

test('the Studio chat bar (400px): nothing leaves the column and the cap holds', async () => {
  const { page, context, errors } = await open({ width: 400 });
  for (const id of ['own-short', 'own-run-a', 'own-run-b', 'own-run-c', 'other-1', 'same-name']) {
    const m = await measure(page, byEvent(id));
    assert.ok(m.article.r <= m.column.r + 0.5, `${id}: inside the column`);
    assert.equal(m.scrollOverflowX, false, `${id}: no horizontal overflow`);
    assert.deepEqual(m.escapes.slice(0, 3), [], `${id}: nothing painted past the content edge`);
    if (m.bubble) {
      assert.ok(m.bubble.rect.w <= (m.contentRight - m.contentLeft) * 0.8 + 0.6, `${id}: within the cap`);
      assert.ok(Math.abs(m.bubble.rect.r - m.contentRight) < 0.6, `${id}: right-aligned`);
    }
  }
  await shot(page, 'v2-light-400.png');
  assert.deepEqual(errors, []);
  await context.close();
});

test('topic messages: your own is the right-aligned block, another person has the nameplate', async () => {
  const { page, context } = await open();
  const own = await measure(page, '[data-testid="topic"] article[data-author="self"]');
  assert.equal(own.hasAvatarColumn, false);
  assert.deepEqual(own.names, []);
  assert.deepEqual(own.bubble.radii, ['12px', '12px', '12px', '12px']);
  assert.ok(own.bubble.rect.r <= own.article.r + 0.5);
  const other = await measure(page, '[data-testid="topic"] article[data-author="other-human"]');
  assert.equal(other.plate.rect.h, 26);
  assert.equal(other.plate.name.text, '阿禾');
  await context.close();
});
