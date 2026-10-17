import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CloudAssistantReturnIngestService } from '../dist/domains/cats/services/cloud-bridge/cloud-assistant-return-ingest.js';
import { MemoryCloudReturnGrantStore } from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { PluginConversationHostAdapter } from '../dist/domains/cats/services/cloud-bridge/plugin-conversation-host/plugin-conversation-host-adapter.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { resolveLocalPluginEffectiveGrants } from '../dist/domains/plugin/manager/machine-catalog-provider.js';
import { OFFICIAL_PLUGIN_HOST_POLICIES } from '../dist/domains/plugin/manager/official-plugin-host-policies.js';
import { ARCHIVE, companionHarness } from './helpers/f202-companion-artifact.js';
import { nativePeer } from './helpers/f202-companion-helper.js';
import { catConfig, pollerFor } from './helpers/f202-return-poller-harness.js';

const options = {
  skip:
    !ARCHIVE &&
    process.env.F202_ARTIFACT_GATE_REQUIRED !== '1' &&
    'set F202_COMPANION_ARCHIVE to run the pinned companion seam',
  timeout: 30000,
};

test(
  'pinned companion receives production grants and its provider lease follows enable/disable/restart',
  options,
  async (t) => {
    const h = await companionHarness(t);
    const expanded = structuredClone(h.record.manifest);
    expanded.features[0].capabilities.push('secret.read');
    assert.deepEqual(
      resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, expanded).sort(),
      ['cloud.conversation.host', 'data.directory'],
      'the package cannot widen its Host-owned grant',
    );
    expanded.features[0].capabilities = ['data.directory'];
    assert.deepEqual(resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, expanded), ['data.directory']);
    expanded.pluginId = 'dev.unlisted.companion';
    assert.deepEqual(resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, expanded), []);
    assert.equal(h.registry.current('chatgpt'), undefined);
    await h.enable();
    const first = h.registry.current('chatgpt');
    assert.equal(first.pluginId, 'official.companion.personal-chrome');
    await h.disable();
    assert.equal(h.registry.current('chatgpt'), undefined);
    const afterStop = await first.attempt(first.contribution.appendMessage.method, {
      conversationId: 'conversation-1',
      text: 'hello',
      idempotencyKey: 'source-1',
    });
    assert.equal(afterStop.status, 'failed');
    assert.equal(afterStop.effect, 'not_started');
    await h.enable();
    assert.ok(h.registry.current('chatgpt').generation > first.generation);
  },
);

test(
  'pinned companion takes over a synthetic legacy authorization without inventing row timestamps',
  options,
  async (t) => {
    const h = await companionHarness(t);
    const timestamp = '2026-09-01T00:00:00.000Z';
    const path = join(h.dataDirectory, 'conversation-binding.json');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        provider: 'chatgpt',
        conversationId: 'legacy-1',
        chatUrl: 'https://chatgpt.com/c/legacy-1',
        boundAt: timestamp,
        updatedAt: timestamp,
      }),
      { mode: 0o600 },
    );
    await h.enable();
    const listed = await h.invoke('authorizations.list');
    assert.equal(listed.render, 'rows');
    assert.equal(listed.data.rows.length, 1);
    assert.equal(listed.data.rows[0].key, 'legacy-1');
    assert.equal(listed.data.rows[0].label, 'legacy-1');
    assert.equal(listed.data.rows[0].authorizedAt, undefined);
    const revoke = h.record.manifest.configuration[0].actions.find((action) => action.id === 'revoke');
    assert.ok(revoke.confirm, 'owner confirmation remains declared');
    await h.invoke('authorizations.revoke', { conversationId: 'legacy-1' });
    assert.equal((await h.invoke('authorizations.list')).data.rows.length, 0);
    await h.disable();
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 2, 'data retained on stop');
  },
);

