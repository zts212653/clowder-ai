import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const FIXTURE_PATH = '/dev/rich-html-interaction-continuity';
export const WIDGET_SELECTOR = '[data-rich-block-id="shared-rich-html"] [data-html-widget]';
export const CLI_SIGNATURE = '[小团团·砚砚/gpt-5.6-terra🐾]';

const CAT = {
  id: 'codex-sol',
  displayName: '缅因猫 Sol',
  variantLabel: 'GPT-5.6 Sol',
  color: { primary: '#6b8f34', secondary: '#c8d8b5' },
  mentionPatterns: ['codex-sol'],
  clientId: 'openai',
  defaultModel: 'gpt-5.6-sol',
  avatar: '/avatars/codex.png',
  roleDescription: '小太阳型攻坚猫',
  personality: 'warm',
  roster: { family: 'maine-coon', roles: [], lead: false, available: true, evaluation: 'fixture' },
};

async function findFreePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert(address && typeof address !== 'string');
  probe.close();
  await once(probe, 'close');
  return address.port;
}

function callbackAuthSnapshot() {
  return {
    reasonCounts: {},
    toolCounts: {},
    byCat: {},
    recentSamples: [],
    totalFailures: 0,
    startedAt: Date.now(),
    uptimeMs: 0,
    recent24h: { totalFailures: 0, byReason: {}, byTool: {}, byCat: {} },
  };
}

function apiBody(pathname) {
  const staticBodies = {
    '/api/cats': { cats: [CAT] },
    '/api/config/cat-order': { catOrder: ['codex-sol'] },
    '/api/health': { status: 'ok' },
    '/api/ready': { status: 'ok' },
    '/api/session': { ok: true },
    '/api/bootcamp/threads': { threads: [] },
    '/api/tasks': { tasks: [] },
  };
  if (pathname === '/api/debug/callback-auth') return callbackAuthSnapshot();
  if (pathname.endsWith('/task-progress')) return { taskProgress: {} };
  if (pathname.endsWith('/queue')) return { queue: [], paused: false, activeInvocations: [] };
  if (pathname === '/api/threads') {
    return {
      threads: [
        { id: 'rich-html-continuity-a', title: 'Continuity A', projectPath: '/fixture' },
        { id: 'rich-html-continuity-b', title: 'Continuity B', projectPath: '/fixture' },
      ],
    };
  }
  if (pathname.startsWith('/api/threads/')) {
    return { id: pathname.split('/')[3], title: 'Continuity fixture', projectPath: '/fixture' };
  }
  return staticBodies[pathname] ?? {};
}

export function createContinuityHarness() {
  let server;
  let browser;
  let context;
  let baseUrl;
  const serverOutput = [];

  async function waitForPage(url) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Next.js exited before readiness:\n${serverOutput.join('')}`);
      try {
        const response = await fetch(url);
        if (response.ok) return;
      } catch {
        // Next is still compiling.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${url}:\n${serverOutput.join('')}`);
  }

  async function stubApis(page) {
    await page.route('**/api/**', async (route) => {
      const body = apiBody(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
  }

  async function openFixture() {
    const page = await context.newPage();
    const clientErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') clientErrors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => clientErrors.push(`pageerror: ${error.stack || error.message}`));
    page.on('requestfailed', (request) =>
      clientErrors.push(`requestfailed: ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`),
    );
    await stubApis(page);
    await page.goto(`${baseUrl}${FIXTURE_PATH}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await page
        .locator('[data-testid="rich-html-interaction-continuity-fixture"][data-hydrated="true"]')
        .waitFor({ state: 'attached', timeout: 20_000 });
    } catch (error) {
      const documentState = await page.evaluate(() => ({
        title: document.title,
        body: document.body.innerText.slice(0, 2_000),
        fixture: document
          .querySelector('[data-testid="rich-html-interaction-continuity-fixture"]')
          ?.getAttribute('data-hydrated'),
      }));
      throw new Error(
        [
          `fixture hydration failed: ${error.message}`,
          JSON.stringify(documentState),
          ...clientErrors,
          serverOutput.join('').slice(-12_000),
        ].join('\n'),
        { cause: error },
      );
    }
    await page.waitForFunction((selector) => {
      const widget = document.querySelector(selector);
      return widget?.getAttribute('data-html-widget-layout-state') === 'ready';
    }, WIDGET_SELECTOR);
    return page;
  }

  async function activeWidget(page) {
    const widget = page.locator(WIDGET_SELECTOR);
    await widget.waitFor({ state: 'visible' });
    return widget;
  }

  async function start() {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: WEB_ROOT,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development', NEXT_PUBLIC_API_URL: baseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => serverOutput.push(chunk.toString()));
    server.stderr.on('data', (chunk) => serverOutput.push(chunk.toString()));
    await waitForPage(`${baseUrl}${FIXTURE_PATH}`);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  }

  async function stop() {
    await context?.close();
    await browser?.close();
    if (!server || server.exitCode !== null) return;
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }

  return { activeWidget, openFixture, start, stop };
}
