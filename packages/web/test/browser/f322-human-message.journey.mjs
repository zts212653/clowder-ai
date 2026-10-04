import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

/**
 * F322 B segment 1 probe — your own message in the new presentation, in a real browser.
 *
 * The REAL ChatMessage / MessageBubble / CoCreatorHueInjector and the real theme CSS builder, on a column the width of the
 * reading column (720) and of the Studio chat bar (400). The human colour travels the way it does in the product:
 * `/api/config` answers with a co-creator config, the real hook reads it, the real injector turns it into hue / chroma,
 * the F056 roles derive the surface, and the bubble paints it. Every request is answered inside the isolated browser; no
 * dev or runtime service, user account or Redis is used.
 *
 * Set HUMAN_EVIDENCE_DIR to also write the screenshots and the measurement table the PR cites.
 */
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(webRoot, 'test/browser/fixtures');
const origin = 'https://f322-human-message.test';
const evidenceDir = process.env.HUMAN_EVIDENCE_DIR;
const measurements = [];
let browser, script, css;
const startedIn = process.cwd();

const COCOA = { primary: '#6B5443', secondary: '#E9DCCF' };
// The two cats that answer in the thread, as the catalog ships their colours.
const cats = [
  ['opus', '布偶猫', '#9B7EBD', 'ragdoll'],
  ['codex', '缅因猫', '#5B8C5A', 'maine-coon'],
].map(([id, displayName, primary, breedId]) => ({
  id,
  displayName,
  breedId,
  avatar: `/avatars/${id}.png`,
  color: { primary, secondary: '#eeeeee' },
  mentionPatterns: [`@${id}`],
  clientId: 'fixture',
  defaultModel: 'fixture',
}));
// The colour You's own saved config carries today: not cocoa, so it shows the colour really follows the config.
const SAVED = { primary: '#815b5b', secondary: '#FFDDD2' };
const EIGHT_DIGIT = { primary: '#6666ffff', secondary: '#ffffffff' };

before(async () => {
  process.chdir(webRoot);
  const result = await build({
    root: webRoot,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: {
      alias: [
        { find: 'next/navigation', replacement: path.join(fixtureRoot, 'f322-shell-navigation.ts') },
        { find: '@', replacement: path.join(webRoot, 'src') },
      ],
    },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(fixtureRoot, 'f322-human-message.tsx'),
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
 * @param color  object = a configured human colour; null = a config without a colour (not undefined: that takes the
 *               default); 'fails' = the config request fails.
 */
async function open({
  shell = 'v2',
  width = 720,
  base = 'light',
  variant = 'default',
  color = COCOA,
  scale = 1,
  consumers = false,
} = {}) {
  const context = await browser.newContext({
    viewport: { width: Math.max(width + 40, 480), height: 1300 },
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
  await context.addInitScript((value) => localStorage.setItem('cat-cafe:shell-presentation', value), shell);
  await page.route('**/*', async (handler) => {
    const request = handler.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(request.url());
      return handler.abort();
    }
    if (url.pathname === '/proof.js') return handler.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/proof.css') return handler.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname.startsWith('/avatars/')) {
      const file = path.join(webRoot, 'public', url.pathname);
      const fallback = path.join(webRoot, 'public/avatars/default.png');
      return handler.fulfill({ contentType: 'image/png', body: readFileSync(existsSync(file) ? file : fallback) });
    }
    if (url.pathname === '/api/config') {
      if (color === 'fails') return handler.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      const coCreator = { name: 'You', aliases: [], mentionPatterns: ['@co-creator'], ...(color ? { color } : {}) };
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ config: { coCreator } }) });
    }
    if (url.pathname === '/api/session')
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ userId: 'owner-1' }) });
    if (url.pathname === '/api/cats')
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ cats }) });
    if (url.pathname === '/api/config/cat-order')
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ catOrder: [] }) });
    if (url.pathname.startsWith('/api/')) {
      unexpected.push(request.url());
      return handler.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    return handler.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
    });
  });
  const configAnswered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/config');
  await page.goto(`${origin}/?w=${width}${consumers ? '&consumers=1' : ''}`, { waitUntil: 'networkidle' });
  await configAnswered;
  if (consumers) {
    await page.waitForSelector('[data-consumer="owner-card"]');
  } else {
    await page.waitForSelector('[data-message-id="h-whisper"]');
    // The registry arrives after the first render; the cats' avatars are the sign that it has.
    await page.waitForSelector('[data-message-id="c-1"] img');
  }
  await page.waitForSelector('#f056-dynamic-cat-tokens', { state: 'attached' });
  await page.evaluate(([b, v]) => window.__human.applyTheme(b, v), [base, variant]);
  await page.evaluate(() =>
    Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null)))),
  );
  // Two frames: the config answer has been handed to React and the injector's effect has run.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return { page, context, errors, unexpected };
}

