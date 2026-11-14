import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApiFixture } from './issue1829-api-fixture.cjs';

// Run after CAT_CAFE_DESKTOP_WEB_BUILD=1 pnpm --filter @cat-cafe/web build.
// ELECTRON_EXECUTABLE must name Electron 35.7.5, not an installed Clowder executable.
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const require = createRequire(path.join(repo, 'packages/web/package.json'));
const { _electron: electron } = require('playwright');
const executablePath = process.env.ELECTRON_EXECUTABLE;
assert.ok(executablePath, 'set ELECTRON_EXECUTABLE to the development Electron binary');
const variant = process.argv[2] || 'fixed';
assert.ok(['baseline', 'fixed'].includes(variant));
const web = path.resolve(process.env.ISSUE1829_WEB_ROOT || path.join(repo, 'packages/web'));
const output = path.resolve(
  process.env.ISSUE1829_EVIDENCE_DIR || path.join(os.tmpdir(), 'cat-cafe-evidence/issue1829'),
  `${variant}-${Date.now()}`,
);
await mkdir(output, { recursive: true });
await mkdir(path.join(output, 'profile'), { recursive: true });
const api = await startApiFixture();
const portProbe = net.createServer();
await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
const frontendPort = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const reservedPorts = [3001, 3002, 3003, 3004, 6399];
assert.ok(!reservedPorts.includes(api.port) && !reservedPorts.includes(frontendPort));
const origin = `http://127.0.0.1:${frontendPort}`;
const apiOrigin = `http://127.0.0.1:${api.port}`;
const runtime = spawn(
  process.execPath,
  [path.join(repo, 'desktop/runtime-web-server.js'), web, String(frontendPort), String(api.port), '127.0.0.1'],
  {
    cwd: repo,
    windowsHide: true,
    env: { ...process.env, API_SERVER_PORT: String(api.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverLog = '';
runtime.stdout.on('data', (chunk) => {
  serverLog += chunk;
});
runtime.stderr.on('data', (chunk) => {
  serverLog += chunk;
});
let app;
const errors = [],
  browserRequests = [],
  warnings = [],
  failed = [],
  blocked = [],
  journeys = [];
try {
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(runtime.exitCode, null, serverLog);
    const ready = await fetch(origin).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  app = await electron.launch({
    executablePath,
    args: [path.join(here, 'issue1829-electron-fixture.cjs')],
    env: {
      ...process.env,
      ISSUE1829_PROFILE: path.join(output, 'profile'),
      ISSUE1829_API_ORIGIN: apiOrigin,
      ISSUE1829_APP_ORIGIN: origin,
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (event) => {
    if (['warning', 'error'].includes(event.type())) warnings.push(event.text());
  });
  page.on('requestfailed', (request) => failed.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('request', (request) => browserRequests.push({ url: request.url(), at: Date.now() }));
  // Leave assets, PWA and IndexedDB real. Reject accidental requests outside this isolated pair.
  await app.context().route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (![origin, apiOrigin].includes(url.origin)) {
      blocked.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  await app.context().addInitScript(() => {
    window.__desktopLongTasks = [];
    new PerformanceObserver((list) =>
      window.__desktopLongTasks.push(
        ...list.getEntries().map((entry) => ({ at: entry.startTime, ms: entry.duration })),
      ),
    ).observe({ type: 'longtask', buffered: true });
  });
  const cdp = await app.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('new-conversation-page').locator('textarea').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('cat-cafe:shell-presentation')), 'v2');
  const versions = await app.evaluate(() => process.versions);
  assert.equal(versions.electron, '35.7.5');

  const openThread = async (id) => {
    const started = Date.now();
    await page.locator(`[data-thread-id="${id}"]`).first().click();
    await page.getByText(`${id} history 79.`, { exact: false }).first().waitFor();
    await page.getByTestId('header-works').waitFor();
    await page.locator('textarea').first().waitFor();
    const other = id === 'probe-a' ? 'probe-b' : 'probe-a';
    assert.equal(await page.getByText(`${other} history 79.`, { exact: false }).count(), 0);
    journeys.push({ action: `click ${id}`, elapsedMs: Date.now() - started });
  };
  await openThread('probe-a');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('img[alt="Desktop test cat"]')].some(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  );
  await page.waitForTimeout(300);
  const before = api.reads.length;
  const browserBefore = browserRequests.length;
  for (let i = 0; i < 40; i++) {
    api.io.emit('agent_message', {
      type: 'text',
      catId: 'codex',
      messageId: 'stream-response',
      threadId: 'probe-a',
      seq: i + 1,
      seqEpoch: 'probe-epoch',
      content: `token-${i} `,
    });
    await page.waitForTimeout(30);
  }
  await page.getByText('token-39', { exact: false }).first().waitFor();
  await page.waitForTimeout(300);
  const artifactReads = api.reads
    .slice(before)
    .filter((request) => request.path === '/api/threads/probe-a/artifacts?view=works');
  const streamAborts = failed.filter((request) => request.url.includes('/threads/probe-a/artifacts'));
  const artifactAttempts = browserRequests
    .slice(browserBefore)
    .filter((request) => request.url.includes('/threads/probe-a/artifacts'));
  journeys.push({
    action: '40 spaced text events',
    artifactAttempts: artifactAttempts.length,
    serverReads: artifactReads.length,
    aborted: streamAborts.length,
  });
  if (variant === 'fixed') {
    assert.ok(artifactAttempts.length <= 2, JSON.stringify(artifactAttempts));
    assert.equal(streamAborts.length, 0);
  } else assert.ok(streamAborts.length >= 20, 'the desktop baseline must reproduce token-driven cancellation');
  await page.screenshot({ path: path.join(output, 'stream.png') });
  api.io.emit('agent_message', {
    type: 'text',
    catId: 'opus',
    messageId: 'parallel-response',
    threadId: 'probe-a',
    seq: 41,
    seqEpoch: 'probe-epoch',
    content: 'parallel-start ',
  });
  await page.getByText('parallel-start', { exact: false }).first().waitFor();
  await page.waitForTimeout(300);
  const parallelBefore = browserRequests.length;
  const abortsBefore = failed.length;
  for (let i = 0; i < 40; i++) {
    api.io.emit('agent_message', {
      type: 'text',
      catId: i % 2 ? 'opus' : 'codex',
      messageId: i % 2 ? 'parallel-response' : 'stream-response',
      threadId: 'probe-a',
      seq: 42 + i,
      seqEpoch: 'probe-epoch',
      content: `parallel-${i} `,
    });
    await page.waitForTimeout(30);
  }
  await page.getByText('parallel-39', { exact: false }).first().waitFor();
  await page.waitForTimeout(300);
  const parallelReads = browserRequests
    .slice(parallelBefore)
    .filter((request) => request.url.includes('/threads/probe-a/artifacts'));
  const parallelAborts = failed
    .slice(abortsBefore)
    .filter((request) => request.url.includes('/threads/probe-a/artifacts'));
  journeys.push({
    action: '40 interleaved text events without lifecycle snapshots',
    artifactAttempts: parallelReads.length,
    aborted: parallelAborts.length,
  });
  if (variant === 'fixed') {
    assert.equal(parallelReads.length, 0);
    assert.equal(parallelAborts.length, 0);
  } else
    assert.ok(parallelReads.length >= 20, 'the desktop baseline must reproduce activity-driven display reordering');
  // Keep A producing while the user clicks B; exercise the background writer as well.
  let next = 81;
  const background = setInterval(
    () =>
      api.io.emit('agent_message', {
        type: 'text',
        catId: 'codex',
        messageId: 'stream-response',
        threadId: 'probe-a',
        seq: ++next,
        seqEpoch: 'probe-epoch',
        content: `background-${next} `,
      }),
    30,
  );
  try {
    await openThread('probe-b');
    await page.locator('textarea').first().fill('Thread B local draft');
  } finally {
    clearInterval(background);
  }
  await openThread('probe-a');
  await openThread('probe-b');
  assert.equal(await page.locator('textarea').first().inputValue(), 'Thread B local draft');
  const startNew = Date.now();
  await page.getByTestId('sidebar-new-thread').click();
  const landing = page.getByTestId('new-conversation-page');
  await landing.locator('textarea').waitFor();
  await landing.locator('textarea').fill('@');
  await page.getByText('Desktop test cat', { exact: false }).first().waitFor();
  await landing.locator('textarea').fill('New conversation local draft');
  assert.equal(await landing.locator('textarea').inputValue(), 'New conversation local draft');
  await landing.getByText('Desktop test cat', { exact: false }).first().waitFor();
  assert.ok((await landing.locator('[data-testid="chat-input-composer-row"] svg').count()) > 0);
  journeys.push({ action: 'new page composer, member and icons', elapsedMs: Date.now() - startNew });
  await page.screenshot({ path: path.join(output, 'new-page.png') });
  const profile = await cdp.send('Profiler.stop');
  await writeFile(path.join(output, 'renderer.cpuprofile'), JSON.stringify(profile.profile));
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  const summary = {
    variant,
    versions,
    web,
    buildCommit: (await readFile(path.join(web, '.next/.build-commit'), 'utf8')).trim(),
    buildId: (await readFile(path.join(web, '.next/BUILD_ID'), 'utf8')).trim(),
    journeys,
    errors,
    warnings,
    failed,
    blocked,
    requests: api.reads,
    longTasks: await page.evaluate(() => window.__desktopLongTasks),
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify(
      {
        output,
        variant,
        electron: versions.electron,
        buildCommit: summary.buildCommit,
        journeys,
        pageErrors: errors.length,
        warnings: warnings.length,
        blocked,
        maxLongTaskMs: Math.max(0, ...summary.longTasks.map((entry) => entry.ms)),
      },
      null,
      2,
    ),
  );
} finally {
  await writeFile(
    path.join(output, 'observations.json'),
    JSON.stringify({ journeys, errors, warnings, failed, blocked, requests: api.reads }, null, 2),
  );
  await writeFile(path.join(output, 'server.log'), serverLog);
  if (app) {
    await app.firstWindow().then(async (page) => {
      await writeFile(path.join(output, 'last-page.txt'), await page.locator('body').innerText());
      await page.screenshot({ path: path.join(output, 'last-page.png') });
    });
    await app.close();
  }
  runtime.kill();
  await new Promise((resolve) => api.io.close(resolve));
}
