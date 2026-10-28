import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { runChatRealPageJourney } from './f322-chat-real-page.mjs';
import { runGroupPeekJourney } from './f322-group-peek.journey.mjs';
import { runPianoJourneys } from './f322-piano.journey.mjs';
import { runNativeSidebarReadingJourney, runSidebarReadingJourney } from './f322-sidebar-reading.journey.mjs';
import { runSidebarV2Journey } from './f322-sidebar-v2.journey.mjs';
import { registerMentionCutoverJourney } from './f322-user-mention-cutover.journey.mjs';
import { registerUserMentionJourney } from './f322-user-mention-todo.journey.mjs';
import { visibleAttentionFixture } from './f322-visible-attention.fixture.mjs';
import { registerWorkspaceMenuTests } from './f322-workspace-menu.journey.mjs';

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
  const connectedBeforeClose = browser?.isConnected() ?? false;
  await browser?.close();
  if (process.env.F322_MENU_EVIDENCE_DIR) {
    mkdirSync(process.env.F322_MENU_EVIDENCE_DIR, { recursive: true });
    writeFileSync(
      path.join(process.env.F322_MENU_EVIDENCE_DIR, 'shared-browser-cleanup.json'),
      JSON.stringify({ connectedBeforeClose, sharedBrowserClosed: !browser?.isConnected() }),
    );
  }
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
const unifiedRead = (overrides = {}) =>
  visibleAttentionFixture({
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: 'owner-1' },
    observedAt: 3,
    sources: {
      approvals: unifiedSource(),
      needsMe: unifiedSource({ coverage: 'current_linked_F310_five_producers' }),
      structuredChoices: unifiedSource({ coverage: 'pending_f306_structured_choices' }),
    },
    readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items: [],
    totalCount: 0,
    attentionCount: (overrides.items ?? []).filter(
      (item) => item.approval?.resolution === 'open' || item.choiceRequest !== undefined,
    ).length,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
    ...overrides,
  });
const approvalRow = (id, summary) => ({
  decisionRef: `approval:F221:${id}`,
  kind: 'approval',
  summary,
  approval: {
    proposalId: id,
    sourceFeatureId: 'F221',
    requesterCatId: 'opus',
    summary,
    detail: {},
    ownerUserId: 'owner-1',
    navigation: { state: 'legacy_unanchored' },
    inlineApprovable: false,
    createdAt: Date.now() - 2 * 3600_000,
    resolution: 'open',
  },
  linkedNeedsMe: [],
});
const s5Config = (cliOutput = 'collapsed') => ({
  cats: {},
  perCatCapacities: {},
  a2a: { enabled: true, maxDepth: 3 },
  memory: { enabled: true, maxKeysPerThread: 50 },
  governance: { degradationEnabled: true, doneTimeoutMs: 1, heartbeatIntervalMs: 1 },
  ui: { bubbleDefaults: { thinking: 'collapsed', cliOutput } },
});
const installPreview = {
  profile: {
    os: 'darwin',
    arch: 'arm64',
    gpu: 'none',
    pythonArch: 'native',
    ramGb: 16,
    diskFreeGb: 40,
    detectedAt: 1,
  },
  recommendation: {
    serviceId: 'fixture-service',
    profile: {
      os: 'darwin',
      arch: 'arm64',
      gpu: 'none',
      pythonArch: 'native',
      ramGb: 16,
      diskFreeGb: 40,
      detectedAt: 1,
    },
    models: [
      {
        name: 'owner/fixture-model',
        size: '2 GB',
        description: '服务数据保持原样',
        requirements: { ramGb: 4, diskGb: 3, gpu: 'recommended' },
        performance: 'Provider data',
      },
    ],
    notes: ['Fixture note'],
  },
  suggestedPort: 18888,
};