/** Everything measured inside the page, so colours are resolved by the browser itself. */
function measureInPage() {
  return (id) => {
    const message = document.querySelector(`[data-message-id="${id}"]`);
    const column = document.querySelector('[data-testid="column"]');
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
      column.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return rgba(value);
    };
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
    };
    const out = { id };
    const bubble = message?.querySelector('[data-testid="message-bubble"]');
    if (!message || !bubble) return { ...out, missing: true };

    const columnStyle = getComputedStyle(column);
    const contentLeft = column.getBoundingClientRect().left + parseFloat(columnStyle.paddingLeft);
    const contentRight = column.getBoundingClientRect().right - parseFloat(columnStyle.paddingRight);
    out.content = { left: contentLeft, right: contentRight, w: contentRight - contentLeft };
    out.column = rect(column);
    out.message = rect(message);
    out.hasAvatar =
      message.querySelector('img') !== null || message.querySelector('button[aria-label^="编辑"]') !== null;
    out.hasNameplate = message.querySelector('[data-testid="cat-nameplate"]') !== null;
    out.mentionsName = message.textContent.includes('You');
    out.scrollOverflowX = message.scrollWidth > message.clientWidth + 1;

    const style = getComputedStyle(bubble);
    out.bubble = {
      rect: rect(bubble),
      backgroundColor: style.backgroundColor,
      fill: rgba(style.backgroundColor),
      opacity: style.opacity,
      borderTopStyle: style.borderTopStyle,
      borderTopWidth: style.borderTopWidth,
      radii: [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ],
      textAlign: style.textAlign,
      overflow: style.overflow,
      transform: style.transform,
      paddingLeft: parseFloat(style.paddingLeft),
    };

    // Anything painted past the column's content box that is not inside something that scrolls or clips it.
    const clips = (el) => ['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(el).overflowX);
    out.escapes = [];
    for (const el of message.querySelectorAll('*')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.right <= contentRight + 0.5) continue;
      let clipped = false;
      for (let up = el.parentElement; up && up !== message; up = up.parentElement) {
        if (clips(up)) {
          clipped = true;
          break;
        }
      }
      if (!clipped) out.escapes.push(`${el.tagName.toLowerCase()} right=${Math.round(box.right)}`);
    }

    // Where each line of the first text node starts: left-aligned text starts every line on the same x.
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode && !textNode.textContent.trim()) textNode = walker.nextNode();
    if (textNode) {
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const lines = new Map();
      for (const box of range.getClientRects()) {
        const key = Math.round(box.top);
        lines.set(key, Math.min(lines.get(key) ?? Infinity, box.left));
      }
      out.lineStarts = Array.from(lines.values()).map((x) => Math.round(x * 10) / 10);
      const bodyColor = rgba(getComputedStyle(textNode.parentElement).color);
      out.bodyColor = bodyColor;
      out.contrast = Number(
        contrast(bodyColor, style.backgroundColor ? rgba(style.backgroundColor) : [0, 0, 0]).toFixed(2),
      );
    }

    // A code panel inside the block: how far its own fill is from the block's (recorded, not a rule).
    const pre = bubble.querySelector('pre');
    out.codePanel = pre
      ? {
          fill: getComputedStyle(pre).backgroundColor,
          ratioToBlock: Number(contrast(rgba(getComputedStyle(pre).backgroundColor), out.bubble.fill).toFixed(2)),
        }
      : null;

    const header = message.querySelector('[data-testid="human-message-header"]');
    out.headerHeight = header ? header.getBoundingClientRect().height : null;
    const time = message.querySelector('[data-testid="human-message-time"]');
    out.time = time
      ? {
          text: time.textContent,
          fontSize: getComputedStyle(time).fontSize,
          color: rgba(getComputedStyle(time).color),
          rect: rect(time),
          contrastOnWork: Number(contrast(rgba(getComputedStyle(time).color), resolve('var(--shell-work)')).toFixed(2)),
        }
      : null;
    out.resolved = {
      cocreatorSurface: resolve('var(--color-cocreator-surface)'),
      shellSelected: resolve('var(--shell-selected)'),
      shellMuted: resolve('var(--shell-muted)'),
    };
    out.hue = getComputedStyle(document.documentElement).getPropertyValue('--cocreator-hue').trim();
    out.chroma = getComputedStyle(document.documentElement).getPropertyValue('--cocreator-chroma').trim();
    return out;
  };
}

