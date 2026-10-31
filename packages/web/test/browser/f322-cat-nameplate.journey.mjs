import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

/**
 * F322 B segment 1 probe — the cat nameplate in a real browser.
 *
 * The REAL ChatMessage / MessageBubble / CatNameplate / CatAvatar, the real CatHueInjector and the real theme CSS
 * builder, on a column the width of the reading column (720) and of the Studio chat bar (400). Every request is answered
 * inside the isolated browser; no dev or runtime service, user account or Redis is used.
 *
 * Set NAMEPLATE_EVIDENCE_DIR to also write the screenshots and the measurement table the PR cites.
 */
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(webRoot, 'test/browser/fixtures');
const origin = 'https://f322-cat-nameplate.test';
const evidenceDir = process.env.NAMEPLATE_EVIDENCE_DIR;
const measurements = [];
let browser, script, css;
const startedIn = process.cwd();

// The family colours as the catalog ships them (cat-template.json), plus one longer name.
const cats = [
  ['opus', '布偶猫', '#9B7EBD', 'ragdoll'],
  ['codex', '缅因猫', '#5B8C5A', 'maine-coon'],
  ['gemini', '暹罗猫', '#5B9BD5', 'siamese'],
  ['glm52', '狸花猫 GLM-5.2 的一个非常非常长的名字用来看窄栏里会不会被截断而不是把时间挤出去', '#D4A76A', 'dragon-li'],
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
        input: path.join(fixtureRoot, 'f322-cat-nameplate.tsx'),
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

async function open({
  shell = 'v2',
  width = 720,
  base = 'light',
  variant = 'default',
  scale = 1,
  saved = null,
  tuner = false,
  deferred = false,
} = {}) {
  const page = await browser.newPage({
    viewport: { width: Math.max(width + 40, 480), height: 1100 },
    deviceScaleFactor: scale,
  });
  page.setDefaultTimeout(5_000);
  const errors = [];
  const unexpected = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  await page.addInitScript((value) => localStorage.setItem('cat-cafe:shell-presentation', value), shell);
  if (deferred) {
    await page.addInitScript(() => {
      window.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
        root = null;
        rootMargin = '0px';
        thresholds = [0];
      };
    });
  }
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
      // A real avatar file when the catalog has one for this cat, otherwise the product's own default avatar.
      const file = path.join(webRoot, 'public', url.pathname);
      const fallback = path.join(webRoot, 'public/avatars/default.png');
      const served = existsSync(file) ? file : fallback;
      return handler.fulfill({ contentType: 'image/png', body: readFileSync(served) });
    }
    if (url.pathname === '/api/session')
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ userId: 'owner-1' }) });
    if (url.pathname === '/api/cats')
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ cats }) });
    // The theme store syncs a saved theme to the server (debounced); the probe only needs it answered.
    if (url.pathname === '/api/config/env') return handler.fulfill({ contentType: 'application/json', body: '{}' });
    // ThemeApplier asks the server for a saved theme when this browser has none; the answer is "nothing saved".
    if (url.pathname === '/api/config/env-summary')
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ variables: [] }) });
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
  await page.goto(`${origin}/?w=${width}${tuner ? '&tuner=1' : ''}${deferred ? '&deferred=1' : ''}`, {
    waitUntil: 'networkidle',
  });
  const waitReady = async () => {
    // The registry arrives after the first render; until then a message has no cat to draw. Wait for it and for the
    // injector's role variables before measuring anything.
    try {
      await page.waitForSelector('[data-message-id="m-opus"] img');
      await page.waitForSelector('#f056-dynamic-cat-tokens', { state: 'attached' });
    } catch (error) {
      const html = await page.evaluate(() =>
        (document.querySelector('[data-message-id="m-opus"]')?.outerHTML ?? 'NO m-opus wrapper').slice(0, 1500),
      );
      throw new Error(
        `${error.message}\nerrors=${JSON.stringify(errors)}\nunexpected=${JSON.stringify(unexpected)}\nhtml=${html}`,
      );
    }
  };
  await waitReady();
  if (saved) {
    // The Tuner's save path (real theme store -> localStorage), then a reload: the store reads it back on boot and the
    // real ThemeApplier applies it. No applyTheme here: that would replace the restored theme.
    await page.evaluate((config) => window.__nameplate.saveCustomTheme(config), saved);
    await page.reload({ waitUntil: 'networkidle' });
    await waitReady();
  } else {
    await page.evaluate(([b, v]) => window.__nameplate.applyTheme(b, v), [base, variant]);
  }
  // The real ThemeApplier has put that theme on the page, resolved against the catalogue that arrived.
  await page.evaluate(() => window.__nameplate.applied());
  // The avatars are real files; wait for them so the shots and the boxes are final.
  await page.evaluate(() =>
    Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null)))),
  );
  return { page, errors, unexpected };
}