async function openProof({
  pins = ['notify'],
  shell = 'v2',
  language = 'zh',
  route = '/thread/thread-return',
  viewport = { width: 1440, height: 900 },
  participantCount = 2,
  retainedApproval = false,
  // Called once per unified read, with the 1-based attempt number; returns { status?, body, raw? } (may be async: a slow read).
  unified = () => ({ body: unifiedRead() }),
  // Offered every other /api request first; returns { status?, body, raw?, abort? } to answer it, or null to fall through.
  api = () => null,
  session = { userId: 'owner-1' },
  ready = language === 'en' ? 'To-do, None' : '待办，暂无',
} = {}) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5_000);
  const errors = [],
    requests = [],
    unexpected = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ pins, shell, language, participantCount, retainedApproval }) => {
      localStorage.setItem('cat-cafe:shell-presentation', shell);
      localStorage.setItem('cat-cafe:shell-language', language);
      localStorage.setItem('cat-cafe:pinned-settings-sections', JSON.stringify(pins));
      window.__F322_PARTICIPANT_COUNT__ = participantCount;
      window.__F322_RETAINED_APPROVAL__ = retainedApproval;
    },
    { pins, shell, language, participantCount, retainedApproval },
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
        const reply = await unified(
          requests.filter((entry) => entry.includes('/api/concierge/work/decisions')).length,
          { request, url },
        );
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
      // Non-mention scenarios have no handling receipt. Real-owner journeys override
      // this exact GET via `api`; every other unknown endpoint still fails closeProof.
      if (request.method() === 'GET' && url.pathname === '/api/config/ignored-items') {
        return handler.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ownerUserId: session.userId, revision: 0, entries: [] }),
        });
      }
      if (request.method() === 'GET' && url.pathname === '/api/approval-hub/settled') {
        return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [], count: 0 }) });
      }
      if (request.method() === 'GET' && url.pathname === '/api/concierge/work/mentions/last-handling') {
        return handler.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ownerUserId: 'owner-1', receipt: null }),
        });
      }
      if (
        request.method() === 'GET' &&
        ['/api/threads/thread-return/artifacts', '/api/threads/thread-other/artifacts'].includes(url.pathname) &&
        url.search === '?view=works'
      ) {
        return handler.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ view: 'works', artifacts: [], total: 0, complete: true, workLineage: 'resolved' }),
        });
      }
      // Read-only legacy taste rows now mount their original owner's status read.
      // Keep the unknown-endpoint assertion strict; only this explicit fixture is admitted.
      if (request.method() === 'GET' && url.pathname === '/api/taste-proposals/p1') {
        return handler.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ proposalId: 'p1', status: 'pending' }),
        });
      }
      const bodies = {
        '/api/session': session,
        '/api/config/ignored-items': { ownerUserId: session.userId, revision: 0, entries: [] },
        '/api/approval-hub/pending': { items: [], count: 0 },
        // The classic presentation (reached by the theme test) still reads Needs Me for its own rail.
        '/api/entrusted-work/needs-me': { ownerReads: [], coverage: { state: 'complete' } },
        // The v2 conversation header's own reads (ThreadIndicator, DaemonActiveIndicator, cat roster).
        '/api/threads/thread-return': { id: 'thread-return', title: '返回原处的对话', projectPath: '/work/fixture' },
        '/api/threads/thread-return/active-pane': { active: false },
        // A second conversation, for "open the source in another conversation".
        '/api/threads/thread-other': { id: 'thread-other', title: '另一个对话', projectPath: '/work/fixture' },
        '/api/threads/thread-other/active-pane': { active: false },
        '/api/cats': {
          cats: [
            {
              id: 'opus',
              carrier: 'cli',
              displayName: '布偶猫',
              color: { primary: '#7966a8', secondary: '#eeeaf8' },
              avatar: '/shell/catball-E-28px.png',
            },
            {
              id: 'glm52',
              carrier: 'cli',
              displayName: '狸花猫',
              variantLabel: 'GLM-5.2',
              color: { primary: '#9b744f', secondary: '#f3eadf' },
              avatar: '/shell/catball-E-28px.png',
            },
          ],
        },
        '/api/config/cat-order': { catOrder: [] },
        '/api/config/conversation-view': {
          stored: null,
          effective: { mode: 'group' },
          source: 'product',
        },
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

registerUserMentionJourney({ test, openProof, closeProof });

test('background approvals cannot open the mailbox during memory or thread navigation', async () => {
  const proof = await openProof({ retainedApproval: true });
  const { page } = proof;
  try {
    assert.equal(await page.getByTestId('mailbox-panel').count(), 0);
    await page.getByTestId('mailbox-button').click();
    await page.getByTestId('mailbox-close').click();
    await page.getByRole('button', { name: 'Proof: memory', exact: true }).click();
    await page.waitForURL('**/memory?from=thread-return');
    assert.equal(await page.getByTestId('mailbox-panel').count(), 0);
    await page.getByRole('button', { name: 'Proof: thread', exact: true }).click();
    await page.waitForURL('**/thread/thread-return?proof=other');
    assert.equal(await page.getByTestId('mailbox-panel').count(), 0);
    await page.getByRole('button', { name: 'Proof: restore visible approval', exact: true }).click();
    assert.equal(await page.getByTestId('mailbox-panel').count(), 0);
    await page.getByRole('button', { name: '在待办中打开', exact: true }).click();
    await page.getByTestId('mailbox-panel').waitFor();
    await page.getByTestId('mailbox-close').click();
    await page.getByRole('button', { name: '在待办中打开', exact: true }).click();
    await page.getByTestId('mailbox-panel').waitFor();
  } finally {
    await closeProof(proof);
  }
});

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
    assert.equal(await page.getByRole('tooltip').textContent(), '打开伴随对话');
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
    assert.equal(await page.getByTestId('mailbox-group-decisions').locator('p').textContent(), '暂无等你决定的事');
    assert.equal(await page.getByTestId('mailbox-group-mentions').locator('p').textContent(), '暂无 @你 请求');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByTestId('mailbox-button').evaluate((el) => el === document.activeElement), true);
  } finally {
    await closeProof(proof);
  }
});