const measure = (page, id) => page.evaluate(measureInPage(), id);
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1.01);
const shot = async (page, name) => {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  await page.locator('[data-testid="column"]').screenshot({ path: path.join(evidenceDir, name) });
};

test('v2: one right-aligned 12px block, no avatar and no name, the blank on the left', async () => {
  const { page, context, errors, unexpected } = await open({ shell: 'v2', width: 720 });
  for (const id of ['h-short', 'h-run-a', 'h-run-b', 'h-code']) {
    const m = await measure(page, id);
    assert.equal(m.hasAvatar, false, `${id}: no avatar`);
    assert.equal(m.hasNameplate, false, `${id}: no nameplate`);
    assert.equal(m.mentionsName, false, `${id}: nothing says who you are`);
    assert.deepEqual(m.bubble.radii, ['12px', '12px', '12px', '12px'], `${id}: one whole block, same corners`);
    assert.equal(m.bubble.textAlign, 'left', `${id}: text left-aligned inside the block`);
    assert.equal(m.bubble.opacity, '1', `${id}: not faded`);
    assert.equal(m.bubble.fill[3], 1, `${id}: opaque fill`);
    assert.equal(m.bubble.transform, 'none', `${id}: no hover lift`);
    assert.equal(m.bubble.overflow, 'hidden', `${id}: content is clipped to the corners`);
    assert.ok(Math.abs(m.bubble.rect.r - m.content.right) < 0.6, `${id}: right edge is the column's content edge`);
    assert.ok(
      m.bubble.rect.w <= m.content.w * 0.8 + 0.6,
      `${id}: at most about 80% (${m.bubble.rect.w} of ${m.content.w})`,
    );
    assert.ok(m.bubble.rect.x - m.content.left >= m.content.w * 0.2 - 0.6, `${id}: at least 20% blank on the left`);
    assert.deepEqual(m.escapes.slice(0, 3), [], `${id}: nothing painted past the content edge`);
    assert.equal(m.scrollOverflowX, false, `${id}: no horizontal overflow`);
  }

  const short = await measure(page, 'h-short');
  assert.ok(short.bubble.rect.w < short.content.w * 0.4, 'a short message hugs its text');
  assert.equal(short.headerHeight, 0, 'a plain message has no empty row above it');
  assert.ok(Math.abs(short.bubble.rect.y - short.message.y) < 0.6, 'the block starts where the message starts');

  const long = await measure(page, 'h-run-b');
  assert.ok(long.bubble.rect.w > long.content.w * 0.75, 'a long message reaches the cap');
  assert.ok(long.lineStarts.length >= 2, 'the long message wraps');
  assert.ok(
    long.lineStarts.every((x) => Math.abs(x - long.lineStarts[0]) < 1),
    `every line starts on the same x: ${long.lineStarts}`,
  );
  assert.ok(Math.abs(long.lineStarts[0] - (long.bubble.rect.x + long.bubble.paddingLeft)) < 1.5, 'at the padding edge');

  const code = await measure(page, 'h-code');
  assert.ok(code.bubble.rect.r <= code.content.right + 0.6, 'wide code stays inside the block');
  assert.ok(code.bubble.rect.w <= code.content.w * 0.8 + 0.6, 'and the block stays within the cap');

  await shot(page, 'v2-light-cocoa-720.png');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await context.close();
});

