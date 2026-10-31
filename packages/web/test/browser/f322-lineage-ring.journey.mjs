import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

/**
 * F322 B probe - the lineage ring (`[data-lineage-focus]`, the ~3 second ring that lands on a message a receipt or an
 * absorption dock points back to) over every layer it can sit on, in a real browser.
 *
 * The ring is a non-text mark: 3:1 against what it is drawn on. It keeps the human's hue and chroma and only has its
 * lightness resolved per theme, against the colours that really exist: the page layers and the surfaces of the cats the
 * registry returned and of the human, as the config paints them (Opus 5.5 3619). The real theme store, the real
 * ThemeApplier, the real cat tokens, the real co-creator injector and the real globals.css rule; the human colour is a config
 * published through the real co-creator cache. Cats of any colour nobody has are measured and disclosed, not promised. Every
 * request is answered in the isolated browser; nothing talks to a service.
 *
 * Set RING_EVIDENCE_DIR to also write the measurement table the PR cites.
 */
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(webRoot, 'test/browser/fixtures');
const origin = 'https://f322-lineage-ring.test';
const evidenceDir = process.env.RING_EVIDENCE_DIR;
const measurements = [];
let browser, script, css;
const startedIn = process.cwd();

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
  carrier: 'cli',
  clientId: 'fixture',
  defaultModel: 'fixture',
}));
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
        input: path.join(fixtureRoot, 'f322-lineage-ring.tsx'),
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

// The human colours the ring is checked with, as hex colours a user can pick and as the config publishes them.
const SECONDARY = '#E9DCCF';
const CONFIGS = {
  // No colour in the config: the shared cocoa that shell-v2.css bakes in applies (DESIGN: no colour set -> cocoa).
  unconfigured: null,
  // What You's running Cafe stores today, and what the repo's own cat-config.json ships now.
  stored: { primary: '#815b5b', secondary: '#FFDDD2' },
  shipped: { primary: '#6B5443', secondary: SECONDARY },
  // The legal-range edges that broke the first version, now as hex colours a user can pick.
  green: { primary: '#00ff00', secondary: SECONDARY },
  magenta: { primary: '#ff00ff', secondary: SECONDARY },
  blue: { primary: '#0000ff', secondary: SECONDARY },
  // An opaque 8-digit hex is a legal config value too (#4983 reads it).
  eightDigit: { primary: '#6666ffff', secondary: SECONDARY },
};
// Independent oracle for the three edge colours: the hue/chroma the F056 chain gives them (the review's own numbers).
const EDGE = { green: [142.5, 0.295], magenta: [328.4, 0.322], blue: [264.05, 0.313] };
const COCOA = [58, 0.04];

/**
 * The REAL chain in the new shell: <html data-shell="v2">, the real injector, a co-creator config published through the real
 * cache, the theme through the real store and the real ThemeApplier, resolved against the cats the registry returned and the
 * human colour in that config. `color`: null = a config without a colour.
 */
async function open({ base = 'light', variant = 'default', color = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 800, height: 1400 } });
  await context.addInitScript(() => localStorage.setItem('cat-cafe:shell-presentation', 'v2'));
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (handler) => {
    const url = new URL(handler.request().url());
    if (url.origin !== origin) return handler.abort();
    if (url.pathname === '/proof.js') return handler.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/proof.css') return handler.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname === '/api/cats')
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ cats }) });
    if (url.pathname === '/api/session')
      return handler.fulfill({ contentType: 'application/json', body: '{"userId":"owner-1"}' });
    // ThemeApplier asks the server for a saved theme when this browser has none; the answer is "nothing saved".
    if (url.pathname === '/api/config/env-summary')
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ variables: [] }) });
    if (url.pathname.startsWith('/api/'))
      return handler.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return handler.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
    });
  });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-layer]');
  await page.waitForSelector('#f056-dynamic-cat-tokens', { state: 'attached' });
  await page.evaluate(
    ([b, v, c]) => {
      window.__ring.setConfig(c);
      window.__ring.applyTheme(b, v);
    },
    [base, variant, color],
  );
  // The real ThemeApplier has put the theme on the page, resolved against this room.
  await page.evaluate(() => window.__ring.applied());
  // The ring and the surfaces transition their colours for a moment after a theme change.
  await page.waitForTimeout(500);
  return { page, context, errors };
}