/** Everything measured inside the page, so colours are resolved by the browser itself. */
function measureInPage() {
  return (id) => {
    const message = document.querySelector(`[data-message-id="${id}"]`);
    const column = document.querySelector('[data-testid="column"]');
    const plate = message?.querySelector('[data-testid="cat-nameplate"]');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = (color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = color;
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
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
    };
    const bubble = message?.querySelector('[data-testid="message-bubble"]');
    const out = { id, hasPlate: Boolean(plate) };
    if (!message || !bubble) return { ...out, missing: true };
    const bubbleStyle = getComputedStyle(bubble);
    out.bubble = {
      backgroundColor: bubbleStyle.backgroundColor,
      backgroundImage: bubbleStyle.backgroundImage,
      borderTopWidth: bubbleStyle.borderTopWidth,
      paddingLeft: bubbleStyle.paddingLeft,
      paddingTop: bubbleStyle.paddingTop,
      borderTopLeftRadius: bubbleStyle.borderTopLeftRadius,
      overflow: bubbleStyle.overflow,
      transform: bubbleStyle.transform,
      rect: rect(bubble),
    };
    out.message = rect(message);
    out.column = rect(column);
    out.scrollOverflowX = message.scrollWidth > message.clientWidth + 1;
    // Anything that is painted past the column's content box and is not inside something that scrolls or clips it.
    const columnStyle = getComputedStyle(column);
    const contentRight = column.getBoundingClientRect().right - parseFloat(columnStyle.paddingRight);
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
      if (!clipped)
        out.escapes.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(box.right)} limit=${Math.round(contentRight)}`,
        );
    }
    if (!plate) return out;
    const name = plate.querySelector('[data-testid="cat-nameplate-name"]');
    const avatar = plate.querySelector('img');
    const time = message.querySelector('[data-testid="cat-nameplate-time"]');
    const plateStyle = getComputedStyle(plate);
    const nameStyle = getComputedStyle(name);
    out.plate = {
      rect: rect(plate),
      paddingLeft: plateStyle.paddingLeft,
      paddingRight: plateStyle.paddingRight,
      borderTopLeftRadius: plateStyle.borderTopLeftRadius,
      borderBottomLeftRadius: plateStyle.borderBottomLeftRadius,
      backgroundImage: plateStyle.backgroundImage,
    };
    out.avatar = avatar ? rect(avatar) : null;
    // the face's own circle carries no cat-coloured ring; the work-surface ring is on the wrapper that places the face
    out.avatarShadow = avatar ? getComputedStyle(avatar.parentElement).boxShadow : null;
    const face = plate.querySelector('[data-testid="cat-nameplate-avatar"]');
    out.face = face ? { rect: rect(face), ring: getComputedStyle(face).boxShadow } : null;
    // Is the top of the face (3px below its top edge, on its vertical axis) really painted, not cut off by an ancestor?
    if (face) {
      const fr = face.getBoundingClientRect();
      const hit = document.elementFromPoint(fr.x + fr.width / 2, fr.y + 3);
      out.faceTopPainted = hit === null ? null : face.contains(hit);
    }
    out.workColor = getComputedStyle(column).backgroundColor;
    out.name = {
      text: name.textContent,
      fontSize: nameStyle.fontSize,
      fontWeight: nameStyle.fontWeight,
      opacity: nameStyle.opacity,
      truncated: name.scrollWidth > name.clientWidth + 1,
      rect: rect(name),
    };
    out.time = time ? { rect: rect(time), fontSize: getComputedStyle(time).fontSize, text: time.textContent } : null;
    // The first line of the body text, and the first thing under the plate.
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode && !textNode.textContent.trim()) textNode = walker.nextNode();
    if (textNode) {
      const range = document.createRange();
      range.selectNodeContents(textNode);
      out.bodyFirstLine = rect(range);
    }

    // Name legibility: the name colour against what is really behind its glyph box. Behind it are the plate's
    // gradient (cat surface fading to transparent, top to bottom) and, through the transparent end, the work surface.
    const probe = document.createElement('div');
    const slug = plate.getAttribute('data-cat-id');
    probe.style.backgroundColor = `var(--color-${slug}-surface)`;
    column.appendChild(probe);
    const surface = rgba(getComputedStyle(probe).backgroundColor);
    probe.remove();
    const work = rgba(getComputedStyle(column).backgroundColor);
    const fg = rgba(nameStyle.color);
    const textRange = document.createRange();
    textRange.selectNodeContents(name);
    const glyphs = textRange.getBoundingClientRect();
    const plateRect = plate.getBoundingClientRect();
    const t0 = Math.max(0, Math.min(1, (glyphs.top - plateRect.top) / plateRect.height));
    const t1 = Math.max(0, Math.min(1, (glyphs.bottom - plateRect.top) / plateRect.height));
    let min = Infinity;
    let at = 0;
    for (let i = 0; i <= 20; i++) {
      const t = t0 + ((t1 - t0) * i) / 20;
      const bg = [0, 1, 2].map((k) => surface[k] * (1 - t) + work[k] * t);
      const ratio = contrast(fg, bg);
      if (ratio < min) {
        min = ratio;
        at = t;
      }
    }
    out.contrast = {
      min: Number(min.toFixed(2)),
      worstAt: Number(at.toFixed(2)),
      t0: Number(t0.toFixed(2)),
      t1: Number(t1.toFixed(2)),
      fg,
      surface,
      work,
    };
    return out;
  };
}

async function measure(page, id) {
  return page.evaluate(measureInPage(), id);
}

test('v2: the cat is a 26px nameplate over unframed text, aligned with the avatar', async () => {
  const { page, errors, unexpected } = await open({ shell: 'v2', width: 720 });
  const m = await measure(page, 'm-opus');

  assert.equal(m.hasPlate, true);
  assert.equal(m.plate.rect.h, 26, 'plate height');
  assert.equal(m.plate.paddingLeft, '40px', '40px on the left for the 32px face');
  assert.equal(m.plate.paddingRight, '10px');
  assert.equal(m.plate.borderTopLeftRadius, '8px');
  assert.equal(m.plate.borderBottomLeftRadius, '0px', 'only the top corners are rounded');
  assert.match(m.plate.backgroundImage, /linear-gradient\(/);
  assert.equal(m.avatar.w, 32);
  assert.equal(m.avatar.h, 32);
  assert.equal(m.avatarShadow, 'none', 'no cat-coloured ring around the face: the plate is already the cat colour');
  // The face is laid over the plate's left end: its bottom edge 2px below the plate's, so its top is 4px above the plate's,
  // and it starts at the plate's left edge; the name starts 40px in.
  assert.equal(Math.round(m.avatar.b - m.plate.rect.b), 2, 'the face reaches 2px below the plate');
  assert.equal(Math.round(m.plate.rect.y - m.avatar.y), 4, 'and rises 4px above it');
  assert.equal(Math.round(m.avatar.x), Math.round(m.plate.rect.x), 'at the plate left edge');
  assert.equal(Math.round(m.name.rect.x - m.plate.rect.x), 40, 'the name starts after the 40px the plate leaves');
  // A 2px ring in the work-surface colour separates the face from the plate.
  assert.match(m.face.ring, /0px 0px 0px 2px$/, 'a 2px ring');
  assert.ok(
    m.face.ring.startsWith(m.workColor),
    `the ring is the work-surface colour (${m.face.ring} vs ${m.workColor})`,
  );
  // The row is wrapped in the production row boundary (content-visibility:auto = paint containment), as in the real list: the
  // top 4px of the face (and the ring above them) hang outside the plate, and must still be painted.
  assert.equal(m.faceTopPainted, true, 'the top of the face is painted, not cut off by the row boundary');
  assert.equal(m.name.fontSize, '13px');
  assert.equal(m.name.fontWeight, '600');
  assert.equal(m.name.opacity, '1', 'no opacity that would cost contrast');
  assert.equal(m.time.fontSize, '12px');
  assert.ok(m.time.rect.x >= m.plate.rect.r, 'time sits to the right of the plate');

  // No bubble: no fill, border, frame padding, radius, clipping or hover lift.
  assert.equal(m.bubble.backgroundColor, 'rgba(0, 0, 0, 0)');
  assert.equal(m.bubble.backgroundImage, 'none');
  assert.equal(m.bubble.borderTopWidth, '0px');
  assert.equal(m.bubble.paddingTop, '0px');
  assert.equal(m.bubble.borderTopLeftRadius, '0px');
  assert.equal(m.bubble.overflow, 'visible');
  assert.equal(m.bubble.transform, 'none');

  // The reading text keeps the 8px inset it always had from the plate's left edge (the face grew from 16 to 32px and now sits
  // at that edge, as in the approved draft); the plate itself starts at the column's text edge.
  assert.equal(Math.round(m.bodyFirstLine.x - m.plate.rect.x), 8, 'the text keeps its 8px inset from the plate edge');
  assert.equal(Math.round(m.plate.rect.x), Math.round(m.message.x), 'plate starts at the message edge');
  for (const id of ['m-opus', 'm-codex', 'm-gemini', 'm-streaming']) {
    assert.deepEqual(
      (await measure(page, id)).escapes.slice(0, 3),
      [],
      `${id}: nothing is painted past the column's content edge`,
    );
  }
  // Only the plate's face: there is no avatar column beside the text.
  assert.equal(await page.locator('[data-message-id="m-opus"] img').count(), 1);

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await page.close();
});