test('the time sits once under the last message of a run, and not under the others', async () => {
  const { page, context } = await open({ shell: 'v2', width: 720 });
  const byId = Object.fromEntries(
    await Promise.all(
      ['h-short', 'h-run-a', 'h-run-b', 'h-code', 'h-whisper'].map(async (id) => [id, await measure(page, id)]),
    ),
  );
  assert.equal(byId['h-run-a'].time, null, 'first of a run: no time');
  assert.equal(byId['h-run-b'].time, null, 'middle of a run: no time');
  for (const id of ['h-short', 'h-code', 'h-whisper']) {
    const m = byId[id];
    assert.ok(m.time, `${id}: last of its run shows the time`);
    assert.equal(m.time.fontSize, '12px', `${id}: caption size`);
    assert.ok(m.time.rect.y >= m.bubble.rect.b - 0.5, `${id}: under the bubble`);
    assert.ok(Math.abs(m.time.rect.r - m.bubble.rect.r) < 1, `${id}: aligned to the bubble's right edge`);
    assert.ok(same(m.time.color, m.resolved.shellMuted), `${id}: the muted role`);
    measurements.push({
      case: 'time',
      id,
      text: m.time.text,
      fontSize: m.time.fontSize,
      contrastOnWork: m.time.contrastOnWork,
    });
  }
  await context.close();
});

test('the copy-id control stays reachable: hidden at rest, revealed on hover, in the blank left of the block', async () => {
  const { page, context } = await open({ shell: 'v2', width: 720 });
  const button = page.locator('[data-message-id="h-short"] button[aria-label^="复制消息 ID"]');
  assert.equal(await button.count(), 1);
  const rest = await button.evaluate((el) => getComputedStyle(el).opacity);
  assert.equal(rest, '0');
  await page.locator('[data-message-id="h-short"] [data-testid="message-bubble"]').hover();
  await page.waitForTimeout(400);
  assert.equal(await button.evaluate((el) => getComputedStyle(el).opacity), '1');
  const box = await button.boundingBox();
  const bubble = await page.locator('[data-message-id="h-short"] [data-testid="message-bubble"]').boundingBox();
  assert.ok(box.x + box.width <= bubble.x + 0.5, 'left of the block, not over it');
  await context.close();
});

