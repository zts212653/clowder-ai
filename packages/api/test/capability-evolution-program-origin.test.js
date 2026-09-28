import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEvolutionProgramOriginResolver } from '../dist/infrastructure/capability-evolution/read-model/program-origin.js';

const program = { programId: `evolution-program:${'a'.repeat(32)}`, workspaceId: 'user:operator' };
const created = {
  programId: program.programId,
  originRef: 'thread:thread-original:invocation:inv-start:message:user-message',
  event: { type: 'program_created', workspaceId: program.workspaceId },
};

function setup({ events = [created], thread = { createdBy: 'operator', title: '让审阅更贴近原始需求' } } = {}) {
  const reads = [];
  const resolver = createEvolutionProgramOriginResolver({
    eventLog: {
      read: async (id) => {
        assert.equal(id, program.programId);
        return events;
      },
    },
    threadStore: {
      get: async (id) => {
        reads.push(id);
        return thread;
      },
    },
  });
  return { resolver, reads, thread };
}

describe('F311 source context remains F117-owned', () => {
  it('exposes only the authenticated creation cat as the continuation contact', async () => {
    const first = { ...created, actorRef: 'cat:codex-sol' };
    const { resolver } = setup({ events: [first, { ...first, actorRef: 'cat:opus5' }] });
    assert.equal((await resolver(program)).createdByCatId, 'codex-sol');
    for (const actorRef of ['user:operator', 'cat:codex-sol\n@opus5', 'browser:cat:opus5']) {
      assert.equal((await setup({ events: [{ ...created, actorRef }] }).resolver(program)).createdByCatId, undefined);
    }
  });
  it('reads the live creation conversation and follows title changes without changing the Program', async () => {
    const before = structuredClone(created);
    const { resolver, reads, thread } = setup();
    assert.deepEqual(await resolver(program), { threadId: 'thread-original', title: thread.title });
    thread.title = '审阅实验 · 新标题';
    assert.equal((await resolver(program)).title, thread.title);
    thread.deletedAt = 10;
    assert.equal(await resolver(program), undefined);
    assert.deepEqual(created, before);
    assert.deepEqual(reads, ['thread-original', 'thread-original', 'thread-original']);
  });
  it('withholds foreign, deleted and missing conversations', async () => {
    for (const thread of [
      null,
      { createdBy: 'other', title: 'private' },
      { createdBy: 'operator', title: 'deleted', deletedAt: 10 },
    ]) {
      assert.equal(await setup({ thread }).resolver(program), undefined);
    }
  });
  it('does not infer a thread from caller text, later commands or another Program stream', async () => {
    for (const events of [
      [],
      [{ ...created, programId: 'another-program' }],
      [{ ...created, event: { ...created.event, workspaceId: 'user:other' } }],
      [{ ...created, originRef: 'browser:operator:message:thread:thread-stolen:invocation:fake:message:fake' }],
      [{ ...created, originRef: 'agent-key:key:message:user-message' }, created],
    ]) {
      const { resolver, reads } = setup({ events });
      assert.equal(await resolver(program), undefined);
      assert.deepEqual(reads, []);
    }
  });
});
