import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

// Real rail, mailbox, tooltip, settings shell, preference/pin stores and navigation hooks.
// Only Next routing and domain content renderers are test boundaries. Every request is
// fulfilled in the isolated browser; no dev/runtime service, user account or Redis is used.
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(webRoot, 'test/browser/fixtures');
const origin = 'https://f322-shell-journey.test';
let browser, script, css;
const startedIn = process.cwd();
before(async () => {
  // Tailwind v3 resolves the config's relative `content` globs against the process working directory, not
  // the config file. Built from the repository root the shell gets 0 bytes of utilities and every layout
  // assertion fails; the build must not depend on where the runner was started.
  process.chdir(webRoot);
  const result = await build({
    root: webRoot,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: {
      alias: [
        { find: 'next/navigation', replacement: path.join(fixtureRoot, 'f322-shell-navigation.ts') },
        {
          find: /^\.\/(?:ThreadSidebar|DesktopUpdatePrompt|listen-mode\/ListenModePlayer|story-player\/TheaterReplayHost|thread-chat|workspace\/FloatingPresentationSurfaceHost|workspace\/ResizeHandle|concierge\/ConciergeHost)$/,
          replacement: path.join(fixtureRoot, 'f322-shell-boundaries.tsx'),
        },
        {
          find: /^@\/(?:stores\/callbackAuthStore|services\/playbackRuntime|hooks\/useWorkspaceNavigate)$/,
          replacement: path.join(fixtureRoot, 'f322-shell-boundaries.tsx'),
        },
        { find: /^\.\/SettingsContent$/, replacement: path.join(fixtureRoot, 'f322-settings-content.tsx') },
        { find: /^\.\.\/dev\/OklchTuner$/, replacement: path.join(fixtureRoot, 'f322-settings-content.tsx') },
        { find: '@', replacement: path.join(webRoot, 'src') },
      ],
    },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(webRoot, 'test/browser/fixtures/f322-shell-journey.tsx'),
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
});

const unifiedSource = (extra = {}) => ({
  status: 'available',
  startedAt: 1,
  observedAt: 2,
  coverage: 'all_registered_F246_producers',
  exhaustiveness: 'complete',
  ...extra,
});
// F310's unified owner read (version 1). The default is the proven complete empty set.
const unifiedRead = (overrides = {}) => ({
  version: 1,
  status: 'available',
  scope: 'owner_all_projects',
  identity: { ownerUserId: 'owner-1' },
  observedAt: 3,
  sources: {
    approvals: unifiedSource(),
    needsMe: unifiedSource({ coverage: 'current_linked_F310_five_producers' }),
  },
  readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
  consistency: { state: 'verified', reasons: [] },
  items: [],
  totalCount: 0,
  page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
  ...overrides,
});
const approvalRow = (id, summary) => ({
  decisionRef: `approval:F128:${id}`,
  kind: 'approval',
  summary,
  approval: {
    proposalId: id,
    sourceFeatureId: 'F128',
    requesterCatId: 'opus',
    summary,
    detail: {},
    createdAt: Date.now() - 2 * 3600_000,
  },
  linkedNeedsMe: [],
});

async function openProof({
  pins = ['notify'],
  shell = 'v2',
  route = '/thread/thread-return',
  viewport = { width: 1440, height: 900 },
  // Called once per unified read, with the 1-based attempt number; returns { status?, body, raw? } (may be async: a slow read).
  unified = () => ({ body: unifiedRead() }),
  // Offered every other /api request first; returns { status?, body, raw?, abort? } to answer it, or null to fall through.
  api = () => null,
  session = { userId: 'owner-1' },
  ready = '待办，暂无',
} = {}) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5_000);
  const errors = [],
    requests = [],
    unexpected = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ pins, shell }) => {
      localStorage.setItem('cat-cafe:shell-presentation', shell);
      localStorage.setItem('cat-cafe:pinned-settings-sections', JSON.stringify(pins));
    },
    { pins, shell },
  );
  await page.route('**/*', async (handler) => {
    const request = handler.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(request.url());
      return handler.abort();
    }
    if (url.pathname === '/proof.js') return handler.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/proof.css') return handler.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname.startsWith('/shell/'))
      return handler.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA9sAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    if (url.pathname.startsWith('/api/')) {
      requests.push(`${request.method()} ${url.pathname}${url.search}`);
      if (url.pathname === '/api/concierge/work/decisions') {
        const reply = await unified(requests.filter((entry) => entry.includes('/api/concierge/work/decisions')).length);
        // A slow read can be superseded and aborted by the page before it is answered: answering it then is not an error.
        return handler
          .fulfill({
            status: reply.status ?? 200,
            contentType: 'application/json',
            body: reply.raw ?? JSON.stringify(reply.body),
          })
          .catch(() => undefined);
      }
      const custom = await api({ request, url, requests });
      if (custom) {
        if (custom.abort) return handler.abort('failed');
        return handler.fulfill({
          status: custom.status ?? 200,
          contentType: 'application/json',
          body: custom.raw ?? JSON.stringify(custom.body),
        });
      }
      const bodies = {
        '/api/session': session,
        '/api/approval-hub/pending': { items: [], count: 0 },
        // The classic presentation (reached by the theme test) still reads Needs Me for its own rail.
        '/api/entrusted-work/needs-me': { ownerReads: [] },
        // The v2 conversation header's own reads (ThreadIndicator, DaemonActiveIndicator, cat roster).
        '/api/threads/thread-return': { id: 'thread-return', title: '返回原处的对话', projectPath: '/work/fixture' },
        '/api/threads/thread-return/active-pane': { active: false },
        // A second conversation, for "open the source in another conversation".
        '/api/threads/thread-other': { id: 'thread-other', title: '另一个对话', projectPath: '/work/fixture' },
        '/api/threads/thread-other/active-pane': { active: false },
        '/api/cats': { cats: [] },
        '/api/config/cat-order': { catOrder: [] },
      };
      if (!(url.pathname in bodies)) {
        unexpected.push(request.url());
        return handler.fulfill({ status: 404, body: '{}' });
      }
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify(bodies[url.pathname]) });
    }
    return handler.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
    });
  });
  await page.goto(origin + route, { waitUntil: 'networkidle' });
  if (shell === 'v2') await page.getByRole('button', { name: ready, exact: true }).waitFor();
  return { page, errors, requests, unexpected };
}
async function closeProof(proof) {
  await proof.page.close();
  assert.deepEqual(proof.errors, []);
  assert.deepEqual(proof.unexpected, []);
}
async function pointAt(page, locator) {
  const box = await locator.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test('shell tooltips wait 150ms once, adjacent controls are immediate, keyboard focus and Escape work', async () => {
  const proof = await openProof();
  const { page } = proof;
  try {
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await pointAt(page, page.getByTestId('mailbox-button'));
    await page.clock.runFor(149);
    assert.equal(await page.getByRole('tooltip').count(), 0);
    await page.clock.runFor(1);
    assert.match(await page.getByRole('tooltip').textContent(), /待办/);
    await pointAt(page, page.getByTestId('concierge-rail-toggle'));
    assert.equal(await page.getByRole('tooltip').count(), 1);
    assert.match(await page.getByRole('tooltip').textContent(), /猫猫球/);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('tooltip').count(), 0);
    await page.mouse.move(500, 500);
    await page.clock.runFor(600);
    await page.keyboard.press('Tab');
    assert.match(await page.getByRole('tooltip').textContent(), /我的 Café/);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('tooltip').count(), 0);
    assert.equal(await page.getByTestId('world-rail').locator('[title]').count(), 0);
  } finally {
    await closeProof(proof);
  }
});

