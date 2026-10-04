import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { seedDefaultCollective } from './f290-default-client.fixture.mjs';
import { reserveNativeOwnerPorts, startNativeOwner } from './f290-native-owner.harness.mjs';

/**
 * F322 B — the shared room follows the Café that opened it: the real Café host (Next, production build), the real Collective
 * Service serving the real Client in the real iframe, the real handshake and the real appearance bridge. Only login, the
 * Agent runtime and `/api/config` are fixtures.
 *
 * What is driven how: the interface version through the same localStorage key and sync event `writeShellPresentation` uses; the
 * scheme through next-themes' own storage key (what the theme switch writes); a saved custom theme by writing the theme store's
 * own localStorage record; the human colour by answering `/api/config` the way the Café's config does. What is measured: the
 * room's own document, with the browser resolving every colour.
 *
 * Set APPEARANCE_EVIDENCE_DIR to also write the screenshots and the measurement table the PR cites.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const evidenceDir = process.env.APPEARANCE_EVIDENCE_DIR;
const measurements = [];

const OWNER_AVATAR = 'https://avatars.fixture.test/owner.jpg';
const MEMBER_AVATAR = 'https://avatars.fixture.test/member.jpg';
const ownerBody = '我想把多人协作真正住进家里：平时就在频道里说话，需要推进的事情再自然长成工作。';
const memberBody = '先把原型的频道和话题接在同一个默认入口里，让每个人都能回来继续。';
// The Café's own tokens each role is read from; kept here as an independent oracle for the producer's table.
const ROLE_SOURCES = {
  canvas: '--cafe-surface-canvas',
  surface: '--cafe-surface',
  sunken: '--cafe-surface-sunken',
  text: '--cafe-text',
  textMuted: '--cafe-text-muted',
  accent: '--cafe-accent',
  humanPrimary: '--color-cocreator-primary',
  humanSurface: '--color-cocreator-surface',
  humanName: '--color-cocreator-text',
};
const ROOM_VARIABLES = {
  canvas: '--console-card-bg',
  surface: '--cafe-surface',
  sunken: '--cafe-surface-sunken',
  text: '--cafe-text',
  textMuted: '--cafe-text-muted',
  accent: '--cafe-accent',
  humanPrimary: '--human-primary',
  humanSurface: '--human-surface',
  humanName: '--human-name',
};

let ports;
let dataDirectory;
let opened;
let seeded;
let server;
let browser;
let nativeOwner;
let ownerContext;
let cookies;
let readersScript;

function humanAuthProvider() {
  return {
    id: 'github',
    readiness: { ready: true },
    authorizationUrl: ({ state }) => `https://github.fixture.test/?state=${state}`,
    authenticate: async ({ code }) => ({
      providerSubject: code,
      handle: code,
      displayName: code === 'operator' ? 'You' : '吴浪',
      avatarUrl: code === 'operator' ? OWNER_AVATAR : MEMBER_AVATAR,
    }),
  };
}

const webRoot = path.resolve(here, '../..');

/** The producer's own reader, bundled for a blank page (the real browser resolves the colours). */
async function buildReaders() {
  const startedIn = process.cwd();
  process.chdir(webRoot);
  try {
    const result = await build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(webRoot, 'test/browser/fixtures/f322-appearance-readers.ts'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const entry = outputs.find((item) => item.type === 'chunk' && item.isEntry);
    assert.ok(entry, 'the reader bundle');
    return entry.code;
  } finally {
    process.chdir(startedIn);
  }
}

before(async () => {
  readersScript = await buildReaders();
  ports = await reserveNativeOwnerPorts();
  dataDirectory = await mkdtemp(path.join(tmpdir(), 'f322-appearance-service-'));
  opened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: humanAuthProvider() });
  seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
  server = await startCollectiveServer({
    store: opened.store,
    host: '127.0.0.1',
    port: 0,
    allowedHostOrigins: [`http://localhost:${ports.hostPort}`],
  });
  browser = await chromium.launch({ headless: true });
  ownerContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  nativeOwner = await startNativeOwner({
    store: opened.store,
    owner: seeded.owner,
    collectiveId: seeded.coordinates.collectiveId,
    serviceUrl: server.url,
    context: ownerContext,
    ports,
  });
  cookies = await ownerContext.cookies();
});

after(async () => {
  await ownerContext?.close();
  await nativeOwner?.close();
  await ports?.close();
  await browser?.close();
  await server?.close();
  if (dataDirectory) await rm(dataDirectory, { recursive: true });
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
  }
});

/** A fresh context per case (fresh localStorage), carrying the fixture owner's session. */
async function newContext({ width = 1440, scheme = 'light', sessionToken, memberAvatar = 'loads' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: scheme });
  await context.addCookies(cookies);
  await context.route(OWNER_AVATAR, async (route) =>
    route.fulfill({
      contentType: 'image/jpeg',
      body: await readFile(path.join(root, 'packages/web/public/avatars/owner.jpg')),
    }),
  );
  await context.route(MEMBER_AVATAR, async (route) =>
    memberAvatar === 'fails'
      ? route.abort()
      : route.fulfill({
          contentType: 'image/png',
          body: await readFile(path.join(root, 'packages/web/public/avatars/default.png')),
        }),
  );
  await context.addInitScript(
    ({ origin, token }) => {
      if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
    },
    { origin: server.url, token: sessionToken ?? seeded.owner.sessionToken },
  );
  return context;
}

/**
 * Open the Café's Collective page with the host in a given state. `seed` runs before the page's scripts, in the host document
 * only; `humanColor` answers `/api/config` the way the Café's config does.
 */
