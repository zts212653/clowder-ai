import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { realSurfaceApiResponse } from './f307-real-surface-fixtures.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EVIDENCE_DIR =
  process.env.F321_RECALL_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'f321-recall-page');
const tastes = [
  ['taste-page-first', '先看真实页面，再讨论布局', 18, 3],
  ['taste-meaning', '状态词要和生产者一致', 12, 2],
  ['taste-empty', '读不到不等于空', 7, 1],
].map(([id, title, hits, presented], index) => ({
  id,
  title,
  revision: 'revision-1',
  visibility: 'private',
  when: '2026-10-04',
  quotes: [title],
  scene: '共创',
  takeaway: null,
  tags: [],
  dimension: null,
  catId: 'sonnet',
  recall: {
    namedDelivery: {
      counts: { presented, drilled: index < 2 ? 2 : 0, applied: index === 0 ? 1 : 0, dismissed: index === 1 ? 1 : 0 },
    },
    search: { hits, opened: 2 - index, unverified: 0 },
  },
}));
const cat = (id, nickname) => ({
  id,
  nickname,
  displayName: nickname,
  color: { primary: 'var(--color-codex-primary)', secondary: 'var(--color-codex-bg)' },
  mentionPatterns: [`@${id}`],
  carrier: 'cli',
  clientId: 'openai',
  defaultModel: 'fixture',
  avatar: '',
  roleDescription: '',
  personality: '',
  roster: { available: true },
});

export async function prepareBrakeDetail(page) {
  const events = Array.from({ length: 10 }, (_, index) => ({
    eventId: `brake-${index}`,
    ownerUserId: 'fixture-owner',
    trigger: 'human_brake',
    confidence: 'high',
    type: '喵约',
    cat: 'sonnet',
    threadId: 'fixture-thread',
    messageId: `fixture-message-${index}`,
    timestamp: Date.now() - index * 1000,
    summary: `喵约，原消息 ${index}。${'这里是完整原话。'.repeat(8)}`,
    relatedHarness: null,
    cognitiveTransition: null,
  }));
  await page.route('**/api/memory/events?**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events, meta: { hasMore: false } }) }),
  );
  await page.route('**/api/memory/brakes/*/source', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ canOpen: false, title: null }) }),
  );
}