test('mailbox shows all real rows while the badge counts only qualified decisions', async () => {
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
    ready: '待办，1 件',
  });
  const { page } = proof;
  try {
    assert.equal(await page.getByTestId('rail-badge-count').textContent(), '1');
    assert.ok(
      proof.requests.includes(
        'GET /api/concierge/work/decisions?view=unified&includeUserMentions=true&offset=0&limit=20&personalView=visible',
      ),
    );
    await page.getByTestId('mailbox-button').click();
    await page.getByRole('dialog', { name: '待办' }).waitFor();
    const rows = page.getByTestId('mailbox-item');
    assert.equal(await rows.count(), 2);
    assert.deepEqual(await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-kind-label'))), [
      '品味',
      '等你判断',
    ]);
    assert.equal(
      await page.getByTestId('mailbox-panel').evaluate((el) => el.contains(document.activeElement)),
      true,
      'opening revalidates the rows; focus stays inside the panel while old rows are disabled',
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
    ready: '待办，1 件',
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
    // The entry navigation counts qualified decisions; every other row remains in its group.
    assert.equal(await page.getByRole('tab').count(), 0);
    assert.equal(await page.getByRole('navigation', { name: '待办入口', exact: true }).count(), 1);
    assert.equal(await page.getByTestId('mailbox-tab-needs-me').getAttribute('aria-current'), 'page');
    assert.equal(await page.getByTestId('mailbox-tab-count').textContent(), '1');
    assert.equal((await page.getByTestId('mailbox-tab-needs-me').textContent())?.replace(/\s/g, ''), '需要我处理1');

    // Native taste is directly rendered; only the two entrusted judgments expand.
    const judgments = page.getByTestId('mailbox-item').filter({ has: page.getByTestId('mailbox-item-toggle') });
    const toggles = judgments.getByTestId('mailbox-item-toggle');
    assert.deepEqual(await toggles.evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded'))), [
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
    await toggles.nth(0).click();
    assert.equal(await page.getByTestId('mailbox-detail-recommendation').textContent(), '建议 用 v3：招牌更亮');
    assert.equal(await page.getByTestId('mailbox-detail-goal').textContent(), '目标 下周会议封面');
    assert.equal(await page.getByTestId('mailbox-detail-prepared').textContent(), '成果 准备好的作品');
    assert.equal(await page.getByTestId('mailbox-open-original').count(), 1);
    assert.doesNotMatch(await judgments.getByTestId('mailbox-item-body').textContent(), /影响/);
    // Opening another closes the first.
    await toggles.nth(1).click();
    assert.equal(await judgments.getByTestId('mailbox-item-body').count(), 1);
    assert.deepEqual(await toggles.evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded'))), [
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
    assert.equal(await toggles.nth(1).getAttribute('aria-expanded'), 'false');
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
    ready: '待办，暂无',
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
    ready: '待办，暂无',
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
  let unavailable = true;
  const proof = await openProof({
    unified: () =>
      unavailable
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
    await page.getByTestId('mailbox-retry').waitFor();
    unavailable = false;
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
    await page.getByTestId('mailbox-state-text').filter({ hasText: '需要登录' }).waitFor();
    assert.equal(await page.getByTestId('mailbox-state-text').textContent(), '需要登录');
    assert.equal(await button.getAttribute('data-dimmed'), 'true');
    assert.equal(await page.locator('[data-testid^="rail-badge-"]').count(), 0);
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
    await page.getByRole('button', { name: '固定「系统」到窄栏', exact: true }).click();
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

test('v2 System saves Activity default and the install preview follows English while preserving service data', async () => {
  let savedDefault = 'collapsed';
  const proof = await openProof({
    route: '/settings?s=system',
    language: 'en',
    api: ({ request, url }) => {
      if (url.pathname === '/api/config' && request.method() === 'PATCH') {
        savedDefault = request.postDataJSON().value;
        return { body: { config: s5Config(savedDefault) } };
      }
      if (url.pathname === '/api/services/fixture-service/install-preview') return { body: installPreview };
      return null;
    },
  });
  const { page, requests } = proof;
  try {
    await page.getByRole('heading', { name: 'Activity default', exact: true }).waitFor();
    assert.equal(await page.getByTestId('execution-record-default-collapsed').isChecked(), true);
    await page.getByTestId('execution-record-default-expanded').click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="execution-record-default-expanded"]')?.checked === true,
    );
    assert.equal(savedDefault, 'expanded');
    assert.ok(requests.includes('PATCH /api/config'));

    await page.getByTestId('open-install-preview').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Install Fixture Service', exact: true }).waitFor();
    await dialog.getByText('Detected environment', { exact: true }).waitFor();
    assert.equal(await dialog.getByText('Service port', { exact: true }).count(), 1);
    assert.equal(await dialog.getByRole('button', { name: 'Start installation', exact: true }).count(), 1);
    assert.equal(await dialog.getByText('服务数据保持原样', { exact: true }).count(), 1);
    assert.equal(await dialog.getByText('· Fixture note', { exact: true }).count(), 1);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
  } finally {
    await closeProof(proof);
  }
});

test('classic System does not mount Activity default and keeps the install preview Chinese in English preference', async () => {
  const proof = await openProof({
    route: '/settings?s=system',
    shell: 'classic',
    language: 'en',
    api: ({ url }) =>
      url.pathname === '/api/services/fixture-service/install-preview' ? { body: installPreview } : null,
  });
  const { page } = proof;
  try {
    await page.getByTestId('settings-owner').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Activity default', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: '执行记录默认', exact: true }).count(), 0);
    await page.getByTestId('open-install-preview').click();
    const heading = page.getByRole('heading', { name: '安装 Fixture Service', exact: true });
    await heading.waitFor();
    const dialog = heading.locator('xpath=../..');
    await dialog.getByText('检测到的环境', { exact: true }).waitFor();
    assert.equal(await dialog.getByText('服务端口', { exact: true }).count(), 1);
    assert.equal(await dialog.getByRole('button', { name: '开始安装', exact: true }).count(), 1);
    assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).count(), 1);
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
      await page.getByTestId('settings-tab-accounts').evaluate((el) => el === document.activeElement),
      true,
      'Right Arrow must reach the next tab',
    );
    await page.keyboard.press('Enter');
    assert.equal(await page.getByTestId('settings-owner').getAttribute('data-section'), 'accounts');
    assert.equal(await page.getByRole('tabpanel').count(), 1, 'selected section needs a named tabpanel');
    const panelId = await page.getByRole('tabpanel').getAttribute('id');
    const tabId = await page.getByTestId('settings-tab-accounts').getAttribute('id');
    assert.ok(panelId && tabId);
    assert.equal(await page.getByTestId('settings-tab-accounts').getAttribute('aria-controls'), panelId);
    assert.equal(await page.getByRole('tabpanel').getAttribute('aria-labelledby'), tabId);
  } finally {
    await closeProof(proof);
  }
});

