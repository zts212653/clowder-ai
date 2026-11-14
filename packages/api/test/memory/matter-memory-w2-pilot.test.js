import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MatterMemoryService } from '../../dist/domains/memory/matters/MatterMemoryService.js';
import { matterOpeningDirectory } from '../../dist/domains/memory/matters/matter-opening-directory.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { estimateTokens } from '../../dist/utils/token-counter.js';

const fixtureUrl = new URL('../../../../docs/evidence/2026-11-07-f332-w2-pilot/pilot.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const drafts = fixture.draftFiles.map((file) => JSON.parse(readFileSync(new URL(file, fixtureUrl), 'utf8')));
const actor = { userId: 'default-user', viewer: { type: 'cat', catId: 'codex61-sol' } };
const primaryId = fixture.rebuildExercise.removedMessageId;
const directoryItems = (rendered) => JSON.parse(rendered.split('\n').find((line) => line.startsWith('{'))).items;

// Fixed, author-visible source mirrors in a fresh temporary SQLite file. No runtime/Redis readers or writes.
// Structural checks cannot judge whether a paraphrase preserves meaning; Argon reviews each conclusion.
describe('F332 W2 development drafts through the existing Matter owner', () => {
  let directory;
  let evidence;
  let service;
  let messages;
  let created;
  const open = async () => {
    evidence = new SqliteEvidenceStore(join(directory, 'pilot.sqlite'));
    await evidence.initialize();
    service = new MatterMemoryService({
      db: evidence.getDb(),
      runWrite: (operation) => evidence.runExclusive(operation),
      messageStore: { getById: (id) => messages.get(id) ?? null },
      threadStore: {
        get: (id) => ({ id, createdBy: 'default-user' }),
        list: () =>
          [...new Set([...messages.values()].map((message) => message.threadId))].map((id) => ({
            id,
            createdBy: 'default-user',
          })),
      },
    });
  };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'f332-w2-pilot-'));
    messages = new Map(fixture.sourceObservations.map(({ message }) => [message.id, structuredClone(message)]));
    await open();
    created = [];
    for (const draft of drafts) created.push(await service.write(actor, draft.change));
  });
  afterEach(async () => {
    await evidence.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('admits verbatim UTF-16 selections, preserves observations and fits whole-description budgets', async () => {
    for (const observation of fixture.sourceObservations) {
      assert.equal(createHash('sha256').update(observation.message.content).digest('hex'), observation.contentSha256);
      assert.ok(Date.parse(observation.observedAt) >= observation.message.timestamp);
    }
    for (const [index, draft] of drafts.entries()) {
      assert.ok(estimateTokens(draft.change.description) <= 1024);
      const page = await service.read(actor, created[index].matter.matterId);
      assert.equal(page.matter.description, draft.change.description);
      assert.equal(page.entries.length, draft.change.sources.length);
      for (const source of draft.change.sources) {
        assert.equal(messages.get(source.messageId).content.slice(source.start, source.end), source.quote);
        const entry = page.entries.find(
          (item) => item.source.messageId === source.messageId && item.source.start === source.start,
        );
        assert.equal(entry.quote, source.quote);
        assert.equal(entry.source.timestamp, messages.get(source.messageId).timestamp);
        assert.equal(entry.sourceStatus, 'current');
        assert.match(entry.source.sourceRevision, /^sha256:[a-f0-9]{64}$/);
      }
    }
  });

  it('rejects quote/offset corruption and keeps the exact draft retry across SQLite reopening', async () => {
    const change = drafts[0].change;
    for (const source of [
      { ...change.sources[1], quote: '搜索已经修好了' },
      { ...change.sources[1], start: change.sources[1].start + 1 },
    ]) {
      await assert.rejects(
        service.write(actor, { ...change, requestId: `corrupt-${source.start}-${source.quote}`, sources: [source] }),
        /invalid_source/,
      );
    }
    await evidence.close();
    await open();
    const retried = await service.write(actor, change);
    assert.equal(retried.matter.matterId, created[0].matter.matterId);
    assert.equal(retried.matter.revision, created[0].matter.revision);
    assert.equal((await service.catalog(actor)).items.length, 2);
  });

  it('marks a changed original stale and withholds its interpretation while another draft stays usable', async () => {
    const threadId = drafts[0].change.sources[0].threadId;
    const before = directoryItems(await matterOpeningDirectory(service, actor.userId, actor.viewer.catId, threadId));
    assert.ok(before.find((item) => item.matterId === created[0].matter.matterId).contextHint);
    messages.get(primaryId).content += '\nFixture-only source revision.';
    const page = await service.read(actor, created[0].matter.matterId);
    assert.equal(page.summaryStatus, 'sources_changed');
    assert.ok(page.entries.filter((entry) => entry.source.messageId === primaryId).every((entry) => !entry.quote));
    const after = directoryItems(await matterOpeningDirectory(service, actor.userId, actor.viewer.catId, threadId));
    assert.equal(after.find((item) => item.matterId === created[0].matter.matterId).contextHint, undefined);
    assert.equal((await service.read(actor, created[1].matter.matterId)).entries[0].sourceStatus, 'current');
  });

  it('hides all metadata after source ACL loss and rebuilds a source-withdrawn page as navigation only', async () => {
    messages.get(primaryId).visibility = 'whisper';
    messages.get(primaryId).whisperTo = ['codex-astra'];
    assert.equal((await service.catalog(actor)).items.length, 1);
    await assert.rejects(service.read(actor, created[0].matter.matterId), /not_available/);
    messages.delete(primaryId);
    const rebuild = fixture.rebuildExercise;
    assert.equal(rebuild.description, '');
    assert.ok(rebuild.sourceCoordinates.every((source) => source.messageId !== primaryId));
    const sources = rebuild.sourceCoordinates.map((source) => ({
      ...source,
      quote: messages.get(source.messageId).content.slice(source.start, source.end),
    }));
    const navigational = await service.write(actor, {
      operation: 'create',
      requestId: 'f332-w2-navigation-rebuild',
      title: rebuild.title,
      description: rebuild.description,
      sources,
    });
    const page = await service.read(actor, navigational.matter.matterId);
    assert.equal(page.matter.description, '');
    assert.equal(page.entries.length, 2);
    assert.ok(page.entries.every((entry) => entry.source.messageId !== primaryId));
    assert.equal((await service.read(actor, created[1].matter.matterId)).entries[0].sourceStatus, 'current');
  });
});
