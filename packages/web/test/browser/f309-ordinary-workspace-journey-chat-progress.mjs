import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fulfillFixtureApi } from './f309-ordinary-workspace-journey-actions.mjs';
import { createReviewState, json } from './f309-ordinary-workspace-journey-fixture.mjs';

// Real Next shell, production CSS and the real ChatMessage; only the network is stubbed. The request state
// is therefore a fixture: this proves how the line looks and behaves, not that a real cat is working.
const REQUEST_ID = `f309-modification-${'c'.repeat(64)}`;
export const EVIDENCE =
  process.env.F309_CHAT_PROGRESS_EVIDENCE ?? '/tmp/cat-cafe-evidence/f309-chat-modification-progress';
const SOURCE_MESSAGE = {
  from: { kind: 'user', userId: 'operator' },
  id: 'human-source',
  type: 'user',
  content: '请把角落的标志移除，其余保持不变。',
  timestamp: 1,
  extra: {
    targetCats: ['codex-sol'],
    contentModificationRequestV1: {
      v: 1,
      requestId: REQUEST_ID,
      requestFingerprint: `sha256:${'d'.repeat(64)}`,
      contentTitle: '窄屏设计稿',
      targetCatId: 'codex-sol',
      targetName: '烁烁',
      executionThreadTitle: 'F309 workspace studio改造',
      completionRule: 'published-result-ready',
    },
  },
};

function detail({ revision = 1, execution, cancelled = false } = {}) {
  return {
    stage: 'queued',
    candidates: [],
    acceptances: [],
    execution: execution
      ? { state: execution, messageId: 'carrier', targetCatId: 'codex-sol', observedAt: 1, evidenceRef: 'evidence' }
      : undefined,
    record: {
      requestId: REQUEST_ID,
      ownerUserId: 'operator',
      revision,
      createdAt: 1,
      updatedAt: 1,
      progress: {},
      payload: { threadId: 'execution-thread' },
      control: cancelled
        ? {
            state: 'cancelled',
            actorId: 'operator',
            cancelledAt: 1,
            receiptRef: 'receipt',
            taskResolution: 'preserved',
          }
        : undefined,
    },
  };
}