test('the workspace-team second-level destination can be pinned like the other settings items', async () => {
  const proof = await openProof({ route: '/settings?from=thread-return', pins: [] });
  const { page } = proof;
  try {
    assert.equal(await page.getByTestId('world-rail').locator('[data-testid^="rail-pin-"]').count(), 0);
    await page.getByRole('button', { name: '固定「成员与运行时」到窄栏', exact: true }).click();
    const members = page.getByTestId('rail-pin-members');
    await members.locator('[data-hub-icon="paw"]').waitFor();
    const collective = page.getByTestId('world-add');
    assert.notDeepEqual(
      await members.locator('path').evaluateAll((paths) => paths.map((node) => node.getAttribute('d'))),
      await collective.locator('path').evaluateAll((paths) => paths.map((node) => node.getAttribute('d'))),
    );
    if (process.env.F322_MENU_EVIDENCE_DIR) {
      mkdirSync(process.env.F322_MENU_EVIDENCE_DIR, { recursive: true });
      await page
        .getByTestId('world-rail')
        .screenshot({ path: path.join(process.env.F322_MENU_EVIDENCE_DIR, 'world-rail-member-paw.png') });
      await page.screenshot({ path: path.join(process.env.F322_MENU_EVIDENCE_DIR, 'world-rail-member-paw-1440.png') });
    }
    assert.equal(
      await page.getByRole('button', { name: '固定「成员能力与路由状态」到窄栏', exact: true }).count(),
      1,
      'every second-level destination needs its pin action',
    );
    await page.getByRole('button', { name: '固定「成员能力与路由状态」到窄栏', exact: true }).click();
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
    assert.equal(await works.getAttribute('aria-label'), '作品 0，这条对话的作品');
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

async function captureHeaderKeyboard(page, width, language) {
  const directory = process.env.F322_CHAT_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `header-keyboard-${width}-${language}.png`), fullPage: true });
  const controls = await page.locator('[data-shell-header="v2"] button').evaluateAll((buttons) =>
    buttons.map((button) => ({
      id: button.getAttribute('data-testid'),
      name: button.getAttribute('aria-label'),
      box: button.getBoundingClientRect().toJSON(),
    })),
  );
  writeFileSync(path.join(directory, `header-keyboard-${width}-${language}.json`), JSON.stringify(controls, null, 2));
}

test('the complete header stays in its real shell pane through keyboard navigation', async (t) => {
  for (const [width, language, paneWidth = width - 52] of [
    [320, 'zh'],
    [320, 'en'],
    [390, 'en'],
    [1440, 'en'],
    [1440, 'en', 268],
  ]) {
    await t.test(`${width}px ${language}, ${paneWidth}px pane`, async () => {
      const proof = await openProof({
        viewport: { width, height: 900 },
        language,
        ready: language === 'en' ? 'Works 0, Works in this conversation' : '作品 0，这条对话的作品',
      });
      const { page } = proof;
      try {
        const header = page.locator('[data-shell-header="v2"]');
        await header.waitFor();
        // Model the host's narrow desktop Chat pane without changing its controls.
        await header.evaluate((element, size) => {
          element.style.width = `${size}px`;
        }, paneWidth);
        const controls = [
          'header-sidebar-expand',
          'conversation-view-menu-toggle',
          'thread-settings-toggle',
          'message-search-entry',
          'header-works',
          'header-tasks',
          'workspace-panel-toggle',
        ];
        const before = await header.boundingBox();
        const bodyBefore = await page.getByTestId('conversation').boundingBox();
        assert.equal(before.x, 52, 'the real world rail consumes 52px of the viewport');
        assert.equal(before.width, paneWidth);
        const evidenceSize = `${width}-pane-${paneWidth}`;
        await captureHeaderKeyboard(page, evidenceSize, language);
        let previousRight = before.x;
        for (const id of controls) {
          const button = await page.getByTestId(id).boundingBox();
          assert.ok(button);
          assert.ok(button.width >= 28, `${id} retains its usable width`);
          assert.ok(button.x >= previousRight, `${id} does not overlap the previous control`);
          previousRight = button.x + button.width;
          assert.ok(
            button.x >= before.x && button.x + button.width <= before.x + before.width,
            `${id} fits the header`,
          );
          assert.equal(
            await page.getByTestId(id).evaluate((element) => {
              const box = element.getBoundingClientRect();
              return (
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === element
              );
            }),
            true,
            `${id} receives pointer input at its center`,
          );
        }
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        const reached = new Set();
        for (let step = 0; step < 80 && reached.size < controls.length; step++) {
          await page.keyboard.press('Tab');
          const id = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
          if (controls.includes(id)) reached.add(id);
          assert.equal((await header.boundingBox()).x, before.x, `Tab ${step + 1}: header must not pan`);
          assert.equal(
            (await page.getByTestId('conversation').boundingBox()).x,
            bodyBefore.x,
            `Tab ${step + 1}: body must not pan`,
          );
        }
        assert.deepEqual([...reached].sort(), [...controls].sort());
        await captureHeaderKeyboard(page, evidenceSize, language);
      } finally {
        await closeProof(proof);
      }
    });
  }
});

