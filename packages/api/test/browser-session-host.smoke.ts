/**
 * Manual smoke (not in the default suite): real @playwright/mcp 0.0.84 + local Chrome, temp profile.
 * Run: node --import tsx packages/api/test/browser-session-host.smoke.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import playwrightMcp from '@playwright/mcp';
import { BrowserSessionHost } from '../src/domains/browser/browser-session-host.js';

const require = createRequire(import.meta.resolve('@playwright/mcp/package.json'));
const { chromium } = require('playwright');
const profile = mkdtempSync(join(tmpdir(), 'f333-smoke-profile-'));
const workspace = mkdtempSync(join(tmpdir(), 'f333-smoke-ws-'));
const declaredElsewhere = mkdtempSync(join(tmpdir(), 'f333-smoke-client-root-'));
let launches = 0;
let context: { listenerCount(e: string): number; browser(): { listenerCount(e: string): number } } | undefined;
let now = Date.now();
let poisoned = 0;
const key = 'k'.repeat(64);
const host = new BrowserSessionHost({
  key,
  now: () => now,
  requestDeadlineMs: 3_000,
  onPoisoned: () => poisoned++,
  launch: async () => {
    launches++;
    const launched = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true });
    context = launched;
    return launched;
  },
  createServer: (config, getter) => playwrightMcp.createConnection(config as never, getter as never) as never,
});
const http = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    void host.handle(req, res, body);
  });
});
await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
const port = (http.address() as { port: number }).port;

async function client(thread: string, binding: string) {
  const c = new Client({ name: `smoke-${binding}`, version: '0' }, { capabilities: { roots: {} } });
  c.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(declaredElsewhere).href }],
  }));
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          'x-cat-cafe-browser-key': key,
          'x-cat-cafe-browser-thread': thread,
          'x-cat-cafe-browser-workspace': workspace,
          'x-cat-cafe-browser-binding': binding,
        },
      },
    }),
  );
  return c;
}
const text = (r: unknown) =>
  ((r as { content: { type: string; text?: string }[] }).content ?? []).map((p) => p.text ?? '').join('\n');

try {
  const a = await client('thread_a', 'bind-a');
  const b = await client('thread_a', 'bind-b');
  const c = await client('thread_c', 'bind-c');
  await a.callTool({ name: 'browser_navigate', arguments: { url: 'data:text/html,<title>PageA</title>A' } });
  const bTabs = text(await b.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
  const cTabs = text(await c.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
  await b.callTool({ name: 'browser_navigate', arguments: { url: 'data:text/html,<title>PageB</title>B' } });
  const aTabs = text(await a.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
  assert.equal(launches, 1, 'one Chrome for the workspace');
  assert.match(bTabs, /PageA/, 'same-thread cat sees the other cat page');
  assert.doesNotMatch(cTabs, /PageA/, 'another thread does not');
  assert.match(aTabs, /\(current\)[^\n]*PageA|PageA[^\n]*\(current\)/, 'A current page is still its own');
  assert.match(aTabs, /PageB/, 'A sees B page in the same thread');
  assert.match(text(await a.callTool({ name: 'browser_close', arguments: {} })), /shared between clients/);

  // R1 P1-1: an explicit file name lands under the verified workspace, never the client-declared root.
  const shot = text(
    await a.callTool({ name: 'browser_take_screenshot', arguments: { type: 'png', filename: 'explicit.png' } }),
  );
  console.log(`--- explicit screenshot\n${shot.slice(0, 400)}`);
  assert.equal(readdirSync(declaredElsewhere).length, 0, 'nothing written where the client pointed');
  const landed = readdirSync(workspace, { recursive: true }).map(String);
  console.log(`--- workspace files: ${JSON.stringify(landed)}`);
  assert.ok(
    landed.some((file) => file.endsWith('explicit.png')),
    'written inside the verified workspace',
  );

  // R1 P1-4: four more sessions come and go; the shared context/browser return to their listener baseline.
  const baseline = { close: context!.listenerCount('close'), disc: context!.browser().listenerCount('disconnected') };
  for (let i = 0; i < 4; i++) {
    const extra = await client('thread_a', `bind-extra-${i}`);
    await extra.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  }
  assert.equal(context!.listenerCount('close'), baseline.close + 4, 'each live session holds one');
  // Baseline was taken with A, B, C live. 31 minutes later only A is touched; reap releases B, C and
  // the four extras (6 states), so listeners end at baseline + 4 - 6.
  now += 31 * 60_000;
  await a.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  await host.reap();
  const remaining = host.sessionCount;
  assert.equal(remaining, 1, 'only A stays');
  assert.equal(context!.listenerCount('close'), baseline.close - 2, 'released sessions let go of the context');
  assert.equal(context!.browser().listenerCount('disconnected'), baseline.disc - 2, 'and of the browser');

  // R2 P1-1: an older client version is negotiated by the real upstream, and listChanged is not promised.
  const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-cat-cafe-browser-key': key,
      'x-cat-cafe-browser-thread': 'thread_old',
      'x-cat-cafe-browser-workspace': workspace,
      'x-cat-cafe-browser-binding': 'bind-old-client',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old', version: '0' } },
    }),
  });
  const init = (await initRes.json()) as {
    result: { protocolVersion: string; capabilities: { tools: { listChanged: boolean } } };
  };
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.capabilities.tools.listChanged, false);

  // R2 P1-2: isolated-context tabs count against the 20-tab thread limit in real Chrome, once each.
  const d = await client('thread_d', 'bind-d');
  let opened = 0;
  let lastList = '';
  let refusal = '';
  for (let i = 0; i < 22; i++) {
    const out = text(await d.callTool({ name: 'browser_tabs', arguments: { action: 'new', isolatedContext: 'iso' } }));
    if (/already has 20 tabs/.test(out)) refusal = out;
    else if (/### Result/.test(out)) opened++, (lastList = out);
    else assert.fail(`unexpected isolated tab result #${i}: ${out.slice(0, 300)}`);
  }
  assert.equal(opened, 19, 'own page + 19 isolated = 20; the rest refused');
  assert.equal((lastList.match(/^- \d+:/gm) ?? []).length, 20, 'each tab listed once');
  assert.match(refusal, /already has 20 tabs/);

  // Popups follow their opener, including noopener ones (what target=_blank means in Chrome today).
  const f = await client('thread_f', 'bind-f');
  await f.callTool({ name: 'browser_navigate', arguments: { url: 'data:text/html,<title>Opener</title>O' } });
  await f.callTool({
    name: 'browser_evaluate',
    arguments: { function: "() => { window.open('about:blank', '_blank', 'noopener'); }" },
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const fTabs = text(await f.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
  console.log(`--- popup tabs\n${fTabs.slice(0, 300)}`);
  assert.equal((fTabs.match(/^- \d+:/gm) ?? []).length, 2, 'the popup is listed with its opener');

  // R1 P1-2: B was released while idle; its client keeps working.
  assert.match(text(await b.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })), /PageA/);

  // R2 P1-3 / R3: a never-settling run_code_unsafe fails once at its deadline; the late call cannot be
  // cancelled, so this process asks to be retired and serves nobody else (the real child exits; see e2e).
  const e = await client('thread_e', 'bind-e');
  const hung = text(
    await e
      .callTool({ name: 'browser_run_code_unsafe', arguments: { code: 'async () => new Promise(() => {})' } })
      .catch((error: Error) => ({ content: [{ type: 'text', text: error.message }] })),
  );
  assert.match(hung, /did not finish in time/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(poisoned, 1, 'the owner is told once');
  await assert.rejects(b.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }), /503|browser_restarting/);
  console.log(`SMOKE OK (sessions after reap: ${remaining})`);
} finally {
  await host.closeAll();
  http.close();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const dir of [profile, workspace, declaredElsewhere]) rmSync(dir, { recursive: true, force: true });
}