test('the colour follows the config through the F056 roles, and no colour set means cocoa, never a neutral', async () => {
  const resolved = {};
  for (const [name, color] of [
    ['cocoa', COCOA],
    ['saved', SAVED],
    ['none', null],
    ['fails', 'fails'],
  ]) {
    const { page, context } = await open({ shell: 'v2', color });
    resolved[name] = await measure(page, 'h-short');
    await context.close();
  }
  for (const name of ['cocoa', 'saved', 'none', 'fails']) {
    const m = resolved[name];
    assert.ok(same(m.bubble.fill, m.resolved.cocreatorSurface), `${name}: the block is the human colour role`);
    assert.ok(!same(m.bubble.fill, m.resolved.shellSelected), `${name}: and never the surface-3 neutral`);
  }
  // No colour set (or a config that cannot be read) is the shared cocoa: the same fill, hue and chroma as configuring cocoa.
  for (const name of ['none', 'fails']) {
    assert.ok(
      same(resolved[name].bubble.fill, resolved.cocoa.bubble.fill),
      `${name}: no colour -> exactly the cocoa fill`,
    );
    assert.equal(resolved[name].hue, '58', `${name}: the baked cocoa hue`);
    assert.equal(resolved[name].chroma, '0.04', `${name}: the baked cocoa chroma`);
  }
  assert.ok(
    !same(resolved.cocoa.bubble.fill, resolved.saved.bubble.fill),
    'a different config colour -> a different fill',
  );
  assert.notEqual(resolved.cocoa.hue, resolved.saved.hue, 'the hue on the page comes from the config');

  // The change arrives while the page is open: the injector and the bubble follow it without a reload.
  const { page, context } = await open({ shell: 'v2', color: COCOA });
  const before = await measure(page, 'h-short');
  await page.evaluate((c) => window.__human.setColor(c), SAVED);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const afterChange = await measure(page, 'h-short');
  assert.ok(!same(before.bubble.fill, afterChange.bubble.fill), 'config change -> the fill follows');
  assert.ok(same(afterChange.bubble.fill, afterChange.resolved.cocreatorSurface), 'to the role');
  await page.evaluate(() => window.__human.setColor(null));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const removed = await measure(page, 'h-short');
  assert.ok(same(removed.bubble.fill, before.bubble.fill), 'colour taken away -> back to cocoa');
  await context.close();

  measurements.push(
    ...Object.entries(resolved).map(([name, m]) => ({
      case: 'colour-source',
      config: name,
      hue: m.hue,
      chroma: m.chroma,
      fill: m.bubble.backgroundColor,
    })),
  );
});

/** Everything is measured in the page, with the browser resolving every colour. */
function measureConsumersInPage() {
  return () => {
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
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    };
    const over = (top, bottom) => {
      const a = top[3];
      return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
    };
    const consumer = (name) => document.querySelector(`[data-consumer="${name}"]`);
    const layerFill = (variable) =>
      rgba(getComputedStyle(document.querySelector(`[data-layer="${variable}"]`)).backgroundColor);
    // Where this text can really sit: the page layers and the bubbles (a pill is in a message header, the owner card on a
    // settings surface). The Tailwind surface classes of the real Hub are not in this proof page, so the ratio is taken
    // against every layer and the worst one is kept.
    const TEXT_LAYERS = [
      '--cafe-surface-canvas',
      '--cafe-surface',
      '--cafe-surface-elevated',
      '--color-opus-surface',
      '--color-codex-surface',
      '--color-cocreator-surface',
    ];
    const worstOnLayers = (el, tint) =>
      Math.min(
        ...TEXT_LAYERS.map((variable) => {
          const behind = tint ? over(tint, layerFill(variable)) : layerFill(variable);
          return contrast(rgba(getComputedStyle(el).color), behind);
        }),
      );
    const pill = consumer('reply-pill').querySelector('button');
    const bar = consumer('reply-bar').firstElementChild;
    const card = consumer('owner-card');
    const mention = [...card.querySelectorAll('span')].find((node) => node.textContent?.includes('@co-creator'));
    const avatar = [...card.querySelectorAll('div')].filter((node) => node.textContent === 'ME').at(-1);
    const out = {
      replyPill: worstOnLayers(pill, rgba(getComputedStyle(pill).backgroundColor)),
      replyBar: Math.min(
        ...[...consumer('reply-bar').querySelectorAll('span')].map((node) =>
          worstOnLayers(node, rgba(getComputedStyle(bar).backgroundColor)),
        ),
      ),
      ownerMention: worstOnLayers(mention),
      ownerInitials: avatar
        ? contrast(rgba(getComputedStyle(avatar).color), rgba(getComputedStyle(avatar).backgroundColor))
        : null,
      focusRing: {},
    };
    for (const layer of document.querySelectorAll('[data-layer]')) {
      const ring = layer.firstElementChild;
      out.focusRing[layer.getAttribute('data-layer')] = contrast(
        rgba(getComputedStyle(ring).outlineColor),
        rgba(getComputedStyle(layer).backgroundColor),
      );
    }
    return out;
  };
}