async function openHost(context, { shell, theme, humanColor, seed } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${nativeOwner.apiUrl}/api/config*`, async (route) => {
    // The Café asks the API across origins, with credentials. A stubbed answer without the CORS headers is discarded by the
    // browser, and the Café then falls back to its default colour as if the config had none. So when a colour is being driven,
    // the stub answers exactly as the fixture API's CORS layer does (and answers the preflight). Without a colour the stub is
    // left as the other cases have always run it.
    const cors = humanColor
      ? {
          'access-control-allow-origin': nativeOwner.hostUrl,
          'access-control-allow-credentials': 'true',
          vary: 'Origin',
        }
      : {};
    const request = route.request();
    if (humanColor && request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*',
        },
      });
    return route.fulfill({
      contentType: 'application/json',
      headers: cors,
      body: JSON.stringify({
        // The Café's config always carries the mention data; a config without it is rejected by the hook, colour and all.
        config: {
          coCreator: {
            name: 'You',
            ...(humanColor ? { aliases: [], mentionPatterns: ['@co-creator'], color: humanColor } : {}),
          },
        },
      }),
    });
  });
  await page.addInitScript(
    ({ hostOrigin, shell: shellValue, theme: themeValue, seed: seedValue }) => {
      if (location.origin !== hostOrigin) return;
      if (shellValue) localStorage.setItem('cat-cafe:shell-presentation', shellValue);
      if (themeValue) localStorage.setItem('theme', themeValue);
      if (seedValue) for (const [key, value] of Object.entries(seedValue)) localStorage.setItem(key, value);
    },
    { hostOrigin: nativeOwner.hostUrl, shell, theme, seed },
  );
  // The room logs every message the host sends it (capture phase, before any handler), so the journey can name the live
  // generation and revision when it forges stale or foreign ones.
  await page.addInitScript(() => {
    if (window === window.parent) return;
    window.__received = [];
    window.__senders = [];
    window.addEventListener(
      'message',
      (event) => {
        window.__received.push(event.data);
        window.__senders.push({ origin: event.origin, fromParent: event.source === window.parent, data: event.data });
      },
      true,
    );
  });
  await page.goto(`${nativeOwner.hostUrl}/collective`, { waitUntil: 'networkidle' });
  const iframe = page.locator('iframe[title="Collective"]');
  await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  assert.ok(frame, 'the room frame');
  const embedded = page.frameLocator('iframe[title="Collective"]');
  await embedded
    .getByRole('navigation', { name: '频道', exact: true })
    .getByRole('button', { name: /产品方向/ })
    .click();
  await embedded.getByText(memberBody, { exact: true }).waitFor();
  return { page, frame, embedded, errors };
}

/** Everything is read in the page, with the browser resolving every colour. */
const readTokens = (sources) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const probe = document.createElement('span');
  probe.style.cssText = 'position:fixed;left:-9999px;visibility:hidden';
  document.body.append(probe);
  const out = {};
  for (const [role, variable] of Object.entries(sources)) {
    probe.style.color = '';
    probe.style.color = `var(${variable})`;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#000';
    context.fillStyle = getComputedStyle(probe).color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    out[role] = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  }
  probe.remove();
  return out;
};

const measureRoom = ({ ownerText, memberText, variables }) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = (value) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#000';
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
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
  const html = document.documentElement;
  const articleOf = (text) =>
    [...document.querySelectorAll('article')].find((node) => node.textContent?.includes(text));
  const owner = articleOf(ownerText);
  const member = articleOf(memberText);
  const body = getComputedStyle(document.body);
  // What is really behind a message: the first opaque background up the tree.
  const backdropOf = (node) => {
    for (let current = node; current; current = current.parentElement) {
      const colour = rgba(getComputedStyle(current).backgroundColor);
      if (colour[3] === 1) return colour;
    }
    return rgba('#ffffff');
  };
  const pageBackground = backdropOf(owner ?? member);
  const out = {
    theme: html.getAttribute('data-theme'),
    colorScheme: html.style.colorScheme,
    roleVariables: Object.fromEntries(
      Object.entries(variables).map(([role, name]) => [role, html.style.getPropertyValue(name).trim()]),
    ),
    ownerAuthor: owner?.getAttribute('data-author') ?? null,
    memberAuthor: member?.getAttribute('data-author') ?? null,
    ownerHasAvatarColumn: Boolean(owner?.querySelector('.avatar-button')),
    ownerHasMeta: Boolean(owner?.querySelector('.message-meta')),
    bodyBackground: body.backgroundColor,
    pageBackgroundLuminance: Math.round(lum(pageBackground) * 1000) / 1000,
  };
  const bubble = owner?.querySelector('.message-bubble');
  if (bubble) {
    const fill = rgba(getComputedStyle(bubble).backgroundColor);
    const text = rgba(getComputedStyle(bubble.querySelector('.message-body') ?? bubble).color);
    out.bubbleFill = fill;
    out.bubbleTextContrast = contrast(text, fill);
  }
  const plate = member?.querySelector('.human-nameplate');
  if (plate) {
    const name = rgba(getComputedStyle(plate.querySelector('strong')).color);
    const fill = rgba(
      getComputedStyle(plate).backgroundImage.match(/(oklch|rgb|color)\([^)]*\)/)?.[0] ?? 'transparent',
    );
    out.plateNameContrastOnFill = contrast(name, fill);
    out.plateNameContrastOnPage = contrast(name, pageBackground);
  }
  const text = rgba(getComputedStyle((owner ?? member).querySelector('.message-body')).color);
  out.bodyTextContrastOnPage = contrast(text, pageBackground);
  return out;
};

const room = (frame) =>
  frame.evaluate(measureRoom, { ownerText: ownerBody, memberText: memberBody, variables: ROOM_VARIABLES });
const hostTokens = (page) => page.evaluate(readTokens, ROLE_SOURCES);
const settle = (page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const record = (label, value) => measurements.push({ case: label, ...value });

/** Wait until the room's document says what the host was set to (the room is classic/light until a host speaks). */
async function waitForRoom(frame, { scheme, v2 }) {
  await frame.waitForFunction(
    ({ scheme: wantScheme, v2: wantV2, ownerText }) => {
      const owner = [...document.querySelectorAll('article')].find((node) => node.textContent?.includes(ownerText));
      return (
        document.documentElement.getAttribute('data-theme') === wantScheme &&
        Boolean(owner?.getAttribute('data-author')) === wantV2 &&
        document.documentElement.style.getPropertyValue('--human-surface') !== ''
      );
    },
    { scheme, v2, ownerText: ownerBody },
  );
}

const shot = async (page, name) => {
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: path.join(evidenceDir, name), fullPage: false });
  }
};

const MIN_CONTRAST = 4.5;
function assertPaintedLikeHost(measured, tokens, label) {
  for (const [role, hex] of Object.entries(tokens)) {
    assert.equal(
      measured.roleVariables[role],
      hex,
      `${label}: room ${ROOM_VARIABLES[role]} must be the Café's resolved ${ROLE_SOURCES[role]}`,
    );
  }
}