/** Every colour is resolved by the browser itself. */
function measureInPage() {
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
    const root = getComputedStyle(document.documentElement);
    const out = {
      bubbleL: root.getPropertyValue('--cat-bubble-l').trim(),
      lineageL: root.getPropertyValue('--cat-lineage-l').trim(),
      ring: {},
      unclaimed: {},
      outline: null,
    };
    const ringOver = (strip) => {
      const style = getComputedStyle(strip.firstElementChild);
      out.outline ??= { width: style.outlineWidth, style: style.outlineStyle, colour: style.outlineColor };
      return contrast(rgba(style.outlineColor), rgba(getComputedStyle(strip).backgroundColor));
    };
    // What the ring is promised to read on: the page layers and the surfaces of the cats and the human that exist.
    for (const strip of document.querySelectorAll('[data-layer]'))
      out.ring[strip.getAttribute('data-layer')] = ringOver(strip);
    // Cats of any colour nobody has: measured and disclosed, not promised.
    for (const strip of document.querySelectorAll('[data-unclaimed]'))
      out.unclaimed[strip.getAttribute('data-unclaimed')] = ringOver(strip);
    return out;
  };
}

const MIN = 3;
const worst = (ring) => Math.min(...Object.values(ring));
const weakest = (ring) => Object.entries(ring).sort((a, b) => a[1] - b[1])[0];

const readHuman = (page) =>
  page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      hue: Number(root.getPropertyValue('--cocreator-hue')),
      chroma: Number(root.getPropertyValue('--cocreator-chroma')),
      injected: Boolean(document.getElementById('f322-cocreator-roles')),
    };
  });

async function assertChain(page, label, color) {
  const human = await readHuman(page);
  if (color === null) {
    assert.equal(human.injected, false, `${label}: no colour in the config writes nothing`);
    assert.deepEqual([human.hue, human.chroma], COCOA, `${label}: the baked cocoa applies`);
    return human;
  }
  assert.equal(human.injected, true, `${label}: the injector wrote its variables`);
  const expected = await page.evaluate((hex) => window.__ring.expected(hex), color.primary);
  assert.deepEqual([human.hue, human.chroma], [Number(expected.hue), Number(expected.chroma)], `${label}: variables`);
  return human;
}

for (const base of ['light', 'dark']) {
  for (const variant of ['default', 'tuned']) {
    test(`${base} / ${variant}: a configured human colour reaches the ring through the injector, and the ring reads 3:1 on every layer and every surface that exists`, async () => {
      const rows = {};
      for (const [name, color] of Object.entries(CONFIGS)) {
        const { page, context, errors } = await open({ base, variant, color });
        const human = await assertChain(page, `${base}/${variant}/${name}`, color);
        const m = await page.evaluate(measureInPage());
        await context.close();
        assert.deepEqual(errors, []);
        assert.equal(m.outline.width, '2px');
        assert.equal(m.outline.style, 'solid');
        if (EDGE[name]) {
          assert.ok(Math.abs(human.hue - EDGE[name][0]) < 0.11, `${name}: hue ${human.hue} vs ${EDGE[name][0]}`);
          assert.ok(
            Math.abs(human.chroma - EDGE[name][1]) < 0.002,
            `${name}: chroma ${human.chroma} vs ${EDGE[name][1]}`,
          );
        }
        const [where, ratio] = weakest(m.ring);
        assert.ok(ratio >= MIN, `${base}/${variant}/${name} via the injector: ${ratio}:1 on ${where} (needs ${MIN})`);
        rows[name] = { ...m, human };
        measurements.push({
          case: 'chain',
          base,
          variant,
          config: name,
          primary: color?.primary ?? null,
          hue: human.hue,
          chroma: human.chroma,
          bubbleL: m.bubbleL,
          lineageL: m.lineageL,
          worst: worst(m.ring),
          weakest: weakest(m.ring)[0],
          // The old promise (every colour a cat could have) is no longer made; this is how it fares, disclosed.
          unclaimedWorst: worst(m.unclaimed),
          unclaimedWeakest: weakest(m.unclaimed)[0],
        });
      }
      // And the human colour really arrives. The repo's shipped config colour IS the cocoa that shell-v2.css bakes in
      // (DESIGN: no colour set -> cocoa), so those two draw the same ring on purpose; every other colour draws its own.
      const outline = Object.fromEntries(Object.entries(rows).map(([name, m]) => [name, m.outline.colour]));
      assert.equal(outline.shipped, outline.unconfigured, 'the shipped config colour is the cocoa default');
      assert.equal(rows.shipped.lineageL, rows.unconfigured.lineageL, 'and it is resolved to the same lightness');
      const others = Object.entries(outline).filter(([name]) => name !== 'shipped');
      assert.equal(
        new Set(others.map(([, colour]) => colour)).size,
        others.length,
        `the ring follows the colour: ${JSON.stringify(outline)}`,
      );
    });
  }
}

