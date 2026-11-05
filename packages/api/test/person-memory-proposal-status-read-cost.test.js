import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { PersonMemoryProposalStatusContextResolver } from '../dist/domains/memory/people/PersonMemoryProposalStatusContextResolver.js';
import { createMessageReadDiagnostics } from '../dist/infrastructure/message-read-diagnostics.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f276-proposal-status-cost');

function returnedCodeUnits(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + returnedCodeUnits(child), 0);
  if (value && typeof value === 'object')
    return Object.values(value).reduce((sum, child) => sum + returnedCodeUnits(child), 0);
  return 0;
}

function proposalExtra(candidateId, subjectDisplayName) {
  return JSON.stringify({
    rich: {
      v: 1,
      blocks: [
        {
          id: `person-memory-${candidateId}`,
          kind: 'card',
          v: 1,
          title: `要把 ${subjectDisplayName} 记下来吗？`,
          actions: [
            {
              label: '去审批',
              action: 'person-memory:open-approval-hub',
              payload: { candidateId },
            },
          ],
          meta: {
            kind: 'person_memory_proposal',
            candidateId,
            subjectDisplayName,
            envelopeRef: `approval:F276:${candidateId}`,
            decisionSurface: 'approval_hub',
            status: 'pending_approval',
          },
        },
      ],
    },
  });
}

function proposalForIndex(index) {
  if (index === 0) return { candidateId: 'person_candidate_huang_ting_oldest', subjectDisplayName: '黄挺' };
  const recentProposalIndex = index - 191;
  if (recentProposalIndex < 1) return undefined;
  return {
    candidateId: `person_candidate_recent_${recentProposalIndex}`,
    subjectDisplayName: `最近人物 ${recentProposalIndex}`,
  };
}

function ownerForIndex(index, ownerUserId) {
  if (index === 50) return 'other-owner';
  if (index === 53) return 'system';
  return ownerUserId;
}

function sourceForIndex(index) {
  if (index === 53) return { kind: 'system', service: 'scheduler' };
  return { kind: 'agent', catId: 'codex61-sol' };
}

function extraForIndex(index, proposal) {
  if (index === 54) return '{malformed';
  if (proposal) return proposalExtra(proposal.candidateId, proposal.subjectDisplayName);
  return JSON.stringify({ trace: { index } });
}

async function seedProposalStatusThread(redis, threadId, ownerUserId) {
  const payload = 'unused tool output '.repeat(3072);
  const toolEvents = JSON.stringify([{ type: 'tool_result', output: payload }]);
  const seed = redis.pipeline();

  for (let index = 0; index < 200; index += 1) {
    const id = `message-${String(index).padStart(3, '0')}`;
    const proposal = proposalForIndex(index);
    const source = sourceForIndex(index);
    seed.hset(`msg:${id}`, {
      id,
      threadId,
      userId: ownerForIndex(index, ownerUserId),
      catId: source.kind === 'system' ? '' : 'codex61-sol',
      from: JSON.stringify(source),
      content: `message ${index}`,
      thinking: 'unused reasoning',
      metadata: JSON.stringify({ source: 'cost-fixture' }),
      contentBlocks: JSON.stringify([{ type: 'text', text: `visible block ${index}` }]),
      toolEvents,
      extra: extraForIndex(index, proposal),
      timestamp: String(index + 1),
      deliveryStatus: index === 51 ? 'queued' : 'delivered',
      ...(index === 52 ? { deletedAt: '1' } : {}),
    });
    seed.zadd(`msg:thread:${threadId}`, index + 1, id);
  }

  await seed.exec();
}

function instrumentProjectedReads(redis) {
  const nativeSend = redis.sendCommand.bind(redis);
  const nativeMulti = redis.multi.bind(redis);
  const stats = {
    fullHashReads: 0,
    projectedReads: 0,
    transferredCodeUnits: 0,
    projectedFields: new Set(),
  };

  redis.sendCommand = (command, ...args) => {
    if (command.name === 'hgetall') stats.fullHashReads += 1;
    if (command.name === 'hmget') {
      stats.projectedReads += 1;
      for (const field of command.args.slice(1)) stats.projectedFields.add(String(field));
    }
    return nativeSend(command, ...args);
  };
  redis.multi = (...args) => {
    const transaction = nativeMulti(...args);
    const nativeExec = transaction.exec.bind(transaction);
    transaction.exec = async (...execArgs) => {
      const result = await nativeExec(...execArgs);
      stats.transferredCodeUnits += returnedCodeUnits(result);
      return result;
    };
    return transaction;
  };

  return {
    stats,
    restore() {
      redis.sendCommand = nativeSend;
      redis.multi = nativeMulti;
    },
  };
}