test('mailbox moves focus into its panel and Escape returns to the exact rail button', async () => {
  const proof = await openProof();
  const { page } = proof;
  try {
    await page.getByTestId('mailbox-button').click();
    const dialog = page.getByRole('dialog', { name: '待办' });
    await dialog.waitFor();
    // A proven empty read has no row to take focus, so focus lands on the panel's close button.
    assert.equal(await page.getByTestId('mailbox-close').evaluate((el) => el === document.activeElement), true);
    assert.equal(await page.getByTestId('mailbox-empty').textContent(), '暂无待办');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByTestId('mailbox-button').evaluate((el) => el === document.activeElement), true);
  } finally {
    await closeProof(proof);
  }
});

test('mailbox shows the proven total and the real rows from one verified read', async () => {
  const items = [
    approvalRow('p1', '记一条品味'),
    {
      decisionRef: 'f306.runtime_interaction:s1:1',
      kind: 'judgment',
      summary: '下周会议封面用哪一版',
      linkedNeedsMe: [],
    },
  ];
  const proof = await openProof({
    unified: () => ({ body: unifiedRead({ items, totalCount: 2 }) }),
    ready: '待办，2 件',
  });
  const { page } = proof;
  try {
    assert.equal(await page.getByTestId('rail-badge-count').textContent(), '2');
    assert.ok(proof.requests.includes('GET /api/concierge/work/decisions?view=unified&offset=0&limit=20'));
    await page.getByTestId('mailbox-button').click();
    await page.getByRole('dialog', { name: '待办' }).waitFor();
    const rows = page.getByTestId('mailbox-item');
    assert.equal(await rows.count(), 2);
    assert.deepEqual(await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-kind-label'))), [
      '审批',
      '等你判断',
    ]);
    assert.equal(
      await rows
        .first()
        .locator('button')
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.getByTestId('mailbox-button').evaluate((el) => el === document.activeElement), true);
  } finally {
    await closeProof(proof);
  }
});

const judgmentRow = (id, summary, extra = {}) => ({
  decisionRef: `f306.runtime_interaction:${id}:1`,
  kind: 'judgment',
  summary,
  linkedNeedsMe: [
    {
      ownerRead: {
        envelope: { subjectRef: `task:${id}`, revision: 1, visibility: { ownerUserId: 'owner-1' } },
        brief: { outcome: { state: 'known', value: '下周会议封面' } },
        work: { title: '会议封面', ownerCatId: 'gemini' },
        preparedArtifact: {
          artifactRef: 'a',
          artifactRevision: '1',
          completenessRef: 'c',
          previewRef: 'p',
          openInWorkspaceRef: 'w',
        },
      },
      receipt: {
        eligible: true,
        kind: 'judgment',
        recommendation: '用 v3：招牌更亮',
        producer: { producerId: 'f306.runtime_interaction', subjectRef: id, revision: 1 },
        ...extra,
      },
    },
  ],
});

