import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

// Production SettingsShell, SettingsContent, editor and API client. Next compiler/router
// boundaries and the network are fixtures. No user's configuration or Redis is touched.
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(webRoot, 'test/browser/fixtures');
const origin = 'https://f322-members.test';
export const screenshots = process.env.MEMBERS_EVIDENCE_DIR;
let browser, script, css;
const cwd = process.cwd();
const template = JSON.parse(readFileSync(path.join(webRoot, '../../cat-template.json'), 'utf8'));
export const catalog = JSON.parse(readFileSync(path.join(webRoot, 'public/avatars/family/catalog.json'), 'utf8'));
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
        { find: 'next/font/local', replacement: path.join(fixtureRoot, 'f322-members-font.ts') },
        { find: '@', replacement: path.join(webRoot, 'src') },
      ],
    },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(fixtureRoot, 'f322-members.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  }).catch((error) => {
    throw new Error(`${error.message}\n${error.id ?? ''}`);
  });
  const outputs = Array.isArray(result) ? result.flatMap((r) => r.output) : result.output;
  script = outputs.find((o) => o.type === 'chunk' && o.isEntry).code;
  css = outputs
    .filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
    .map((o) => o.source)
    .join('\n');
  browser = await chromium.launch({ headless: true });
  if (screenshots) mkdirSync(screenshots, { recursive: true });
});
after(async () => {
  process.chdir(cwd);
  await browser?.close();
});

