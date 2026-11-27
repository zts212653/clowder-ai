import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { test } from 'node:test';
import { realTaskOutcome } from './native-team-a2a-proof.mjs';
import { callRealPartner, openLiveJourney } from './native-team-live.harness.mjs';
import { waitForRenderedReply } from './native-team-rendered-reply.mjs';

const clients = [
  { key: 'codex', clientId: 'openai', quotaField: 'quota' },
  { key: 'claude-code', clientId: 'anthropic', quotaField: 'claudeQuota', quotaRoute: 'claude' },
  { key: 'dsh', clientId: 'acp' },
  { key: 'agy', clientId: 'google', quotaField: 'agyQuota' },
  { key: 'kimi', clientId: 'kimi', quotaField: 'kimiQuota' },
];
const manager = '/api/plugin-manager/plugins';

function post(body) {
  return { method: 'POST', body: JSON.stringify(body) };
}

async function getAdapter(journey, pluginId) {
  return (await journey.request(`${manager}/${pluginId}`)).plugin;
}

async function setEnabled(journey, pluginId, enabled) {
  const plugin = await getAdapter(journey, pluginId);
  await journey.request(
    `${manager}/${pluginId}/set-enabled`,
    post({ enabled, expectedRevision: plugin.lifecycleRevision }),
  );
}

async function installAdapter(journey, key, archive) {
  assert.ok(isAbsolute(archive), 'Use a locally built archive with an absolute path');
  const pluginId = `official.agent-${key}`;
  await journey.request(`${manager}/install`, post({ source: { kind: 'local-archive', path: archive } }));
  const plugin = await getAdapter(journey, pluginId);
  assert.ok(plugin.pluginInstanceId && plugin.packageDigest, 'Read back the exact installed package');
  if (plugin.intent !== 'enabled') await setEnabled(journey, pluginId, true);
  const active = await getAdapter(journey, pluginId);
  assert.equal(active.live, 'running', pluginId);
  return active;
}

async function detect(journey) {
  return (await journey.request('/api/agent-access/v1/detect', post({ refresh: true }))).candidates;
}

async function legacyContinuation(journey, legacy) {
  const { page, request, web } = journey;
  const { threadId, catId, sessionId, historyMarker, messageIds } = legacy;
  const messages = () => request(`/api/messages?threadId=${encodeURIComponent(threadId)}&limit=50`);
  const sessions = () =>
    request(`/api/threads/${encodeURIComponent(threadId)}/sessions?catId=${encodeURIComponent(catId)}`);
  const before = (await messages()).messages;
  for (const id of messageIds)
    assert.ok(
      before.some((message) => message.id === id),
      `Legacy message missing: ${id}`,
    );
  const sessionIds = async () => (await sessions()).sessions.map((session) => session.cliSessionId).sort();
  const beforeSessionIds = await sessionIds();
  assert.ok(beforeSessionIds.includes(sessionId), 'Legacy session must be readable');
  await page.goto(new URL(`/thread/${threadId}?shell=v2&lang=zh`, web).href);
  await page.locator(`[data-message-id="${messageIds.at(-1)}"]`).waitFor();
  const nonce = randomUUID().slice(0, 8);
  const input = page.locator('textarea').first();
  await input.fill(`${legacy.mention} Repeat the original session marker, followed by ${nonce}.`);
  const posted = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/messages' && response.request().method() === 'POST',
  );
  await input.press('Enter');
  const response = await posted;
  assert.equal(response.status(), 202);
  const beforeMessageIds = new Set(before.map((message) => message.id));
  const expires = Date.now() + 180000;
  let result;
  while (Date.now() < expires) {
    const newMessages = (await messages()).messages.filter((message) => !beforeMessageIds.has(message.id));
    result = realTaskOutcome(newMessages, catId, nonce);
    if (result) break;
    await page.waitForTimeout(500);
  }
  assert.equal(result?.status, 'passed', 'Legacy invocation did not complete');
  const resumed = (await messages()).messages.find((message) => message.id === result.messageId);
  assert.ok(resumed?.content?.includes(historyMarker), 'Request did not recover the original session marker');
  assert.deepEqual(await sessionIds(), beforeSessionIds, 'Continuation opened a different native session');
  await page.reload();
  await waitForRenderedReply(page, result.messageId, historyMarker);
}

