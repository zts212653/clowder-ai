import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');

test(
  'F290 owner/member direct journey and Clowder AI launch surface share one real Service-backed Client',
  { timeout: 120_000 },
  async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-browser-service-'));
    const evidenceDirectory = await mkdtemp(path.join(tmpdir(), 'f290-browser-evidence-'));
    const servicePort = await availablePort();
    const hostPort = await availablePort();
    const serviceUrl = `http://127.0.0.1:${servicePort}`;
    const hostUrl = `http://127.0.0.1:${hostPort}`;
    const opened = await CollectiveServiceStore.open({
      dataDirectory,
      humanAuthProvider: fakeAuthProvider(),
      humanAuthRedirectUri: `${serviceUrl}/api/auth/github/callback`,
    });
    const service = await startCollectiveServer({
      store: opened.store,
      host: '127.0.0.1',
      port: servicePort,
      allowedHostOrigins: [hostUrl],
    });
    const next = startNext(hostPort);
    let browser;

    try {
      await waitForHttp(`${hostUrl}/collective`, next);
      browser = await chromium.launch({ headless: true });
      const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const ownerAuth = await fakeGitHub(ownerContext, 'owner-code', 'You');
      const ownerPage = await ownerContext.newPage();

      const directResponse = await ownerPage.goto(`${serviceUrl}/#bootstrap=${opened.bootstrapSecret}`, {
        waitUntil: 'networkidle',
      });
      assert.equal(directResponse?.status(), 200);
      assert.equal(directResponse?.headers()['x-collective-client-build'], 'collective-client-v2');
      await ownerPage.getByLabel('你希望显示的名字').fill('You');
      await ownerPage.getByRole('button', { name: '创建管理入口' }).click();
      await ownerPage.getByRole('heading', { name: '给共同家园起个名字' }).waitFor();
      await ownerPage.getByLabel('Collective 名称').fill('Clowder AI Collective');
      await ownerPage.getByRole('button', { name: '建立 Collective' }).click();
      await ownerPage.getByRole('heading', { name: '绑定你的 Human 身份' }).waitFor();

      const deniedPopup = await openAuthPopup(ownerPage, '继续使用 GitHub 验证');
      await deniedPopup.getByRole('link', { name: 'Cancel fake GitHub' }).click();
      await ownerPage.getByText('登录已取消；你可以留在这里，准备好后再试').waitFor();
      assert.equal(await ownerPage.getByRole('heading', { name: '绑定你的 Human 身份' }).count(), 1);

      const ownerPopup = await openAuthPopup(ownerPage, '继续使用 GitHub 验证');
      await ownerPopup.getByRole('link', { name: 'Continue as You' }).click();
      await ownerPage.getByRole('heading', { name: '# general' }).waitFor();
      await ownerPage.getByPlaceholder('发消息到 # general').fill('Owner browser message');
      await ownerPage.getByRole('button', { name: '发送', exact: true }).click();
      await ownerPage.getByText('Owner browser message', { exact: true }).waitFor();
      await ownerPage.getByRole('button', { name: '邀请成员' }).click();
      const inviteUrl = await ownerPage.locator('.destination-notice').textContent();
      assert.ok(inviteUrl?.startsWith(`${serviceUrl}/#invite=`));
      await ownerPage.screenshot({ path: path.join(evidenceDirectory, 'owner-direct.png'), fullPage: true });

      const memberContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      await fakeGitHub(memberContext, 'member-code', 'Member');
      const memberPage = await memberContext.newPage();
      await memberPage.goto(inviteUrl, { waitUntil: 'networkidle' });
      await memberPage.getByRole('heading', { name: '加入同一个共同现场' }).waitFor();
      const memberPopup = await openAuthPopup(memberPage, '使用 GitHub 验证并加入');
      await memberPopup.getByRole('link', { name: 'Continue as Member' }).click();
      await memberPage.getByRole('heading', { name: '# general' }).waitFor();
      await memberPage.getByText('Owner browser message', { exact: true }).waitFor();
      await memberPage.getByPlaceholder('发消息到 # general').fill('Member joined the same Collective');
      await memberPage.getByRole('button', { name: '发送', exact: true }).click();
      await memberPage.getByText('Member joined the same Collective', { exact: true }).waitFor();
      await memberPage.screenshot({ path: path.join(evidenceDirectory, 'member-direct.png'), fullPage: true });
      const memberSessionToken = await browserSessionToken(memberPage, serviceUrl);

      const hostApi = await mockHostApi(memberContext, serviceUrl, opened.store.serviceInstanceId);
      await memberPage.goto(`${hostUrl}/collective`, { waitUntil: 'networkidle' });
      const serviceInput = memberPage.getByLabel('Collective Service 地址');
      if (await serviceInput.isVisible().catch(() => false)) {
        await serviceInput.fill(serviceUrl);
        await memberPage.getByRole('button', { name: '打开', exact: true }).click();
      }
      await memberPage.locator('[data-testid="collective-launch-surface"]').waitFor();
      const frame = memberPage.frames().find((candidate) => candidate.url().startsWith(`${serviceUrl}/?hostOrigin=`));
      assert.ok(frame, 'Clowder AI launch surface must embed the canonical Service Client');
      await frame.getByRole('heading', { name: '# general' }).waitFor();
      assert.equal(await frame.locator('[data-spatial-role="global-rail"]').count(), 0);
      assert.equal(await memberPage.getByRole('button', { name: 'Collective', exact: true }).count(), 1);
      assert.equal(await frame.getByRole('button', { name: '邀请成员' }).count(), 0);
      await frame.getByRole('button', { name: '连接此 Café' }).click();
      await waitFor(() => hostApi.pairRequests.length === 1, 'Host must receive the member pairing intent');
      assert.equal(hostApi.pairRequests[0].serviceUrl, serviceUrl);
      assert.equal(hostApi.pairRequests[0].intent.serviceInstanceId, opened.store.serviceInstanceId);
      await memberPage.getByText('Café 连接在线').waitFor();
      await memberPage.screenshot({ path: path.join(evidenceDirectory, 'host-embedded-member.png'), fullPage: true });

      const ownerProjection = await opened.store.getHumanProjection(ownerAuth.sessionToken());
      const memberProjection = await opened.store.getHumanProjection(memberSessionToken);
      assert.equal(ownerProjection.collectives[0].collectiveId, memberProjection.collectives[0].collectiveId);
      const events = await opened.store.listEventsForHuman(
        ownerAuth.sessionToken(),
        ownerProjection.collectives[0].collectiveId,
      );
      assert.deepEqual(
        events.map((event) => event.body),
        ['Owner browser message', 'Member joined the same Collective'],
      );

      process.stdout.write(
        `${JSON.stringify(
          {
            serviceUrl,
            hostUrl,
            serviceInstanceId: opened.store.serviceInstanceId,
            collectiveId: ownerProjection.collectives[0].collectiveId,
            clientBuildId: 'collective-client-v2',
            ownerHumanId: ownerProjection.human.humanId,
            memberHumanId: memberProjection.human.humanId,
            eventOrder: events.map((event) => ({ sequence: event.sequence, body: event.body })),
            pairRequests: hostApi.pairRequests.length,
            evidenceDirectory,
          },
          null,
          2,
        )}\n`,
      );

      await memberContext.close();
      await ownerContext.close();
    } finally {
      await browser?.close();
      await service.close();
      await stopChild(next);
      await rm(dataDirectory, { recursive: true, force: true });
    }
  },
);