test('the config changes while the page is open: the injector rewrites the variables, the theme is resolved again, the ring follows and still reads, and removing the colour returns to cocoa', async () => {
  const { page, context } = await open({ base: 'light', variant: 'default', color: CONFIGS.unconfigured });
  const start = await page.evaluate(measureInPage());
  await assertChain(page, 'start', null);
  // The cocoa ring itself reads too (it is the weakest of the colours under the old rule: low chroma at the bubble's L).
  assert.ok(weakest(start.ring)[1] >= MIN, `the cocoa ring at the start: ${weakest(start.ring)}`);
  const seen = [];
  const lightness = [start.lineageL];
  for (const name of ['green', 'magenta', 'blue', 'stored', 'eightDigit']) {
    await page.evaluate((color) => window.__ring.setConfig(color), CONFIGS[name]);
    await page.evaluate(() => window.__ring.applied());
    await page.waitForTimeout(500);
    await assertChain(page, `after ${name}`, CONFIGS[name]);
    const m = await page.evaluate(measureInPage());
    const [where, ratio] = weakest(m.ring);
    assert.ok(ratio >= MIN, `after the config became ${name}: ${ratio}:1 on ${where}`);
    assert.notEqual(m.outline.colour, start.outline.colour);
    seen.push(m.outline.colour);
    lightness.push(m.lineageL);
  }
  assert.equal(new Set(seen).size, seen.length, 'each colour draws its own ring');
  // The ring is resolved against the human colour that is in the config now, so its lightness follows the config too.
  assert.ok(new Set(lightness).size > 1, `the lightness follows the config: ${JSON.stringify(lightness)}`);
  // The colour removed from the config: the injector takes its variables away, the baked cocoa ring is back, unchanged.
  await page.evaluate(() => window.__ring.setConfig(null));
  await page.evaluate(() => window.__ring.applied());
  await page.waitForTimeout(500);
  await assertChain(page, 'colour removed', null);
  const back = await page.evaluate(measureInPage());
  assert.ok(weakest(back.ring)[1] >= MIN, `the cocoa ring after the colour was removed: ${weakest(back.ring)}`);
  assert.equal(back.outline.colour, start.outline.colour, 'back to the cocoa ring');
  assert.equal(back.lineageL, start.lineageL);
  measurements.push({ case: 'config-change', lightness });
  await context.close();
});

test('the theme changes while the page is open: the lightness is recomputed for the new theme, for the colour in use', async () => {
  const { page, context } = await open({ base: 'light', variant: 'default', color: CONFIGS.green });
  const seen = {};
  for (const [base, variant] of [
    ['light', 'tuned'],
    ['dark', 'default'],
    ['dark', 'tuned'],
    ['light', 'default'],
  ]) {
    await page.evaluate(([b, v]) => window.__ring.applyTheme(b, v), [base, variant]);
    await page.evaluate(() => window.__ring.applied());
    await page.waitForTimeout(500);
    const m = await page.evaluate(measureInPage());
    const [where, ratio] = weakest(m.ring);
    assert.ok(ratio >= MIN, `${base}/${variant} with a green human colour: ${ratio}:1 on ${where}`);
    seen[`${base}/${variant}`] = m.lineageL;
  }
  assert.equal(new Set(Object.values(seen)).size >= 3, true, `the value follows the theme: ${JSON.stringify(seen)}`);
  await context.close();
});

test('the saved theme is not rewritten: the bubble lightness stays as saved; the ring moves only where the saved value does not read on what exists', async () => {
  const { page, context } = await open({ base: 'light' });
  const m = await page.evaluate(measureInPage());
  await context.close();
  assert.equal(m.bubbleL, '0.62', 'the bubble role keeps its saved lightness');
  assert.ok(
    Number(m.lineageL) < 0.62,
    `the Light ring is moved darker, where the saved .62 does not read (${m.lineageL})`,
  );
  assert.ok(weakest(m.ring)[1] >= MIN, `and it reads: ${weakest(m.ring)}`);
  const dark = await open({ base: 'dark' });
  const d = await dark.page.evaluate(measureInPage());
  await dark.context.close();
  assert.equal(d.bubbleL, '0.68', 'the Dark bubble role keeps its saved lightness too');
  // Against the cats and the human that exist, the saved Dark .68 already reads 3:1 on every one of them, so it is drawn as
  // saved. (The old rule floored it to a lighter value because it was checked against a swept range of colours.)
  assert.equal(Number(d.lineageL), 0.68, `the Dark ring is drawn as saved, it already reads (${d.lineageL})`);
  assert.ok(weakest(d.ring)[1] >= MIN, `and it reads: ${weakest(d.ring)}`);
});