test('待办 is a full-height panel beside the rail: rows open one at a time, it stays when you click elsewhere', async () => {
  const items = [
    approvalRow('p1', '记一条品味'),
    judgmentRow('s1', '下周会议封面用哪一版'),
    judgmentRow('s2', '另一件'),
  ];
  const proof = await openProof({
    unified: () => ({ body: unifiedRead({ items, totalCount: 3 }) }),
    ready: '待办，3 件',
  });
  const { page } = proof;
  try {
    const button = page.getByTestId('mailbox-button');
    await button.click();
    const dialog = page.getByRole('dialog', { name: '待办' });
    await dialog.waitFor();
    // Geometry once it has finished sliding out: docked at the rail's right edge, from the top of the window to the
    // bottom, and the rail stays usable.
    await dialog.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
    const box = await dialog.boundingBox();
    const railRight = await page.getByTestId('world-rail').evaluate((el) => el.getBoundingClientRect().right);
    assert.ok(box);
    assert.equal(Math.round(box.x), Math.round(railRight));
    assert.equal(Math.round(box.y), 0);
    assert.equal(Math.round(box.height), 900);
    assert.equal(Math.round(box.width), 440);
    assert.equal(
      await button.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      }),
      true,
      'the panel must not cover the rail button that opened it',
    );
    // One tab, with the proven total beside it.
    assert.equal(await page.getByRole('tab').count(), 1);
    assert.equal((await page.getByTestId('mailbox-tab-needs-me').textContent())?.replace(/\s/g, ''), '需要我处理3');

    const toggles = page.getByTestId('mailbox-item-toggle');
    assert.deepEqual(await toggles.evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded'))), [
      'false',
      'false',
      'false',
    ]);
    // A work row names the entrusted work it belongs to — not a source feature it does not know.
    assert.equal(
      await page
        .getByTestId('mailbox-item')
        .nth(1)
        .textContent()
        .then((t) => t.includes('受托工作「会议封面」')),
      true,
    );
    // Open the judgment: it says what the contract carries, and has exactly one way forward.
    await toggles.nth(1).click();
    assert.equal(await page.getByTestId('mailbox-detail-recommendation').textContent(), '建议 用 v3：招牌更亮');
    assert.equal(await page.getByTestId('mailbox-detail-goal').textContent(), '目标 下周会议封面');
    assert.equal(await page.getByTestId('mailbox-detail-prepared').textContent(), '成果 准备好的作品');
    assert.equal(await page.getByTestId('mailbox-open-original').count(), 1);
    assert.doesNotMatch(await page.getByTestId('mailbox-item-body').textContent(), /影响/);
    // Opening another closes the first.
    await toggles.nth(2).click();
    assert.equal(await page.getByTestId('mailbox-item-body').count(), 1);
    assert.deepEqual(await toggles.evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded'))), [
      'false',
      'false',
      'true',
    ]);
    // A click on the work area behind the panel does not dismiss it.
    await page.mouse.click(1000, 400);
    assert.equal(await dialog.count(), 1);
    // The keyboard reaches and works the same controls.
    await toggles.nth(0).focus();
    await page.keyboard.press('Enter');
    assert.equal(await toggles.nth(0).getAttribute('aria-expanded'), 'true');
    assert.equal(await toggles.nth(2).getAttribute('aria-expanded'), 'false');
    // × closes it and focus returns to the rail button.
    await page.getByTestId('mailbox-close').click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await button.evaluate((el) => el === document.activeElement), true);
    assert.deepEqual(proof.errors, []);
  } finally {
    await closeProof(proof);
  }
});

test('a row whose action is a source message really goes there; one it cannot locate says so and opens its list', async () => {
  const reachable = judgmentRow('s1', '能直接去的一件', {
    action: { actionRef: 'message:thread-other:msg-9#block-1', expectedProducerRevision: 1 },
  });
  const unlocatable = judgmentRow('s2', '要在工作台里才能定位的一件', {
    action: { actionRef: '/api/meeting-intakes/p9/retry', expectedProducerRevision: 1 },
  });
  const proof = await openProof({
    unified: () => ({ body: unifiedRead({ items: [reachable, unlocatable], totalCount: 2 }) }),
    ready: '待办，2 件',
  });
  const { page } = proof;
  try {
    await page.getByTestId('mailbox-button').click();
    await page.getByRole('dialog', { name: '待办' }).waitFor();
    const toggles = page.getByTestId('mailbox-item-toggle');
    // The row the panel cannot find says so, and its button is named for what it opens.
    await toggles.nth(1).click();
    assert.equal(await page.getByTestId('mailbox-place-note').textContent(), '原处暂不可定位');
    assert.equal(await page.getByTestId('mailbox-open-original').textContent(), '打开待处理列表');
    assert.equal(await page.getByTestId('mailbox-open-original').getAttribute('data-place'), 'list');
    // The reachable row has no such note and runs the real navigation: the coordinate is stored by the real function
    // before it routes, and the panel closes because the user has left for the place.
    await toggles.nth(0).click();
    assert.equal(await page.getByTestId('mailbox-place-note').count(), 0);
    assert.equal(await page.getByTestId('mailbox-open-original').textContent(), '打开原处处理');
    assert.equal(await page.getByTestId('mailbox-open-original').getAttribute('data-place'), 'exact');
    await page.getByTestId('mailbox-open-original').click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(
      JSON.parse(await page.evaluate(() => sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1'))),
      { kind: 'message', threadId: 'thread-other', messageId: 'msg-9', blockId: 'block-1' },
    );
    assert.deepEqual(proof.errors, []);
  } finally {
    await closeProof(proof);
  }
});

// "Open the source" must end up at the source's conversation wherever the user is. The navigation function decides
// "already in this conversation" from the REMEMBERED thread (the fixture remembers thread-return, as the real app does
// after leaving a chat), not from the page, so from /settings or /memory it used to record the coordinate and stay put.
const PENDING_KEY = 'cat-cafe:f310:pending-source-action:v1';
const exactSource = (threadId) =>
  judgmentRow('src', '回到原卡的一件', {
    action: { actionRef: `message:${threadId}:msg-9#block-1`, expectedProducerRevision: 1 },
  });

async function openExact({ route, threadId }) {
  const proof = await openProof({
    route,
    unified: () => ({ body: unifiedRead({ items: [exactSource(threadId)], totalCount: 1 }) }),
    ready: '待办，1 件',
  });
  const { page } = proof;
  await page.evaluate(() => {
    window.__sameDocument = true; // survives pushState, is lost on a full page load
    window.__historyLength = history.length;
  });
  await page.getByTestId('mailbox-button').click();
  await page.getByTestId('mailbox-item-toggle').click();
  await page.getByTestId('mailbox-open-original').click();
  return proof;
}
const storedCoordinate = (page) => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), PENDING_KEY);