test('v2: deferred placeholders keep their 240px flow while the face may paint 6px outside the row', async () => {
  const { page, errors, unexpected } = await open({ shell: 'v2', width: 720, deferred: true });
  const geometry = await page.locator('[data-testid="deferred-placeholder-stack"]').evaluate((stack) => {
    const rows = [...stack.querySelectorAll('[data-message-viewport-boundary]')];
    const first = rows[0].getBoundingClientRect();
    const second = rows[1].getBoundingClientRect();
    const style = getComputedStyle(rows[0]);
    return {
      mountedChildren: rows.map((row) => row.childElementCount),
      flowPerRow: second.top - first.top,
      stackHeight: stack.getBoundingClientRect().height,
      overflowClipMargin: style.overflowClipMargin,
      paddingTop: style.paddingTop,
      marginTop: style.marginTop,
    };
  });
  assert.deepEqual(geometry.mountedChildren, [0, 0], 'the probe measures real deferred placeholders');
  assert.equal(geometry.flowPerRow, 240, 'each placeholder keeps the navigation owner’s 240px estimate');
  assert.equal(geometry.stackHeight, 480, 'placeholder estimates compose without cumulative scroll-height loss');
  assert.equal(geometry.overflowClipMargin, '6px', 'paint containment alone makes room for the face and its ring');
  assert.equal(geometry.paddingTop, '0px');
  assert.equal(geometry.marginTop, '0px');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await page.close();
});

test('classic: the old bubble is exactly what it was', async () => {
  const { page, errors } = await open({ shell: 'classic', width: 720 });
  const m = await measure(page, 'm-opus');

  assert.equal(m.hasPlate, false);
  assert.notEqual(m.bubble.backgroundColor, 'rgba(0, 0, 0, 0)', 'the bubble keeps its cat surface fill');
  assert.equal(m.bubble.paddingLeft, '16px');
  assert.equal(await page.locator('[data-message-id="m-opus"] img').count(), 1, 'one avatar, in its own column');
  assert.equal((await page.locator('[data-message-id="m-opus"] img').first().boundingBox()).width, 32);
  if (evidenceDir)
    await page.locator('[data-testid="column"]').screenshot({ path: path.join(evidenceDir, 'classic-light-720.png') });
  assert.deepEqual(errors, []);
  await page.close();
});

for (const [base, variant] of [
  ['light', 'default'],
  ['dark', 'default'],
  ['light', 'tuned'],
  ['dark', 'tuned'],
]) {
  test(`name legibility ≥ 4.5:1 on what is really behind it — ${base} / ${variant}`, async () => {
    const { page } = await open({ shell: 'v2', width: 720, base, variant });
    for (const id of ['m-opus', 'm-codex', 'm-gemini', 'm-streaming']) {
      const m = await measure(page, id);
      measurements.push({ theme: `${base}/${variant}`, message: id, name: m.name.text, contrast: m.contrast });
      assert.ok(
        m.contrast.min >= 4.5,
        `${base}/${variant} ${id}: name contrast ${m.contrast.min} < 4.5 (worst at t=${m.contrast.worstAt})`,
      );
    }
    if (evidenceDir)
      await page
        .locator('[data-testid="column"]')
        .screenshot({ path: path.join(evidenceDir, `v2-${base}-${variant}-720.png`) });
    await page.close();
  });
}

