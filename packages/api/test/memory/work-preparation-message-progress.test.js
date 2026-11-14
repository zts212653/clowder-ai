import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnerPreparationSources } from '../../dist/domains/memory/cue/preparation/OwnerPreparationSources.js';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { preparationFixture } from '../helpers/work-preparation-fixture.js';

for (const heldAt of ['source-thread', 'source-message', 'retrieval'])
  test(`W3 failure identifies pending ${heldAt} without source content or false settlement`, async (t) => {
    const logs = [];
    const f = preparationFixture(t, { logger: { warn: (fields) => logs.push(fields) } });
    const thread = { id: f.auth.threadId, createdBy: f.auth.userId, projectPath: '/PRIVATE_PATH' };
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const wait = async (phase, result) => {
      if (phase === heldAt) await waiting;
      return result;
    };
    const service = new MessageSearchService({
      threadStore: { list: () => [thread], get: () => wait('source-thread', thread) },
      messageStore: {
        getById: (id) =>
          wait('source-message', {
            id,
            threadId: thread.id,
            userId: f.auth.userId,
            content: 'PRIVATE_BODY',
            timestamp: 1,
          }),
      },
      evidenceStore: {
        readMessagePassageState: () => ({ current: true }),
        searchMessagePassages: (_query, options) => {
          options.onReadSnapshot?.({
            phase: 'embedding-embed',
            outcome: 'pending',
            elapsedMs: 2,
            query: 'PRIVATE_QUERY',
            pid: 42,
            candidateAudit: { body: 'PRIVATE_BODY' },
            executionId: 'PRIVATE_COORDINATE',
          });
          return wait('retrieval', { passages: [], meta: { effectiveMode: 'lexical', truncated: false } });
        },
      },
    });
    const owners = new OwnerPreparationSources({ messages: service, taste: { resolveExplicit: async () => null } });
    f.deps.sources.create = (input) => owners.create(input);
    const result = await f.service.prepare({
      auth: f.auth,
      activity: 'html',
      query: 'PRIVATE_QUERY',
      receivedAt: Date.now(),
      deadlineAt: Date.now() + 550,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'source_unavailable');
    assert.deepEqual(result.pointers, []);
    assert.equal(logs.length, 1);
    const source = logs[0].sourcePhases[0];
    assert.equal(source.phases.read.state, 'pending');
    assert.ok(source.readProgress, 'the original native read must contribute a bounded internal stage snapshot');
    assert.equal(source.readProgress.stage, heldAt);
    assert.equal(source.readProgress.state, 'pending');
    assert.ok(source.readProgress.elapsedMs >= 0);
    if (heldAt === 'retrieval') assert.equal(source.readProgress.native.phase, 'embedding-embed');
    const snapshot = JSON.stringify(logs);
    assert.doesNotMatch(snapshot, /PRIVATE_|candidateAudit|executionId|"pid"/);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(logs), snapshot, 'late child events cannot mutate the captured failure');
  });