for (const route of ['/settings?from=thread-return', '/memory?from=thread-return']) {
  test(`an exact source in the remembered conversation still opens that conversation from ${route}`, async () => {
    const proof = await openExact({ route, threadId: 'thread-return' });
    try {
      await proof.page.waitForURL('**/thread/thread-return');
      assert.equal(new URL(proof.page.url()).pathname, '/thread/thread-return');
      // The coordinate (with its block) is stored for the conversation to reveal on arrival.
      assert.deepEqual(await storedCoordinate(proof.page), {
        kind: 'message',
        threadId: 'thread-return',
        messageId: 'msg-9',
        blockId: 'block-1',
      });
      assert.deepEqual(proof.errors, []);
    } finally {
      await closeProof(proof);
    }
  });
}

test('an exact source in another conversation opens that conversation from a page that is not a chat', async () => {
  const proof = await openExact({ route: '/settings?from=thread-return', threadId: 'thread-other' });
  try {
    await proof.page.waitForURL('**/thread/thread-other');
    assert.equal(new URL(proof.page.url()).pathname, '/thread/thread-other');
    assert.equal((await storedCoordinate(proof.page)).threadId, 'thread-other');
  } finally {
    await closeProof(proof);
  }
});

test('an exact source in the conversation you are in stays put: no new route, no new history entry, no reload', async () => {
  const proof = await openExact({ route: '/thread/thread-return', threadId: 'thread-return' });
  try {
    await proof.page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(new URL(proof.page.url()).pathname, '/thread/thread-return');
    assert.deepEqual(
      await proof.page.evaluate(() => [window.__sameDocument, history.length === window.__historyLength]),
      [true, true],
    );
    assert.equal((await storedCoordinate(proof.page)).blockId, 'block-1');
  } finally {
    await closeProof(proof);
  }
});

test('an exact source in another conversation, from a chat, moves there in the same page', async () => {
  const proof = await openExact({ route: '/thread/thread-return', threadId: 'thread-other' });
  try {
    await proof.page.waitForURL('**/thread/thread-other');
    assert.equal(await proof.page.evaluate(() => window.__sameDocument), true);
    assert.equal((await storedCoordinate(proof.page)).threadId, 'thread-other');
  } finally {
    await closeProof(proof);
  }
});

test('mailbox never claims a number it was not given, and a failed read can be retried', async () => {
  const proof = await openProof({
    unified: (attempt) =>
      attempt === 1
        ? { status: 503, raw: 'upstream down' }
        : {
            body: unifiedRead({
              items: [approvalRow('p1', '一件')],
              consistency: { state: 'uncertain', reasons: ['x'] },
              totalCount: undefined,
            }),
          },
    ready: '待办，暂不可用',
  });
  const { page } = proof;
  try {
    assert.equal(await page.getByTestId('rail-badge-alert').count(), 1);
    await page.getByTestId('mailbox-button').click();
    await page.getByTestId('mailbox-retry').click();
    // Rows exist but no totalCount was proven: a dot and "count unconfirmed", never a digit.
    await page.getByRole('button', { name: '待办，数量未确认', exact: true }).waitFor();
    assert.equal(await page.getByTestId('rail-badge-dot').count(), 1);
    assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
  } finally {
    await closeProof(proof);
  }
});

test('mailbox refuses rows that belong to someone other than the signed-in session', async () => {
  const proof = await openProof({
    unified: () => ({ body: unifiedRead({ items: [approvalRow('p1', '别人的一件')], totalCount: 1 }) }),
    session: { userId: 'someone-else' },
    ready: '待办，暂不可用',
  });
  const { page } = proof;
  try {
    await page.getByTestId('mailbox-button').click();
    await page.getByRole('dialog', { name: '待办' }).waitFor();
    assert.equal(await page.getByTestId('mailbox-item').count(), 0);
    assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
  } finally {
    await closeProof(proof);
  }
});

test('a login-required read dims the icon (still reachable) and shows no badge — never an empty-looking box', async () => {
  const proof = await openProof({
    unified: () => ({ status: 401, body: { error: 'Plugin read endpoint requires an authenticated owner session' } }),
    ready: '待办，需要登录',
  });
  const { page } = proof;
  try {
    const button = page.getByTestId('mailbox-button');
    assert.equal(await button.getAttribute('data-dimmed'), 'true');
    assert.equal(await page.locator('[data-testid^="rail-badge-"]').count(), 0);
    assert.equal(
      await button
        .locator('svg')
        .first()
        .evaluate((el) => getComputedStyle(el.parentElement).opacity),
      '0.4',
    );
    await button.click();
    assert.equal(await page.getByTestId('mailbox-state-text').textContent(), '需要登录');
  } finally {
    await closeProof(proof);
  }
});