test('missing helper is an honest typed failure across real module actions and Host adapter', options, async (t) => {
  const h = await companionHarness(t);
  await h.enable();
  const adapter = new PluginConversationHostAdapter({ registry: h.registry, provider: 'chatgpt' });
  await assert.rejects(adapter.append_message('conversation-1', 'hello', 'source-1'), { code: 'HOST_UNAVAILABLE' });
  assert.deepEqual(await h.invoke('assistant-returns.list'), { returns: [] });
  assert.deepEqual(
    await h.invoke('assistant-returns.ack', {
      conversationId: 'conversation-1',
      sourceMessageId: 'source-1',
      assistantMessageId: 'assistant-1',
    }),
    { status: 'failed', errorCode: 'HOST_UNAVAILABLE' },
  );
  const refreshed = await h.invoke('authorizations.refresh-titles');
  assert.deepEqual(refreshed.data.titleSync, { status: 'unavailable', errorCode: 'HOST_UNAVAILABLE' });
  const status = await h.invoke('authorizations.status');
  assert.equal(status.data.helper.state, 'not_installed');
});

test('real package append/list/ack feeds Host ingest once and keeps the paired directory', options, async (t) => {
  const h = await companionHarness(t);
  const messages = new MessageStore();
  const grants = new MemoryCloudReturnGrantStore();
  const source = messages.append({
    userId: 'owner',
    threadId: 'thread-test',
    catId: null,
    content: 'hello',
    mentions: [],
    timestamp: Date.now(),
  });
  assert.equal(
    (
      await grants.issue({
        userId: 'owner',
        threadId: 'thread-test',
        sourceMessageId: source.id,
        targetCatId: 'gpt-pro',
        dispatchInvocationId: 'invocation-test',
      })
    ).ok,
    true,
  );
  const returned = {
    conversationId: 'conversation-1',
    sourceMessageId: source.id,
    assistantMessageId: 'assistant-1',
    content: 'the answer',
  };
  const peer = await nativePeer(t, h, returned);
  const cats = catConfig({});
  const outcomes = [];
  const ingest = new CloudAssistantReturnIngestService({
    messageStore: messages,
    grantStore: grants,
    cats,
    socketManager: { broadcastAgentMessage() {} },
    logger: { warn() {}, error() {} },
  });
  const p = pollerFor(h.registry, {
    cats,
    ingest: async (input) => {
      const result = await ingest.ingest(input);
      outcomes.push(result);
      return result;
    },
  });
  p.poller.start();
  t.after(() => p.poller.stop());
  await h.enable();
  assert.deepEqual(p.scheduler.pending(), [], 'enabled package without a cloud cat remains dormant');
  assert.deepEqual(p.lines, []);
  const adapter = new PluginConversationHostAdapter({ registry: h.registry, provider: 'chatgpt' });
  assert.equal((await adapter.append_message('conversation-1', 'hello', source.id)).hostMessageId, 'provider-1');
  cats.set({ 'gpt-pro': { provider: 'openai-chatgpt-pro' } });
  p.poller.reevaluate();
  await p.scheduler.fire();
  // IO is real; wait for the next scheduled round, not a fixed sleep.
  const deadline = Date.now() + 5000;
  while (p.scheduler.pending().length === 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['persisted'],
  );
  assert.equal(peer.requests.filter(({ request }) => request.kind === 'ack_assistant_return').length, 1);
  const duplicate = await ingest.ingest({ provider: 'chatgpt', sourceMessageId: source.id, content: returned.content });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.messageId, outcomes[0].messageId);
  assert.deepEqual(await h.invoke('assistant-returns.list'), { returns: [] });
  const titles = await h.invoke('authorizations.refresh-titles');
  assert.deepEqual(titles.data.titleSync, { status: 'synced', updatedCount: 1, requestedCount: 1 });
  assert.deepEqual(JSON.parse(await readFile(join(h.dataDirectory, 'pairing.json'), 'utf8')), peer.pairing);
  await h.disable();
  assert.deepEqual(p.scheduler.pending(), []);
});

test('a lost native receipt remains ambiguous through the real package and Host adapter', options, async (t) => {
  const h = await companionHarness(t);
  const peer = await nativePeer(t, h, undefined, { dropAppendReceipt: true });
  await h.enable();
  const adapter = new PluginConversationHostAdapter({ registry: h.registry, provider: 'chatgpt' });
  await assert.rejects(adapter.append_message('conversation-1', 'hello', 'source-1'), { code: 'AMBIGUOUS_EFFECT' });
  assert.equal(peer.requests.length, 1, 'no automatic replay after the helper received the request');
  assert.equal(peer.requests[0].request.idempotencyKey, 'source-1');
});