function candidateStoreFor(ownerUserId, lookups) {
  return {
    async getCandidateForOwner(requestedOwnerUserId, candidateId) {
      assert.equal(requestedOwnerUserId, ownerUserId);
      lookups.push(candidateId);
      return {
        candidateId,
        state: 'withdrawn',
        remainingDraftIds: [],
        publication: { state: 'failed', reason: 'test' },
      };
    },
  };
}

test('proposal status discovery preserves its bounded result without reading large tool payloads', async (t) => {
  const redis = owned.client('f276-proposal-status-cost:');
  const events = [];
  const diagnostics = createMessageReadDiagnostics({
    onEvent(event) {
      events.push(event);
    },
    minBatchMs: 0,
  });
  const store = new RedisMessageStore(redis, { ttlSeconds: 0, readDiagnostics: diagnostics });
  const threadId = 'thread-f276-cost';
  const ownerUserId = 'owner-1';
  await seedProposalStatusThread(redis, threadId, ownerUserId);

  const baselineMessages = await store.getByThread(threadId, 200, ownerUserId);
  const baselineIds = baselineMessages.map((message) => message.id);
  const baseline = events.findLast((event) => event.kind === 'message_read_batch');
  assert(baseline && baseline.kind === 'message_read_batch');
  assert.equal(baselineIds.length, 197, 'foreign, queued and deleted rows remain invisible while system is visible');
  assert(baseline.parsers.toolEvents.inputCodeUnits > 10_000_000, 'fixture must reproduce the observed payload cost');
  events.length = 0;

  const instrumentation = instrumentProjectedReads(redis);

  let readArguments;
  let discoveredIds;
  const lookups = [];
  try {
    const resolver = new PersonMemoryProposalStatusContextResolver(candidateStoreFor(ownerUserId, lookups), {
      async getByThread(...args) {
        readArguments = args;
        const messages = await store.getByThread(...args);
        discoveredIds = messages.map((message) => message.id);
        return messages;
      },
    });

    const context = await resolver.resolve(ownerUserId, threadId, '黄挺现在是什么状态？');

    assert.deepEqual(readArguments, [threadId, 200, ownerUserId, { artifactProjection: true }]);
    assert.deepEqual(discoveredIds, baselineIds, 'projection must preserve ordering and visibility');
    assert.equal(lookups.length, 8);
    assert.equal(lookups[0], 'person_candidate_huang_ting_oldest');
    assert.doesNotMatch(context, /person_candidate_recent_1.*liveStatus=/);
    assert.match(context, /person_candidate_huang_ting_oldest.*subject="黄挺".*liveStatus=withdrawn/);

    const projected = events.findLast((event) => event.kind === 'message_read_batch');
    assert(projected && projected.kind === 'message_read_batch');
    t.diagnostic(
      JSON.stringify({
        baselineToolEventCodeUnits: baseline.parsers.toolEvents.inputCodeUnits,
        projectedToolEventCodeUnits: projected.parsers.toolEvents.inputCodeUnits,
        projectedContentBlockCodeUnits: projected.parsers.contentBlocks.inputCodeUnits,
        projectedExtraCodeUnits: projected.parsers.extraHydration.inputCodeUnits,
        transferredCodeUnits: instrumentation.stats.transferredCodeUnits,
      }),
    );
    assert.equal(instrumentation.stats.fullHashReads, 0, 'status discovery must not fetch full message hashes');
    assert.ok(instrumentation.stats.projectedReads >= 200, 'the same bounded history window is still examined');
    for (const field of ['content', 'thinking', 'metadata', 'toolEvents'])
      assert.equal(
        instrumentation.stats.projectedFields.has(field),
        false,
        `${field} is unrelated to proposal discovery`,
      );
    assert.equal(instrumentation.stats.projectedFields.has('extra'), true, 'typed proposal cards remain available');
    assert.equal(
      instrumentation.stats.projectedFields.has('contentBlocks'),
      true,
      'artifactProjection honestly retains content blocks',
    );
    assert.equal(projected.parsers.toolEvents.inputCodeUnits, 0);
    assert.ok(projected.parsers.contentBlocks.inputCodeUnits > 0);
    assert.ok(projected.parsers.extraHydration.inputCodeUnits > 0);
    assert.ok(
      instrumentation.stats.transferredCodeUnits < 1_000_000,
      'large synthetic tool payloads must stay in Redis',
    );
  } finally {
    diagnostics.stop();
    instrumentation.restore();
  }
});