test('a partly read mailbox shows the "!" in the danger colour, in light and dark, and says it has confirmed items', async () => {
  const proof = await openProof({
    unified: () => ({
      body: unifiedRead({
        status: 'partial',
        items: [approvalRow('p1', '读到的一件')],
        totalCount: undefined,
        sources: {
          approvals: unifiedSource(),
          needsMe: unifiedSource({ status: 'unavailable', exhaustiveness: 'unknown' }),
        },
      }),
    }),
    ready: '待办，仅部分读取 · 已确认有事',
  });
  const { page } = proof;
  try {
    assert.equal(await page.getByTestId('rail-badge-dot').count(), 0, 'part of the read missing is a "!", not a dot');
    const badge = page.getByTestId('rail-badge-alert');
    const colours = async () =>
      badge.evaluate((el) => ({
        mark: getComputedStyle(el).color,
        ring: getComputedStyle(el).borderTopColor,
        ink: getComputedStyle(document.body).color,
      }));
    const light = await colours();
    assert.equal(light.mark, light.ring, 'the "!" and its ring share the danger colour');
    assert.notEqual(light.mark, light.ink, 'the "!" is not the ink colour');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const dark = await colours();
    assert.notEqual(dark.mark, dark.ink);
    assert.notEqual(dark.mark, light.mark, 'dark theme maps its own danger value');
    await page.getByTestId('mailbox-button').click();
    assert.equal(await page.getByTestId('mailbox-source-note-needs-me').textContent(), '等你判断或修复：暂不可用');
  } finally {
    await closeProof(proof);
  }
});

test('avatar opens settings; all 14 sections remain reachable; old and dest: pins stay distinct above the mailbox', async () => {
  const proof = await openProof();
  const { page } = proof;
  try {
    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-v2').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('from'), 'thread-return');
    assert.equal(await page.getByTestId('settings-owner').getAttribute('data-section'), 'members');
    assert.equal(await page.locator('[data-testid^="settings-entry-"]').count(), 11);
    const sections = [];
    for (const entry of ['team', 'connect', 'system']) {
      await page.getByTestId(`settings-entry-${entry}`).click();
      sections.push(
        ...(await page
          .getByRole('tab')
          .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-testid').replace('settings-tab-', '')))),
      );
    }
    assert.deepEqual(
      sections.sort(),
      [
        'accounts',
        'concierge',
        'im',
        'marketplace',
        'mcp',
        'members',
        'notify',
        'ops',
        'plugins',
        'profiles',
        'rules',
        'skills',
        'system',
        'voice',
      ].sort(),
    );
    await page.getByRole('button', { name: '固定「系统」到侧栏', exact: true }).click();
    await page.getByTestId('rail-pin-dest-system').waitFor();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('cat-cafe:pinned-settings-sections'))), [
      'notify',
      'dest:system',
    ]);
    assert.deepEqual(
      await page
        .getByTestId('world-rail')
        .locator('[data-testid^="rail-pin-"], [aria-hidden="true"].h-px, [data-testid="mailbox-button"]')
        .evaluateAll((nodes) => nodes.map((el) => el.getAttribute('data-testid') ?? 'separator').slice(-4)),
      ['rail-pin-notify', 'rail-pin-dest-system', 'separator', 'mailbox-button'],
    );
    const pin = await page.getByTestId('rail-pin-dest-system').boundingBox(),
      mailbox = await page.getByTestId('mailbox-button').boundingBox();
    assert.ok(pin.y + pin.height < mailbox.y);
    await page.getByTestId('rail-pin-notify').click();
    await page.getByTestId('settings-owner').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('standalone'), '1');
    assert.equal(await page.getByTestId('settings-owner').getAttribute('data-section'), 'notify');
    await page.getByTestId('rail-pin-dest-system').click();
    await page.getByTestId('settings-v2').waitFor();
    assert.equal(await page.getByTestId('settings-owner').getAttribute('data-section'), 'system');
    await page.getByTestId('world-cafe').click();
    await page.getByTestId('conversation').waitFor();
    assert.equal(new URL(page.url()).pathname, '/thread/thread-return');
  } finally {
    await closeProof(proof);
  }
});

test('settings tabs support keyboard navigation and their selected content is associated', async () => {
  const proof = await openProof({ route: '/settings?from=thread-return' });
  const { page } = proof;
  try {
    await page.getByTestId('settings-tab-members').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(
      await page.getByTestId('settings-tab-profiles').evaluate((el) => el === document.activeElement),
      true,
      'Right Arrow must reach the next tab',
    );
    await page.keyboard.press('Enter');
    assert.equal(await page.getByTestId('settings-owner').getAttribute('data-section'), 'profiles');
    assert.equal(await page.getByRole('tabpanel').count(), 1, 'selected section needs a named tabpanel');
    const panelId = await page.getByRole('tabpanel').getAttribute('id');
    const tabId = await page.getByTestId('settings-tab-profiles').getAttribute('id');
    assert.ok(panelId && tabId);
    assert.equal(await page.getByTestId('settings-tab-profiles').getAttribute('aria-controls'), panelId);
    assert.equal(await page.getByRole('tabpanel').getAttribute('aria-labelledby'), tabId);
  } finally {
    await closeProof(proof);
  }
});

