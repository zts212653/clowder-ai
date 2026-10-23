import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitFor, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { CALENDAR_THREAD } from './f310-work-calendar.fixture.mjs';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url));
const tree = path.resolve(web, '../..');
const evidence =
  process.env.DECISION_LATENCY_EVIDENCE ?? path.join(tree, '.cat-cafe/evidence/decision-latency/browser');

test(
  'an actual Decision result renders before an unrelated Needs Me read completes',
  { timeout: 180000 },
  async (t) => {
    await mkdir(evidence, { recursive: true });
    let block = false;
    let pending = 0;
    const releases = [];
    const release = () => {
      block = false;
      for (const finish of releases.splice(0)) finish();
    };
    const fixture = await createInboxProposalFixture({
      configureOwnedReads: async ({ app }) => {
        app.get('/api/entrusted-work/needs-me', async () => {
          if (block) {
            pending += 1;
            try {
              await new Promise((resolve) => releases.push(resolve));
            } finally {
              pending -= 1;
            }
          }
          return { ownerReads: [], coverage: { state: 'complete' } };
        });
      },
    });
    let environment, server, browser;
    const output = [];
    t.after(async () => {
      release();
      const cleanup = await Promise.allSettled([
        browser?.close(),
        (async () => {
          if (server) await stopChild(server);
          await environment?.cleanup();
        })(),
        fixture.close(),
      ]);
      await writeFile(path.join(evidence, 'web.log'), output.join(''));
      await writeFile(
        path.join(evidence, 'cleanup.json'),
        JSON.stringify(
          cleanup.map((result) => ({
            status: result.status,
            ...(result.status === 'rejected' ? { reason: String(result.reason) } : {}),
          })),
          null,
          2,
        ),
      );
      assert.ok(
        cleanup.every((result) => result.status === 'fulfilled'),
        'all owned resources must release',
      );
    });
    const webPort = await availablePort();
    environment = await createNextDevTestEnvironment('decision-confirmation', {
      API_SERVER_PORT: String(fixture.apiPort),
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
      FRONTEND_PORT: String(webPort),
    });
    server = spawn(
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
        String(webPort),
      ],
      { cwd: web, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    server.stdout.on('data', (data) => output.push(String(data)));
    server.stderr.on('data', (data) => output.push(String(data)));
    await waitForHttp(`http://127.0.0.1:${webPort}/thread/${CALENDAR_THREAD}`, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.addInitScript(() => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:shell-language', 'zh');
      localStorage.setItem('theme', 'light');
    });
    await page.goto(`http://127.0.0.1:${webPort}/thread/${CALENDAR_THREAD}?shell=v2`);
    await page.getByTestId('mailbox-button').click();
    const row = page.getByTestId('mailbox-item').filter({ hasText: 'Native new conversation reject' });
    const button = row.getByTestId('reject-btn');
    await button.waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector(
        '[data-testid="mailbox-panel"] [data-testid="approval-item-inbox-native-reject"] [data-testid="reject-btn"]',
      );
      return button && !button.disabled;
    });
    await page.screenshot({ path: path.join(evidence, 'before.png') });
    block = true;
    const startedAt = performance.now();
    await button.focus();
    await page.keyboard.press('Enter');
    const result = page.getByTestId('mailbox-panel').getByTestId('proposal-result-label').filter({ hasText: '已拒绝' });
    await result.waitFor({ timeout: 1500 });
    const latencyMs = performance.now() - startedAt;
    await waitFor(() => pending > 0, 'the full unified read must actually overlap the result');
    assert.equal(fixture.proposals.get('inbox-native-reject').status, 'rejected');
    assert.equal(
      fixture.mutations.filter((item) => item.path === '/api/proposals/inbox-native-reject/reject').length,
      1,
    );
    await page.screenshot({ path: path.join(evidence, 'confirmed-while-pending.png') });
    await writeFile(
      path.join(evidence, 'result.json'),
      JSON.stringify(
        {
          latencyMs,
          unrelatedReadsStillPending: pending,
          canonicalStatus: fixture.proposals.get('inbox-native-reject').status,
          rendered: await result.innerText(),
          pageErrors,
          apiPort: fixture.apiPort,
          webPort,
        },
        null,
        2,
      ),
    );
    assert.deepEqual(pageErrors, []);
    release();
    await waitFor(() => pending === 0, 'blocked reads must drain after release');
  },
);