export async function startRecallBrowser() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const fixture = spawnSync(process.execPath, ['--import', 'tsx', 'test/memory-recall-browser-fixture.ts'], {
    cwd: path.resolve(WEB_ROOT, '../api'),
    encoding: 'utf8',
    maxBuffer: 5_000_000,
  });
  assert.equal(fixture.status, 0, `${fixture.stdout}\n${fixture.stderr}`);
  const line = fixture.stdout.split('\n').find((item) => item.startsWith('F321_FIXTURE_JSON='));
  assert.ok(line, 'real API fixture did not emit its samples');
  const samples = JSON.parse(line.slice('F321_FIXTURE_JSON='.length));
  await writeFile(path.join(EVIDENCE_DIR, 'api-samples.json'), JSON.stringify(samples));
  const settingsFixture = spawnSync(process.execPath, ['--import', 'tsx', 'test/memory-settings-browser-fixture.ts'], {
    cwd: path.resolve(WEB_ROOT, '../api'),
    encoding: 'utf8',
    maxBuffer: 5_000_000,
  });
  assert.equal(settingsFixture.status, 0, `${settingsFixture.stdout}\n${settingsFixture.stderr}`);
  const settingsLine = settingsFixture.stdout.split('\n').find((item) => item.startsWith('F321_SETTINGS_JSON='));
  assert.ok(settingsLine, 'production Library/maintenance fixture did not emit its samples');
  const settingsSamples = JSON.parse(settingsLine.slice('F321_SETTINGS_JSON='.length));
  await writeFile(path.join(EVIDENCE_DIR, 'settings-api-samples.json'), JSON.stringify(settingsSamples));
  const sync = spawnSync(process.execPath, ['scripts/sync-vendor-assets.mjs'], { cwd: WEB_ROOT, encoding: 'utf8' });
  assert.equal(sync.status, 0, `${sync.stdout}\n${sync.stderr}`);
  const dist = await mkdtemp(path.join(WEB_ROOT, '.next-test-f321-recall-'));
  const tsconfig = path.join(WEB_ROOT, `tsconfig.${path.basename(dist).slice(1)}.json`);
  await writeFile(
    tsconfig,
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { noEmit: true },
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', `${path.basename(dist)}/types/**/*.ts`],
      exclude: ['node_modules'],
    }),
  );
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  socket.close();
  await once(socket, 'close');
  const server = spawn(
    process.execPath,
    [path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)],
    {
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: '',
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
        CAT_CAFE_WEB_TEST_DIST_DIR: path.basename(dist),
        CAT_CAFE_WEB_TEST_TSCONFIG: path.basename(tsconfig),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const log = [];
  server.stdout.on('data', (chunk) => log.push(chunk.toString()));
  server.stderr.on('data', (chunk) => log.push(chunk.toString()));
  const origin = `http://127.0.0.1:${port}`;
  let browser;
  try {
    const deadline = Date.now() + 180_000;
    let ready = false;
    while (Date.now() < deadline && server.exitCode === null && server.signalCode === null) {
      try {
        if ((await fetch(`${origin}/memory/preview?tab=recall&shell=v2`)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* Readiness is bounded by the explicit deadline. */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(ready, `Next preview not ready: ${log.join('')}`);
    browser = await chromium.launch({ headless: true });
    console.log(
      JSON.stringify({
        state: 'isolated-preview-ready',
        origin,
        pid: server.pid,
        apiListenerStarted: false,
        redisStarted: false,
      }),
    );
    return { browser, origin, samples, settingsSamples, close };
  } catch (error) {
    await close();
    throw error;
  }
  async function close() {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGKILL');
        await once(server, 'exit');
      }
    }
    await writeFile(path.join(EVIDENCE_DIR, 'next.log'), log.join(''));
    await rm(dist, { recursive: true, force: true });
    await rm(tsconfig, { force: true });
    let portClosed = false;
    let portProbeError;
    try {
      await fetch(origin);
    } catch (error) {
      portProbeError = error.cause?.code;
      portClosed = portProbeError === 'ECONNREFUSED';
    }
    await writeFile(
      path.join(EVIDENCE_DIR, 'cleanup.json'),
      JSON.stringify({
        pid: server.pid,
        exitCode: server.exitCode,
        signalCode: server.signalCode,
        portClosed,
        portProbeError,
        removedOwnDist: dist,
        removedOwnTsconfig: tsconfig,
        apiListenerStarted: false,
        redisStarted: false,
      }),
    );
    assert.ok(portClosed, 'own Next preview port did not prove closed');
  }
}

function tasteResponse(state) {
  if (state === 'error') return { status: 503, body: { error: 'Taste unavailable' } };
  return {
    body: {
      readStatus: state === 'partial' ? 'partial' : 'ready',
      entries: state === 'empty' ? [] : tastes,
      coverage: { unverified: 0 },
      dimensionHints: { presented: 0, drilled: 0, applied: 0, dismissed: 0 },
    },
  };
}
function hostResponse(pathname, state) {
  if (pathname === '/api/memory/taste') return tasteResponse(state);
  const responses = {
    '/api/session': { body: { userId: 'owner' } },
    '/api/cats': { body: { cats: [cat('sonnet', '宪宪'), cat('codex61-sol', '砚砚')] } },
    '/api/evidence/status': { body: { healthy: true, backend: 'sqlite', docs_count: 3 } },
  };
  return responses[pathname];
}
function recallResponse(samples, state, key, cursorFailed) {
  if (cursorFailed) return { status: 503, body: { error: 'Recall reader unavailable' } };
  const sample = samples[state]?.[key];
  assert.ok(sample, `missing real API sample for ${state} ${key}`);
  return sample;
}
export async function recallPage(runtime, viewport, initial = 'ready') {
  const context = await runtime.browser.newContext({ viewport });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  const pending = [];
  let state = initial;
  let failCursor = false;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = url.pathname + url.search;
    requests.push(key);
    const fulfill = (response) =>
      route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
    if (url.pathname.startsWith('/api/memory/recall')) {
      if (state === 'loading') await new Promise((resolve) => pending.push(resolve));
      return fulfill(recallResponse(runtime.samples, state, key, url.searchParams.has('cursor') && failCursor));
    }
    return fulfill(
      runtime.settingsSamples[url.pathname] ??
        hostResponse(url.pathname, state) ??
        realSurfaceApiResponse(request, false),
    );
  });
  await page.goto(`${runtime.origin}/memory/preview?tab=recall&shell=v2`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '召回记录', exact: true }).waitFor();
  return {
    page,
    context,
    requests,
    errors,
    setState: (next) => {
      state = next;
      for (const resolve of pending.splice(0)) resolve();
    },
    failCursor: (value) => {
      failCursor = value;
    },
  };
}