test('the Studio chat bar (400px): nothing leaves the column, a long name truncates, code stays inside', async () => {
  const { page, errors } = await open({ shell: 'v2', width: 400 });
  for (const id of ['m-opus', 'm-codex', 'm-gemini', 'm-streaming']) {
    const m = await measure(page, id);
    assert.ok(m.message.r <= m.column.r + 0.5, `${id} stays inside the column`);
    assert.equal(m.scrollOverflowX, false, `${id} has no horizontal overflow`);
    assert.deepEqual(m.escapes.slice(0, 3), [], `${id}: nothing is painted past the column's content edge`);
    assert.ok(m.plate.rect.r <= m.column.r, `${id} plate stays inside the column`);
  }
  const long = await measure(page, 'm-streaming');
  assert.equal(long.name.truncated, true, 'the long name truncates instead of pushing the time out');
  assert.ok(long.time.rect.r <= long.column.r, 'the time stays inside the column');
  assert.equal(long.plate.rect.h, 26);
  if (evidenceDir)
    await page
      .locator('[data-testid="column"]')
      .screenshot({ path: path.join(evidenceDir, 'v2-light-default-400.png') });
  assert.deepEqual(errors, []);
  await page.close();
});

test('a clickable avatar shows the accent ring on hover, also while it is streaming and glowing', async () => {
  const { page } = await open({ shell: 'v2', width: 720 });
  // The computed box-shadow, not the class: an inline glow can replace the whole stack and a class assertion would not see it.
  const shadowBeforeAndAfterHover = async (id) => {
    const face = page.locator(`[data-message-id="${id}"] [data-testid="cat-nameplate"] button`);
    const before = await face.evaluate((el) => getComputedStyle(el).boxShadow);
    await face.hover();
    await page.waitForTimeout(500); // the ring and the shadow transition for 300ms
    const after = await face.evaluate((el) => getComputedStyle(el).boxShadow);
    await page.mouse.move(0, 0);
    return { before, after };
  };
  const ring = /0px 0px 0px 2px/;

  const idle = await shadowBeforeAndAfterHover('m-opus');
  assert.equal(idle.before, 'none', 'no ring and no glow at rest');
  assert.match(idle.after, ring, 'the accent ring appears on hover');

  const streaming = await shadowBeforeAndAfterHover('m-streaming');
  assert.match(streaming.before, /10px/, 'the streaming glow is there at rest');
  assert.doesNotMatch(streaming.before, ring, 'and no ring at rest');
  assert.match(streaming.after, ring, 'the accent ring still appears on hover while streaming');
  assert.match(streaming.after, /10px/, 'and the glow stays with it');
  await page.close();
});

test('the human message and the streaming state are unchanged by the plate', async () => {
  const { page } = await open({ shell: 'v2', width: 720 });
  const user = await measure(page, 'm-user');
  assert.equal(user.hasPlate, false, 'the co-creator message has no cat plate');
  // The cat that is still speaking keeps the streaming ring on its (32px) face.
  const pulse = await page
    .locator('[data-message-id="m-streaming"] [data-testid="cat-nameplate"] .animate-pulse')
    .count();
  assert.ok(pulse >= 1, 'streaming state is on the plate avatar');
  await page.close();
});

// The design owner's rule: with no ring, an avatar that blends into its plate in dark gets a 1px line. "Blends" is a
// judgement made by looking, so the probe captures the dark plates at 4x for the evidence folder and for a human to look at.
for (const variant of ['default', 'tuned']) {
  test(`evidence: the dark plates at 4x (${variant}), where a blending avatar would show`, async () => {
    const { page } = await open({ shell: 'v2', width: 720, base: 'dark', variant, scale: 4 });
    const clip = await page.evaluate(() => {
      const plates = ['m-opus', 'm-codex', 'm-gemini', 'm-streaming'].map((id) =>
        document.querySelector(`[data-message-id="${id}"] [data-testid="cat-nameplate"]`).getBoundingClientRect(),
      );
      const x = Math.min(...plates.map((r) => r.x)) - 4;
      const y = plates[0].y - 4;
      return { x, y, width: 230, height: plates[3].bottom + 4 - y };
    });
    const png = await page.screenshot({ clip, scale: 'device' });
    assert.ok(png.length > 10_000, 'a real capture was taken');
    if (evidenceDir) writeFileSync(path.join(evidenceDir, `v2-dark-${variant}-avatars-4x.png`), png);
    await page.close();
  });
}

// Independent Alpha acceptance of #4978 (2026-10-01) found a theme the Tuner allows and saves in which the names all but
// vanish: custom theme, Light surface step L .78 / Cmul .99, cat-name role H 144 / L .78 / C .025 (the name sits at the
// plate's own lightness). The role is the user's own choice and the saved value must not be rewritten, so the plate has to
// stay readable with the saved value intact.
const SAVED_NEAR_TONE = { base: 'light', surfaceL: 0.78, surfaceCmul: 0.99, nameH: 144, nameL: 0.78, nameC: 0.025 };

