import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import type { RecallResolverFamily } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { EventMemoryCueSource } from '../src/domains/memory/cue/sources/EventMemoryCueSource.js';
import { eventMemoryRevision, type StoredEventMemoryLifecycle } from '../src/domains/memory/EventMemoryStore.js';
import { InMemoryTasteProposalStore } from '../src/domains/taste/stores/InMemoryTasteProposalStore.js';
import { readRecallSourceViews } from '../src/routes/recall-candidate-view.js';
import { readOwnerMessageView } from '../src/routes/recall-owner-message-view.js';

let db: Database.Database;
let root: string;
let threads: ThreadStore;
let messages: MessageStore;
let currentThreadId: string;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE evidence_docs (anchor TEXT, title TEXT, kind TEXT, collection_id TEXT, world_id TEXT);
    CREATE TABLE memory_cue_events (owner_user_id TEXT, thread_id TEXT, invocation_id TEXT, cue_id TEXT,
    resolver_family TEXT, source_anchor TEXT, source_revision TEXT, consumer_cat_id TEXT, occurred_at INTEGER);`);
  root = mkdtempSync(join(tmpdir(), 'f321-cue-navigation-'));
  threads = new ThreadStore();
  messages = new MessageStore();
  currentThreadId = 'current';
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function seed(family: RecallResolverFamily, anchor: string, revision: string) {
  db.prepare('INSERT INTO memory_cue_events VALUES (?,?,?,?,?,?,?,?,?)').run(
    'owner',
    currentThreadId,
    'inv',
    'cue',
    family,
    anchor,
    revision,
    'sonnet',
    1,
  );
}
function source(owner = 'owner') {
  const thread = threads.create(owner, '原始对话');
  const message = messages.append({
    from: { kind: 'user', userId: owner },
    userId: owner,
    threadId: thread.id,
    content: 'PRIVATE original body',
    timestamp: 1,
  });
  return { threadId: thread.id, messageId: message.id };
}
const href = (ref: { threadId: string; messageId: string }) =>
  `/thread/${encodeURIComponent(ref.threadId)}?message=${encodeURIComponent(ref.messageId)}`;
const read = (readers: Parameters<typeof readRecallSourceViews>[5]) =>
  readRecallSourceViews(db, 'owner', currentThreadId, [], ['inv'], readers).then((views) => {
    assert.ok(views[0]);
    return views[0];
  });

it('links a person cue to its revision-checked original message, never its current aggregate revision', async () => {
  const ref = source();
  seed('person_entity', 'person-memory:person_one', 'delivered-card-revision');
  const view = await read({
    threadStore: threads,
    personMemoryStore: { getPerson: async () => ({ ownerUserId: 'owner', status: 'active', displayName: '人物名字' }) },
    cueSourceReader: {
      read: async (input) => {
        assert.equal(input.expectedRevision, 'delivered-card-revision');
        return { status: 'ok', payload: { displayName: '人物名字', provenanceRefs: [ref], facts: ['PRIVATE'] } };
      },
    },
  });
  assert.equal(view.href, href(ref));
  assert.equal(view.title, '人物名字');
  assert.ok(!JSON.stringify(view).includes('PRIVATE'));
});

it('does not revive a corrected person cue from a readable current person name', async () => {
  seed('person_entity', 'person-memory:person_one', 'old-card');
  const view = await read({
    personMemoryStore: {
      getPerson: async () => ({ ownerUserId: 'owner', status: 'active', displayName: 'Current name' }),
    },
    cueSourceReader: { read: async () => ({ status: 'not_available', invalidationReason: 'source_corrected' }) },
  });
  assert.equal(view.href, null);
  assert.equal(view.title, undefined);
  assert.equal(view.sourceUnavailableReason, 'source_corrected');
});

it('never links a person provenance into a foreign thread or invents a source for owner-only records', async () => {
  const ref = source('other');
  seed('person_entity', 'person-memory:person_one', 'card');
  for (const provenanceRefs of [[ref], []]) {
    const view = await read({
      threadStore: threads,
      cueSourceReader: { read: async () => ({ status: 'ok', payload: { displayName: '人物名字', provenanceRefs } }) },
    });
    assert.equal(view.href, null);
  }
});

function taste() {
  const ref = source();
  const proposalStore = new InMemoryTasteProposalStore();
  const proposal = proposalStore.create({
    userId: 'owner',
    catId: 'sonnet',
    threadId: ref.threadId,
    sourceMessageId: ref.messageId,
    scene: 'PRIVATE scene',
    quote: 'PRIVATE quote',
    tags: ['truth'],
    dimension: 'cognitive-honesty',
    privacy: 'public',
  });
  const sourcePath = 'docs/taste/vignettes/cue-source.md';
  assert.ok(proposalStore.claimForApproval(proposal.id, 'owner'));
  assert.ok(proposalStore.finalizeApproval(proposal.id, 'owner', 'cue-source', sourcePath));
  const content = `---\nwhen: 先核真实来源\nquotes: ["PRIVATE quote"]\nscene: PRIVATE scene\ntags: [truth]\ndimension: cognitive-honesty\nprivacy: public\nproposalId: ${proposal.id}\n---\n`;
  mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
  writeFileSync(join(root, sourcePath), content);
  const revision = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  return {
    ref,
    sourcePath,
    revision,
    readers: {
      ownerUserId: 'owner',
      repository: { canonicalRoot: () => root, approvalLockKey: () => root },
      sourceReaders: { proposalStore, threadStore: threads, messageStore: messages },
    },
  };
}
it('links a taste cue through its settled proposal and exact canonical vignette revision', async () => {
  const item = taste();
  seed('taste', `taste-vignette:${item.sourcePath}`, item.revision);
  const view = await read({ tasteSources: item.readers });
  assert.equal(view.href, href(item.ref));
  assert.equal(view.title, '先核真实来源');
  assert.ok(!JSON.stringify(view).includes('PRIVATE'));
});
it('does not replace a historical taste with changed or lifecycle-forgotten content', async () => {
  const item = taste();
  seed('taste', `taste-vignette:${item.sourcePath}`, item.revision);
  for (const forgotten of [true, false]) {
    if (!forgotten) writeFileSync(join(root, item.sourcePath), 'changed content');
    const view = await read({ tasteSources: { ...item.readers, lifecycle: { isReadable: () => !forgotten } } });
    assert.equal(view.href, null);
    assert.equal(view.title, undefined);
  }
});

it('does not relabel the configured taste repository as another requesting owner', async () => {
  const item = taste();
  const view = await readOwnerMessageView(
    {
      invocation_id: 'inv',
      cue_id: 'cue',
      resolver_family: 'taste',
      source_anchor: `taste-vignette:${item.sourcePath}`,
      source_revision: item.revision,
      consumer_cat_id: 'sonnet',
    },
    { ownerUserId: 'other', threadId: 'current' },
    async () => ({ href: null }),
    undefined,
    { tasteSources: { ...item.readers, ownerUserId: 'owner' } },
  );
  assert.equal(view?.title, undefined);
  assert.equal(view?.href, null);
  assert.equal(view?.sourceUnavailableReason, 'scope_revoked');
});

function event() {
  const ref = source();
  currentThreadId = ref.threadId;
  const record: StoredEventMemoryLifecycle = {
    ...ref,
    eventId: 'evt_history',
    ownerUserId: 'owner',
    type: 'scope_correction',
    trigger: 'human_brake',
    cat: 'sonnet',
    timestamp: 1,
    summary: '已确认的真实事件',
    cognitiveTransition: 'scope_correction',
    relatedHarness: ['F321'],
    confidence: 'high',
    status: 'active',
    updatedAt: 1,
  };
  return {
    ref,
    record,
    readers: { store: { getEvent: () => record }, sourceReaders: { threadStore: threads, messageStore: messages } },
  };
}
it('opens an old event source as its owner without extending the model short-lived drill window', async () => {
  const item = event();
  seed('event', `event-memory:${item.record.eventId}`, eventMemoryRevision(item.record));
  const view = await read({
    eventSources: item.readers,
    cueSourceReader: {
      read: async () => {
        assert.fail('owner history metadata must not use the model freshness grant');
      },
    },
  });
  assert.equal(view.href, href(item.ref));
  assert.equal(view.title, item.record.summary);
  const modelReader = new EventMemoryCueSource({
    ownerUserId: 'owner',
    eventStore: {
      getEvent: () => item.record,
      listEvents: () => [item.record],
    },
    messageStore: messages,
    episodeStore: { hasTerminalConsumptionForSource: () => false },
    now: Date.now,
  });
  assert.deepEqual(
    await modelReader.read({
      ownerUserId: 'owner',
      threadId: currentThreadId,
      anchor: `event-memory:${item.record.eventId}`,
      expectedRevision: eventMemoryRevision(item.record),
    }),
    { status: 'not_available', invalidationReason: 'expired' },
  );
});
it('keeps event revision, owner, and original-message visibility fences before publishing any link', async () => {
  const item = event();
  seed('event', `event-memory:${item.record.eventId}`, eventMemoryRevision(item.record));
  for (const mutation of [
    { summary: 'New body' },
    { ownerUserId: 'other' },
    { threadId: 'other' },
    { status: 'retired' as const },
  ]) {
    const view = await read({
      eventSources: { ...item.readers, store: { getEvent: () => ({ ...item.record, ...mutation }) } },
    });
    assert.equal(view.href, null);
    assert.equal(view.title, undefined);
  }
  const view = await read({
    eventSources: {
      ...item.readers,
      sourceReaders: { ...item.readers.sourceReaders, messageStore: { getById: async () => null } },
    },
  });
  assert.equal(view.href, null);
});
