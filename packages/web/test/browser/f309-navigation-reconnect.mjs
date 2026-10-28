import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { startReconnectTransport } from './f309-reconnect-transport.mjs';

const wt = resolve(process.env.F309_WORKTREE_ROOT ?? process.cwd());
const require = createRequire(`${wt}/package.json`);
const { chromium } = require('playwright');
const web = 'http://127.0.0.1:35231';
const api = 'http://127.0.0.1:35233';
const run = process.env.F309_RECONNECT_RUN ?? 'candidate';
const out = `${process.env.F309_RECONNECT_EVIDENCE}/${run}`;
assert.ok(process.env.F309_RECONNECT_EVIDENCE);
await mkdir(out, { recursive: true, mode: 0o700 });
const result = {
  run,
  stages: [],
  frames: [],
  errors: [],
  noApiMocks: true,
  transportOnly: true,
  apiOriginConfiguration: 'served HTML data-cat-cafe-api-origin points at the transparent local TCP transport',
};
const save = () => writeFile(`${out}/result.json`, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
async function stage(name, work) {
  result.currentStage = name;
  await save();
  const start = performance.now();
  const value = await work();
  result.stages.push({ name, elapsedMs: performance.now() - start, value });
  await save();
  console.log(JSON.stringify({ stage: name, ok: true }));
  return value;
}
async function until(predicate, timeout = 20000) {
  const start = performance.now();
  while (!predicate()) {
    assert.ok(performance.now() - start < timeout, 'observable condition did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let browser, context, page, proxy;
let phase = 'initial';
const sockets = new Map();
const rooms = ['workspace:navigate:ack', 'workspace:global'];
const activeRoom = (room) => [...sockets.values()].some((s) => !s.closed && s.rooms.has(room));
try {
  proxy = await startReconnectTransport('http://127.0.0.1:35232', 35233);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    localStorage.setItem('cat-cafe:shell-language', 'zh-CN');
  });
  const response = await context.request.get(`${api}/api/session`);
  assert.equal(response.status(), 200);
  const session = await response.json();
  assert.ok(session.csrfToken);
  const headers = { Origin: web, 'x-csrf-token': session.csrfToken };
  const post = async (path, data, expected = 200) => {
    const r = await context.request.post(api + path, { headers, data });
    assert.equal(r.status(), expected, `${path}: ${await r.text()}`);
    return r.json();
  };
  const targets = await stage('seed-real-owner-messages-and-events', async () => {
    const messages = [];
    for (const name of ['source', 'target']) {
      const r = await post(
        '/api/threads',
        {
          title: `F309 reconnect ${name}`,
          projectPath: wt,
          preferredCats: [],
          idempotencyKey: randomUUID(),
        },
        201,
      );
      const thread = r.thread ?? r;
      const m = await post(
        '/api/messages',
        {
          threadId: thread.id,
          content: `脚手架：隔离重连验收的合成事件 ${name}。`,
          idempotencyKey: randomUUID(),
        },
        202,
      );
      assert.equal(m.entries?.length, 0);
      messages.push({ threadId: thread.id, messageId: m.userMessage.id });
    }
    await post('/api/memory/events/backfill', {});
    for (const target of messages) {
      const r = await context.request.get(`${api}/api/memory/events?threadId=${target.threadId}`);
      assert.equal(r.status(), 200);
      assert.ok((await r.json()).events.some((e) => e.messageId === target.messageId));
    }
    return messages;
  });
  const [source, target] = targets;
  const roots = await (await context.request.get(`${api}/api/workspace/worktrees`)).json();
  const root = roots.worktrees.find((r) => r.root === wt || r.resolvedRoot === wt);
  assert.ok(root);
  const paths = [
    'docs/plans/2026-10-27-f320-startup-recovery-diagnostics.md',
    'docs/plans/2026-10-27-f309-one-content-viewer.md',
  ];
  result.inputFiles = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(resolve(wt, path));
      return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
    }),
  );
  const navigate = (path, threadId = source.threadId) =>
    post('/api/workspace/navigate', {
      path,
      threadId,
      worktreeId: root.id,
      action: 'open',
    });
  const owner = (path) => page.locator(`[data-owner-path="${path}"]:visible`);
  page = await context.newPage();
  page.on('pageerror', (e) => result.errors.push(String(e).slice(0, 300)));
  let documentLoads = 0;
  page.on('load', () => documentLoads++);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
    if (new URL(url).host === new URL(api).host) sockets.set(requestId, { rooms: new Set(), closed: false });
  });
  cdp.on('Network.webSocketClosed', ({ requestId }) => {
    const s = sockets.get(requestId);
    if (s) s.closed = true;
  });
  cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
    const s = sockets.get(requestId);
    if (s && response.payloadData.startsWith('40{')) {
      const { sid } = JSON.parse(response.payloadData.slice(2));
      s.sid = sid;
      result.frames.push({ phase, requestId, event: 'connected', sid });
    }
  });
  cdp.on('Network.webSocketFrameSent', ({ requestId, response }) => {
    const s = sockets.get(requestId);
    if (!s || !response.payloadData.startsWith('42[')) return;
    const [event, room] = JSON.parse(response.payloadData.slice(2));
    if (event === 'join_room' && rooms.includes(room)) {
      s.rooms.add(room);
      result.frames.push({ phase, requestId, event, room });
    }
  });

  await stage('same-page-initial-navigation-and-Teleport', async () => {
    await page.goto(`${web}/thread/${source.threadId}?shell=v2`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.getByRole('textbox', { name: '消息输入框' }).waitFor();
    await until(() => rooms.every(activeRoom));
    const receipt = await navigate(paths[0]);
    assert.equal(receipt.deliveryStatus, 'applied');
    await owner(paths[0]).getByTestId('workspace-file-viewer').waitFor();
    await post('/api/memory/teleport', source);
    await page.locator(`[data-message-id="${source.messageId}"][data-message-jump-focus="true"]`).waitFor();
    result.browserUrl = page.url();
    await page.screenshot({ path: `${out}/before.png`, fullPage: true });
    return { receipt, teleportHighlighted: true };
  });
  const composer = page.getByRole('textbox', { name: '消息输入框' });
  const draft = '原草稿：运输断线不重载、不发送。';
  await composer.fill(draft);
  const composerNode = await composer.elementHandle();
  const bodyNode = await page.locator('body').elementHandle();
  const oldConnections = [...sockets].filter(([, s]) => !s.closed && s.rooms.size).map(([id]) => id);
  await stage('real-transport-loss-and-automatic-reconnection', async () => {
    phase = 'reconnected';
    const cutSocketCount = proxy.cutConnections();
    assert.ok(cutSocketCount > 0);
    await until(() => oldConnections.every((id) => sockets.get(id).closed));
    await until(() => [...sockets].filter(([id, s]) => !oldConnections.includes(id) && !s.closed && s.sid).length >= 2);
    // Both implementations get the same bounded settling time; still submit the
    // real navigation below when the old implementation never rejoins its room.
    await until(() => rooms.every(activeRoom), 2000).catch(() => {});
    assert.equal(await composerNode.evaluate((node) => node.isConnected), true);
    assert.equal(await bodyNode.evaluate((node) => node.isConnected), true);
    assert.equal(await composer.inputValue(), draft);
    return { cutSocketCount, oldConnections, documentLoads, noRemountDuringTransportLoss: true };
  });
  await stage('after-reconnect-navigation', async () => {
    const highlight = page.locator(`[data-message-id="${source.messageId}"][data-message-jump-focus="true"]`);
    await highlight.waitFor({ state: 'hidden', timeout: 5000 });
    await post('/api/memory/teleport', source);
    result.teleportRestoredAfterReconnect = await highlight.waitFor({ timeout: 2000 }).then(
      () => true,
      () => false,
    );
    const receipt = await navigate(paths[1]);
    result.afterReconnectReceipt = receipt;
    await save();
    assert.equal(receipt.deliveryStatus, 'applied');
    assert.equal(result.teleportRestoredAfterReconnect, true);
    assert.ok(rooms.every(activeRoom));
    await owner(paths[1]).getByTestId('workspace-file-viewer').waitFor();
    assert.equal(await composer.inputValue(), draft);
    assert.equal(documentLoads, 1);
    await page.screenshot({ path: `${out}/after.png`, fullPage: true });
    return { receipt, activeRoomsRestored: rooms };
  });
  await stage('real-presentation-lock-after-reconnect', async () => {
    const menu = page.getByTestId('v2-workspace-actions').getByText('⋯', { exact: true });
    await menu.click();
    await page.getByRole('menuitemcheckbox', { name: /^(锁定视图|解锁视图)$/ }).click();
    const receipt = await navigate(paths[0]);
    assert.equal(receipt.deliveryStatus, 'blocked');
    assert.equal(receipt.deliveryReason, 'presentation_lock');
    await owner(paths[1]).waitFor();
    await page.screenshot({ path: `${out}/locked.png`, fullPage: true });
    await menu.click();
    await page.getByRole('menuitemcheckbox', { name: /^(锁定视图|解锁视图)$/ }).click();
    await owner(paths[1]).waitFor();
    return receipt;
  });
  await stage('real-responsive-queue-after-reconnect', async () => {
    await page.setViewportSize({ width: 640, height: 900 });
    await page.waitForFunction(() => window.matchMedia('(max-width: 767px)').matches);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const receipt = await navigate(paths[0]);
    assert.equal(receipt.deliveryStatus, 'queued');
    assert.equal(receipt.deliveryReason, 'narrow_viewport');
    await owner(paths[1]).waitFor();
    await page.setViewportSize({ width: 1500, height: 1000 });
    await owner(paths[0]).waitFor();
    return receipt;
  });
  await stage('inactive-queue-and-actual-Teleport-after-reconnect', async () => {
    const receipt = await navigate(paths[1], target.threadId);
    assert.equal(receipt.deliveryStatus, 'queued');
    assert.equal(receipt.deliveryReason, 'thread_inactive');
    assert.equal(new URL(page.url()).pathname, `/thread/${source.threadId}`);
    await post('/api/memory/teleport', target);
    await page.waitForURL((url) => url.pathname === `/thread/${target.threadId}`);
    await page.locator(`[data-message-id="${target.messageId}"][data-message-jump-focus="true"]`).waitFor();
    await owner(paths[1]).waitFor();
    await page.screenshot({ path: `${out}/teleport.png`, fullPage: true });
    await page.goBack();
    await page.waitForURL((url) => url.pathname === `/thread/${source.threadId}`);
    assert.equal(await page.getByRole('textbox', { name: '消息输入框' }).inputValue(), draft);
    return { receipt, exactTeleportTarget: target, returnedDraft: true };
  });
  await stage('real-non-chat-route-queues', async () => {
    phase = 'non-chat';
    await page.goto(`${web}/memory`, { waitUntil: 'domcontentloaded' });
    await until(() => result.frames.some((f) => f.phase === phase && f.room === rooms[0]));
    const receipt = await navigate(paths[0]);
    assert.equal(receipt.deliveryStatus, 'queued');
    assert.equal(receipt.deliveryReason, 'non_chat_route');
    return receipt;
  });
  await stage('no-client-remains-unconfirmed', async () => {
    await page.close();
    assert.equal(page.isClosed(), true);
    const receipt = await navigate(paths[0]);
    assert.equal(receipt.deliveryStatus, 'unconfirmed');
    assert.equal(receipt.deliveryReason, 'no_client_ack');
    return receipt;
  });
  assert.deepEqual(result.errors, []);
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.failure = String(error.stack ?? error);
  if (page && !page.isClosed()) await page.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  await proxy?.close();
  await save();
}
console.log(JSON.stringify({ status: result.status, stage: result.currentStage }));
if (result.status !== 'passed') process.exitCode = 1;