test('a saved custom theme with the name role at the plate lightness: restored intact, names still ≥ 4.5:1', async () => {
  const { page } = await open({ shell: 'v2', width: 720, saved: SAVED_NEAR_TONE });

  // NAMEPLATE_EVIDENCE_TAG lets the same capture be taken with and without the fix ("-before").
  if (evidenceDir)
    await page.locator('[data-testid="column"]').screenshot({
      path: path.join(evidenceDir, `v2-light-saved-near-tone-720${process.env.NAMEPLATE_EVIDENCE_TAG ?? ''}.png`),
    });
  // It is the saved theme that is on screen, restored by the real store: the Tuner's values are in storage untouched, and
  // the page keeps the user's hue, chroma and plate; only the drawn lightness of the name moves.
  const restored = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const stored = JSON.parse(localStorage.getItem('cat-cafe:themes') ?? '{}');
    const custom = (stored.custom ?? [])[0];
    return {
      nameL: Number(root.getPropertyValue('--cat-name-l')),
      nameC: root.getPropertyValue('--cat-name-c').trim(),
      nameH: root.getPropertyValue('--cat-name-h').trim(),
      surfaceL: root.getPropertyValue('--cat-surface-l').trim(),
      surfaceCmul: root.getPropertyValue('--cat-surface-cmul').trim(),
      saved: {
        nameL: custom?.params?.catTextLightL,
        nameC: custom?.params?.catTextC,
        nameH: custom?.params?.catTextH,
        surfaceL: custom?.params?.light?.surface?.L,
        surfaceCmul: custom?.params?.light?.surface?.Cmul,
      },
      activeId: stored.activeId,
    };
  });
  assert.match(restored.activeId, /^custom-/, 'the custom theme is the active one');
  assert.deepEqual(
    restored.saved,
    { nameL: 0.78, nameC: 0.025, nameH: 144, surfaceL: 0.78, surfaceCmul: 0.99 },
    'what the user saved is untouched in storage',
  );
  assert.equal(restored.nameH, '144', "the user's hue is what the page uses");
  assert.equal(restored.nameC, '0.025', "the user's chroma is what the page uses");
  assert.equal(restored.surfaceL, '0.78', "the user's plate is untouched");
  assert.equal(restored.surfaceCmul, '0.99');
  assert.ok(
    restored.nameL > 0 && restored.nameL < 0.78,
    `the drawn name lightness moved from the saved .78 (got ${restored.nameL})`,
  );

  const seen = {};
  for (const id of ['m-opus', 'm-codex', 'm-gemini', 'm-streaming']) {
    const m = await measure(page, id);
    seen[id] = m.contrast.min;
    measurements.push({
      theme: 'custom/near-tone (saved, restored)',
      message: id,
      name: m.name.text,
      contrast: m.contrast,
    });
  }
  assert.ok(
    Object.values(seen).every((ratio) => ratio >= 4.5),
    `name contrast per cat (need >= 4.5): ${JSON.stringify(seen)}`,
  );
  await page.close();
});

// A saved name that already meets the criterion is drawn exactly as saved (DESIGN.md), even when it is under the headroom
// the search aims for. Sol6.1's counterexample for #4985: plate step L .85 / Cmul 0, name H 0 / C 0 / L .39.
const SAVED_ALREADY_READS = { base: 'light', surfaceL: 0.85, surfaceCmul: 0, nameH: 0, nameL: 0.39, nameC: 0 };

test('a saved name that already reads is drawn as saved, on the nameplate and in the classic header', async () => {
  const v2 = await open({ shell: 'v2', width: 720, saved: SAVED_ALREADY_READS });
  const drawn = await v2.page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--cat-name-l').trim(),
  );
  assert.equal(drawn, '0.39', 'what the page draws is what was saved');
  for (const id of ['m-opus', 'm-codex', 'm-gemini', 'm-streaming']) {
    const m = await measure(v2.page, id);
    measurements.push({
      theme: 'custom/already-reads (saved, restored)',
      message: id,
      name: m.name.text,
      contrast: m.contrast,
    });
    assert.ok(m.contrast.min >= 4.5, `already-reads ${id}: ${m.contrast.min} < 4.5`);
  }
  await v2.page.close();

  const classic = await open({ shell: 'classic', width: 720, saved: SAVED_ALREADY_READS });
  assert.equal(
    await classic.page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--cat-name-l').trim(),
    ),
    '0.39',
  );
  for (const id of ['m-opus', 'm-codex', 'm-gemini']) {
    const m = await classic.page.evaluate(measureClassicNameInPage(), id);
    measurements.push({ theme: 'classic custom/already-reads (saved)', message: id, name: m.text, classicHeader: m });
    assert.ok(m.ratio >= 4.5, `classic already-reads ${id}: ${m.ratio} < 4.5`);
  }
  await classic.page.close();
});

// The same promise across the range, not just at the one repro: whatever lightness the name role is saved at, in a light or
// a dark custom theme whose plate step leaves some lightness readable, the drawn names measure >= 4.5:1 on the real plates.
for (const config of [
  { base: 'light', surfaceL: 0.7, surfaceCmul: 0.99, nameL: 0.5 },
  { base: 'light', surfaceL: 0.9, surfaceCmul: 0.6, nameL: 1 },
  { base: 'light', surfaceL: 0.78, surfaceCmul: 0.99, nameL: 0 },
  { base: 'dark', surfaceL: 0.3, surfaceCmul: 0.99, nameL: 0.3 },
  { base: 'dark', surfaceL: 0.4, surfaceCmul: 0.6, nameL: 0.5 },
  { base: 'dark', surfaceL: 0.3, surfaceCmul: 0.25, nameL: 0 },
]) {
  test(`saved ${config.base} custom theme, plate L ${config.surfaceL} / Cmul ${config.surfaceCmul}, name L ${config.nameL}: names read`, async () => {
    const { page } = await open({
      shell: 'v2',
      width: 720,
      saved: { ...config, nameH: 144, nameC: 0.025 },
    });
    const seen = {};
    for (const id of ['m-opus', 'm-codex', 'm-gemini', 'm-streaming']) {
      const m = await measure(page, id);
      seen[id] = m.contrast.min;
      measurements.push({
        theme: `custom/${config.base} plate ${config.surfaceL}/${config.surfaceCmul} name ${config.nameL} (saved, restored)`,
        message: id,
        name: m.name.text,
        contrast: m.contrast,
      });
    }
    assert.ok(
      Object.values(seen).every((ratio) => ratio >= 4.5),
      `name contrast per cat: ${JSON.stringify(seen)}`,
    );
    await page.close();
  });
}

