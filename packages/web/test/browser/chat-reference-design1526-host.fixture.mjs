import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
export async function openDesign1526Host({ fixture, threadId, language, evidence, label }) {
  const host = { fixture, evidence, label, errors: [], writes: [], cleanup: [], closed: false };
  try {
    const port = await availablePort();
    host.env = await createNextDevTestEnvironment(`f322-design1526-${language}-${label}`, {
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
      API_SERVER_PORT: String(fixture.apiPort),
      FRONTEND_PORT: String(port),
    });
    host.server = spawn(
      process.execPath,
      [
        path.join(web, 'scripts/sync-vendor-assets.mjs'),
        '--watch',
        '--',
        process.execPath,
        path.join(tree, 'node_modules/next/dist/bin/next'),
        'dev',
        '-H',
        '127.0.0.1',
        '-p',
        String(port),
      ],
      {
        cwd: web,
        env: host.env.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    for (const stream of [host.server.stdout, host.server.stderr])
      stream.on('data', (data) => void writeFile(path.join(evidence, `${label}-web.log`), data, { flag: 'a' }));
    host.base = `http://127.0.0.1:${port}`;
    await waitForHttp(`${host.base}/thread/${threadId}`, host.server);
    host.browser = await chromium.launch({ headless: true });
    host.context = await host.browser.newContext({ viewport: { width: 1440, height: 1100 } });
    host.page = await host.context.newPage();
    host.page.setDefaultTimeout(15000);
    host.page.on('pageerror', (error) => host.errors.push(error.message));
    host.page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        request.method() !== 'GET' &&
        /\/(approval-hub|runtime-interactions|profile-updates|session-handoff)\//.test(pathname)
      )
        host.writes.push({ method: request.method(), path: pathname });
    });
    await host.page.addInitScript((language) => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:shell-language', language);
      localStorage.setItem('theme', 'light');
    }, language);
    await host.page.goto(`${host.base}/thread/${threadId}?shell=v2`);
    const collapse = host.page.locator('[data-testid="sidebar-collapse"]:visible');
    if (await collapse.count()) await collapse.first().click();
    return host;
  } catch (error) {
    await closeDesign1526Host(host);
    throw error;
  }
}

export async function closeDesign1526Host(host) {
  if (host.closed) return;
  host.closed = true;
  for (const [name, close] of [
    ['context', () => host.context?.close()],
    ['browser', () => host.browser?.close()],
    ['server', () => host.server && stopChild(host.server)],
    ['fixture', () => host.fixture.close()],
    ['environment', () => host.env?.cleanup()],
  ]) {
    try {
      await close();
      host.cleanup.push({ name, status: 'fulfilled' });
    } catch (error) {
      host.cleanup.push({ name, status: 'rejected', reason: String(error) });
    }
  }
  assert.ok(
    host.cleanup.every((row) => row.status === 'fulfilled'),
    JSON.stringify(host.cleanup),
  );
}