test('the workspace-team second-level destination can be pinned like the other settings items', async () => {
  const proof = await openProof({ route: '/settings?from=thread-return' });
  const { page } = proof;
  try {
    assert.equal(
      await page.getByRole('button', { name: '固定「成员能力与路由状态」到侧栏', exact: true }).count(),
      1,
      'every second-level destination needs its pin action',
    );
    await page.getByRole('button', { name: '固定「成员能力与路由状态」到侧栏', exact: true }).click();
    const pin = page.getByTestId('world-rail').getByRole('button', { name: '成员能力与路由状态', exact: true });
    await pin.waitFor();
    await page.getByTestId('settings-team-workspace').click();
    await page.getByTestId('conversation').waitFor();
    assert.equal(await page.getByTestId('workspace-mode').textContent(), 'team');
    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-entry-eval').click();
    await page.getByTestId('conversation').waitFor();
    assert.equal(await page.getByTestId('workspace-mode').textContent(), 'eval');
    await page.getByTestId('settings-button').click();
    await pin.click();
    await page.getByTestId('conversation').waitFor();
    assert.equal(new URL(page.url()).pathname, '/thread/thread-return');
    assert.equal(
      await page.getByTestId('workspace-mode').textContent(),
      'team',
      'the pin must open the same Workspace team owner',
    );
  } finally {
    await closeProof(proof);
  }
});

test('theme presentation choice can override a shell query that was already consumed', async () => {
  const proof = await openProof({ route: '/settings?s=theme&shell=v2&from=thread-return' });
  const { page } = proof;
  try {
    await page.getByTestId('shell-presentation-classic').click();
    await page.waitForTimeout(50);
    assert.equal(
      await page.getByTestId('world-rail').count(),
      0,
      'the URL is an initial selection, not a permanent lock',
    );
    assert.equal(await page.evaluate(() => document.documentElement.dataset.shell), undefined);
    assert.equal(await page.evaluate(() => localStorage.getItem('cat-cafe:shell-presentation')), 'classic');
  } finally {
    await closeProof(proof);
  }
});

test('the v2 conversation header is the real one: sidebar restore, 作品, 任务 and the Workspace toggle are named and work', async () => {
  const proof = await openProof();
  const { page } = proof;
  try {
    const header = page.locator('[data-shell-header="v2"]');
    await header.waitFor();
    // ThreadIndicator reads the exact thread through the real client, so the title proves the data path, not a stub.
    await header.getByText('返回原处的对话').waitFor();

    // The sidebar has its own collapse control; the header's only job is to bring a collapsed one back.
    const expand = page.getByRole('button', { name: '展开侧栏', exact: true });
    assert.equal(await expand.getAttribute('title'), null);
    await expand.click();
    assert.equal(await page.getByRole('button', { name: '展开侧栏', exact: true }).count(), 0);

    const works = page.getByTestId('header-works');
    assert.equal(await works.getAttribute('aria-label'), '作品，这条对话的作品');
    await works.click();
    assert.equal(await page.getByTestId('workspace-mode').textContent(), 'artifacts');
    const worksToggle = page.getByTestId('workspace-panel-toggle');
    assert.equal(await worksToggle.getAttribute('aria-label'), '收起 Workspace');
    await worksToggle.click();
    assert.equal(await worksToggle.getAttribute('aria-label'), '打开 Workspace');

    const tasks = page.getByTestId('header-tasks');
    // No tasks are loaded: zero stays unnumbered, because "not loaded yet" and "none" are indistinguishable there.
    assert.equal(await tasks.getAttribute('aria-label'), '任务，这条对话的任务');
    await tasks.click();
    assert.equal(await page.getByTestId('workspace-mode').textContent(), 'tasks');

    // 作品 and 任务 recall the Workspace, so the header's own toggle must already say it can be closed.
    const toggle = page.getByTestId('workspace-panel-toggle');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="workspace-panel-toggle"]')?.getAttribute('data-client-interactive') ===
        'true',
    );
    assert.equal(await toggle.getAttribute('aria-label'), '收起 Workspace');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-label'), '打开 Workspace');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-label'), '收起 Workspace');

    // The header's own controls are named by the 150ms tooltip and the accessible name, never the ~1s native title.
    // (ThreadIndicator's two secondary hints — rename and copy path — are still native titles; see the PR notes.)
    for (const control of [works, tasks, toggle]) assert.equal(await control.getAttribute('title'), null);
  } finally {
    await closeProof(proof);
  }
});