function fakeAuthProvider() {
  return {
    id: 'github',
    readiness: { ready: true },
    authorizationUrl: ({ state, redirectUri }) => {
      const url = new URL('https://github.test/login/oauth/authorize');
      url.searchParams.set('state', state);
      url.searchParams.set('redirect_uri', redirectUri);
      return url.toString();
    },
    authenticate: async ({ code }) =>
      code === 'owner-code'
        ? { providerSubject: '1001', handle: 'operator', displayName: 'You' }
        : { providerSubject: '1002', handle: 'member', displayName: 'Member' },
  };
}

async function fakeGitHub(context, code, displayName) {
  let sessionToken;
  await context.route('https://github.test/**', async (route) => {
    const authorization = new URL(route.request().url());
    const state = authorization.searchParams.get('state');
    const redirectUri = authorization.searchParams.get('redirect_uri');
    assert.ok(state && redirectUri);
    const accepted = new URL(redirectUri);
    accepted.searchParams.set('state', state);
    accepted.searchParams.set('code', code);
    const denied = new URL(redirectUri);
    denied.searchParams.set('state', state);
    denied.searchParams.set('error', 'access_denied');
    denied.searchParams.set('error_description', 'raw fake-provider denial');
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<main><h1>Fake GitHub</h1><a href="${accepted}">Continue as ${displayName}</a><a href="${denied}">Cancel fake GitHub</a></main>`,
    });
  });
  context.on('response', async (response) => {
    if (!response.url().endsWith('/api/auth/completions/exchange') || response.request().method() !== 'POST') return;
    const body = await response.json().catch(() => undefined);
    if (typeof body?.sessionToken === 'string') sessionToken = body.sessionToken;
  });
  return {
    sessionToken: () => {
      assert.ok(sessionToken, `Missing captured ${displayName} session token`);
      return sessionToken;
    },
  };
}

async function openAuthPopup(page, buttonName) {
  const popupPromise = page.context().waitForEvent('page', { timeout: 5_000 });
  await page.getByRole('button', { name: buttonName }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  return popup;
}

async function mockHostApi(context, serviceUrl, serviceInstanceId) {
  const pairRequests = [];
  let connected;
  await context.route('**/api/session', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.route('**/api/plugins/collective-connector**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/plugins/collective-connector/pair') {
      const request = route.request().postDataJSON();
      pairRequests.push(request);
      connected = {
        serviceUrl,
        canonicalClientAnchor: {
          kind: 'collective-client',
          serviceUrl,
          clientBuildId: 'collective-client-v2',
          serviceInstanceId,
          collectiveId: request.intent.collectiveId,
          connectionId: 'con_browser_host',
        },
        serviceInstanceId,
        collectiveId: request.intent.collectiveId,
        connectionId: 'con_browser_host',
        endpointId: 'ep_browser_host',
        endpointLabel: 'Clowder AI browser Host',
        authorityStatus: 'connected',
        liveStatus: 'online',
        lastAckedSequence: 0,
        outbox: { queued: 0, accepted: 0 },
        route: { configured: false },
        inbox: { persisted: 0, pending: 0, routed: 0, failed: 0 },
      };
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    if (url.pathname === '/api/plugins/collective-connector') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runtimeStatus: 'active', connections: connected ? [connected] : [] }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return { pairRequests };
}

async function browserSessionToken(page, serviceUrl) {
  return page.evaluate(
    ({ origin, key }) => {
      const token = window.sessionStorage.getItem(`${key}:${origin}`);
      if (!token) throw new Error('Missing browser Service session');
      return token;
    },
    { origin: serviceUrl, key: 'collective-session' },
  );
}

function startNext(port) {
  return spawn('pnpm', ['--filter', '@cat-cafe/web', 'exec', 'next', 'start', '-p', String(port)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForHttp(url, child) {
  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Next exited early (${child.exitCode}): ${output.join('').slice(-4000)}`);
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${output.join('').slice(-4000)}`);
}

async function waitFor(predicate, failure) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(failure);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