test('the v2 header keeps the conversation view honest and inside a narrow viewport', async () => {
  const proof = await openProof({
    viewport: { width: 390, height: 860 },
    ready: '作品 0，这条对话的作品',
    api: ({ request, url }) => {
      if (url.pathname !== '/api/config/conversation-view') return null;
      if (request.method() === 'PUT') {
        assert.deepEqual(request.postDataJSON(), { threadId: 'thread-return', view: { mode: 'group' } });
        return { body: { stored: { mode: 'group' }, effective: { mode: 'group' }, source: 'thread' } };
      }
      return {
        body: {
          stored: { mode: 'cat', catId: 'opus' },
          effective: { mode: 'cat', catId: 'opus' },
          source: 'thread',
        },
      };
    },
  });
  const { page } = proof;
  try {
    const toggle = page.getByTestId('conversation-view-menu-toggle');
    await toggle.waitFor();
    assert.match(await toggle.textContent(), /群聊/);
    assert.equal(await page.getByTestId('header-participants').count(), 0);
    await toggle.click();
    const menu = page.getByTestId('conversation-view-menu');
    await menu.waitFor();
    assert.equal(await menu.locator('[data-conversation-cat]').count(), 2);
    assert.equal(await menu.locator('[data-conversation-cat]:disabled').count(), 2);
    assert.match(await menu.textContent(), /布偶猫.*还没有可确认的对话记录.*狸花猫/);
    const box = await menu.boundingBox();
    assert.ok(box);
    assert.ok(box.x >= 0);
    assert.ok(box.x + box.width <= 390);

    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0);
    assert.equal(await toggle.evaluate((element) => element === document.activeElement), true);

    await toggle.click();
    await menu.locator('[data-conversation-view="group"]').click();
    await menu.waitFor({ state: 'detached' });
    assert.equal(await menu.count(), 0);
    assert.ok(proof.requests.includes('PUT /api/config/conversation-view'));

    await page.evaluate(() => {
      localStorage.setItem('cat-cafe:shell-language', 'en');
      window.dispatchEvent(new CustomEvent('cat-cafe:shell-language-sync'));
    });
    assert.match(await toggle.textContent(), /Group chat/);
  } finally {
    await closeProof(proof);
  }

  const classic = await openProof({ shell: 'classic', viewport: { width: 390, height: 860 } });
  try {
    assert.equal(await classic.page.getByTestId('conversation-view-menu-toggle').count(), 0);
  } finally {
    await closeProof(classic);
  }
});

test('the conversation view menu stays inside a short viewport and scrolls to its final participant and status', async () => {
  const viewport = { width: 390, height: 667 };
  const proof = await openProof({
    viewport,
    participantCount: 13,
    ready: '作品 0，这条对话的作品',
    api: ({ request, url }) =>
      url.pathname === '/api/config/conversation-view' && request.method() === 'GET' ? { abort: true } : null,
  });
  const { page } = proof;
  try {
    const toggle = page.getByTestId('conversation-view-menu-toggle');
    await toggle.click();
    const menu = page.getByTestId('conversation-view-menu');
    const status = menu.getByRole('status');
    await status.waitFor();
    assert.equal(await menu.locator('[data-conversation-cat]').count(), 13);

    const initial = await menu.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        bottom: box.bottom,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
    });
    assert.ok(initial.bottom <= viewport.height, `menu bottom ${initial.bottom} exceeds viewport ${viewport.height}`);
    assert.ok(initial.scrollHeight > initial.clientHeight, 'the capacity fixture must overflow the menu');

    await menu.hover();
    await page.mouse.wheel(0, 10_000);
    await page.waitForFunction(() => document.querySelector('[data-testid="conversation-view-menu"]')?.scrollTop > 0);
    const finalParticipant = menu.locator('[data-conversation-cat="cat-13"]');
    const [menuBox, participantBox, statusBox] = await Promise.all([
      menu.boundingBox(),
      finalParticipant.boundingBox(),
      status.boundingBox(),
    ]);
    assert.ok(menuBox && participantBox && statusBox);
    assert.ok((await menu.evaluate((element) => element.scrollTop)) > 0);
    assert.ok(participantBox.y + participantBox.height <= menuBox.y + menuBox.height);
    assert.ok(statusBox.y + statusBox.height <= menuBox.y + menuBox.height);

    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0);
    assert.equal(await toggle.evaluate((element) => element === document.activeElement), true);
  } finally {
    await closeProof(proof);
  }
});

// ---- S3-2b-1c: an approval decided in the 待办 panel through its ORIGINAL card ----------------------------------------------
// The card is the Approval Hub's own, acting through its own store and endpoint. The panel only locks it while what it shows
// may not be true, and states what a re-read of BOTH sources proved.
// These generic session/reconciliation cells use the same inline F128 fixture as mailbox-fixtures.ts.
// Native F193 authorization/body/effect is exercised by the actual Next information journeys, not an unstamped mock.
// The single switch (`decide`) is "the decision really happened"; the cells then assert on the request log as much as on the page.
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
    // A settled F128 row verifies its created-thread binding with the original
    // producer. This generic fixture has no created conversation, so prove none.
    if (request.method() === 'GET' && url.pathname === '/api/proposals/p1')
      return {
        body: { proposal: { proposalId: 'p1', createdBy: 'owner-1', status: state.listed ? 'pending' : 'approved' } },
      };
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