export async function assertFitsViewport(page, row) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no horizontal overflow, got ${overflow}px`);
  const box = await row.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width, 'the row stays inside the viewport');
}

/** State is carried by the dot only: the words keep the row's normal colour. */
async function assertDotOnlyColour(row, indicator) {
  const colours = await row.evaluate((element, kind) => {
    const dot = element.querySelector(`[data-indicator="${kind}"]`);
    const title = element.querySelector('output > span');
    return {
      dot: dot ? getComputedStyle(dot).backgroundColor : null,
      title: title ? getComputedStyle(title).color : null,
      row: getComputedStyle(element).color,
    };
  }, indicator);
  assert.ok(colours.dot && colours.dot !== 'rgba(0, 0, 0, 0)', `the ${indicator} dot is painted`);
  assert.equal(colours.title, colours.row, 'the words keep the normal text colour');
  assert.notEqual(colours.title, colours.dot, 'the words are not the state colour');
}

const TEXT_MIN_CONTRAST = 4.5;
const INDICATOR_MIN_CONTRAST = 3;

/**
 * WCAG contrast of what the reader really sees: the computed colour (a canvas resolves OKLCH and color-mix),
 * the element's own opacity, composited over every surface behind it. The line sits inside the user's own
 * tinted bubble, so a palette that is fine on a plain page can still fall below the threshold here.
 */
export async function measureContrast(locator, paint) {
  return locator.evaluate((element, mode) => {
    const resolve = (css) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    const over = (top, under) => {
      const a = top.a + under.a * (1 - top.a);
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
      const mix = (t, u) => (t * top.a + u * under.a * (1 - top.a)) / a;
      return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a };
    };
    const luminance = ({ r, g, b }) => {
      const channel = (value) => {
        const unit = value / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ancestors = [];
    for (let node = element.parentElement; node; node = node.parentElement) ancestors.unshift(node);
    let surface = { r: 255, g: 255, b: 255, a: 1 };
    for (const node of ancestors) surface = over(resolve(getComputedStyle(node).backgroundColor), surface);
    // `text-on-fill`: a filled control (a button with its own colour) paints that colour under its own words.
    if (mode === 'text-on-fill') surface = over(resolve(getComputedStyle(element).backgroundColor), surface);
    const style = getComputedStyle(element);
    const colour = {
      text: style.color,
      'text-on-fill': style.color,
      border: style.borderLeftColor,
      background: style.backgroundColor,
    }[mode];
    // Opacity of the element and of the ancestors above it, up to the surface it is painted on.
    let opacity = 1;
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      if (node !== element && resolve(getComputedStyle(node).backgroundColor).a >= 0.99) break;
      opacity *= Number(getComputedStyle(node).opacity);
    }
    const painted = resolve(colour);
    const seen = over({ ...painted, a: painted.a * opacity }, surface);
    const [light, dark] = [luminance(seen), luminance(surface)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  }, paint);
}

/** Every word, the action and the state indicator stay legible on the surface they actually sit on. */
const measured = {};

/** `sink` lets another scene keep its own contrast record instead of adding to this one's `contrast.json`. */
export async function assertReadable(row, label, sink = { values: measured, file: `${EVIDENCE}/contrast.json` }) {
  const texts = row.locator('output > span, button, [role="alert"]');
  for (let index = 0; index < (await texts.count()); index += 1) {
    const item = texts.nth(index);
    const ratio = await measureContrast(item, 'text');
    const words = ((await item.textContent()) ?? '').trim();
    sink.values[`${label} | ${words}`] = Number(ratio.toFixed(2));
    assert.ok(
      ratio >= TEXT_MIN_CONTRAST,
      `${label}: "${words}" is ${ratio.toFixed(2)}:1, below ${TEXT_MIN_CONTRAST}:1`,
    );
  }
  const indicator = row.locator('[data-indicator]').first();
  const kind = (await indicator.getAttribute('data-indicator')) === 'spinner' ? 'border' : 'background';
  const ratio = await measureContrast(indicator, kind);
  sink.values[`${label} | indicator ${kind}`] = Number(ratio.toFixed(2));
  await writeFile(sink.file, `${JSON.stringify(sink.values, null, 2)}\n`);
  assert.ok(
    ratio >= INDICATOR_MIN_CONTRAST,
    `${label}: the state indicator is ${ratio.toFixed(2)}:1, below ${INDICATOR_MIN_CONTRAST}:1`,
  );
}

/** The dark cases must really be dark: an attribute that only flips a label would make them a light rerun. */
export async function assertThemeApplied(page, dark) {
  const luminance = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = getComputedStyle(document.body).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });
  assert.ok(
    dark ? luminance < 0.3 : luminance > 0.6,
    `${dark ? 'dark' : 'light'} theme is applied (body ${luminance.toFixed(2)})`,
  );
}

/**
 * Opens the thread in the real Next shell with the given history, in light or the real dark base. `handleApi`
 * gets every API request first and may answer it (`{ body, status? }`, or `{ raw, contentType, status? }` for bytes);
 * anything it leaves alone falls through to the shared journey fixture.
 */
export async function openChatPage(
  suite,
  { width = 1440, dark = false, messages, handleApi, sessionStorage = {}, resetLocalStorage = true },
) {
  const { browser, baseUrl } = suite();
  await mkdir(EVIDENCE, { recursive: true });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  if (resetLocalStorage) await context.addInitScript(() => window.localStorage.clear());
  // The real dark base is activated through next-themes' own persistence (the way f293-team-experience does);
  // a hand-set data-theme attribute is overwritten by the provider and leaves the page light.
  if (dark) await context.addInitScript(() => window.localStorage.setItem('theme', 'dark'));
  // Drafts a person left in the composer: the shell hydrates them from sessionStorage when it loads.
  for (const [key, value] of Object.entries(sessionStorage))
    await context.addInitScript(([k, v]) => window.sessionStorage.setItem(k, v), [key, value]);
  const page = await context.newPage();
  const calls = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = createReviewState();
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/messages' && request.method() === 'GET')
      return json(route, { messages, hasMore: false });
    const answer = await handleApi?.(request, url, calls);
    // `raw` answers with bytes (an image), anything else with JSON.
    if (answer?.raw)
      return route.fulfill({ status: answer.status ?? 200, contentType: answer.contentType, body: answer.raw });
    if (answer) return json(route, answer.body, answer.status ?? 200);
    return fulfillFixtureApi(route, state, []);
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-chat-container]').waitFor({ timeout: 30_000 });
  if (dark)
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', undefined, {
      timeout: 15_000,
    });
  await assertThemeApplied(page, dark);
  return { context, page, calls, errors };
}

export function registerOrdinaryChatProgressJourney(suite) {
  /** `respond(method, path)` decides the request answer; every call is recorded for the assertions. */
  async function open({ width = 1440, dark = false, respond }) {
    const { context, page, calls, errors } = await openChatPage(suite, {
      width,
      dark,
      messages: [SOURCE_MESSAGE],
      handleApi: async (request, url, recorded) => {
        if (!url.pathname.startsWith(`/api/content-modifications/${REQUEST_ID}`)) return undefined;
        recorded.push(
          `${request.method()} ${url.pathname.slice('/api/content-modifications/'.length + REQUEST_ID.length)}`,
        );
        return respond(request.method(), url.pathname);
      },
    });
    const source = page.getByTestId('content-modification-source');
    await source.waitFor({ timeout: 20_000 });
    return { context, page, calls, errors, source, row: page.getByTestId('modification-progress') };
  }

  for (const [label, width, dark] of [
    ['desktop light', 1440, false],
    ['desktop dark', 1440, true],
    ['390px light', 390, false],
    ['390px dark', 390, true],
  ]) {
    test(
      `chat shows live progress and a working cancel under the request headline (${label})`,
      { timeout: 90_000 },
      async () => {
        let cancelled = false;
        const { context, page, calls, errors, source, row } = await open({
          width,
          dark,
          respond: (method, path) => {
            if (method === 'POST' && path.endsWith('/cancel')) {
              cancelled = true;
              return { body: detail({ revision: 2, execution: 'running', cancelled: true }) };
            }
            return { body: detail({ revision: cancelled ? 2 : 1, execution: 'running', cancelled }) };
          },
        });
        const slug = label.replaceAll(' ', '-');
        try {
          assert.match(await source.textContent(), /请烁烁修改《窄屏设计稿》/);
          assert.equal(await row.getAttribute('data-state'), 'working');
          assert.match(await row.locator('output').textContent(), /修改中 · 窄屏设计稿/);
          await assertFitsViewport(page, row);
          await assertReadable(row, `${label} working`);
          const cancel = row.getByRole('button', { name: '取消修改' });
          assert.equal(await cancel.textContent(), '取消');
          await source.screenshot({ path: `${EVIDENCE}/${slug}-working.png` });

          await cancel.click();
          await page.locator('[data-testid="modification-progress"][data-state="cancelled_still_running"]').waitFor();
          assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1, 'cancel is sent exactly once');
          assert.match(await row.textContent(), /修改已取消，执行仍在进行/);
          assert.match(await row.textContent(), /取消修改不会停止本轮执行。/);
          // No stop control is drawn until a stop handler exists.
          assert.equal(await row.getByRole('button').count(), 0);
          await assertDotOnlyColour(row, 'attention');
          await assertReadable(row, `${label} cancelled-still-running`);
          await assertFitsViewport(page, row);
          await source.screenshot({ path: `${EVIDENCE}/${slug}-cancelled-still-running.png` });
          if (width === 1440 && !dark)
            await page.screenshot({ path: `${EVIDENCE}/host-chat-cancelled-still-running.png` });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
    );
  }

  test('a failed run says so with a danger dot and opens the execution conversation', { timeout: 60_000 }, async () => {
    const { context, page, row, source } = await open({ respond: () => ({ body: detail({ execution: 'failed' }) }) });
    try {
      assert.equal(await row.getAttribute('data-state'), 'incomplete');
      assert.match(await row.textContent(), /修改未完成/);
      await assertDotOnlyColour(row, 'danger');
      await assertReadable(row, 'failed run');
      await source.screenshot({ path: `${EVIDENCE}/desktop-light-incomplete.png` });
      await row.getByRole('button', { name: '打开执行对话' }).click();
      await page.waitForURL(/\/thread\/execution-thread/);
    } finally {
      await context.close();
    }
  });

  test(
    'an unreadable status says unknown and recovers on reload instead of guessing',
    { timeout: 60_000 },
    async () => {
      let healthy = false;
      const { context, row, source } = await open({
        respond: () =>
          healthy ? { body: detail({ execution: 'running' }) } : { body: { error: 'boom' }, status: 500 },
      });
      try {
        assert.equal(await row.getAttribute('data-state'), 'unavailable');
        assert.match(await row.textContent(), /无法获取状态/);
        assert.doesNotMatch(await row.textContent(), /修改中/);
        await assertReadable(row, 'unreadable status');
        await source.screenshot({ path: `${EVIDENCE}/desktop-light-unavailable.png` });
        healthy = true;
        await row.getByRole('button', { name: '重新加载' }).click();
        await source.page().locator('[data-testid="modification-progress"][data-state="working"]').waitFor();
        assert.equal(await row.getAttribute('data-state'), 'working');
      } finally {
        await context.close();
      }
    },
  );

  test('a viewer who cannot read the request sees only the headline', { timeout: 60_000 }, async () => {
    const { context, source, row } = await open({ respond: () => ({ body: { error: 'access_denied' }, status: 403 }) });
    try {
      assert.match(await source.textContent(), /请烁烁修改《窄屏设计稿》/);
      assert.equal(await row.count(), 0);
    } finally {
      await context.close();
    }
  });

  test('only a request that can still change keeps being read', { timeout: 60_000 }, async () => {
    const { context, calls } = await open({ respond: () => ({ body: detail({ execution: 'finished' }) }) });
    try {
      const reads = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      assert.equal(calls.length, reads, 'a quiet request is not polled');
    } finally {
      await context.close();
    }
  });
}
