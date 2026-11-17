import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { matterWriteInputSchema } from '@cat-cafe/shared';
import { MatterMemoryService } from '../dist/domains/memory/matters/MatterMemoryService.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { headers, matterCallbackFixture } from './helpers/matter-callback-fixture.js';

describe('F332 historical occurrence persistence', () => {
  let fixture;
  let sequence = 0;
  beforeEach(async () => {
    fixture = await matterCallbackFixture();
  });
  afterEach(async () => {
    await fixture.app.close();
    await fixture.evidenceStore.close();
  });
  const request = (input, caller = 'call-a') =>
    fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-matters/write',
      headers: headers(caller),
      payload: { requestId: `history-${sequence++}`, ...input },
    });
  const write = async (input, caller = 'call-a') => {
    const response = await request(input, caller);
    assert.ok(response.statusCode < 300, response.body);
    return response.json();
  };
  const read = async (matterId, history = false) => {
    const response = await fixture.app.inject({
      url: `/api/callbacks/memory-matters/${matterId}?history=${history}`,
      headers: headers('call-b'),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  it('persists return history and exact retries through reopening, then forgets every occurrence and fixed receipt', async () => {
    const [a, b] = [{ threadId: fixture.threadA.id }, { threadId: fixture.threadB.id }];
    const create = {
      operation: 'create',
      requestId: 'persist-create',
      title: 'Disk history',
      summary: '归纳',
      sources: [a],
    };
    const created = await write(create);
    const matterId = created.matter.matterId;
    const first = (await read(matterId)).entries[0];
    await write({
      operation: 'correct',
      matterId,
      expectedRevision: 1,
      entryId: first.entryId,
      summary: first.summary,
      source: b,
    });
    const second = (await read(matterId)).entries[0];
    const correction = {
      operation: 'correct',
      requestId: 'persist-return',
      matterId,
      expectedRevision: 2,
      entryId: second.entryId,
      summary: first.summary,
      source: a,
    };
    const returned = await write(correction);
    const directory = mkdtempSync(join(tmpdir(), 'f332-history-'));
    const path = join(directory, 'memory.sqlite');
    let evidence;
    const actor = { userId: 'owner-a', viewer: { type: 'cat', catId: 'codex-astra' } };
    const reopen = async () => {
      evidence = new SqliteEvidenceStore(path);
      await evidence.initialize();
      return new MatterMemoryService({
        db: evidence.getDb(),
        messageStore: fixture.messageStore,
        threadStore: fixture.threadStore,
        runWrite: (operation) => evidence.runExclusive(operation),
      });
    };
    try {
      await fixture.evidenceStore.getDb().backup(path);
      let service = await reopen();
      assert.equal((await service.read(actor, matterId, { history: true })).entries.length, 3);
      assert.deepEqual(await service.write(actor, matterWriteInputSchema.parse(correction)), returned);
      assert.deepEqual(await service.write(actor, matterWriteInputSchema.parse(create)), created);
      const oldSnapshot = await service.writeSnapshot(
        { userId: 'owner-a', viewer: { type: 'user' } },
        matterId,
        created.writeRef,
      );
      assert.equal(oldSnapshot.entries[0].entryId, first.entryId);
      await service.write(
        { userId: 'owner-a', viewer: { type: 'user' } },
        { operation: 'forget', requestId: 'forget-history', matterId, expectedRevision: 3 },
      );
      await evidence.close();
      service = await reopen();
      assert.equal((await service.write(actor, matterWriteInputSchema.parse(correction))).outcome, 'forgotten');
      assert.equal((await service.write(actor, matterWriteInputSchema.parse(create))).outcome, 'forgotten');
      assert.deepEqual(await service.catalog(actor), { items: [] });
      assert.equal(evidence.getDb().prepare('SELECT COUNT(*) AS n FROM memory_matter_entries').get().n, 0);
      assert.equal(
        evidence
          .getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM memory_matter_requests WHERE json_type(result_json, '$.snapshot') IS NOT NULL",
          )
          .get().n,
        0,
      );
    } finally {
      await evidence?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
