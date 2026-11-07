import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MatterMemoryService } from '../../dist/domains/memory/matters/MatterMemoryService.js';
import { matterOpeningDirectory } from '../../dist/domains/memory/matters/matter-opening-directory.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { estimateTokens } from '../../dist/utils/token-counter.js';

const actor = { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } };
const writer = { userId: 'owner', viewer: { type: 'cat', catId: 'codex-astra' } };
const selection = (message) => ({
  threadId: message.threadId,
  messageId: message.id,
  segment: 'body',
  start: 0,
  end: message.content.length,
  quote: message.content,
});
const payload = (text) => JSON.parse(text.split('\n').find((line) => line.startsWith('{')));

describe('F332 contextual directory and the same-version interpretation', () => {
  let directory, evidence, service, messages, sequence;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'f332-context-'));
    evidence = new SqliteEvidenceStore(join(directory, 'memory.sqlite'));
    await evidence.initialize();
    messages = new Map();
    sequence = 0;
    service = new MatterMemoryService({
      db: evidence.getDb(),
      runWrite: (operation) => evidence.runExclusive(operation),
      messageStore: { getById: (id) => messages.get(id) ?? null },
      threadStore: { get: (id) => ({ id, createdBy: 'owner' }), list: () => [] },
    });
  });
  afterEach(async () => {
    await evidence.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const source = (threadId = 'elsewhere', extra = {}) => {
    const id = `message-${sequence++}`;
    const message = {
      id,
      threadId,
      userId: 'owner',
      from: { kind: 'user', userId: 'owner' },
      catId: null,
      content: `Original decision ${id}`,
      timestamp: 1,
      mentions: [],
      ...extra,
    };
    messages.set(id, message);
    return message;
  };
  const create = async (
    threadId = 'elsewhere',
    description = '仅适用于原社区管理线程。工程线程可继续获准工作。',
    title = 'Matter',
    extra = {},
  ) => {
    const message = source(threadId, extra);
    const receipt = await service.write(writer, {
      operation: 'create',
      requestId: `create-${sequence++}`,
      title,
      description,
      sources: [selection(message)],
    });
    return { ...receipt.matter, message, description };
  };

  it('finds a current-thread page beyond the old first twelve, then pages all readable items in stable time/ID order', async () => {
    const pages = [];
    for (let i = 0; i < 16; i++) pages.push(await create());
    pages.sort((a, b) => (a.matterId < b.matterId ? -1 : 1));
    const local = pages.at(-1);
    const localSource = source('here');
    await service.write(writer, {
      operation: 'append',
      requestId: 'add-local',
      matterId: local.matterId,
      expectedRevision: 1,
      sources: [selection(localSource)],
    });
    evidence.getDb().prepare('UPDATE memory_matters SET updated_at = 100').run();
    evidence.getDb().prepare('UPDATE memory_matters SET updated_at = 1 WHERE matter_id = ?').run(local.matterId);
    await create('here', 'PRIVATE explanation', 'PRIVATE title', { visibility: 'whisper', whisperTo: ['codex-astra'] });
    const first = await service.catalog(actor, { threadId: 'here', limit: 12 });
    assert.equal(first.items[0].matterId, local.matterId);
    assert.equal(first.items[0].hasThreadSource, true);
    const second = await service.catalog(actor, { threadId: 'here', cursor: first.nextCursor, limit: 12 });
    assert.deepEqual(
      [...first.items, ...second.items].map((item) => item.matterId),
      [local, ...pages.slice(0, -1)].map((item) => item.matterId),
    );
    assert.equal(second.nextCursor, undefined);
    assert.equal(JSON.stringify(first).includes('PRIVATE'), false);
    await assert.rejects(service.catalog(actor, { threadId: 'another', cursor: first.nextCursor }), /invalid_cursor/);
    const opening = payload(await matterOpeningDirectory(service, 'owner', 'codex61-sol', 'here'));
    assert.equal(opening.items[0].matterId, local.matterId);
    assert.equal(opening.items[0].threadSource, '含本线程来源');
    const tail = await service.catalog(actor, { threadId: 'here', cursor: opening.nextCursor });
    assert.equal(tail.items.length, 4);
    const engineering = payload(await matterOpeningDirectory(service, 'owner', 'codex61-sol', 'engineering'));
    assert.ok(engineering.items.every((item) => !item.threadSource && !item.contextHint));
    assert.equal(evidence.getDb().prepare('SELECT COUNT(*) AS n FROM memory_cue_events').get().n, 0);
  });

  it('does not turn changed, retired, recalled or newly private sources into a local rule or a current interpretation', async () => {
    const changed = await create('here', 'UNVERIFIED interpretation');
    const extra = source();
    await service.write(writer, {
      operation: 'append',
      requestId: 'second-source',
      matterId: changed.matterId,
      expectedRevision: 1,
      sources: [selection(extra)],
    });
    const page = await service.read(actor, changed.matterId);
    const expected = page.entries.find((entry) => entry.source.messageId === extra.id);
    const details = {
      matterId: changed.matterId,
      pageRevision: page.matter.revision,
      entries: [{ entryId: expected.entryId, sourceRevision: expected.source.sourceRevision }],
    };
    changed.message.content = 'Corrected original meaning';
    const retired = await create('here', 'Retired source');
    const retiredEntry = (await service.read(writer, retired.matterId)).entries[0];
    await service.write(writer, {
      operation: 'retire_entry',
      requestId: 'retire-local',
      matterId: retired.matterId,
      expectedRevision: 1,
      entryId: retiredEntry.entryId,
    });
    const recalled = await create('here', 'RECALLED interpretation', 'RECALLED title');
    recalled.message.recall = { recalledAt: 2 };
    const privatePage = await create('here', 'PRIVATE interpretation', 'PRIVATE title');
    privatePage.message.visibility = 'whisper';
    privatePage.message.whisperTo = ['codex-astra'];
    const catalogue = await service.catalog(actor, { threadId: 'here' });
    assert.ok(catalogue.items.every((item) => !item.hasThreadSource));
    assert.equal(catalogue.items.find((item) => item.matterId === changed.matterId).summaryStatus, 'sources_changed');
    const text = await matterOpeningDirectory(service, 'owner', 'codex61-sol', 'here');
    assert.doesNotMatch(text, /UNVERIFIED|RECALLED|PRIVATE/);
    assert.deepEqual(await service.readReceipt('owner', 'codex61-sol', details), { status: 'changed' });
    assert.equal((await service.read(actor, changed.matterId)).summaryStatus, 'sources_changed');
    assert.equal(evidence.getDb().prepare('SELECT COUNT(*) AS n FROM memory_cue_events').get().n, 0);
  });

  it('keeps complete scoped descriptions only when they fit the published page and whole-directory token limits', async () => {
    const descriptions = new Map();
    const long = await create(
      'here',
      `${'需要先核验真实需求，再判断架构和维护成本。'.repeat(110)}\n仅限社区管理；工程线程获准施工。`,
      'Long',
    );
    descriptions.set(long.matterId, long.description);
    for (let i = 0; i < 9; i++) {
      const row = await create(
        'here',
        `${'背景和行动必须一起保留。'.repeat(38)}\n仅限社区管理；工程线程获准施工。`,
        `Local ${i}`,
      );
      descriptions.set(row.matterId, row.description);
    }
    await create('elsewhere', 'UNRELATED full description');
    const text = await matterOpeningDirectory(service, 'owner', 'codex61-sol', 'here');
    const body = payload(text);
    assert.equal(body.budget.summaryTokensPerPage, 1024);
    assert.equal(body.budget.directoryTokens, 3072);
    assert.equal(body.budget.encoding, 'o200k_base');
    assert.ok(estimateTokens(text) <= body.budget.directoryTokens);
    assert.ok(body.items.some((item) => item.contextHint));
    for (const item of body.items.filter((item) => item.contextHint)) {
      assert.equal(item.contextHint, descriptions.get(item.matterId));
      assert.ok(estimateTokens(item.contextHint) <= body.budget.summaryTokensPerPage);
      assert.match(item.contextHint, /仅限社区管理；工程线程获准施工。$/);
      assert.ok(item.revision > 0);
    }
    assert.equal(body.items.find((item) => item.matterId === long.matterId).contextHint, undefined);
    assert.doesNotMatch(text, /UNRELATED full description/);
    assert.equal(evidence.getDb().prepare('SELECT COUNT(*) AS n FROM memory_cue_events').get().n, 0);
  });

  it('continues from the last actually displayed item when even directory metadata exceeds the round budget', async () => {
    const ids = [];
    for (let i = 0; i < 14; i++) ids.push((await create('elsewhere', '', `${i} ${'𰻞'.repeat(78)}`)).matterId);
    const text = await matterOpeningDirectory(service, 'owner', 'codex61-sol', 'here');
    const opening = payload(text);
    assert.ok(estimateTokens(text) <= 3072);
    assert.ok(opening.items.length < 12);
    assert.ok(opening.nextCursor);
    const rest = await service.catalog(actor, { threadId: 'here', cursor: opening.nextCursor, limit: 30 });
    assert.deepEqual(new Set([...opening.items, ...rest.items].map((item) => item.matterId)), new Set(ids));
    assert.equal(opening.items.length + rest.items.length, ids.length);
  });
});