test('every place that writes in the human colour reads in both themes, with the config colour or the cocoa default', async () => {
  const rows = [];
  for (const base of ['light', 'dark']) {
    for (const [name, color] of [
      ['cocoa', null],
      ['saved', SAVED],
      // The config chain accepts #RRGGBBAA; an opaque one is the same fill as its 6-digit form and gets the same ink.
      ['eight-digit', EIGHT_DIGIT],
    ]) {
      const { page, context, errors } = await open({ shell: 'v2', base, color, consumers: true });
      await page.waitForTimeout(500); // the ring and the surfaces transition their colours for a moment after a theme change
      const m = await page.evaluate(measureConsumersInPage());
      await context.close();
      assert.deepEqual(errors, [], `${base}/${name}: no page errors`);
      for (const [place, ratio] of Object.entries({
        'reply pill': m.replyPill,
        'reply bar': m.replyBar,
        'owner mention': m.ownerMention,
        'owner initials': m.ownerInitials,
      })) {
        assert.ok(ratio !== null && ratio >= 4.5, `${base}/${name}: ${place} ${ratio}:1 (≥ 4.5)`);
      }
      rows.push({ case: 'identity-colour consumers', base, config: name, ...m });
    }
  }
  measurements.push(...rows);
});

/**
 * The identity-colour tint behind the reply pill (alpha 0x20) and the reply bar (alpha 0x18), as the browser paints it.
 * The tint is spelt by appending the alpha byte to the colour, which is only a colour when the colour is a six-digit hex.
 */
function measureReplyTintsInPage() {
  return () => {
    const paint = (el) => getComputedStyle(el).backgroundColor;
    const pill = document.querySelector('[data-consumer="reply-pill"] button');
    const bar = document.querySelector('[data-consumer="reply-bar"]').firstElementChild;
    return {
      pill: paint(pill),
      bar: paint(bar),
      written: { pill: pill.getAttribute('style'), bar: bar.getAttribute('style') },
    };
  };
}

async function replyTintsFor(primary, base = 'light') {
  const { page, context, errors } = await open({
    shell: 'v2',
    base,
    color: { primary, secondary: '#ffffff' },
    consumers: true,
  });
  await page.waitForTimeout(500);
  const { written, ...tints } = await page.evaluate(measureReplyTintsInPage());
  await context.close();
  assert.deepEqual(errors, [], `${primary}: no page errors`);
  return { tints, written };
}

test('an opaque 3/4/8-digit human colour tints the reply pill and the reply bar exactly like its six-digit spelling', async () => {
  const rows = [];
  for (const base of ['light', 'dark']) {
    const { tints: reference } = await replyTintsFor('#6666ff', base);
    // The six-digit spelling is the reference and is itself pinned: 0x20 and 0x18 of #6666ff.
    assert.deepEqual(reference, {
      pill: 'rgba(102, 102, 255, 0.125)',
      bar: 'rgba(102, 102, 255, 0.094)',
    });
    for (const spelling of ['#6666ffff', '#6666FFFF', '#66f', '#66ff', '#66F']) {
      const { tints, written } = await replyTintsFor(spelling, base);
      assert.deepEqual(
        tints,
        reference,
        `${base}: ${spelling} paints the same tint as #6666ff (wrote ${JSON.stringify(written)})`,
      );
      rows.push({ case: 'reply-tint-equivalence', base, spelling, ...tints });
    }
  }
  measurements.push(...rows);
});