/** What the page drew for the cat-name role, the plate step and the ring, next to what the Tuner saved (read back from storage). */
async function readThemeState(page, base) {
  return page.evaluate((b) => {
    const root = getComputedStyle(document.documentElement);
    const number = (name) => Number(root.getPropertyValue(name));
    const stored = JSON.parse(localStorage.getItem('cat-cafe:themes') ?? '{}');
    const params = (stored.custom ?? [])[0]?.params;
    return {
      nameL: number('--cat-name-l'),
      nameC: root.getPropertyValue('--cat-name-c').trim(),
      nameH: root.getPropertyValue('--cat-name-h').trim(),
      plateL: number('--cat-surface-l'),
      plateCmul: number('--cat-surface-cmul'),
      ringL: number('--cat-lineage-l'),
      saved: {
        surface: params?.[b]?.surface,
        nameL: b === 'light' ? params?.catTextLightL : params?.catTextDarkL,
        nameC: params?.catTextC,
        nameH: params?.catTextH,
      },
    };
  }, base);
}

// Opus 5.5 (3327/3619): when no lightness of the name reads against both the plates and the pages, the PLATE gives way and
// the name does not. Which plate steps that happens at depends on the colours that really exist: with this catalogue a Light
// step of .5 leaves a dark name losing to the plates and a light name losing to the page (the plate is drawn lighter, .62), and
// in Dark the first step that does is above .5 (a Dark .6 is drawn at .5). Where the name alone can fix it, the name moves and
// the plate stays (Dark .5 with a saved .88 name). Either way what is stored is untouched and the names read.
for (const config of [
  { base: 'light', surfaceL: 0.5, nameL: 0.15, plate: 'lighter', nameStays: true },
  { base: 'dark', surfaceL: 0.6, nameL: 0.96, plate: 'darker', nameStays: true },
  { base: 'dark', surfaceL: 0.5, nameL: 0.88, plate: 'stays', nameStays: false },
]) {
  test(`saved ${config.base} plate L ${config.surfaceL} / Cmul .99, name L ${config.nameL}: plate ${config.plate}, name ${config.nameStays ? 'stays' : 'moves'}, names read, storage is untouched`, async () => {
    const saved = { ...config, surfaceCmul: 0.99, nameH: 144, nameC: 0.025 };
    const { page } = await open({ shell: 'v2', width: 720, saved });
    const state = await readThemeState(page, config.base);
    assert.deepEqual(
      state.saved,
      { surface: { L: config.surfaceL, Cmul: 0.99 }, nameL: config.nameL, nameC: 0.025, nameH: 144 },
      'what the user saved is untouched in storage',
    );
    assert.equal(state.plateCmul, 0.99, "the plate's chroma is the user's");
    assert.equal(state.nameC, '0.025', "the name's chroma is the user's");
    assert.equal(state.nameH, '144', "the name's hue is the user's");
    if (config.nameStays) assert.equal(state.nameL, config.nameL, 'the name stays where it was saved');
    else assert.ok(state.nameL > config.nameL, `the name goes to the nearest value that reads (got ${state.nameL})`);
    if (config.plate === 'lighter')
      assert.ok(state.plateL > config.surfaceL, `the plate is drawn lighter than saved (got ${state.plateL})`);
    else if (config.plate === 'darker')
      assert.ok(state.plateL < config.surfaceL, `the plate is drawn darker than saved (got ${state.plateL})`);
    else assert.equal(state.plateL, config.surfaceL, 'the plate is drawn as saved');

    const seen = {};
    for (const id of ['m-opus', 'm-codex', 'm-gemini', 'm-streaming']) {
      const m = await measure(page, id);
      seen[id] = m.contrast.min;
      measurements.push({
        theme: `custom/${config.base} plate ${config.surfaceL}/.99 name ${config.nameL} (saved, restored)`,
        message: id,
        name: m.name.text,
        plateDrawnL: state.plateL,
        nameDrawnL: state.nameL,
        contrast: m.contrast,
      });
    }
    assert.ok(
      Object.values(seen).every((ratio) => ratio >= 4.5),
      `name contrast per cat (need >= 4.5): ${JSON.stringify(seen)}`,
    );
    if (evidenceDir)
      await page.locator('[data-testid="column"]').screenshot({
        path: path.join(
          evidenceDir,
          `v2-${config.base}-plate-${config.surfaceL}-720${process.env.NAMEPLATE_EVIDENCE_TAG ?? ''}.png`,
        ),
      });
    await page.close();
  });
}

// (b) The colours the plate and the ring are resolved against are the ones that really exist, and they are resolved again when
// they change: publishing a different human colour through the real co-creator cache (the seam the Hub editor writes) changes
// what the ring is drawn at, with no reload and no Tuner involved.
test('the ring follows the configured human colour: a new config resolves the theme again', async () => {
  const { page } = await open({ shell: 'v2', width: 720, base: 'light' });
  const ringFor = async (color) => {
    await page.evaluate((c) => window.__nameplate.setConfig(c), color);
    // The injector has written (or removed) the colour; give the theme two frames to be resolved against it.
    await page.waitForFunction((c) => Boolean(document.getElementById('f322-cocreator-roles')) === Boolean(c), color);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return (await readThemeState(page, 'light')).ringL;
  };
  const cocoa = await ringFor(null);
  const yellow = await ringFor({ primary: '#F2C500', secondary: '#eeeeee' });
  const blue = await ringFor({ primary: '#1F4FD8', secondary: '#eeeeee' });
  measurements.push({ theme: 'ring follows config (light/default)', cocoa, yellow, blue });
  assert.ok(
    new Set([cocoa, yellow, blue]).size > 1,
    `a different human colour is a different ring: cocoa ${cocoa}, yellow ${yellow}, blue ${blue}`,
  );
  await page.close();
});