test('an approval is approved on its original card inside 待办; 已同意 is claimed only after both sources are re-read', async () => {
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
    assert.match(await page.getByTestId('mailbox-retained-line').textContent(), /已同意/);
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
    assert.match(await page.getByTestId('mailbox-retained-line').textContent(), /已同意/);
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
    // Inline generic F128 keeps its expanded card; the fresh read permits a new decision.
    assert.equal(await page.getByTestId('mailbox-item-toggle').getAttribute('aria-expanded'), 'true');
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
  // Opening revalidates too. Delay the read after the actual write, rather than
  // assuming a request ordinal denotes the write's reconciliation read.
  const unified = async () => {
    if (server.state.posts.length > 0) await slow;
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
    assert.equal(await page.getByTestId('approve-btn').count(), 1);
    assert.equal(await page.getByTestId('approve-btn').isDisabled(), true);
    assert.equal(await page.getByTestId('mailbox-row-reread').count(), 0);
    release();
    await page.getByTestId('mailbox-retained-result').waitFor();
    assert.match(await page.getByTestId('mailbox-retained-line').textContent(), /已同意/);
    assert.equal(server.state.posts.length, 1);
  } finally {
    await closeProof(proof);
  }
});

test('an approval that left the list with no settled row is "结果待确认", never 已同意, until the history says so', async () => {
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
    assert.equal((await page.getByTestId('mailbox-panel').textContent()).includes('已同意'), false);
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
      /已同意/.test(document.querySelector('[data-testid="mailbox-retained-line"]')?.textContent ?? ''),
    );
    assert.equal(server.state.posts.length, 1);
  } finally {
    await closeProof(proof);
  }
});

test('accepted chat real page: sidebar, composer and control ownership', async (t) => {
  await runChatRealPageJourney(t, browser);
});