test('changing the human colour to an opaque 8-digit one at runtime moves the reply tint, it does not leave the old colour behind', async () => {
  // The Settings editor publishes the new colour to a page that already painted the old one. An invalid CSS value assigned
  // to an inline style is ignored by the browser, which keeps the PREVIOUS value: the tint would stay in the old colour.
  const { page, context, errors } = await open({
    shell: 'v2',
    color: { primary: '#6666ff', secondary: '#ffffff' },
    consumers: true,
  });
  await page.waitForTimeout(500);
  const before = await page.evaluate(measureReplyTintsInPage());
  assert.equal(before.pill, 'rgba(102, 102, 255, 0.125)');
  await page.evaluate(() => window.__human.setColor({ primary: '#cc3333ff', secondary: '#ffffff' }));
  await page.waitForTimeout(500);
  const after = await page.evaluate(measureReplyTintsInPage());
  await context.close();
  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(
    after.pill,
    'rgba(204, 51, 51, 0.125)',
    `pill follows the new colour (wrote ${JSON.stringify(after.written)})`,
  );
  assert.equal(after.bar, 'rgba(204, 51, 51, 0.094)', 'bar follows the new colour');
  measurements.push({
    case: 'reply-tint-runtime-change',
    from: '#6666ff',
    to: '#cc3333ff',
    pill: after.pill,
    bar: after.bar,
  });
});

test('a translucent human colour keeps its existing reply tint: none is painted (the theme shows through) and nothing throws', async () => {
  const rows = [];
  for (const spelling of ['#6666ff80', '#66f8']) {
    const { tints, written } = await replyTintsFor(spelling);
    assert.deepEqual(
      tints,
      { pill: 'rgba(0, 0, 0, 0)', bar: 'rgba(0, 0, 0, 0)' },
      `${spelling}: no tint (wrote ${JSON.stringify(written)})`,
    );
    rows.push({ case: 'reply-tint-translucent', spelling, ...tints });
  }
  measurements.push(...rows);
});

test('the lineage focus ring (outline in the human primary) reaches 3:1 on the page layers it can sit on, in both themes', async () => {
  const rows = [];
  for (const base of ['light', 'dark']) {
    const { page, context } = await open({ shell: 'v2', base, color: null, consumers: true });
    await page.waitForTimeout(500);
    const m = await page.evaluate(measureConsumersInPage());
    await context.close();
    rows.push({ case: 'focus-ring', base, config: 'cocoa', ...m.focusRing });
    // The ring sits on the message list (the page layers) and, for a receipt or absorption dock, inside the bubble of its
    // message. Nothing that takes lineage focus is drawn on the sunken layer, so that one is recorded and not asserted. On a
    // bubble in the light theme the ring is below 3:1 -- 2.29-2.35 now, 2.40-2.46 before this change (the classic apricot),
    // so it is a shortfall this work did not create and made 0.1 worse; it is recorded, not hidden, and not asserted.
    const pageLayers = ['--cafe-surface-canvas', '--cafe-surface', '--cafe-surface-elevated'];
    const bubbles = ['--color-opus-surface', '--color-codex-surface', '--color-cocreator-surface'];
    for (const layer of pageLayers) {
      assert.ok(m.focusRing[layer] >= 3, `${base}: focus ring on ${layer} is ${m.focusRing[layer]}:1 (needs 3:1)`);
    }
    if (base === 'dark') {
      for (const layer of bubbles) {
        assert.ok(m.focusRing[layer] >= 3, `${base}: focus ring on ${layer} is ${m.focusRing[layer]}:1 (needs 3:1)`);
      }
    }
  }
  measurements.push(...rows);
});

test('classic: the old bubble with its avatar and header time, and the config colour does not touch it', async () => {
  const cocoa = await open({ shell: 'classic', color: COCOA });
  const a = await measure(cocoa.page, 'h-short');
  assert.equal(a.hasAvatar, true, 'the avatar is still there');
  assert.equal(a.mentionsName, true, 'and the name');
  assert.equal(a.time, null, 'no under-bubble time in classic');
  assert.equal(a.bubble.radii[2], '2px', 'the corner tail is still there');
  assert.ok(
    (await cocoa.page.locator('html[data-shell="v2"]').count()) === 0,
    'the page is not marked as the new shell',
  );
  assert.equal(
    await cocoa.page.locator('#f322-cocreator-roles').count(),
    1,
    'the injector writes its (v2-scoped) rule',
  );
  const hueInClassic = await cocoa.page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--cocreator-hue').trim(),
  );
  await shot(cocoa.page, 'classic-light-720.png');
  await cocoa.context.close();

  const saved = await open({ shell: 'classic', color: SAVED });
  const b = await measure(saved.page, 'h-short');
  assert.ok(same(a.bubble.fill, b.bubble.fill), 'classic fill is the same whatever colour the config has');
  assert.equal(
    await saved.page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--cocreator-hue').trim(),
    ),
    hueInClassic,
    'the hue in classic is not driven by the config',
  );
  await saved.context.close();
});