// ---- S3-2b-1c: an approval decided in the 待办 panel through its ORIGINAL card ----------------------------------------------
// The card is the Approval Hub's own, acting through its own store and endpoint. The panel only locks it while what it shows
// may not be true, and states what a re-read of BOTH sources proved. Every request is answered by a small fake server whose
// single switch (`decide`) is "the decision really happened"; the cells then assert on the request log as much as on the page.
const hostableApproval = (id, summary) => ({
  proposalId: id,
  sourceFeatureId: 'F128',
  requesterCatId: 'opus',
  summary,
  detail: {},
  // Fixed, not Date.now(): the panel's copy and the Approval Hub's copy must be the same decision, so both come from here.
  createdAt: 1_700_000_000_000,
  resolution: 'open',
  materialization: { state: 'not_started' },
  inlineApprovable: true,
  navigation: {
    state: 'anchored',
    originRef: { kind: 'message', threadId: 'thread-other', messageId: 'origin-message' },
    approvalCardRef: { threadId: 'thread-other', messageId: 'approval-card' },
  },
});
const hostableRow = (id, summary) => ({
  decisionRef: `approval:F128:${id}`,
  kind: 'approval',
  summary,
  approval: hostableApproval(id, summary),
  linkedNeedsMe: [],
});
function approvalServer({ summary = '记一条品味', storeHasIt = true } = {}) {
  const state = {
    listed: true,
    storeHasIt,
    settled: [],
    posts: [],
    approveReply: () => ({ body: { ok: true } }),
  };
  const decide = () => {
    state.listed = false;
    state.settled = [
      {
        proposalId: 'p1',
        sourceFeatureId: 'F128',
        ownerUserId: 'owner-1',
        resolution: 'accepted',
        decidedAt: 1_700_000_100_000,
        decidedBy: 'owner-1',
      },
    ];
  };
  const listing = () => ({
    body: unifiedRead({
      items: state.listed ? [hostableRow('p1', summary)] : [],
      totalCount: state.listed ? 1 : 0,
    }),
  });
  const api = ({ request, url }) => {
    if (url.pathname === '/api/approval-hub/pending') {
      const items =
        state.listed && state.storeHasIt ? [{ ...hostableApproval('p1', summary), ownerUserId: 'owner-1' }] : [];
      return { body: { items, count: items.length } };
    }
    if (url.pathname === '/api/approval-hub/settled')
      return { body: { items: state.settled, count: state.settled.length } };
    if (request.method() === 'POST' && url.pathname.endsWith('/p1/approve')) {
      state.posts.push(url.pathname);
      return state.approveReply();
    }
    return null;
  };
  return { state, decide, listing, api };
}
const unifiedReads = (requests) => requests.filter((entry) => entry.includes('/api/concierge/work/decisions'));
const afterTheWrite = (requests) => requests.slice(requests.findIndex((entry) => /^POST .*\/p1\/approve$/.test(entry)));
async function openApprovalRow(page) {
  await page.getByTestId('mailbox-button').click();
  await page.getByTestId('mailbox-item-toggle').click();
  await page.getByTestId('approve-btn').waitFor();
}

// Where a decision's session speaks: in the open card, or on the row's own line when a re-read has closed the row.
const SESSION_TEXT = '[data-testid="mailbox-approval-result"], [data-testid="mailbox-row-session-line"]';
const waitForSessionText = (page, expected) =>
  page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent === expected, {
    selector: SESSION_TEXT,
    expected,
  });
const reread = (page) =>
  page.locator('[data-testid="mailbox-row-reread"], [data-testid="mailbox-approval-reread"]').first().click();

test('an approval is approved on its original card inside 待办; 已批准 is claimed only after both sources are re-read', async () => {
  const server = approvalServer();
  server.state.approveReply = () => {
    server.decide();
    return { body: { ok: true } };
  };
  const proof = await openProof({ unified: server.listing, api: server.api, ready: '待办，1 件' });
  const { page, requests } = proof;
  try {
    await openApprovalRow(page);
    // The original card, under the Approval Hub's own test ids; the panel adds one quiet way back to the place.
    assert.equal(await page.getByTestId('reject-btn').count(), 1);
    assert.equal(await page.getByTestId('mailbox-open-original').count(), 1);
    await page.getByTestId('approve-btn').click();
    await page.getByTestId('mailbox-retained-result').waitFor();
    assert.match(await page.getByTestId('mailbox-retained-line').textContent(), /已批准/);
    // One write, sent by the original store to the producer's own endpoint; the panel never repeated it.
    assert.equal(server.state.posts.length, 1);
    // After it: a new unified read, a store refresh and the settled history, in that the write came first.
    const after = afterTheWrite(requests);
    assert.ok(after.some((entry) => entry.includes('/api/concierge/work/decisions')));
    assert.ok(after.some((entry) => entry.includes('/api/approval-hub/pending')));
    assert.ok(after.some((entry) => entry.includes('/api/approval-hub/settled')));
    // The decided card is gone; the result stands alone and is dismissable. It is not a number: the rail says what was read.
    assert.equal(await page.getByTestId('approve-btn').count(), 0);
    await page.getByTestId('mailbox-retained-dismiss').click();
    assert.equal(await page.getByTestId('mailbox-retained-result').count(), 0);
  } finally {
    await closeProof(proof);
  }
});

test('a lost connection is unknown, never "not approved": the user re-reads, and the write is never repeated', async () => {
  const server = approvalServer();
  server.state.approveReply = () => ({ abort: true });
  const proof = await openProof({ unified: server.listing, api: server.api, ready: '待办，1 件' });
  const { page } = proof;
  try {
    await openApprovalRow(page);
    await page.getByTestId('approve-btn').click();
    // The read after the write still lists it and the store agrees: still open, said without claiming a failure.
    await waitForSessionText(page, '没能确认提交结果，重新读取后仍待决定');
    assert.equal(server.state.posts.length, 1);
    // Meanwhile the decision did land on the server (the response was lost). A re-read the user asks for finds the row.
    server.decide();
    await reread(page);
    await page.getByTestId('mailbox-retained-result').waitFor();
    assert.match(await page.getByTestId('mailbox-retained-line').textContent(), /已批准/);
    assert.equal(server.state.posts.length, 1);
  } finally {
    await closeProof(proof);
  }
});

test('a 403 is "没有权限": the card is held, nothing is re-read on its own, and the user can read again', async () => {
  const server = approvalServer();
  server.state.approveReply = () => ({ status: 403, body: { error: 'forbidden' } });
  const proof = await openProof({ unified: server.listing, api: server.api, ready: '待办，1 件' });
  const { page, requests } = proof;
  try {
    await openApprovalRow(page);
    const readsBefore = unifiedReads(requests).length;
    await page.getByTestId('approve-btn').click();
    await waitForSessionText(page, '没有权限');
    assert.equal(await page.getByTestId('approve-btn').isDisabled(), true);
    assert.equal(unifiedReads(requests).length, readsBefore);
    // The user asks to read again; it is still open, and the earlier answer is still worded as what it was.
    await reread(page);
    await waitForSessionText(page, '请求返回异常，重新读取后仍待决定');
    assert.equal(server.state.posts.length, 1);
  } finally {
    await closeProof(proof);
  }
});