test('v2 F128 retains the native contract and confirmed result group with the original record entrance', async () => {
  const proposal = {
    proposalId: 'direct-approval',
    status: 'pending',
    createdBy: 'owner-1',
    createdAt: Date.now(),
    sourceCatId: 'opus',
    sourceThreadId: 'thread-return',
    title: '查清真实证据',
    reason: '先核对原始记录，再决定下一步。\n这是提议里的原话。',
    parentThreadId: 'thread-return',
    preferredCats: ['glm52'],
    initialMessage: '请核对证据',
    projectPath: '/work/fixture',
    declaredWorkMode: 'parallel',
    subjectTaskId: 'task:work:isolated-approval',
    subjectTaskTitle: '隔离审批验证',
    approvedDevelopmentScope: {
      featureRef: 'feature:F322',
      phaseKey: 'S3',
      workUnitRef: 'feature-phase:F322:S3',
      acceptedSourceRef: 'file:docs/features/F322-everyday-work-experience.md',
      acceptedRevision: 'a'.repeat(40),
    },
  };
  const item = {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F128',
    requesterCatId: proposal.sourceCatId,
    ownerUserId: 'owner-1',
    resolution: 'open',
    materialization: { state: 'not_started' },
    createdAt: proposal.createdAt,
    summary: `New thread: ${proposal.title}`,
    detail: {
      title: proposal.title,
      reason: proposal.reason,
      parentThreadId: proposal.parentThreadId,
      preferredCats: proposal.preferredCats,
      initialMessage: proposal.initialMessage,
      projectPath: proposal.projectPath,
    },
    inlineApprovable: false,
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: 'thread-return', messageId: 'trigger' },
      approvalCardRef: { threadId: 'thread-return', messageId: 'proposal-card' },
    },
  };
  const row = {
    decisionRef: 'approval:F128:direct-approval',
    kind: 'approval',
    summary: item.summary,
    approval: Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'ownerUserId')),
    linkedNeedsMe: [],
  };
  const before = { decisionRef: 'work-before', kind: 'judgment', summary: '前一件工作', linkedNeedsMe: [] };
  const after = { decisionRef: 'work-after', kind: 'judgment', summary: '后一件工作', linkedNeedsMe: [] };
  let decided = false;
  let releaseConfirmation = () => {};
  const confirmation = new Promise((resolve) => {
    releaseConfirmation = resolve;
  });
  const proof = await openProof({
    ready: '待办，1 件',
    unified: async () => {
      if (decided) await confirmation;
      return {
        body: unifiedRead({ items: decided ? [before, after] : [before, row, after], totalCount: decided ? 2 : 3 }),
      };
    },
    api: ({ request, url }) => {
      if (url.pathname === '/api/approval-hub/pending')
        return { body: { items: decided ? [] : [item], count: decided ? 0 : 1 } };
      if (url.pathname === '/api/proposals/direct-approval/approve') {
        assert.equal(request.method(), 'POST');
        decided = true;
        // Deliberately omit the navigation handle in this bounded transport test
        // so the slower canonical reread can be observed on the current page.
        // The separate native Next journey verifies the real route's threadId,
        // creation, pin, seed materialization and immediate original navigation.
        return { body: { ok: true } };
      }
      if (url.pathname === '/api/proposals/direct-approval')
        return {
          body: {
            proposal: decided ? { ...proposal, status: 'approved', createdThreadId: 'thread-created' } : proposal,
          },
        };
      if (url.pathname === '/api/approval-hub/settled')
        return {
          body: {
            items: decided ? [{ ...item, resolution: 'accepted', decidedAt: Date.now(), decidedBy: 'owner-1' }] : [],
            count: decided ? 1 : 0,
          },
        };
      if (url.pathname === '/api/threads/thread-created')
        return { body: { id: 'thread-created', createdBy: 'owner-1', createdFromProposalId: 'direct-approval' } };
      if (url.pathname === '/api/threads/thread-created/active-pane') return { body: { active: false } };
      return null;
    },
  });
  const { page } = proof;
  try {
    await page.getByTestId('mailbox-button').click();
    const native = page.getByTestId('approval-item-direct-approval');
    await native.getByTestId('approve-btn').waitFor();
    const reason = native.getByTestId('proposal-reason');
    await reason.locator('summary').click();
    await page
      .getByTestId('approve-btn')
      .isEnabled()
      .then((enabled) => assert.equal(enabled, true));
    assert.equal(await reason.getByRole('region').innerText(), proposal.reason);
    let contractText = await native.innerText();
    assert.match(contractText, /谁来做:.*狸花猫/s);
    assert.match(contractText, /放在:.*返回原处的对话/s);
    assert.match(contractText, /并行 · 不回报/);
    assert.equal(contractText.includes(proposal.subjectTaskId), false, 'technical addresses stay folded');
    await native.getByText('技术详情', { exact: true }).click();
    contractText = await native.innerText();
    assert.ok(contractText.includes('隔离审批验证'));
    assert.ok(contractText.includes(proposal.subjectTaskId));
    assert.ok(contractText.includes(proposal.approvedDevelopmentScope.acceptedSourceRef));
    assert.ok(contractText.includes(proposal.approvedDevelopmentScope.acceptedRevision));
    assert.equal(await page.getByTestId('mailbox-open-original').textContent(), '在原处打开');
    const evidenceDir = process.env.F322_MAILBOX_EVIDENCE_DIR;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({ path: path.join(evidenceDir, 'pending-light.png') });
    }
    await page.getByTestId('approve-btn').click();
    await page.getByTestId('mailbox-approval-result').filter({ hasText: '正在确认' }).waitFor();
    // The native card folds its actions after its own successful POST. The
    // mailbox still withholds the confirmed result until both canonical reads
    // land, and exposes no action that could repeat this decision meanwhile.
    assert.equal(await page.getByTestId('approve-btn').count(), 0);
    assert.equal(await page.getByTestId('reject-btn').count(), 0);
    assert.equal(await page.getByTestId('mailbox-result-open').count(), 0);
    assert.equal(
      proof.requests.filter((request) => request === 'POST /api/proposals/direct-approval/approve').length,
      1,
    );
    releaseConfirmation();
    await page.getByTestId('mailbox-retained-line').filter({ hasText: '对话已开' }).waitFor();
    assert.match(await page.getByTestId('mailbox-retained-line').textContent(), /已同意 · 对话已开/);
    assert.equal(await page.getByTestId('mailbox-group-results').getByTestId('mailbox-retained-result').count(), 1);
    assert.equal(await page.getByTestId('mailbox-group-decisions').getByTestId('mailbox-item').count(), 0);
    const remainingWork = page.getByTestId('mailbox-group-other').getByTestId('mailbox-item-toggle');
    assert.equal(await remainingWork.count(), 2);
    for (const [index, title] of ['前一件工作', '后一件工作'].entries()) {
      await remainingWork.nth(index).getByText(title, { exact: true }).waitFor();
    }
    assert.equal(await page.getByTestId('mailbox-tab-count').textContent(), '0');
    await page.getByTestId('mailbox-records').click();
    await page.getByTestId('approval-tab-history').waitFor();
    assert.equal(await page.getByTestId('approval-tab-history').getAttribute('aria-pressed'), 'true');
    await page.getByTestId('mailbox-records-back').click();
    await page.getByTestId('mailbox-records').click();
    await page.getByTestId('approval-tab-pending').click();
    await page.getByTestId('approval-filter-bar').waitFor();
    await page.getByTestId('mailbox-records-back').click();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'result-dark.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.getByTestId('mailbox-panel').evaluate((node) => node.getBoundingClientRect().right <= innerWidth),
    );
    if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'result-mobile.png') });
    await page.getByTestId('mailbox-result-open').click();
    assert.equal(new URL(page.url()).pathname, '/thread/thread-created');
  } finally {
    releaseConfirmation();
    await closeProof(proof);
  }
});

test('accepted sidebar v2: groups, cats, attention, labels and measured layout', async (t) => {
  await runSidebarV2Journey(t, browser);
});

test('sidebar green reply click preserves reading placement', async (t) => {
  await runSidebarReadingJourney(t, browser);
});

test('native Next sidebar read click keeps the following thread reachable', async () => {
  await runNativeSidebarReadingJourney(browser);
});

test('collapsed Group attention shortcuts preserve layout and per-Group preferences', async (t) => {
  await runGroupPeekJourney(t, browser);
});