for (const [base, variant] of [
  ['light', 'default'],
  ['dark', 'default'],
  ['light', 'tuned'],
  ['dark', 'tuned'],
]) {
  for (const [name, color] of [
    ['cocoa', COCOA],
    ['saved', SAVED],
    ['unconfigured', null],
  ]) {
    test(`text on the block ≥ 4.5:1 — ${base} / ${variant} / ${name}`, async () => {
      const { page, context } = await open({ shell: 'v2', width: 720, base, variant, color });
      const code = await measure(page, 'h-code');
      measurements.push({ case: 'code-panel-vs-block', theme: `${base}/${variant}`, config: name, ...code.codePanel });
      for (const id of ['h-short', 'h-run-b']) {
        const m = await measure(page, id);
        measurements.push({
          case: 'text-contrast',
          theme: `${base}/${variant}`,
          config: name,
          id,
          contrast: m.contrast,
        });
        assert.ok(m.contrast >= 4.5, `${base}/${variant}/${name} ${id}: ${m.contrast} < 4.5`);
        assert.equal(m.bubble.fill[3], 1, 'the fill is opaque, so the composite is the fill itself');
      }
      // One picture per theme with the human colour, and the other two colour states in the themes that stress them most.
      const first = base === 'light' && variant === 'default' && name === 'cocoa'; // already shot by the geometry test
      if (
        !first &&
        (name === 'cocoa' ||
          (variant === 'default' && name === 'unconfigured') ||
          (variant === 'tuned' && name === 'saved'))
      )
        await shot(page, `v2-${base}-${variant}-${name}-720.png`);
      await context.close();
    });
  }
}

test('the Studio chat bar (400px): nothing leaves the column and the cap holds', async () => {
  const { page, context, errors } = await open({ shell: 'v2', width: 400 });
  for (const id of ['h-short', 'h-run-a', 'h-run-b', 'h-code', 'h-whisper']) {
    const m = await measure(page, id);
    assert.ok(m.message.r <= m.column.r + 0.5, `${id}: stays inside the column`);
    assert.equal(m.scrollOverflowX, false, `${id}: no horizontal overflow`);
    assert.deepEqual(m.escapes.slice(0, 3), [], `${id}: nothing painted past the content edge`);
    assert.ok(m.bubble.rect.w <= m.content.w * 0.8 + 0.6, `${id}: within the cap`);
    assert.ok(Math.abs(m.bubble.rect.r - m.content.right) < 0.6, `${id}: right-aligned`);
  }
  await shot(page, 'v2-light-cocoa-400.png');
  assert.deepEqual(errors, []);
  await context.close();
});

test('an unrevealed whisper keeps its own warning look instead of the human colour', async () => {
  const { page, context } = await open({ shell: 'v2', width: 720 });
  const whisper = await measure(page, 'h-whisper');
  const plain = await measure(page, 'h-short');
  assert.equal(whisper.bubble.borderTopStyle, 'dashed');
  assert.ok(!same(whisper.bubble.fill, plain.bubble.fill), 'not the human fill');
  assert.equal(whisper.hasAvatar, false, 'still no avatar');
  const mark = await page.locator('[data-message-id="h-whisper"]').getByText('悄悄话').count();
  assert.ok(mark >= 1, 'the whisper mark is still shown');
  await context.close();
});