function cat(id, nickname, available = true, extra = {}) {
  return {
    id,
    name: `隔离${nickname}`,
    displayName: `隔离${nickname}`,
    nickname,
    color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
    avatar: '/avatars/family/codex61-sol.png',
    mentionPatterns: [`@${id}`],
    clientId: 'anthropic',
    carrier: 'cli',
    accountRef: 'claude',
    defaultModel: 'test-model',
    roleDescription: '隔离验收伙伴',
    personality: '',
    roster: { family: 'maine-coon', roles: [], lead: false, available, evaluation: '' },
    ...extra,
  };
}
export async function scene(width = 1440, dark = false, classic = false, protectedMember = false, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  if (options.clockTime !== undefined) await page.clock.install({ time: options.clockTime });
  const state = {
    accounts: options.accounts ?? [
      {
        id: 'claude',
        name: 'Claude',
        displayName: 'Claude',
        clientId: 'anthropic',
        authType: 'oauth',
        kind: 'builtin',
        builtin: true,
        models: [],
      },
    ],
    strategy: {
      catId: 'fixture-a',
      effective: {
        strategy: options.strategy ?? 'compress',
        thresholds: { warn: 0.8, action: 0.9 },
        hybrid: { maxCompressions: 2 },
      },
      source: 'runtime_override',
      hasOverride: true,
      revision: 'fixture-revision',
      changedAt: 1,
      executionStatus: { status: options.strategyStatus ?? 'active', missingCapabilities: [] },
    },
    cats: [
      cat('fixture-a', '测试甲'),
      cat('fixture-b', '测试乙', false),
      cat('fixture-c', '测试丙', true, {
        clientId: 'openai',
        carrier: 'app_server',
        codexCarrier: { effective: 'app_server', source: 'per-cat' },
      }),
    ],
    order: [],
    writes: [],
    rejectSave: false,
    rejectConfig: false,
    rejectDefaultSave: false,
    defaultId: 'fixture-a',
    routingData: null,
  };
  if (protectedMember)
    state.cats.push(
      cat('gpt-pro', '隔离Pro', true, {
        clientId: 'openai',
        carrier: 'cli',
        defaultModel: 'gpt-pro',
        mentionPatterns: ['@gpt-pro'],
        identityProtection: {
          kind: 'builtin-cloud',
          state: 'healthy',
          lockedFields: [
            'breedId',
            'clientId',
            'defaultModel',
            'provider',
            'mcpSupport',
            'accountRef',
            'cli',
            'commandArgs',
            'cliConfigArgs',
            'acp',
          ],
          driftedFields: [],
        },
      }),
    );
  const config = {
    cats: {},
    perCatCapacities: {},
    coCreator: { name: '隔离所有者', aliases: [], mentionPatterns: ['@fixture-owner'] },
    cli: { codexSandboxMode: 'workspace-write', codexApprovalPolicy: 'on-request' },
    codexExecution: { authMode: 'oauth' },
  };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    if (p === '/entry.js') return route.fulfill({ contentType: 'application/javascript', body: script });
    if (p === '/entry.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (p.startsWith('/avatars/'))
      return route.fulfill({ contentType: 'image/png', body: readFileSync(path.join(webRoot, 'public', p)) });
    if (p.startsWith('/api/')) {
      if (request.method() !== 'GET')
        state.writes.push({ path: p, method: request.method(), body: request.postDataJSON() });
      if (options.catsProducer && (p === '/api/cats' || p.startsWith('/api/cats/'))) {
        if (request.method() === 'PATCH' && state.rejectSave)
          return json(route, { error: 'Fixture save rejected' }, 403);
        const response = await options.catsProducer.app.inject({
          method: request.method(),
          url: p,
          headers: { 'x-cat-cafe-user': 'default-user', 'content-type': 'application/json' },
          ...(request.postData() ? { payload: request.postData() } : {}),
        });
        return route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
      }
      if (p === '/api/auth/session') return json(route, { userId: 'fixture-owner' });
      if (p === '/api/cats' && request.method() === 'GET') return json(route, { cats: state.cats });
      if (p === '/api/config' && request.method() === 'GET')
        return state.rejectConfig
          ? json(route, { error: 'fixture config read rejected' }, 503)
          : json(route, { config });
      if (p === '/api/config/default-cat') {
        if (request.method() === 'PUT') {
          if (state.rejectDefaultSave) return json(route, { error: 'fixture default save rejected' }, 503);
          state.defaultId = request.postDataJSON().catId;
        }
        return json(route, { catId: state.defaultId });
      }
      if (p === '/api/config/cat-order') {
        if (request.method() === 'PUT') state.order = request.postDataJSON().catOrder;
        return json(route, { catOrder: state.order });
      }
      if (p === '/api/cat-templates') return json(route, { templates: template.roleTemplates });
      if (p === '/api/accounts') return json(route, { providers: state.accounts });
      if (p === '/api/config/session-strategy') return json(route, { cats: [state.strategy] });
      if (p === '/api/config/session-strategy/fixture-a' && request.method() === 'PATCH') {
        const body = request.postDataJSON();
        state.strategy.effective = { ...state.strategy.effective, ...body };
        state.strategy.executionStatus = {
          status: { compress: 'active', hybrid: 'degraded', handoff: 'unavailable' }[body.strategy],
          missingCapabilities: body.strategy === 'compress' ? [] : ['fixture-capability'],
        };
        return json(route, { cat: state.strategy });
      }
      if (p === '/api/routing-context/snapshot')
        return json(
          route,
          state.routingData ?? {
            v: 1,
            ownerId: 'fixture-owner',
            observedAt: 1,
            catalogRevision: 'revision',
            signalEvents: [],
            preferenceRevisions: [],
            resolution: {
              state: 'degraded',
              reason: 'routing_store_unavailable',
              affectedCatIds: state.cats.map((c) => c.id),
              candidateBindings: [],
            },
          },
        );
      if (p.startsWith('/api/cats/') && request.method() === 'PATCH') {
        if (state.rejectSave) return json(route, { error: '没有权限' }, 403);
        const id = p.split('/').at(-1),
          member = state.cats.find((c) => c.id === id),
          patch = request.postDataJSON();
        Object.assign(member, patch);
        if (patch.available !== undefined) member.roster.available = patch.available;
        return json(route, { cat: member });
      }
      if (p.startsWith('/api/cats/fixture-') && request.method() === 'DELETE') {
        state.cats = state.cats.filter((cat) => cat.id !== p.split('/').at(-1));
        return json(route, { ok: true });
      }
      if (p === '/api/cats' && request.method() === 'POST') {
        const body = request.postDataJSON();
        if (body.clientId !== 'antigravity' && !body.accountRef)
          return json(route, { error: `client "${body.clientId}" requires a provider binding` }, 400);
        state.cats.push({ ...cat(body.id ?? body.catId, '新增'), ...body });
        return json(route, { cat: state.cats.at(-1) }, 201);
      }
      if (request.method() !== 'GET') return json(route, { error: 'Unmocked mutation rejected' }, 403);
      return json(route, {});
    }
    if (url.hostname === 'f322-members.test')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>',
      });
    return route.abort();
  });
  await page.goto(`${origin}/settings${classic ? '?classic=1' : ''}`);
  if (dark) await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  return { context, page, state };
}
