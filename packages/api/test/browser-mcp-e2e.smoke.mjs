/**
 * Manual end-to-end smoke (not in the default suite): API route → forked browser-process-entry →
 * @playwright/mcp 0.0.84 → local headless Chrome. Only the invocation registry is a stand-in.
 * Run after build: node packages/api/test/browser-mcp-e2e.smoke.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify from 'fastify';
import { BrowserProcess } from '../dist/domains/browser/BrowserProcess.js';
import { workspaceProfileDir } from '../dist/domains/browser/shared-browser-descriptor.js';
import { registerBrowserMcpRoutes } from '../dist/routes/browser-mcp.js';

const workspace = mkdtempSync(join(tmpdir(), 'f333-e2e-ws-'));
mkdirSync(join(workspace, '.cat-cafe'));
writeFileSync(
  join(workspace, '.cat-cafe/capabilities.json'),
  JSON.stringify({
    version: 2,
    capabilities: [
      {
        id: 'playwright',
        type: 'mcp',
        enabled: true,
        globalEnabled: true,
        source: 'external',
        mcpServer: { command: '', args: [], resolver: 'shared-browser' },
      },
    ],
  }),
);
const record = (threadId) => ({
  catId: 'opus55',
  userId: 'default-user',
  threadId,
  sharedMcpContext: { v: 1, deploymentId: 'd', workspaceRoot: workspace, capabilityRoot: workspace },
});
const invocations = { 'inv-a': record('thread_a'), 'inv-b': record('thread_a'), 'inv-c': record('thread_c') };
// Short enough to test a late call, long enough for the first call's cold Chrome launch.
const DEADLINE_MS = 6000;
const browser = new BrowserProcess({ requestDeadlineMs: DEADLINE_MS });
const app = Fastify();
registerBrowserMcpRoutes(app, {
  registry: {
    isStartupRecoveryComplete: () => true,
    verifyLatest: async (id, token) =>
      invocations[id] && token === `tok-${id}` ? { ok: true, record: invocations[id] } : { ok: false, reason: 'x' },
  },
  deploymentId: 'd',
  browser,
});
await app.listen({ port: 0, host: '127.0.0.1' });
const url = new URL(`http://127.0.0.1:${app.server.address().port}/api/browser-mcp/mcp?shared=1`);

async function cat(invocationId) {
  const client = new Client({ name: invocationId, version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          'x-invocation-id': invocationId,
          'x-callback-token': `tok-${invocationId}`,
          'x-mcp-connection-id': `conn-${invocationId}`,
        },
      },
    }),
  );
  return client;
}
const text = (r) => (r.content ?? []).map((p) => p.text ?? '').join('\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Browser children of this smoke process (another run elsewhere has another parent). */
const ourChildren = () =>
  execFileSync('ps', ['-Ao', 'pid=,ppid=,args='])
    .toString()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, ...args]) => ppid === String(process.pid) && args.join(' ').includes('browser-process-entry'))
    .map(([pid]) => pid);
const chromeOnProfile = () => {
  try {
    return execFileSync('pgrep', ['-f', workspaceProfileDir(workspace)])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean).length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
};

try {
  const a = await cat('inv-a');
  const b = await cat('inv-b');
  const c = await cat('inv-c');
  await a.callTool({ name: 'browser_navigate', arguments: { url: 'data:text/html,<title>PageA</title>A' } });
  const bTabs = text(await b.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
  const cTabs = text(await c.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
  const shot = text(await a.callTool({ name: 'browser_take_screenshot', arguments: { type: 'png' } }));
  console.log(`--- B tabs\n${bTabs}\n--- C tabs\n${cTabs}\n--- A screenshot\n${shot.slice(0, 300)}`);
  assert.match(bTabs, /PageA/);
  assert.doesNotMatch(cTabs, /PageA/);
  // Paths are reported relative to Playwright's cwd, which is now the verified workspace (R1 P1-1).
  assert.match(shot, /\]\(\.playwright-mcp\/thread_a\/page-/, 'output stays in the thread folder');
  assert.ok(
    readdirSync(join(workspace, '.playwright-mcp', 'thread_a')).some((f) => f.endsWith('.png')),
    'the file is really there',
  );

  // R3: a call that outlives its deadline ends with its process, and its late effect never lands.
  await a.callTool({ name: 'browser_navigate', arguments: { url: 'data:text/html,<title>Before</title>B' } });
  const [oldChild] = ourChildren();
  assert.ok(oldChild && chromeOnProfile() > 0, 'one child and its Chrome are running');
  const late = `async (page) => { await new Promise((r) => setTimeout(r, ${DEADLINE_MS + 1500})); await page.evaluate(() => { document.title = 'LATE_EFFECT'; }); }`;
  const started = Date.now();
  const outcomes = [];
  await a
    .callTool({ name: 'browser_run_code_unsafe', arguments: { code: late } })
    .then((r) => outcomes.push(`result: ${text(r).slice(0, 120)}`))
    .catch((error) => outcomes.push(`error: ${error.message}`));
  console.log(`--- late call after ${Date.now() - started}ms: ${outcomes.join(' | ')}`);
  assert.equal(outcomes.length, 1, 'one outcome, no retry');
  assert.match(outcomes[0], /^error: .*did not finish in time/);
  for (let i = 0; i < 100 && ourChildren().includes(oldChild); i++) await sleep(100);
  assert.ok(!ourChildren().includes(oldChild), 'the old child exited');
  assert.equal(chromeOnProfile(), 0, 'and its Chrome with it, before any new request');
  const fresh = text(await b.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
  const [newChild] = ourChildren();
  assert.ok(newChild && newChild !== oldChild, 'the next request is served by a new generation');
  await sleep(Math.max(0, started + DEADLINE_MS + 3000 - Date.now())); // past the moment the late write was due
  const afterDue = text(await a.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
  console.log(`--- new generation\n${fresh}\n--- after the late write was due\n${afterDue}`);
  assert.doesNotMatch(`${fresh}\n${afterDue}`, /LATE_EFFECT/, 'the late write never lands');
  console.log('E2E SMOKE OK');
} finally {
  browser.stop();
  await app.close();
  // The child closes Chrome after the IPC disconnect; Chrome writes to the profile while closing.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  rmSync(workspaceProfileDir(workspace), { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