async function readFixture() {
  const fixturePath = process.env.CAT_CAFE_PER_CLIENT_CUTOVER_FIXTURE;
  assert.ok(fixturePath && isAbsolute(fixturePath), 'Provide the isolated per-client cutover fixture file');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  for (const { key, quotaField } of clients) {
    const input = fixture.clients?.[key];
    assert.ok(
      input?.archive && input?.upgradeArchive && input?.detectId && input?.member,
      `Missing client fixture: ${key}`,
    );
    assert.ok(
      input.legacy?.messageIds?.length && input.legacy.historyMarker && input.legacy.sessionId,
      'Generate legacy state on the older Host first',
    );
    if (quotaField)
      assert.ok(
        input.account?.id && input.account.expectedRef,
        `Provide the authorized isolated quota account for ${key}`,
      );
  }
  return fixture;
}

test(
  'five independently installed agent packages preserve quota, member and history journeys',
  { timeout: 2400000 },
  async () => {
    const fixture = await readFixture();
    const journey = await openLiveJourney();
    const { request, page, web, record, log } = journey;
    record.scenario = 'per-client-agent-package-cutover';
    const instances = new Map();
    try {
      const installedPlugins = (await request(manager)).plugins;
      for (const { key } of clients) {
        const installed = installedPlugins.find((plugin) => plugin.pluginId === `official.agent-${key}`);
        assert.ok(!installed?.pluginInstanceId, 'Begin with an isolated Host that has no split packages installed');
      }

      for (const { key } of clients) {
        const input = fixture.clients[key];
        const active = await installAdapter(journey, key, input.archive);
        instances.set(key, active);
        const observed = await detect(journey);
        for (const candidate of clients) {
          const matches = observed.filter((entry) => entry.id === fixture.clients[candidate.key].detectId);
          assert.equal(
            matches.length,
            Number(instances.has(candidate.key)),
            `${candidate.key} detection must be owned by its enabled package`,
          );
        }
        await log(`E01/E02 installed and detected ${key}`, {
          version: active.installedVersion,
          packageDigest: active.packageDigest,
        });
      }
      assert.equal(new Set([...instances.values()].map((row) => row.pluginInstanceId)).size, clients.length);

      for (const { key, clientId, quotaField, quotaRoute } of clients) {
        const input = fixture.clients[key];
        const created = (await request('/api/cats', post(input.member))).cat;
        assert.equal(created.clientId, clientId);
        assert.ok(created.id && created.mentionPatterns.length);
        await page.goto(new URL('/settings?s=members&shell=v2&lang=zh', web).href);
        await page.getByText(created.displayName, { exact: true }).first().waitFor();
        assert.ok((await request('/api/cats')).cats.some((cat) => cat.id === created.id));
        await log(`E03 role visible after creation ${key}`, { catId: created.id });

        if (quotaField) {
          const account = input.account;
          const quota = await request(
            `/api/accounts/${encodeURIComponent(account.id)}/${quotaRoute ?? key}/quota`,
            post({}),
          );
          assert.equal(quota.accountRef, account.expectedRef);
          assert.ok(quota[quotaField], `Quota observation unavailable for ${key}`);
          await log(`E04 fixed account quota observed ${key}`);
        }
        assert.ok((await callRealPartner(journey, created)).passed);
        await log(`E05 live chat completed ${key}`);
        await legacyContinuation(journey, input.legacy);
        await log(`E06 old history and native session continued ${key}`);
      }

      for (const { key } of clients) {
        const input = fixture.clients[key];
        const original = instances.get(key);
        const changed = await installAdapter(journey, key, input.upgradeArchive);
        assert.equal(changed.pluginInstanceId, original.pluginInstanceId);
        assert.notEqual(changed.packageDigest, original.packageDigest);
        const restored = await installAdapter(journey, key, input.archive);
        assert.equal(restored.packageDigest, original.packageDigest);
        assert.equal(restored.pluginInstanceId, original.pluginInstanceId);
        for (const other of clients.filter((item) => item.key !== key)) {
          const current = await getAdapter(journey, `official.agent-${other.key}`);
          const before = instances.get(other.key);
          assert.equal(current.packageDigest, before.packageDigest);
          assert.equal(current.lifecycleRevision, before.lifecycleRevision);
        }
        await setEnabled(journey, `official.agent-${key}`, false);
        const candidates = await detect(journey);
        assert.ok(!candidates.some((candidate) => candidate.id === input.detectId));
        for (const other of clients.filter((item) => item.key !== key))
          assert.ok(candidates.some((candidate) => candidate.id === fixture.clients[other.key].detectId));
        await setEnabled(journey, `official.agent-${key}`, true);
        instances.set(key, await getAdapter(journey, `official.agent-${key}`));
        await log(`E07 target archive restored and isolation observed ${key}`);
      }
    } finally {
      await journey.close();
    }
  },
);
