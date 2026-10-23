import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { visibleAttentionFixture } from './f322-visible-attention.fixture.mjs';

// Real rail, mailbox, tooltip, settings shell, preference/pin stores and navigation hooks.
// Only Next routing and domain content renderers are test boundaries. Every request is
// fulfilled in the isolated browser; no dev/runtime service, user account or Redis is used.
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(webRoot, 'test/browser/fixtures');
const origin = 'https://f247-dot-entry.test';
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
        { find: /^\.\/SettingsContent$/, replacement: path.join(fixtureRoot, 'f247-dot-settings-content.tsx') },
        { find: /^\.\.\/dev\/OklchTuner$/, replacement: path.join(fixtureRoot, 'f247-dot-settings-content.tsx') },
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
  if (process.env.F247_DOT_BROWSER_EVIDENCE_DIR) {
    writeFileSync(
      path.join(process.env.F247_DOT_BROWSER_EVIDENCE_DIR, 'shared-browser-cleanup.json'),
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
    attentionCount: 0,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
    ...overrides,
  });
export async function openProof({
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
  session = { userId: 'owner-1', csrfToken: 'fixture-browser-csrf' },
  ready = '待办，暂无',
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
        '/api/entrusted-work/needs-me': { ownerReads: [], coverage: { state: 'complete' } },
        // The v2 conversation header's own reads (ThreadIndicator, DaemonActiveIndicator, cat roster).
        '/api/threads/thread-return': { id: 'thread-return', title: '返回原处的对话', projectPath: '/work/fixture' },
        '/api/threads/thread-return/active-pane': { active: false },
        '/api/threads/thread-return/artifacts': {
          view: 'works',
          artifacts: [],
          total: 0,
          complete: true,
          workLineage: 'resolved',
        },
        // A second conversation, for "open the source in another conversation".
        '/api/threads/thread-other': { id: 'thread-other', title: '另一个对话', projectPath: '/work/fixture' },
        '/api/threads/thread-other/active-pane': { active: false },
        '/api/threads/thread-other/artifacts': {
          view: 'works',
          artifacts: [],
          total: 0,
          complete: true,
          workLineage: 'resolved',
        },
        '/api/cats': {
          cats: [
            {
              id: 'opus',
              displayName: '布偶猫',
              color: { primary: '#7966a8', secondary: '#eeeaf8' },
              avatar: '/shell/catball-E-28px.png',
            },
            {
              id: 'glm52',
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
