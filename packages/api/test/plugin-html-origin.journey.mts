import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import {
  requireLocalCapabilityReadRequest,
  requireLocalCapabilityWriteRequest,
} from '../src/config/capabilities/capability-write-guards.js';
import { securityHeadersPlugin } from '../src/infrastructure/security-headers.js';
import { pluginWebhookForwardingRoutes } from '../src/routes/plugin/plugin-webhook-forwarding-routes.js';

const artifactRoot = resolve(process.env.PLUGIN_ORIGIN_ARTIFACTS ?? '../../artifacts/plugin-html-origin');
await mkdir(artifactRoot, { recursive: true });
const playwright = createRequire(import.meta.url)(process.env.FEEDBACK_PLAYWRIGHT_MODULE ?? 'playwright');
const app = Fastify();
await app.register(securityHeadersPlugin);
let coreReads = 0;
let coreWrites = 0;
app.addHook('onRequest', async (request) => {
  request.sessionUserId = 'owner';
});
app.get('/api/core-private', async (request, reply) => {
  const denied = requireLocalCapabilityReadRequest(request);
  if (denied) return reply.status(denied.status).send(denied);
  coreReads += 1;
  return { secret: 'synthetic-owner-secret' };
});
app.post('/api/core-private', async (request, reply) => {
  const denied = requireLocalCapabilityWriteRequest(request);
  if (denied) return reply.status(denied.status).send(denied);
  coreWrites += 1;
  return { ok: true };
});
const payload = `Promise.allSettled([fetch('/api/core-private',{credentials:'include'}).then(r=>r.json()).then(v=>document.documentElement.setAttribute('data-leaked',v.secret)),fetch('/api/core-private',{method:'POST',credentials:'include'})]).then(()=>document.documentElement.setAttribute('data-done','true'))`;
const documents = [
  { type: 'html', mime: 'text/html', body: `<html><body>Package page<script>${payload}</script></body></html>` },
  {
    type: 'xhtml',
    mime: 'application/xhtml+xml',
    body: `<html xmlns="http://www.w3.org/1999/xhtml"><body>Package page<script>${payload}</script></body></html>`,
  },
  {
    type: 'svg',
    mime: 'image/svg+xml',
    body: `<svg xmlns="http://www.w3.org/2000/svg"><script>${payload}</script></svg>`,
  },
];
await app.register(pluginWebhookForwardingRoutes, {
  webhooks: {
    resolvePluginWebhook: (_pluginId, path) =>
      documents.some((item) => item.type === path)
        ? { contributionId: path, path, methods: ['GET'], anonymous: false }
        : undefined,
    callPluginWebhook: async (_pluginId, id) => {
      const document = documents.find((item) => item.type === id);
      assert.ok(document);
      return { status: 200, headers: { 'content-type': document.mime }, body: document.body };
    },
  },
});
const ledger = { task: 'host-pr1762-origin-regression', owner: 'codex', pid: process.pid, url: '', state: 'starting' };
const browser = await playwright.chromium.launch({
  headless: true,
  ...(process.env.FEEDBACK_CHROMIUM ? { executablePath: process.env.FEEDBACK_CHROMIUM } : {}),
});
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  ledger.url = `http://127.0.0.1:${address.port}`;
  ledger.state = 'running';
  await writeFile(join(artifactRoot, 'instance-ledger.json'), JSON.stringify(ledger, null, 2));
  const page = await browser.newPage();
  const receipts = [];
  for (const document of documents) {
    coreReads = coreWrites = 0;
    const response = await page.goto(`${ledger.url}/api/plugins/dev.origin/${document.type}`);
    await page.waitForFunction(() => document.documentElement.getAttribute('data-done') === 'true');
    const observation = await page.evaluate(() => ({
      origin: self.origin,
      leaked: document.documentElement.getAttribute('data-leaked'),
    }));
    const receipt = {
      type: document.type,
      ...observation,
      coreReads,
      coreWrites,
      csp: response?.headers()['content-security-policy'],
    };
    receipts.push(receipt);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }
  await writeFile(join(artifactRoot, 'receipt.json'), JSON.stringify(receipts, null, 2));
  for (const receipt of receipts) {
    assert.equal(receipt.origin, 'null', `direct plugin ${receipt.type} navigation must keep an opaque origin`);
    assert.equal(receipt.leaked, null);
    assert.equal(receipt.coreReads, 0, `plugin ${receipt.type} must not directly read a Host API`);
    assert.equal(receipt.coreWrites, 0, `plugin ${receipt.type} must not directly write a Host API`);
    assert.equal(receipt.csp, "sandbox allow-scripts; frame-ancestors 'none'");
  }
  process.stdout.write('PASS: direct plugin HTML/XHTML/SVG have no Host origin or core API access\n');
} finally {
  await browser.close();
  await app.close();
  await writeFile(
    join(artifactRoot, 'instance-ledger.json'),
    JSON.stringify(
      { ...ledger, state: 'stopped', stoppedAt: new Date().toISOString(), retained: 'synthetic evidence only' },
      null,
      2,
    ),
  );
}
