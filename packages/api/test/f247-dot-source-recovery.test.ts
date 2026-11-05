import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { MemoryCloudReturnGrantStore } from '../src/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { DotConnectionService } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { DotConnectionStore } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionStore.js';
import { DotConnectionTestService } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionTestService.js';
import { DotDispatchStore } from '../src/domains/cats/services/cloud-bridge/dot/DotDispatchStore.js';
import { DotEventsBridge } from '../src/domains/cats/services/cloud-bridge/dot/DotEventsBridge.js';
import { DotReturnService } from '../src/domains/cats/services/cloud-bridge/dot/DotReturnService.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dot-source-recovery-'));
  let now = Date.now();
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const dispatches = new DotDispatchStore(join(directory, 'dispatches'));
  const grants = new MemoryCloudReturnGrantStore(() => now);
  const connection = new DotConnectionService({
    keys: new AgentKeyRegistry(),
    store: new DotConnectionStore(join(directory, 'connection.json')),
    authority: async () => ({ ownerUserId: 'owner', pluginInstanceId: 'dot-instance' }),
    ensureIdentity: async () => {},
    now: () => now,
    sendWebhook: async (_url, _headers, body) => ({
      status: 200,
      body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
    }),
  });
  const setup = await connection.begin('owner');
  await connection.subscribe(setup.credentialSecret, {
    attemptId: setup.attemptId!,
    pairingCode: setup.pairingCode!,
    url: 'https://example.com/callback',
    secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
    ttlMs: null,
  });
  const delivered: string[] = [];
  const bridge = new DotEventsBridge({
    connection,
    dispatches,
    messageStore: messages,
    threadStore: threads,
    enabled: async () => true,
    now: () => now,
    sendWebhook: async (_url, _headers, body) => {
      delivered.push(JSON.parse(body).eventId);
      return { status: 202, body: '{}' };
    },
  });
  const options = { connection, dispatches, bridge, messages, threads, grants, projectPath: '/isolated' };
  const returns = new DotReturnService({
    connection,
    dispatches,
    messages,
    threads,
    postReply: async ({ threadId, sourceMessageId }) => {
      const claim = await grants.claim({ threadId, sourceMessageId, userId: 'owner', targetCatId: 'gpt-dot' });
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error(claim.reason);
      assert.equal(await grants.commit(claim), true);
      return { messageId: `reply:${sourceMessageId}` };
    },
  });
  return {
    ...options,
    setup,
    returns,
    delivered,
    advance: () => {
      now += 86_400_001;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('old summons read only the canonical source boundary, including equal timestamps and current privacy', async () => {
  const f = await fixture();
  try {
    const thread = f.threads.create('owner', 'source boundary');
    const append = (content: string, timestamp = 100) =>
      f.messages.append({
        threadId: thread.id,
        userId: 'owner',
        from: { kind: 'user', userId: 'owner' },
        content,
        mentions: [],
        timestamp,
      });
    const earlier = append('earlier at same timestamp');
    const deleted = append('deleted');
    f.messages.softDelete(deleted.id, 'owner');
    f.messages.append({
      threadId: thread.id,
      userId: 'owner',
      from: { kind: 'user', userId: 'owner' },
      content: 'private whisper',
      mentions: [],
      timestamp: 100,
      visibility: 'whisper',
      whisperTo: [],
    });
    const source = append('admitted source');
    append('future at same timestamp');
    const outcome = await f.bridge.dispatch({
      catId: 'gpt-dot',
      userId: 'owner',
      threadId: thread.id,
      sourceMessageId: source.id,
      dispatchInvocationId: 'old-source',
      content: source.content,
    });
    assert.equal(outcome.kind, 'sent');
    for (let i = 0; i < 35; i++) append(`future ${i}`, 101 + i);
    const read = await f.returns.read(f.setup.credentialSecret, f.delivered[0]!);
    assert.equal(read.source.id, source.id);
    assert.deepEqual(
      read.context.map((message) => message.id),
      [earlier.id],
    );
    f.messages.softDelete(earlier.id, 'owner');
    assert.deepEqual((await f.returns.read(f.setup.credentialSecret, f.delivered[0]!)).context, []);
  } finally {
    await f.cleanup();
  }
});

test('source and visible context preserve rich payloads without exposing unrelated metadata', async () => {
  const f = await fixture();
  try {
    const thread = f.threads.create('owner', 'non-text source boundary');
    const rich = {
      v: 1 as const,
      blocks: [
        { kind: 'card' as const, v: 1 as const, id: 'answer', title: 'Result', bodyMarkdown: 'actual card body' },
      ],
    };
    const append = (timestamp: number, visibility?: 'whisper') =>
      f.messages.append({
        userId: 'owner',
        threadId: thread.id,
        from: { kind: 'user', userId: 'owner' },
        content: 'verbatim original text',
        mentions: [],
        timestamp,
        thinking: 'stored presentation sentinel',
        extra: { rich: structuredClone(rich), stream: { invocationId: 'internal-invocation' } },
        ...(visibility ? { visibility, whisperTo: [] } : {}),
      });
    const earlier = append(100);
    const hidden = append(101, 'whisper');
    const source = append(102);
    assert.equal(
      (
        await f.bridge.dispatch({
          catId: 'gpt-dot',
          userId: 'owner',
          threadId: thread.id,
          sourceMessageId: source.id,
          dispatchInvocationId: 'presentation-read',
          content: source.content,
        })
      ).kind,
      'sent',
    );
    const eventId = f.delivered[0]!;
    const read = await f.returns.read(f.setup.credentialSecret, eventId);
    assert.deepEqual(
      read.context.map((message) => message.id),
      [earlier.id],
    );
    for (const projected of [read.source, ...read.context]) {
      assert.equal(projected.content, source.content);
      assert.deepEqual(projected.rich, rich);
      assert.equal(projected.thinking, source.thinking);
      assert.equal('extra' in projected, false, 'do not serialize all MessageExtra');
      assert.equal(JSON.stringify(projected).includes('internal-invocation'), false);
    }
    const hiddenRecord = f.messages.getById(hidden.id)!;
    hiddenRecord.extra!.rich!.blocks[0] = { ...rich.blocks[0]!, bodyMarkdown: 'private rich sentinel' };
    const current = await f.returns.read(f.setup.credentialSecret, eventId);
    assert.equal(JSON.stringify(current).includes('private rich sentinel'), false);
    f.messages.softDelete(earlier.id, 'owner');
    assert.deepEqual((await f.returns.read(f.setup.credentialSecret, eventId)).context, []);
    f.messages.softDelete(source.id, 'owner');
    await assert.rejects(f.returns.read(f.setup.credentialSecret, eventId), /dot_source_unavailable/);
  } finally {
    await f.cleanup();
  }
});

test('explicit setup retry after 24h renews only unfinished sources and survives restart', async () => {
  const f = await fixture();
  try {
    await new DotConnectionTestService(f).run('owner');
    const [a, b] = (await f.connection.current())!.testEventIds;
    const recordA = (await f.dispatches.read(a!))!;
    await f.returns.read(f.setup.credentialSecret, a!);
    await f.returns.reply(f.setup.credentialSecret, a!, `received ${recordA.expectedNonce}`);
    f.advance();
    await new DotConnectionTestService(f).run('owner');
    const [nextA, nextB] = (await f.connection.current())!.testEventIds;
    assert.equal(nextA, a, 'successful A keeps its original receipt');
    assert.notEqual(nextB, b, 'unfinished B receives a new event generation');
    assert.deepEqual(f.delivered.slice(0, 2).sort(), [a, b].sort(), 'initial A/B delivery order is immaterial');
    assert.deepEqual(f.delivered.slice(2), [nextB], 'only B is redelivered');
    const oldB = (await f.dispatches.read(b!))!;
    const newB = (await f.dispatches.read(nextB!))!;
    assert.equal(newB.threadId, oldB.threadId);
    assert.equal(newB.sourceMessageId, oldB.sourceMessageId);
    const claim = await f.grants.claim({
      threadId: newB.threadId,
      sourceMessageId: newB.sourceMessageId,
      userId: 'owner',
      targetCatId: 'gpt-dot',
    });
    assert.equal(claim.ok, true, 'expired return grant is renewed');
    if (!claim.ok) throw new Error(claim.reason);
    assert.equal(claim.dispatchInvocationId, newB.dispatchInvocationId);
    await f.grants.release(claim);
    await f.returns.read(f.setup.credentialSecret, nextB!);
    await f.returns.reply(f.setup.credentialSecret, nextB!, `received ${newB.expectedNonce}`);
    await new DotConnectionTestService(f).run('owner');
    assert.equal(f.delivered.length, 3, 'completed tests never resend on restart');
  } finally {
    await f.cleanup();
  }
});

test('explicit setup retry preserves an active append claim and its event', async () => {
  const f = await fixture();
  try {
    await new DotConnectionTestService(f).run('owner');
    const ids = (await f.connection.current())!.testEventIds;
    const records = await Promise.all(ids.map((id) => f.dispatches.read(id)));
    const claims = await Promise.all(
      records.map((record) =>
        f.grants.claim({
          threadId: record!.threadId,
          sourceMessageId: record!.sourceMessageId,
          userId: 'owner',
          targetCatId: 'gpt-dot',
        }),
      ),
    );
    await new DotConnectionTestService(f).run('owner');
    assert.deepEqual((await f.connection.current())!.testEventIds, ids);
    assert.equal(f.delivered.length, 2, 'in-flight returns are not redelivered');
    for (const claim of claims) {
      assert.equal(claim.ok, true);
      if (claim.ok) assert.equal(await f.grants.commit(claim), true, 'original append claim remains valid');
    }
  } finally {
    await f.cleanup();
  }
});