// The Tuner says what is drawn (Opus 5.5 3619): nothing when the saved name is what is drawn; "显示时已调到可读" with the saved
// and the drawn values side by side when the drawn lightness moved; "这组颜色下名字读不清（最高 x:1）" when nothing in the theme
// reads, never counted as a pass. The numbers in the hint must be the ones the page draws, so they are read back from the page.
async function readHint(page) {
  return page.evaluate(() => {
    const hint = document.querySelector('[data-testid="tuner-name-hint"]');
    const root = getComputedStyle(document.documentElement);
    const text = (id) => hint?.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
    return {
      present: Boolean(hint),
      state: hint?.getAttribute('data-state') ?? null,
      title: text('tuner-name-hint-title'),
      name: text('tuner-name-hint-name'),
      plate: text('tuner-name-hint-plate'),
      text: hint?.textContent ?? null,
      drawnNameL: Number(root.getPropertyValue('--cat-name-l')),
      drawnPlateL: Number(root.getPropertyValue('--cat-surface-l')),
    };
  });
}
const numberAfter = (text, label) => Number(new RegExp(`${label} L (\\d\\.\\d+)`).exec(text ?? '')?.[1]);

test('the Tuner: a default theme has nothing to say about the cat name', async () => {
  const { page } = await open({ shell: 'v2', width: 720, base: 'light', tuner: true });
  await page.waitForSelector('[data-testid="tuner-cat-name"]');
  const hint = await readHint(page);
  assert.equal(hint.present, false, `no hint when the saved name is what is drawn (got ${JSON.stringify(hint)})`);
  await page.close();
});

test('the Tuner: a saved name that does not read says it was adjusted, saved and drawn side by side, and the page draws what it says', async () => {
  const { page } = await open({ shell: 'v2', width: 720, saved: SAVED_NEAR_TONE, tuner: true });
  await page.waitForSelector('[data-testid="tuner-cat-name"]');
  const hint = await readHint(page);
  assert.equal(hint.state, 'adjusted');
  assert.equal(hint.title, '显示时已调到可读');
  assert.equal(numberAfter(hint.name, '你存的'), 0.78, 'the saved value is shown as saved');
  const shown = numberAfter(hint.name, '实际显示');
  assert.ok(shown > 0 && shown < 0.78, `the drawn name is moved (${shown})`);
  assert.ok(Math.abs(shown - hint.drawnNameL) < 0.0006, `the hint says ${shown}, the page draws ${hint.drawnNameL}`);
  assert.ok(hint.text.includes('已存的值没有改'), 'and it says nothing stored was changed');
  assert.ok(!/读不清/.test(hint.text), 'it is not the "does not read" state');
  measurements.push({ theme: 'tuner/near-tone', hint });
  await page.close();
});

test('the Tuner: when the plate gives way, the plate line shows the saved and the drawn plate lightness the page draws', async () => {
  const saved = { base: 'light', surfaceL: 0.5, surfaceCmul: 0.99, nameL: 0.15, nameH: 144, nameC: 0.025 };
  const { page } = await open({ shell: 'v2', width: 720, saved, tuner: true });
  await page.waitForSelector('[data-testid="tuner-cat-name"]');
  const hint = await readHint(page);
  assert.equal(hint.state, 'adjusted');
  assert.equal(hint.name, null, 'the name did not move, so there is no name line');
  assert.equal(numberAfter(hint.plate, '你存的'), 0.5);
  const shown = numberAfter(hint.plate, '实际显示');
  assert.ok(shown > 0.5, `the drawn plate is lighter than saved (${shown})`);
  assert.ok(Math.abs(shown - hint.drawnPlateL) < 0.0006, `the hint says ${shown}, the page draws ${hint.drawnPlateL}`);
  measurements.push({ theme: 'tuner/plate-yields', hint });
  await page.close();
});

test('the Tuner: a page base on which no name can read says so, with the best figure, and does not call it a pass', async () => {
  // Page layers on both ends of the lightness scale: a near-black sunken layer under near-white ones. No single name colour
  // reaches 4.5:1 on both; the best case is drawn and the Tuner says it is not reached.
  const saved = {
    base: 'light',
    surfaceL: 0.85,
    surfaceCmul: 0.45,
    nameL: 0.3,
    nameH: 144,
    nameC: 0.025,
    elev: { sunken: 0.1, base: 0.95, elevated: 0.95, canvas: 0.95 },
  };
  const { page } = await open({ shell: 'v2', width: 720, saved, tuner: true });
  await page.waitForSelector('[data-testid="tuner-cat-name"]');
  const hint = await readHint(page);
  assert.equal(hint.state, 'unreadable', JSON.stringify(hint));
  const best = Number(/最高 (\d+\.\d+):1/.exec(hint.title ?? '')?.[1]);
  assert.ok(best > 1 && best < 4.5, `the figure is a number short of 4.5 (got ${best} from "${hint.title}")`);
  assert.ok(hint.text.includes('没有达到 4.5:1'));
  assert.ok(!hint.text.includes('显示时已调到可读'), 'and it is not dressed up as adjusted');
  // The name moved (saved .3): the not-reached state still shows it, saved and drawn side by side (codex-sol #5086 P2).
  assert.equal(numberAfter(hint.name, '你存的'), 0.3, 'the name line shows the saved value');
  const bestL = numberAfter(hint.name, '实际显示');
  assert.ok(Math.abs(bestL - hint.drawnNameL) < 0.0006, `the hint says ${bestL}, the page draws ${hint.drawnNameL}`);
  measurements.push({ theme: 'tuner/dead-zone page base', hint });
  await page.close();
});

