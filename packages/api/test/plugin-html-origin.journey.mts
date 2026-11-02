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
await app.register(pluginWebhookForwardingRoutes, {
  webhooks: {
    resolvePluginWebhook: () => ({
      contributionId: 'panel',
      path: 'panel',
      methods: ['GET'],
      anonymous: false,
    }),
    callPluginWebhook: async () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `<p>Package page</p><script>Promise.allSettled([fetch('/api/core-private',{credentials:'include'}).then(r=>r.json()).then(v=>document.body.dataset.leaked=v.secret),fetch('/api/core-private',{method:'POST',credentials:'include'})]).then(()=>document.body.dataset.done='true')</script>`,
    }),
  },
});
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}`;
const ledger = { task: 'host-pr1762-origin-regression', owner: 'codex', pid: process.pid, url, state: 'running' };
await writeFile(join(artifactRoot, 'instance-ledger.json'), JSON.stringify(ledger, null, 2));
const browser = await playwright.chromium.launch({
  headless: true,
  ...(process.env.FEEDBACK_CHROMIUM ? { executablePath: process.env.FEEDBACK_CHROMIUM } : {}),
});
const page = await browser.newPage();
try {
  const response = await page.goto(`${url}/api/plugins/dev.origin/panel`);
  await page.waitForFunction(() => document.body.dataset.done === 'true');
  const observation = await page.evaluate(() => ({ origin: self.origin, leaked: document.body.dataset.leaked }));
  const receipt = { ...observation, coreReads, coreWrites, csp: response?.headers()['content-security-policy'] };
  await writeFile(join(artifactRoot, 'receipt.json'), JSON.stringify(receipt, null, 2));
  assert.equal(observation.origin, 'null', 'direct plugin HTML navigation must keep an opaque origin');
  assert.equal(observation.leaked, undefined);
  assert.equal(coreReads, 0, 'plugin HTML must not directly read a Host API');
  assert.equal(coreWrites, 0, 'plugin HTML must not directly write a Host API');
  assert.equal(receipt.csp, "sandbox allow-scripts; frame-ancestors 'none'");
  process.stdout.write('PASS: direct plugin HTML has no Host origin or core API access\n');
} finally {
  await page.close();
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
