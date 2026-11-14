import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MemoryCueEpisodeStore } from '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { projectInvocationCues } from '../../dist/domains/memory/cue/project-invocation-cues.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MatterMemoryService } from '../../dist/domains/memory/matters/MatterMemoryService.js';
import { matterOpeningDirectory } from '../../dist/domains/memory/matters/matter-opening-directory.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const astra = { userId: 'owner-a', viewer: { type: 'cat', catId: 'codex-astra' } };
const sol = { userId: 'owner-a', viewer: { type: 'cat', catId: 'codex61-sol' } };
const owner = { userId: 'owner-a', viewer: { type: 'user' } };
const scope = { ownerUserId: 'owner-a', threadId: 'b', invocationId: 'read-b' };
const selection = (message, extra = {}) => ({
  threadId: message.threadId,
  messageId: message.id,
  segment: 'body',
  start: 0,
  end: message.content.length,
  quote: message.content,
  ...extra,
});

describe('F332 canonical matters: privacy, lossless sources and immutable read evidence', () => {
  let directory;
  let evidence;
  let service;
  let messages;
  let threads;
  let sequence;
  let dbPath;
  const message = (id, content, extra = {}) => ({
    id,
    threadId: 'a',
    userId: 'owner-a',
    from: { kind: 'user', userId: 'owner-a' },
    catId: null,
    content,
    timestamp: 100,
    mentions: [],
    ...extra,
  });
  const reopen = async () => {
    evidence = new SqliteEvidenceStore(dbPath);
    await evidence.initialize();
    service = new MatterMemoryService({
      db: evidence.getDb(),
      runWrite: (operation) => evidence.runExclusive(operation),
      messageStore: { getById: (id) => messages.get(id) ?? null },
      threadStore: {
        get: (id) => threads.get(id) ?? null,
        list: (userId) => [...threads.values()].filter((thread) => thread.createdBy === userId),
      },
    });
  };
  const create = async (sources, title = 'Settings decision') =>
    service.write(astra, {
      operation: 'create',
      requestId: `create-${sequence++}`,
      title,
      description: 'Cat interpretation',
      sources,
    });
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'f332-matters-'));
    dbPath = join(directory, 'memory.sqlite');
    messages = new Map();
    threads = new Map([
      ['a', { id: 'a', createdBy: 'owner-a' }],
      ['b', { id: 'b', createdBy: 'owner-a' }],
      ['foreign', { id: 'foreign', createdBy: 'owner-b' }],
    ]);
    sequence = 0;
    messages.set('first', message('first', 'Use the current workspace entry.'));
    await reopen();
  });
  afterEach(async () => {
    await evidence.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('revalidates mixed-page metadata for each cat, including retired sources, and keeps owner management possible', async () => {
    messages.set(
      'private',
      message('private', 'Private title material', { visibility: 'whisper', whisperTo: ['codex-astra'] }),
    );
    const created = await create(
      [selection(messages.get('first')), selection(messages.get('private'))],
      'Private mixed matter',
    );
    const id = created.matter.matterId;
    assert.equal((await service.catalog(astra)).items.length, 1);
    assert.deepEqual(await service.catalog(sol), { items: [] });
    await assert.rejects(service.read(sol, id), /not_available/);
    const page = await service.read(astra, id);
    const hidden = page.entries.find((entry) => entry.source.messageId === 'private');
    await service.write(astra, {
      operation: 'retire_entry',
      requestId: 'retire-private',
      matterId: id,
      expectedRevision: page.matter.revision,
      entryId: hidden.entryId,
    });
    assert.deepEqual(await service.catalog(sol, { query: 'Private' }), { items: [] });
    assert.deepEqual(await service.catalog({ ...astra, userId: 'owner-b' }), { items: [] });
    messages.get('private').deletedAt = 200;
    const managed = await service.catalog(owner, { management: true });
    assert.deepEqual(Object.keys(managed.items[0]).sort(), ['matterId', 'revision', 'status', 'unavailable']);
    assert.equal(JSON.stringify(managed).includes('Private'), false);
    const retired = await service.write(owner, {
      operation: 'retire',
      requestId: 'retire-unavailable',
      matterId: id,
      expectedRevision: managed.items[0].revision,
    });
    const forgotten = await service.write(owner, {
      operation: 'forget',
      requestId: 'forget-unavailable',
      matterId: id,
      expectedRevision: retired.matter.revision,
    });
    assert.equal(forgotten.outcome, 'forgotten');
    assert.equal((await service.catalog(owner, { management: true })).items.length, 0);
  });

  it('rejects foreign, recalled, deleted-thread and unpublished source admission without leaking a page', async () => {
    for (const [id, changes] of [
      ['foreign', { threadId: 'foreign', userId: 'owner-b' }],
      ['recalled', { recall: { recalledAt: 5 } }],
      ['queued', { deliveryStatus: 'queued' }],
      ['deleted', { _tombstone: true }],
    ]) {
      const source = message(id, 'Should stay unavailable', changes);
      messages.set(id, source);
      await assert.rejects(create([selection(source)]), /not_available/);
    }
    threads.get('a').deletedAt = 10;
    await assert.rejects(create([selection(messages.get('first'))]), /not_available/);
    assert.equal(evidence.getDb().prepare('SELECT COUNT(*) AS n FROM memory_matters').get().n, 0);
  });

  it('preserves raw whitespace, block/attachment coordinates and the two speakers of a quote', async () => {
    messages.set(
      'quoted',
      message('quoted', 'One  precise\nquote', { from: { kind: 'agent', catId: 'codex61-sol' }, catId: 'codex61-sol' }),
    );
    const attachment = {
      v: 1,
      id: 'quote-1',
      kind: 'quote',
      text: messages.get('quoted').content,
      comment: '  Keep this\nspacing.  ',
      selectionStart: 0,
      selectionEnd: messages.get('quoted').content.length,
      source: { kind: 'message', threadId: 'a', messageId: 'quoted', senderCatId: 'codex61-sol' },
    };
    const outer = message('outer', 'Body plus serialized quote', {
      contentBlocks: [
        { type: 'text', text: 'Owner body' },
        { type: 'context_attachment', attachment },
      ],
    });
    messages.set('outer', outer);
    const source = (segment, text) =>
      selection(outer, {
        segment,
        contentBlockIndex: 1,
        attachmentId: 'quote-1',
        start: 0,
        end: text.length,
        quote: text,
      });
    const created = await create([source('quote_comment', attachment.comment), source('quote_text', attachment.text)]);
    const page = await service.read(astra, created.matter.matterId);
    const comment = page.entries.find((entry) => entry.source.segment === 'quote_comment');
    const quote = page.entries.find((entry) => entry.source.segment === 'quote_text');
    assert.equal(comment.quote, attachment.comment);
    assert.equal(comment.source.author.kind, 'user');
    assert.equal(quote.attribution, 'quoted_in_message');
    assert.equal(quote.verifiedQuotedAuthor.catId, 'codex61-sol');
    messages.delete('quoted');
    assert.equal(
      (await service.read(astra, created.matter.matterId)).entries.find(
        (entry) => entry.attribution === 'quoted_in_message',
      ).verifiedQuotedAuthor,
      undefined,
    );
    attachment.comment = attachment.comment.trim();
    const changed = await service.read(astra, created.matter.matterId);
    assert.ok(changed.entries.every((entry) => entry.sourceStatus === 'changed' && entry.quote === undefined));
    await assert.rejects(create([selection(outer)]), /invalid_source/);
  });

  it('keeps pages, replacements, exact retries and forget suppression through force rebuild and reopening', async () => {
    const input = {
      operation: 'create',
      requestId: 'persistent-create',
      title: 'Persistence',
      description: '',
      sources: [selection(messages.get('first'))],
    };
    const [created, retry] = await Promise.all([service.write(astra, input), service.write(astra, input)]);
    assert.deepEqual(retry, created);
    const id = created.matter.matterId;
    messages.set('replacement', message('replacement', 'The revised entry.'));
    const page = await service.read(astra, id);
    await service.write(astra, {
      operation: 'correct',
      requestId: 'correct-persist',
      matterId: id,
      expectedRevision: 1,
      entryId: page.entries[0].entryId,
      source: selection(messages.get('replacement')),
    });
    const docs = join(directory, 'docs');
    mkdirSync(docs);
    writeFileSync(join(docs, 'note.md'), '# Index fixture\n');
    await new IndexBuilder(evidence, docs).rebuild({ force: true });
    await evidence.close();
    await reopen();
    assert.deepEqual(await service.write(astra, input), created);
    const restored = await service.read(astra, id, { history: true });
    assert.equal(restored.entries.find((entry) => entry.source.messageId === 'first').status, 'superseded');
    assert.equal((await service.read(sol, id)).entries[0].quote, 'The revised entry.');
    await service.write(owner, { operation: 'forget', requestId: 'forget-persist', matterId: id, expectedRevision: 2 });
    await new IndexBuilder(evidence, docs).rebuild({ force: true });
    await evidence.close();
    await reopen();
    assert.equal((await service.write(astra, input)).outcome, 'forgotten');
    assert.deepEqual(await service.catalog(astra), { items: [] });
    await assert.rejects(service.write(astra, { ...input, title: 'different retry' }), /request_conflict/);
  });

  it('records atomic read pairs, merges pages only in projection and preserves old versions after correction', async () => {
    messages.set('second', message('second', 'Another source.'));
    const id = (await create([selection(messages.get('first')), selection(messages.get('second'))])).matter.matterId;
    await service.catalog(sol);
    await service.read(owner, id);
    const db = evidence.getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_cue_events').get().n, 0);
    db.exec(
      "CREATE TEMP TRIGGER fail_matter_drill BEFORE INSERT ON memory_cue_events WHEN NEW.consumption_outcome = 'drilled' BEGIN SELECT RAISE(ABORT, 'read pair fault'); END",
    );
    await assert.rejects(service.readForInvocation(scope, 'codex61-sol', id), /read pair fault/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_cue_events').get().n, 0);
    db.exec('DROP TRIGGER fail_matter_drill');
    const first = await service.readForInvocation(scope, 'codex61-sol', id, { limit: 1 });
    const originalRows = db.prepare('SELECT * FROM memory_cue_events ORDER BY rowid').all();
    await service.readForInvocation(scope, 'codex61-sol', id, { limit: 1 });
    assert.deepEqual(db.prepare('SELECT * FROM memory_cue_events ORDER BY rowid').all(), originalRows);
    await service.readForInvocation(scope, 'codex61-sol', id, { limit: 1, cursor: first.nextCursor });
    const ledger = new MemoryCueEpisodeStore(db);
    const cues = projectInvocationCues(ledger.listByInvocation('owner-a', 'b', 'read-b'));
    assert.equal(cues.length, 1);
    assert.equal(cues[0].source, 'pull');
    assert.equal(cues[0].readDetails.entries.length, 2);
    assert.equal(cues[0].status, 'drilled');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM memory_cue_events WHERE consumption_outcome = 'applied'").get().n,
      0,
    );
    assert.throws(() => db.prepare('UPDATE memory_cue_events SET occurred_at = 5').run(), /append-only/);
    await service.write(owner, {
      operation: 'edit',
      requestId: 'explanation',
      matterId: id,
      expectedRevision: 1,
      title: 'Changed title',
      description: 'Changed interpretation',
    });
    assert.deepEqual(await service.readReceipt('owner-a', 'codex61-sol', cues[0].readDetails), { status: 'changed' });
    await service.readForInvocation(scope, 'codex61-sol', id);
    assert.equal(projectInvocationCues(ledger.listByInvocation('owner-a', 'b', 'read-b')).length, 2);
    messages.get('first').visibility = 'whisper';
    messages.get('first').whisperTo = ['codex-astra'];
    assert.deepEqual(await service.readReceipt('owner-a', 'codex61-sol', cues[0].readDetails), {
      status: 'not_available',
    });
    await assert.rejects(service.readForInvocation(scope, 'codex61-sol', id), /not_available/);
  });

  it('pages visible catalogue entries without exposing hidden-page counts and refreshes the opening directory', async () => {
    for (let index = 0; index < 14; index++) await create([selection(messages.get('first'))], `Matter ${index}`);
    messages.set('hidden', message('hidden', 'secret', { visibility: 'whisper', whisperTo: ['codex-astra'] }));
    await create([selection(messages.get('hidden'))], 'Secret title');
    const directoryText = await matterOpeningDirectory(service, 'owner-a', 'codex61-sol');
    assert.equal(directoryText.includes('Secret title'), false);
    const first = await service.catalog(sol);
    assert.equal(first.items.length, 12);
    assert.ok(first.nextCursor);
    const last = await service.catalog(sol, { cursor: first.nextCursor });
    assert.equal(last.items.length, 2);
    assert.equal(last.nextCursor, undefined);
    await assert.rejects(service.catalog(astra, { cursor: first.nextCursor }), /invalid_cursor/);
    const updated = await service.write(owner, {
      operation: 'edit',
      requestId: 'directory-edit',
      matterId: first.items[0].matterId,
      expectedRevision: first.items[0].revision,
      title: 'New directory title',
      description: '',
    });
    assert.equal(updated.matter.revision, 2);
    assert.match(await matterOpeningDirectory(service, 'owner-a', 'codex61-sol'), /New directory title/);
  });
});