test('Café classic and light: the room is the classic layout in the Café light tokens, and paints what the Café resolved', async () => {
  const context = await newContext();
  const { page, frame, errors } = await openHost(context, {});
  try {
    await waitForRoom(frame, { scheme: 'light', v2: false });
    await settle(page);
    const measured = await room(frame);
    const tokens = await hostTokens(page);

    assertPaintedLikeHost(measured, tokens, 'classic/light');
    assert.equal(measured.ownerHasAvatarColumn, true, 'classic keeps the avatar column');
    assert.equal(measured.ownerAuthor, null);
    assert.equal(measured.memberAuthor, null);
    assert.ok(measured.pageBackgroundLuminance > 0.6, 'a light room');
    assert.ok(measured.bodyTextContrastOnPage >= MIN_CONTRAST, `body text ${measured.bodyTextContrastOnPage}`);
    record('café classic · light', { tokens, measured });
    await shot(page, 'host-classic-light.png');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('Café new interface, light: your own message is the block, another person has the plate, in the Café colours', async () => {
  const context = await newContext();
  const { page, frame, errors } = await openHost(context, { shell: 'v2' });
  try {
    await waitForRoom(frame, { scheme: 'light', v2: true });
    await settle(page);
    const measured = await room(frame);
    const tokens = await hostTokens(page);

    assertPaintedLikeHost(measured, tokens, 'v2/light');
    assert.equal(measured.ownerAuthor, 'self');
    assert.equal(measured.memberAuthor, 'other-human');
    assert.equal(measured.ownerHasAvatarColumn, false);
    assert.equal(measured.ownerHasMeta, false);
    assert.ok(measured.bubbleTextContrast >= MIN_CONTRAST, `text on your block ${measured.bubbleTextContrast}`);
    assert.ok(
      measured.plateNameContrastOnFill >= MIN_CONTRAST,
      `name on the plate ${measured.plateNameContrastOnFill}`,
    );
    assert.ok(measured.plateNameContrastOnPage >= MIN_CONTRAST, `name on the page ${measured.plateNameContrastOnPage}`);
    record('café new · light', { tokens, measured });
    await shot(page, 'host-v2-light.png');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('Café new interface, dark: the room is dark, with legible text on your block and the name on the plate', async () => {
  const context = await newContext();
  const { page, frame, errors } = await openHost(context, { shell: 'v2', theme: 'dark' });
  try {
    await waitForRoom(frame, { scheme: 'dark', v2: true });
    await settle(page);
    const measured = await room(frame);
    const tokens = await hostTokens(page);

    assertPaintedLikeHost(measured, tokens, 'v2/dark');
    assert.equal(measured.theme, 'dark');
    assert.equal(measured.colorScheme, 'dark');
    assert.ok(measured.pageBackgroundLuminance < 0.2, `a dark room (luminance ${measured.pageBackgroundLuminance})`);
    assert.ok(measured.bubbleTextContrast >= MIN_CONTRAST, `text on your block ${measured.bubbleTextContrast}`);
    assert.ok(
      measured.plateNameContrastOnFill >= MIN_CONTRAST,
      `name on the plate ${measured.plateNameContrastOnFill}`,
    );
    assert.ok(measured.plateNameContrastOnPage >= MIN_CONTRAST, `name on the page ${measured.plateNameContrastOnPage}`);
    assert.ok(measured.bodyTextContrastOnPage >= MIN_CONTRAST, `body text ${measured.bodyTextContrastOnPage}`);
    record('café new · dark', { tokens, measured });
    await shot(page, 'host-v2-dark.png');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

const setShell = (page, value) =>
  page.evaluate((next) => {
    localStorage.setItem('cat-cafe:shell-presentation', next);
    window.dispatchEvent(new CustomEvent('cat-cafe:shell-presentation-sync'));
  }, value);
const received = (frame) =>
  frame.evaluate(() => window.__received.filter((message) => message?.type === 'collective:host-appearance'));

test('a switch in the Café reaches the open room without a reload, and the draft being typed survives it', async () => {
  const context = await newContext();
  const { page, frame, embedded, errors } = await openHost(context, {});
  const chooseTheme = async (name) => {
    await page.getByRole('button', { name: '主题' }).click();
    await page.getByRole('button', { name, exact: true }).click();
  };
  try {
    await waitForRoom(frame, { scheme: 'light', v2: false });
    const composer = embedded.getByPlaceholder('在 #产品方向 里说点什么……');
    await composer.fill('这条还没发出去的草稿，不能因为外观切换丢掉。');
    const marker = await frame.evaluate(() => {
      window.__roomMarker = `${Math.random()}`;
      return window.__roomMarker;
    });

    await chooseTheme('Dark'); // the Café's own theme menu: themeStore.setActive
    await waitForRoom(frame, { scheme: 'dark', v2: false });
    await page.getByRole('button', { name: '主题' }).click();
    await page.getByTestId('try-new-shell').click(); // the Café's own entry: writeShellPresentation('v2')
    await waitForRoom(frame, { scheme: 'dark', v2: true });
    await setShell(page, 'classic'); // the same function the settings panel calls
    await waitForRoom(frame, { scheme: 'dark', v2: false });
    await chooseTheme('Light');
    await waitForRoom(frame, { scheme: 'light', v2: false });
    await settle(page);

    const measured = await room(frame);
    assertPaintedLikeHost(measured, await hostTokens(page), 'after the switches');
    assert.equal(await frame.evaluate(() => window.__roomMarker), marker, 'the room document was not reloaded');
    assert.equal(await composer.inputValue(), '这条还没发出去的草稿，不能因为外观切换丢掉。');
    // The room handshakes more than once while it loads (each handshake is a new generation); the live one is the last.
    const everything = await received(frame);
    const live = everything.at(-1).bridgeId;
    const messages = everything.filter((message) => message.bridgeId === live);
    // A change in the Café can arrive as more than one message (the scheme flips, then the theme styles settle), each one
    // true of the page at that moment; so the order of looks is checked with repeats collapsed, and the numbering for gaps.
    const looks = messages
      .map((message) => `${message.presentation}/${message.resolvedScheme}`)
      .filter((look, index, all) => look !== all[index - 1]);
    assert.deepEqual(looks, ['classic/light', 'classic/dark', 'v2/dark', 'classic/dark', 'classic/light']);
    assert.deepEqual(
      messages.map((message) => message.appearanceRevision),
      messages.map((_, index) => index + 1),
      'revisions rise by one, with no gap and no repeat',
    );
    record('switches in the open room', {
      messages: messages.map((message) => [message.appearanceRevision, message.presentation, message.resolvedScheme]),
      draftKept: true,
      reloaded: false,
    });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('reloading the Café brings the same look back to a fresh room', async () => {
  const context = await newContext();
  const { page, errors } = await openHost(context, { shell: 'v2', theme: 'dark' });
  try {
    await page.reload({ waitUntil: 'networkidle' });
    const iframe = page.locator('iframe[title="Collective"]');
    await iframe.waitFor();
    const frame = await (await iframe.elementHandle()).contentFrame();
    await page
      .frameLocator('iframe[title="Collective"]')
      .getByRole('navigation', { name: '频道', exact: true })
      .getByRole('button', { name: /产品方向/ })
      .click();
    await waitForRoom(frame, { scheme: 'dark', v2: true });
    await settle(page);

    const measured = await room(frame);
    assertPaintedLikeHost(measured, await hostTokens(page), 'after the reload');
    const heard = await received(frame);
    assert.equal(heard.filter((message) => message.bridgeId === heard.at(-1).bridgeId)[0].appearanceRevision, 1);
    record('café reload', { measured });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('the room refuses what is not the current host speaking about the current generation', async () => {
  const serverHostOrigin = nativeOwner.hostUrl;
  const context = await newContext();
  const { page, frame, errors } = await openHost(context, { shell: 'v2' });
  try {
    await waitForRoom(frame, { scheme: 'light', v2: true });
    await settle(page);
    const before = await room(frame);
    const [live] = (await received(frame)).slice(-1);
    const flip = { ...live, presentation: 'classic', resolvedScheme: 'dark' };
    const aliens = {
      'same revision again': { ...flip },
      'an older revision': { ...flip, appearanceRevision: Math.max(live.appearanceRevision - 1, 1) },
      'another generation': {
        ...flip,
        bridgeId: 'bridge_notthislive',
        appearanceRevision: live.appearanceRevision + 1,
      },
      'an unknown version': { ...flip, v: 2, appearanceRevision: live.appearanceRevision + 1 },
      'an extra key': { ...flip, humanDisplayName: '阿宪', appearanceRevision: live.appearanceRevision + 1 },
      'a css string for a colour': {
        ...flip,
        appearanceRevision: live.appearanceRevision + 1,
        roles: { ...live.roles, text: 'url(https://evil.test/x.png)' },
      },
      'a missing role': {
        ...flip,
        appearanceRevision: live.appearanceRevision + 1,
        roles: { ...live.roles, accent: undefined },
      },
    };
    const sendFromHost = (message) =>
      page.evaluate(
        ({ origin, payload }) =>
          document.querySelector('iframe[title="Collective"]').contentWindow.postMessage(payload, origin),
        { origin: server.url, payload: message },
      );
    for (const message of Object.values(aliens)) await sendFromHost(message);
    // A window that is not the room's parent, with the host's own origin (a srcdoc frame inherits it): right place, wrong
    // sender. The post must run in the stranger's own realm, or the browser would name the host as its source.
    await page.evaluate(
      ({ origin, payload }) => {
        const stranger = document.createElement('iframe');
        stranger.style.display = 'none';
        stranger.srcdoc = `<!doctype html><script>parent.document.querySelector('iframe[title="Collective"]').contentWindow.postMessage(${JSON.stringify(
          payload,
        )}, ${JSON.stringify(origin)});</script>`;
        document.body.append(stranger);
      },
      { origin: server.url, payload: { ...flip, appearanceRevision: live.appearanceRevision + 1 } },
    );
    await settle(page);

    // The foreign window's message really arrived (right origin, valid shape, newer revision) - from a sender that is not the
    // parent - so a refusal here is the sender check, not a missing delivery.
    const senders = await frame.evaluate(() => window.__senders);
    const stranger = senders.find(
      ({ origin, fromParent, data }) =>
        origin === serverHostOrigin && !fromParent && data?.type === 'collective:host-appearance',
    );
    assert.ok(stranger, 'the message from the other window was delivered');
    assert.equal(stranger.data.appearanceRevision, live.appearanceRevision + 1);
    assert.equal(stranger.data.bridgeId, live.bridgeId);

    const after = await room(frame);
    assert.deepEqual(after, before, 'the room is exactly as it was');
    assert.equal(after.theme, 'light');
    assert.equal(after.ownerAuthor, 'self');

    // Positive control: the channel is open. The real host sending the next revision is believed.
    await sendFromHost({ ...flip, appearanceRevision: live.appearanceRevision + 1 });
    await waitForRoom(frame, { scheme: 'dark', v2: false });
    record('refused', {
      refused: Object.keys(aliens).concat('another window with the host origin'),
      positiveControlAccepted: true,
    });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('opened alone, the room is classic, light and cocoa, whatever the OS prefers; ?presentation=v2 is a link entry, not a host', async () => {
  const context = await newContext({ scheme: 'dark' });
  const alone = async (search) => {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.url}/${search}`, { waitUntil: 'networkidle' });
    await page
      .getByRole('navigation', { name: '频道', exact: true })
      .getByRole('button', { name: /产品方向/ })
      .click();
    await page.getByText(memberBody, { exact: true }).waitFor();
    return { page, errors };
  };
  try {
    const classic = await alone('');
    const measuredClassic = await room(classic.page.mainFrame());
    assert.equal(measuredClassic.theme, 'light', 'the OS preference is not followed');
    assert.equal(measuredClassic.colorScheme, 'light');
    assert.equal(measuredClassic.ownerAuthor, null);
    assert.equal(measuredClassic.ownerHasAvatarColumn, true);
    assert.ok(
      Object.values(measuredClassic.roleVariables).every((value) => value === ''),
      'no host, no role override',
    );
    assert.ok(measuredClassic.pageBackgroundLuminance > 0.6);

    const v2 = await alone('?presentation=v2');
    const measuredV2 = await room(v2.page.mainFrame());
    assert.equal(measuredV2.theme, 'light');
    assert.equal(measuredV2.ownerAuthor, 'self');
    assert.equal(measuredV2.memberAuthor, 'other-human');
    assert.ok(Object.values(measuredV2.roleVariables).every((value) => value === ''));
    assert.ok(measuredV2.bubbleTextContrast >= MIN_CONTRAST, `text on your block ${measuredV2.bubbleTextContrast}`);
    assert.ok(
      measuredV2.plateNameContrastOnFill >= MIN_CONTRAST,
      `name on the plate ${measuredV2.plateNameContrastOnFill}`,
    );
    record('alone', { classic: measuredClassic, v2: measuredV2 });
    await shot(v2.page, 'alone-v2-light-os-dark.png');
    assert.deepEqual([...classic.errors, ...v2.errors], []);
  } finally {
    await context.close();
  }
});

/** The profile panel the member entries open: who it names and which image it shows, read from the room's own DOM. */
async function readProfile(frame) {
  await frame.waitForSelector('aside[aria-label="成员资料"] .member-profile');
  return frame.evaluate(() => {
    const panel = document.querySelector('aside[aria-label="成员资料"]');
    return {
      name: panel.querySelector('.member-profile h3')?.textContent,
      caption: panel.querySelector('.member-profile p')?.textContent,
      images: [...panel.querySelectorAll('img')].map((image) => image.getAttribute('src')),
    };
  });
}

test('in the new presentation your own profile is still reachable from the member list, with your name and your authenticated avatar; another person opens from the plate', async () => {
  const owner = seeded.first.actor;
  const context = await newContext();
  const { page, frame, embedded, errors } = await openHost(context, { shell: 'v2' });
  try {
    await waitForRoom(frame, { scheme: 'light', v2: true });
    // Your own message carries no avatar to click, by design; the member list is the way to your own profile.
    assert.equal(await embedded.getByRole('button', { name: '查看 You', exact: true }).count(), 0);

    await embedded.getByRole('button', { name: /^成员/ }).first().click();
    await embedded.getByRole('button', { name: /You.*维护者/ }).click();
    const own = await readProfile(frame);
    assert.equal(own.name, owner.displayName, 'the name is the one on your message');
    assert.deepEqual(own.images, [OWNER_AVATAR], 'your authenticated avatar, exactly');
    await shot(page, 'host-v2-own-profile.png');
    await embedded.getByRole('button', { name: '关闭成员资料', exact: true }).click();
    await embedded.getByText(ownerBody, { exact: true }).waitFor();
    assert.equal(
      await frame.locator('aside[aria-label="成员资料"]').count(),
      0,
      'the panel closes, back to the channel',
    );

    // Another person: from the nameplate on their message.
    await embedded.getByRole('button', { name: '查看 吴浪', exact: true }).first().click();
    const other = await readProfile(frame);
    assert.equal(other.name, '吴浪');
    assert.deepEqual(other.images, [MEMBER_AVATAR], "that person's own avatar, not the owner's");
    assert.notEqual(other.images[0], own.images[0]);
    await embedded.getByRole('button', { name: '关闭成员资料', exact: true }).click();
    await embedded.getByText(memberBody, { exact: true }).waitFor();

    // The profile name is tied to the identity on the Service's own event, not typed into the test.
    const events = await opened.store.listEventsForHuman(seeded.owner.sessionToken, seeded.coordinates.collectiveId);
    const memberEvent = events.find((event) => event.body === memberBody);
    assert.equal(memberEvent.actor.displayName, other.name);
    assert.notEqual(memberEvent.actor.humanId, owner.humanId, 'two different people');
    record('profiles in the new presentation', {
      own,
      other,
      ownerHumanId: owner.humanId,
      memberHumanId: memberEvent.actor.humanId,
    });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('with the other person as the viewer the roles swap, and a cat is never the viewer', async () => {
  const member = seeded.member;
  const context = await newContext({ sessionToken: member.sessionToken });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${server.url}/?presentation=v2`, { waitUntil: 'networkidle' });
    await page
      .getByRole('navigation', { name: '频道', exact: true })
      .getByRole('button', { name: /产品方向/ })
      .click();
    await page.getByText(memberBody, { exact: true }).waitFor();
    const authors = await page.evaluate(() =>
      [...document.querySelectorAll('article[data-event-id]')].map((article) => ({
        text: article.textContent?.slice(0, 24),
        author: article.getAttribute('data-author'),
        isCat: article.querySelector('[data-actor-kind="agent"]') !== null,
      })),
    );
    const byText = (fragment) => authors.find((entry) => entry.text?.includes(fragment));
    assert.equal(byText('先把原型的频道')?.author, 'self', "the member's own message is the block");
    assert.equal(
      byText('我想把多人协作')?.author,
      'other-human',
      "the owner's message is now another person's, on a plate",
    );
    assert.ok(
      authors.some((entry) => entry.isCat),
      'the channel has a cat message to check',
    );
    assert.ok(
      authors.filter((entry) => entry.isCat).every((entry) => entry.author === null),
      'a cat is never self',
    );

    await page.getByRole('button', { name: '查看 You', exact: true }).first().click();
    const owner = await readProfile(page.mainFrame());
    assert.deepEqual(owner.images, [OWNER_AVATAR], "the owner's avatar from the plate");
    await page.getByRole('button', { name: '关闭成员资料', exact: true }).click();
    await page.getByRole('button', { name: /^成员/ }).first().click();
    await page.getByRole('button', { name: /吴浪.*成员/ }).click();
    const own = await readProfile(page.mainFrame());
    assert.equal(own.name, '吴浪');
    assert.deepEqual(own.images, [MEMBER_AVATAR], 'your own avatar from the member list');
    record('viewer swapped', { authors, owner, own });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('the Café token reader answers only with a colour the token itself resolves to; a missing, invalid or circular token is unresolved, never the colour it would inherit', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const validTokens = {
      '--cafe-surface-canvas': '#101112',
      '--cafe-surface': '#202122',
      '--cafe-surface-sunken': '#303132',
      '--cafe-text': '#e0e1e2',
      '--cafe-text-muted': '#a0a1a2',
      '--cafe-accent': '#d4a984',
      '--color-cocreator-primary': '#c66846',
      '--color-cocreator-surface': '#4a3a31',
      '--color-cocreator-text': '#f3e4d8',
    };
    const declarations = Object.entries(validTokens)
      .map(([name, value]) => `${name}:${value}`)
      .join(';');
    await page.setContent(
      `<!doctype html><html><head><style>:root{${declarations};--valid:#abcdef;--oklch:oklch(0.62 0.04 58);--invalid:not-a-colour;--cycle:var(--cycle);--current:currentcolor;--see-through:rgb(0 0 0 / .5)}</style></head><body style="color:#123456"></body></html>`,
    );
    await page.addScriptTag({ type: 'module', content: readersScript });
    await page.waitForFunction(() => Boolean(window.__appearanceReaders));

    const out = await page.evaluate(
      ({ roleSources }) => {
        const { resolveColorFromDocument, readHostAppearance } = window.__appearanceReaders;
        const resolve = resolveColorFromDocument(document);
        const tokens = ['--valid', '--oklch', '--missing', '--invalid', '--cycle', '--current', '--see-through'];
        const direct = Object.fromEntries(tokens.map((token) => [token, resolve(token) ?? null]));
        const sources = Object.values(roleSources);
        const whole = () =>
          readHostAppearance({ presentation: 'v2', scheme: 'light', resolveColor: resolve })?.roles ?? null;
        const intact = whole();
        const root = document.documentElement;
        const broken = {};
        for (const [label, value] of [
          ['invalid', 'not-a-colour'],
          ['cycle', 'var(--cycle)'],
          ['missing', 'var(--nowhere)'],
          ['current', 'currentcolor'],
        ]) {
          root.style.setProperty('--color-cocreator-text', value);
          broken[label] = whole();
        }
        root.style.setProperty('--color-cocreator-text', '#f3e4d8');
        const recovered = whole();
        // The same resolver, a token that did not exist and now does: it is answered, not remembered as unresolved.
        root.style.setProperty('--missing', '#0a0b0c');
        const nowDefined = resolve('--missing') ?? null;
        return {
          direct,
          intact,
          broken,
          recovered,
          nowDefined,
          sourceCount: sources.length,
          leftovers: document.body.children.length,
        };
      },
      { roleSources: ROLE_SOURCES },
    );

    assert.equal(out.direct['--valid'], '#abcdef');
    assert.match(out.direct['--oklch'], /^#[0-9a-f]{6}$/);
    assert.notEqual(out.direct['--oklch'], '#123456', 'a real token is not the body colour');
    for (const token of ['--missing', '--invalid', '--cycle', '--current', '--see-through']) {
      assert.equal(out.direct[token], null, `${token} must be unresolved, not the body colour #123456`);
    }
    assert.equal(out.sourceCount, 9);
    assert.deepEqual(out.intact, {
      canvas: '#101112',
      surface: '#202122',
      sunken: '#303132',
      text: '#e0e1e2',
      textMuted: '#a0a1a2',
      accent: '#d4a984',
      humanPrimary: '#c66846',
      humanSurface: '#4a3a31',
      humanName: '#f3e4d8',
    });
    for (const [label, roles] of Object.entries(out.broken)) {
      assert.equal(
        roles,
        null,
        `one role token that is ${label}: nothing is said, not a package with an inherited colour`,
      );
    }
    assert.deepEqual(out.recovered, out.intact, 'the same tokens restored: the whole package is back');
    assert.equal(out.nowDefined, '#0a0b0c');
    assert.equal(out.leftovers, 0, 'the probe leaves nothing in the page');
    record('token reader', { direct: out.direct, broken: Object.keys(out.broken), recovered: true });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

/** The initial on the human-colour disc (the plate's avatar once its picture is missing or failed), as the browser paints it. */
const readInitials = () => {
  const avatar = document.querySelector('.human-nameplate .avatar');
  if (!avatar) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgb = (value) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#000';
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const lum = (colour) => {
    const [r, g, b] = colour.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const style = getComputedStyle(avatar);
  const ink = rgb(style.color);
  const disc = rgb(style.backgroundColor);
  const [hi, lo] = [lum(ink), lum(disc)].sort((x, y) => y - x);
  return {
    text: avatar.textContent,
    hasPicture: Boolean(avatar.querySelector('img')),
    ink: style.color,
    disc: style.backgroundColor,
    contrast: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
  };
};
const waitForInitials = (frame) =>
  frame.waitForFunction(() => {
    const avatar = document.querySelector('.human-nameplate .avatar');
    return Boolean(avatar && !avatar.querySelector('img') && avatar.textContent);
  });

for (const scheme of ['light', 'dark']) {
  test(`the plate's initial reads on the human-colour disc when the picture is missing or fails (${scheme}), and follows any primary the Café resolves`, async () => {
    const context = await newContext({ memberAvatar: 'fails' });
    const { page, frame, errors } = await openHost(context, {
      shell: 'v2',
      ...(scheme === 'dark' ? { theme: 'dark' } : {}),
    });
    try {
      await waitForRoom(frame, { scheme, v2: true });
      await waitForInitials(frame);
      const first = await frame.evaluate(readInitials);
      assert.equal(first.text, '吴');
      assert.equal(first.hasPicture, false);
      assert.ok(first.contrast >= MIN_CONTRAST, `${scheme} default: initial ${first.contrast}`);
      const rows = [{ primary: 'Café default', ...first }];

      // The warm mid-tone the review measured at 3.32:1 with the page surface as ink, both ends of the range, the darkest and
      // lightest, and the two mid-luminance greys where either pure ink is weakest (relative luminance about 0.179).
      for (const primary of ['#c66846', '#6666ff', '#757575', '#767676', '#f2e6da', '#3b2a20', '#ffffff', '#000000']) {
        await page.evaluate((value) => {
          document.documentElement.style.setProperty('--color-cocreator-primary', value);
        }, primary);
        await frame.waitForFunction(
          (value) => document.documentElement.style.getPropertyValue('--human-primary') === value,
          primary,
        );
        await settle(page);
        const measured = await frame.evaluate(readInitials);
        assert.equal(measured.hasPicture, false);
        assert.ok(measured.contrast >= MIN_CONTRAST, `${scheme} primary ${primary}: initial ${measured.contrast}`);
        rows.push({ primary, ...measured });
      }
      record(`plate initial · ${scheme}`, { rows });
      if (scheme === 'light') await shot(page, 'host-v2-light-initial.png');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test('opened alone, the plate initial reads on the default cocoa disc', async () => {
  const context = await newContext({ memberAvatar: 'fails' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${server.url}/?presentation=v2`, { waitUntil: 'networkidle' });
    await page
      .getByRole('navigation', { name: '频道', exact: true })
      .getByRole('button', { name: /产品方向/ })
      .click();
    await page.getByText(memberBody, { exact: true }).waitFor();
    await waitForInitials(page.mainFrame());
    const measured = await page.evaluate(readInitials);
    assert.equal(measured.text, '吴');
    assert.ok(measured.contrast >= MIN_CONTRAST, `default cocoa disc: initial ${measured.contrast}`);
    const inkVariable = await page.evaluate(() => document.documentElement.style.getPropertyValue('--human-ink'));
    assert.equal(inkVariable, '', 'no host, no derived ink: the stylesheet default stands');
    record('plate initial · alone', { measured });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// What the room paints when the Café carries a SAVED custom theme, and when the Café's config carries a HUMAN COLOUR.
// Both are driven the way the Café itself receives them (the theme store's own localStorage record; `/api/config`), and read
// back from the room's own document with the browser resolving every colour. Neither is a fixture of the bridge.
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * A saved custom theme, written as the theme store writes it. The params are partial on purpose: the store fills what is missing
 * from the engine's defaults on read (`migrateTunerState`), exactly as it does for a theme saved by an older Tuner.
 */
const savedThemeRecord = (base, params) => ({
  'cat-cafe:themes': JSON.stringify({
    version: 'journey',
    activeId: 'custom-journey',
    custom: [{ id: 'custom-journey', name: 'Journey', base, builtIn: false, params }],
    builtInOverrides: {},
  }),
});

/** One host in a fresh context (fresh localStorage), measured once the room says what the host was set to. */
async function measureHost(hostOptions, { scheme, contextOptions } = {}) {
  const context = await newContext(contextOptions);
  const opened = await openHost(context, { shell: 'v2', ...hostOptions });
  try {
    await waitForRoom(opened.frame, { scheme, v2: true });
    await settle(opened.page);
    const measured = await room(opened.frame);
    const tokens = await hostTokens(opened.page);
    assert.deepEqual(opened.errors, []);
    return { measured, tokens, page: opened.page, frame: opened.frame, context };
  } catch (error) {
    await context.close();
    throw error;
  }
}

// Strong, plainly different looks: a blue accent on a blue-tinted surface, far from the warm defaults.
const SAVED_THEME_PARAMS = { accentHue: 250, accentChroma: 0.16, surfaceHue: 250, surfaceChroma: 3 };

for (const scheme of ['light', 'dark']) {
  test(`a saved custom theme in the Café reaches the room (${scheme} base): the room paints the saved theme's resolved colours, not the defaults, and still reads`, async () => {
    const seed = savedThemeRecord(scheme, SAVED_THEME_PARAMS);
    const control = await measureHost({ ...(scheme === 'dark' ? { theme: 'dark' } : {}) }, { scheme });
    const saved = await measureHost({ theme: scheme, seed }, { scheme });
    try {
      // The saved theme really is what the Café is wearing: its surface and accent differ from the built-in theme's.
      assert.notEqual(
        saved.tokens.surface,
        control.tokens.surface,
        `${scheme}: the saved theme changed the Café surface`,
      );
      assert.notEqual(saved.tokens.accent, control.tokens.accent, `${scheme}: the saved theme changed the Café accent`);

      // The room paints exactly what the Café resolved, role by role, and not what it would have painted by default.
      assertPaintedLikeHost(saved.measured, saved.tokens, `saved theme/${scheme}`);
      assert.notEqual(
        saved.measured.roleVariables.surface,
        control.measured.roleVariables.surface,
        'not the default surface',
      );
      assert.notEqual(
        saved.measured.roleVariables.accent,
        control.measured.roleVariables.accent,
        'not the default accent',
      );

      assert.equal(saved.measured.theme, scheme);
      assert.equal(saved.measured.ownerAuthor, 'self');
      assert.equal(saved.measured.memberAuthor, 'other-human');
      assert.ok(
        saved.measured.bubbleTextContrast >= MIN_CONTRAST,
        `text on your block ${saved.measured.bubbleTextContrast}`,
      );
      assert.ok(
        saved.measured.plateNameContrastOnFill >= MIN_CONTRAST,
        `name on the plate ${saved.measured.plateNameContrastOnFill}`,
      );
      assert.ok(
        saved.measured.plateNameContrastOnPage >= MIN_CONTRAST,
        `name on the page ${saved.measured.plateNameContrastOnPage}`,
      );
      assert.ok(
        saved.measured.bodyTextContrastOnPage >= MIN_CONTRAST,
        `body text ${saved.measured.bodyTextContrastOnPage}`,
      );
      record(`saved custom theme · ${scheme}`, {
        control: { tokens: control.tokens },
        saved: { tokens: saved.tokens, measured: saved.measured },
      });
      await shot(saved.page, `host-v2-${scheme}-saved-theme.png`);
    } finally {
      await saved.context.close();
      await control.context.close();
    }
  });
}

// The Café's config answers the human colour; the Café's injector turns it into the human's theme roles. Three spellings of
// one colour: six digits, opaque eight digits (the config chain accepts #RRGGBBAA), and the stored reddish a running Café returns.
const HUMAN_COLOURS = [
  { label: 'stored reddish', color: { primary: '#815b5b', secondary: '#FFDDD2' } },
  { label: 'blue, six digits', color: { primary: '#6666ff', secondary: '#ffffff' } },
  { label: 'blue, opaque eight digits', color: { primary: '#6666ffff', secondary: '#ffffffff' } },
];

for (const scheme of ['light', 'dark']) {
  test(`a configured human colour in the Café reaches the room (${scheme}): the block, the plate and the name follow it, and the ink reads on the disc`, async () => {
    const hostFor = (extra) => ({ ...(scheme === 'dark' ? { theme: 'dark' } : {}), ...extra });
    const cocoa = await measureHost(hostFor({}), { scheme, contextOptions: { memberAvatar: 'fails' } });
    const results = {};
    try {
      for (const { label, color } of HUMAN_COLOURS) {
        const run = await measureHost(hostFor({ humanColor: color }), {
          scheme,
          contextOptions: { memberAvatar: 'fails' },
        });
        try {
          // The Café really wears the configured colour: its human roles are not the default cocoa ones.
          assert.notEqual(
            run.tokens.humanPrimary,
            cocoa.tokens.humanPrimary,
            `${label}/${scheme}: the Café human primary moved`,
          );
          assert.notEqual(
            run.tokens.humanSurface,
            cocoa.tokens.humanSurface,
            `${label}/${scheme}: the Café human surface moved`,
          );
          // The room paints exactly what the Café resolved for the human, and not the default cocoa.
          assertPaintedLikeHost(run.measured, run.tokens, `${label}/${scheme}`);
          assert.notEqual(
            run.measured.roleVariables.humanPrimary,
            cocoa.measured.roleVariables.humanPrimary,
            'not cocoa',
          );
          assert.ok(
            run.measured.bubbleTextContrast >= MIN_CONTRAST,
            `${label}: text on your block ${run.measured.bubbleTextContrast}`,
          );
          assert.ok(
            run.measured.plateNameContrastOnFill >= MIN_CONTRAST,
            `${label}: name on the plate ${run.measured.plateNameContrastOnFill}`,
          );
          assert.ok(
            run.measured.plateNameContrastOnPage >= MIN_CONTRAST,
            `${label}: name on the page ${run.measured.plateNameContrastOnPage}`,
          );
          await waitForInitials(run.frame);
          const initial = await run.frame.evaluate(readInitials);
          assert.equal(initial.hasPicture, false);
          assert.ok(
            initial.contrast >= MIN_CONTRAST,
            `${label}/${scheme}: the initial on the disc ${initial.contrast}`,
          );
          results[label] = { tokens: run.tokens, measured: run.measured, initial };
          if (label === 'stored reddish' && scheme === 'light')
            await shot(run.page, 'host-v2-light-configured-human.png');
        } finally {
          await run.context.close();
        }
      }
      // One colour, two spellings: an opaque eight-digit colour is the same fill as its six-digit form, in the Café and in the room.
      for (const role of ['humanPrimary', 'humanSurface', 'humanName']) {
        assert.equal(
          results['blue, opaque eight digits'].tokens[role],
          results['blue, six digits'].tokens[role],
          `${scheme}: ${role} must not depend on how the colour was spelled`,
        );
        assert.equal(
          results['blue, opaque eight digits'].measured.roleVariables[role],
          results['blue, six digits'].measured.roleVariables[role],
          `${scheme}: the room's ${ROOM_VARIABLES[role]} must not depend on how the colour was spelled`,
        );
      }
      record(`configured human colour · ${scheme}`, { cocoa: { tokens: cocoa.tokens }, results });
    } finally {
      await cocoa.context.close();
    }
  });
}