// Synthetic F193 source record: expiry changes write eligibility, never the displayed census.
test('v2 second-layer 已过期 finds the canonical item without permitting a producer write', async () => {
  const item = {
    proposalId: 'expired-source',
    sourceFeatureId: 'F193',
    requesterCatId: 'opus',
    ownerUserId: 'owner-1',
    resolution: 'open',
    materialization: { state: 'not_started' },
    createdAt: Date.now() - 2 * 3600_000,
    expiresAt: Date.now() - 1000,
    summary: '过期但仍需看到的工作',
    detail: { content: '过期但仍需看到的工作', targetCats: ['glm52'] },
    inlineApprovable: true,
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: 'thread-return', messageId: 'trigger' },
      approvalCardRef: { threadId: 'thread-return', messageId: 'expired-card' },
    },
  };
  const row = {
    decisionRef: 'approval:F193:expired-source',
    kind: 'approval',
    summary: item.summary,
    approval: Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'ownerUserId')),
    linkedNeedsMe: [],
  };
  const proof = await openProof({
    ready: '待办，1 件',
    unified: () => ({ body: unifiedRead({ items: [row], totalCount: 1 }) }),
    api: ({ url }) => {
      if (url.pathname === '/api/approval-hub/pending') return { body: { items: [item], count: 1 } };
      if (url.pathname === '/api/approval-hub/settled') return { body: { items: [], count: 0 } };
      return null;
    },
  });
  try {
    await proof.page.getByTestId('mailbox-button').click();
    await proof.page.getByTestId('mailbox-records').click();
    await proof.page.getByTestId('approval-tab-pending').click();
    await proof.page.getByTestId('approval-filter-stale').click();
    await proof.page.getByText(item.summary, { exact: true }).waitFor();
    assert.equal(await proof.page.getByTestId('approval-empty-state').count(), 0);
    assert.equal(await proof.page.getByTestId('approval-empty-filtered').count(), 0);
    assert.equal(await proof.page.getByTestId('approval-batch-bar').count(), 0);
    assert.equal(await proof.page.getByTestId('approve-btn').count(), 0);
    assert.equal(await proof.page.getByTestId('reject-btn').count(), 0);
    assert.ok(proof.requests.every((request) => !request.startsWith('POST ')));
    const evidenceDir = process.env.F322_MAILBOX_EVIDENCE_DIR;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      await proof.page.screenshot({ path: path.join(evidenceDir, 'expired-filter.png') });
    }
  } finally {
    await closeProof(proof);
  }
});

// Same original producer actions, isolated owner: a lost answer stays held even when both canonical readers list it.
test('v2 safe batch excludes the unknown-result approval and submits only the idle decision', async () => {
  const rows = [hostableRow('unknown-first', '第一件工作'), hostableRow('idle-second', '第二件工作')].map((row) => ({
    ...row,
    approval: { ...row.approval, detail: { content: row.summary, targetCats: ['glm52'] } },
  }));
  const items = rows.map((row) => ({ ...row.approval, ownerUserId: 'owner-1' }));
  const posts = [];
  const proof = await openProof({
    ready: '待办，2 件',
    unified: () => ({ body: unifiedRead({ items: rows, totalCount: 2 }) }),
    api: ({ request, url }) => {
      if (url.pathname === '/api/approval-hub/pending') return { body: { items, count: 2 } };
      if (url.pathname === '/api/approval-hub/settled') return { body: { items: [], count: 0 } };
      if (request.method() === 'POST' && url.pathname === '/api/proposals/unknown-first/approve') {
        posts.push(url.pathname);
        return { abort: true };
      }
      if (request.method() === 'POST' && url.pathname === '/api/proposals/idle-second/approve') {
        posts.push(url.pathname);
        return { body: { ok: true } };
      }
      return null;
    },
  });
  const { page } = proof;
  try {
    await page.getByTestId('mailbox-button').click();
    await page.getByTestId('mailbox-item-toggle').first().click();
    await page.getByTestId('mailbox-item').first().getByTestId('approve-btn').click();
    await waitForSessionText(page, '没能确认提交结果，重新读取后仍待决定');
    assert.deepEqual(posts, ['/api/proposals/unknown-first/approve']);
    await page.getByTestId('mailbox-records').click();
    await page.getByTestId('approval-tab-pending').click();
    const held = page.getByTestId('mailbox-tools-item-unknown-first');
    const idle = page.getByTestId('mailbox-tools-item-idle-second');
    await held.getByTestId('mailbox-approval-reread').waitFor();
    assert.match(await held.textContent(), /没能确认提交结果，重新读取后仍待决定/);
    assert.equal(await held.getByTestId('approve-btn').isDisabled(), true);
    assert.equal(await held.getByTestId('reject-btn').isDisabled(), true);
    // HostedApprovalCard checks its canonical store copy after mounting the
    // batch surface; wait for that read before asserting the idle action.
    await page.waitForFunction(() => {
      const action = document.querySelector(
        '[data-testid="mailbox-tools-item-idle-second"] [data-testid="approve-btn"]',
      );
      return action && !action.disabled;
    });
    assert.equal(await idle.getByTestId('approve-btn').isDisabled(), false);
    await page.getByTestId('approval-batch-select-toggle').click();
    assert.equal(await page.getByTestId('approval-batch-select-toggle').textContent(), '取消选择 (1)');
    const evidenceDir = process.env.F322_MAILBOX_EVIDENCE_DIR;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({ path: path.join(evidenceDir, 'unknown-batch.png') });
    }
    await page.getByTestId('approval-batch-approve').click();
    await page.getByTestId('mailbox-approval-tools').waitFor({ state: 'detached' });
    assert.deepEqual(posts, ['/api/proposals/unknown-first/approve', '/api/proposals/idle-second/approve']);
    // The unknown item's actual reread is the only remaining operation; no approval is retransmitted.
    await page.getByTestId('mailbox-row-reread').first().click();
    await waitForSessionText(page, '没能确认提交结果，重新读取后仍待决定');
    assert.equal(posts.filter((pathname) => pathname.includes('/unknown-first/')).length, 1);
  } finally {
    await closeProof(proof);
  }
});

test('piano navigation uses the real reading surface and original owner', async (t) => {
  await runPianoJourneys(t, browser);
});

// Reuse this unit's browser: the menu regression never starts a concurrent browser.
registerWorkspaceMenuTests(() => browser);

registerMentionCutoverJourney({ test, openProof, closeProof });