test('the Tuner: every field the page moved is shown with the number the page draws (a saturated plate step and a saturated name: the plate runs a long way)', async () => {
  // A saturated plate step (Cmul 2, L .1) and a saturated name: the plate has to run a long way. With this catalogue it does
  // read (the plate goes to .805); whichever state it lands in, every field the page really moved appears in the hint with the
  // number the page draws. A not-reached state with a moved plate needs colours more extreme than any this catalogue has; that
  // one is pinned in the resolver's unit tests with the six edge colours a hex can have.
  const saved = { base: 'light', surfaceL: 0.1, surfaceCmul: 2, nameL: 0.05, nameH: 144, nameC: 0.3 };
  const { page } = await open({ shell: 'v2', width: 720, saved, tuner: true });
  await page.waitForSelector('[data-testid="tuner-cat-name"]');
  const hint = await readHint(page);
  measurements.push({ theme: 'tuner/saturated plate and name', hint });
  assert.ok(['adjusted', 'unreadable'].includes(hint.state), `something moved on this theme (${JSON.stringify(hint)})`);
  // The plate: shown iff the page draws it somewhere else than saved, and with the number it draws.
  assert.equal(
    hint.plate !== null,
    hint.drawnPlateL !== saved.surfaceL,
    `plate line iff the plate moved: ${JSON.stringify(hint)}`,
  );
  if (hint.plate !== null) {
    assert.equal(numberAfter(hint.plate, '你存的'), saved.surfaceL);
    assert.ok(
      Math.abs(numberAfter(hint.plate, '实际显示') - hint.drawnPlateL) < 0.0006,
      'the plate line is what the page draws',
    );
  }
  // The name: the same.
  assert.equal(
    hint.name !== null,
    hint.drawnNameL !== saved.nameL,
    `name line iff the name moved: ${JSON.stringify(hint)}`,
  );
  if (hint.name !== null)
    assert.ok(
      Math.abs(numberAfter(hint.name, '实际显示') - hint.drawnNameL) < 0.0006,
      'the name line is what the page draws',
    );
  // The state and the number never contradict: "not reached" always carries a figure under the criterion.
  if (hint.state === 'unreadable') {
    const figure = Number(/最高 (\d+\.\d+):1/.exec(hint.title ?? '')?.[1]);
    assert.ok(figure < 4.5, `not reached with a figure under 4.5 (got ${figure} from "${hint.title}")`);
  }
  await page.close();
});

/** The classic header name as drawn: its colour at its own opacity, over the page behind it (`body` = --bg-app). */
function measureClassicNameInPage() {
  return (id) => {
    const message = document.querySelector(`[data-message-id="${id}"]`);
    const name = message?.querySelector('span.font-semibold');
    if (!name) return { missing: true };
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = (color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = color;
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
    const style = getComputedStyle(name);
    const fg = rgba(style.color);
    // What really sits behind the name: the nearest ancestor with a painted background, as the page paints it.
    const backdrop = () => {
      for (let up = name.parentElement; up; up = up.parentElement) {
        const color = rgba(getComputedStyle(up).backgroundColor);
        if (color[3] > 0.99) return color;
      }
      return rgba('#fff');
    };
    const bg = backdrop();
    const opacity = Number(style.opacity);
    const drawn = [0, 1, 2].map((k) => fg[k] * opacity + bg[k] * (1 - opacity));
    const [hi, lo] = [lum(drawn), lum(bg)].sort((x, y) => y - x);
    return { text: name.textContent, opacity, ratio: Number(((hi + 0.05) / (lo + 0.05)).toFixed(2)) };
  };
}

const CLASSIC_CELLS = [
  ['light/default', { base: 'light', variant: 'default' }],
  ['dark/default', { base: 'dark', variant: 'default' }],
  ['custom/light near-tone (saved)', { saved: SAVED_NEAR_TONE }],
  ...[
    { base: 'light', surfaceL: 0.7, surfaceCmul: 0.99, nameL: 0.5 },
    { base: 'light', surfaceL: 0.9, surfaceCmul: 0.6, nameL: 1 },
    { base: 'dark', surfaceL: 0.3, surfaceCmul: 0.99, nameL: 0.3 },
    { base: 'dark', surfaceL: 0.4, surfaceCmul: 0.6, nameL: 0.5 },
    { base: 'dark', surfaceL: 0.3, surfaceCmul: 0.25, nameL: 0 },
  ].map((config) => [
    `custom/${config.base} plate ${config.surfaceL}/${config.surfaceCmul} name ${config.nameL} (saved)`,
    { saved: { ...config, nameH: 144, nameC: 0.025 } },
  ]),
];

for (const [label, options] of CLASSIC_CELLS) {
  test(`classic: the cat name in the old header, at its own opacity over the page, reads — ${label}`, async () => {
    const { page } = await open({ shell: 'classic', width: 720, ...options });
    const seen = {};
    for (const id of ['m-opus', 'm-codex', 'm-gemini']) {
      const m = await page.evaluate(measureClassicNameInPage(), id);
      seen[id] = m.ratio;
      measurements.push({ theme: `classic ${label}`, message: id, name: m.text, classicHeader: m });
    }
    if (evidenceDir && label.includes('near-tone'))
      await page.locator('[data-testid="column"]').screenshot({
        path: path.join(
          evidenceDir,
          `classic-light-saved-near-tone-720${process.env.NAMEPLATE_EVIDENCE_TAG ?? ''}.png`,
        ),
      });
    assert.ok(
      Object.values(seen).every((ratio) => ratio >= 4.5),
      `classic header name contrast: ${JSON.stringify(seen)}`,
    );
    await page.close();
  });
}