test('a 409 that leaves the approval open is confirmed by a re-read, not reported as a failure, and the card works again', async () => {
  const server = approvalServer();
  server.state.approveReply = () => ({ status: 409, body: { error: 'conflict' } });
  const proof = await openProof({ unified: server.listing, api: server.api, ready: '待办，1 件' });
  const { page } = proof;
  try {
    await openApprovalRow(page);
    await page.getByTestId('approve-btn').click();
    await waitForSessionText(page, '请求返回异常，重新读取后仍待决定');
    assert.equal(server.state.posts.length, 1);
    // The re-read closed the row; opening it again shows the same decision on both sides, so the card may act again,
    // by the user's own press. The panel did not repeat the write.
    await page.getByTestId('mailbox-item-toggle').click();
    await page.getByTestId('approve-btn').waitFor();
    assert.equal(await page.getByTestId('approve-btn').isDisabled(), false);
    await page.getByTestId('approve-btn').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="approve-btn"]') !== null);
    assert.equal(server.state.posts.length, 2);
  } finally {
    await closeProof(proof);
  }
});

test('an approval the Approval Hub no longer holds is read-only here, says why, and keeps the way to its original place', async () => {
  const server = approvalServer({ storeHasIt: false });
  const proof = await openProof({ unified: server.listing, api: server.api, ready: '待办，1 件' });
  const { page } = proof;
  try {
    await page.getByTestId('mailbox-button').click();
    await page.getByTestId('mailbox-item-toggle').click();
    await page.getByTestId('mailbox-approval-unmatched').waitFor();
    assert.equal(await page.getByTestId('mailbox-approval-unmatched').getAttribute('data-reason'), 'not_in_store');
    assert.equal(await page.getByTestId('approve-btn').count(), 0);
    assert.equal(server.state.posts.length, 0);
    await page.getByTestId('mailbox-open-original').click();
    assert.equal(await page.getByRole('dialog').count(), 0);
  } finally {
    await closeProof(proof);
  }
});

test('while the re-read is slow nothing is claimed: no card to press, no result, only what the read proves once it lands', async () => {
  const server = approvalServer();
  server.state.approveReply = () => {
    server.decide();
    return { body: { ok: true } };
  };
  let release = () => undefined;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  // Read 1 is the mount read; read 2 is the one the write starts, and it is slow. (Same-URL reads do not overtake each
  // other: the transport waits for a read already out before sending the next, so a late older answer cannot arrive.)
  const unified = async (attempt) => {
    if (attempt === 2) await slow;
    return server.listing();
  };
  const proof = await openProof({ unified, api: server.api, ready: '待办，1 件' });
  const { page } = proof;
  try {
    await openApprovalRow(page);
    await page.getByTestId('approve-btn').click();
    await waitForSessionText(page, '已提交，正在确认结果…');
    // The decision is on the server, but the panel has not read it: it claims nothing, and the previous read has no actions.
    assert.equal(await page.getByTestId('mailbox-retained-result').count(), 0);
    assert.equal(await page.getByTestId('approve-btn').count(), 0);
    assert.equal(await page.getByTestId('mailbox-row-reread').count(), 0);
    release();
    await page.getByTestId('mailbox-retained-result').waitFor();
    assert.match(await page.getByTestId('mailbox-retained-line').textContent(), /已批准/);
    assert.equal(server.state.posts.length, 1);
  } finally {
    await closeProof(proof);
  }
});

test('an approval that left the list with no settled row is "结果待确认", never 已批准, until the history says so', async () => {
  const server = approvalServer();
  // The write is accepted and the approval is gone from the Approval Hub's pending list and the unified read, but the settled
  // history has no row for it yet. The store's optimistic removal and the page's absence both say "gone"; neither says "decided".
  server.state.approveReply = () => {
    server.state.listed = false;
    return { body: { ok: true } };
  };
  const proof = await openProof({ unified: server.listing, api: server.api, ready: '待办，1 件' });
  const { page } = proof;
  try {
    await openApprovalRow(page);
    await page.getByTestId('approve-btn').click();
    await page.getByTestId('mailbox-retained-result').waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="mailbox-retained-line"]')?.textContent === '已不在当前待办，结果待确认',
    );
    assert.equal((await page.getByTestId('mailbox-panel').textContent()).includes('已批准'), false);
    // Not a result the user can wave away as done: it stays, and offers the re-read.
    assert.equal(await page.getByTestId('mailbox-retained-dismiss').count(), 1);
    server.state.settled = [
      {
        proposalId: 'p1',
        sourceFeatureId: 'F128',
        ownerUserId: 'owner-1',
        resolution: 'accepted',
        decidedAt: 1_700_000_100_000,
        decidedBy: 'owner-1',
      },
    ];
    await page.getByTestId('mailbox-retained-reread').click();
    await page.waitForFunction(() =>
      /已批准/.test(document.querySelector('[data-testid="mailbox-retained-line"]')?.textContent ?? ''),
    );
    assert.equal(server.state.posts.length, 1);
  } finally {
    await closeProof(proof);
  }
});
