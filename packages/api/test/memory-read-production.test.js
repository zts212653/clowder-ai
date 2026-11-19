import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { withInvocationCredentials } from '../../mcp-server/dist/tools/invocation-auth.js';
import { memoryReadSources } from '../../mcp-server/dist/tools/memory-read-result.js';
import { handleReadMemory } from '../../mcp-server/dist/tools/read-memory-tools.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MatterMemoryService } from '../dist/domains/memory/matters/MatterMemoryService.js';
import { boundedRelationshipCard } from '../dist/domains/memory/people/PersonMemoryRecallService.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackMessageReadRoutes } from '../dist/routes/callback-message-read-routes.js';
import { registerCallbackMatterMemoryRoutes } from '../dist/routes/memory-matter-routes.js';

async function fixture(t) {
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const origin = threads.create('owner', 'source');
  const target = threads.create('owner', 'current');
  const source = messages.append({
    userId: 'owner',
    threadId: origin.id,
    from: { kind: 'user', userId: 'owner' },
    content: 'Exact original: preserve the named audience.',
    mentions: [],
    timestamp: 1000,
  });
  const actor = { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } };
  const matters = new MatterMemoryService({
    db: evidence.getDb(),
    messageStore: messages,
    threadStore: threads,
    runWrite: (operation) => evidence.runExclusive(operation),
  });
  const created = await matters.write(actor, {
    operation: 'create',
    requestId: 'create',
    title: 'Reading contract',
    description: 'Cat interpretation; only applies to this source.',
    sources: [
      {
        threadId: origin.id,
        messageId: source.id,
        segment: 'body',
        start: 0,
        end: source.content.length,
        quote: source.content,
      },
    ],
  });
  const app = Fastify();
  const registry = new InvocationRegistry();
  const auth = await registry.create('owner', 'codex61-sol', target.id);
  registerCallbackAuthHook(app, registry);
  registerCallbackMatterMemoryRoutes(app, () => matters);
  registerCallbackMessageReadRoutes(app, { messageStore: messages, threadStore: threads });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    const parsed = new URL(url);
    const result = await app.inject({
      method: init?.method ?? 'GET',
      url: parsed.pathname + parsed.search,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(init?.body ? { payload: init.body } : {}),
    });
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
    await evidence.close();
  });
  async function read(ref, credentials = auth) {
    const result = await withInvocationCredentials(
      { ...credentials, catId: 'codex61-sol', userId: 'owner', threadId: target.id, apiUrl: 'http://memory-fixture' },
      () => handleReadMemory({ ref }),
    );
    return JSON.parse(result.content[0].text);
  }
  return {
    evidence,
    messages,
    matters,
    actor,
    source,
    origin,
    target,
    created,
    read,
    registry,
    calls: () => calls,
    catalog: () => matters.catalog(actor, { threadId: target.id }),
  };
}

test('a real directory ref opens its page, then its selected source, with original citation facts and two calls', async (t) => {
  const f = await fixture(t);
  const catalog = await f.catalog();
  assert.equal(f.evidence.getDb().prepare('SELECT COUNT(*) AS n FROM memory_cue_events').get().n, 0);
  const page = await f.read(catalog.items[0].readRef);
  assert.equal(page.contentKind, 'mixed');
  assert.equal(page.data.matter.description, 'Cat interpretation; only applies to this source.');
  const ref = page.sources[0];
  assert.ok(ref.sourceSelection, 'preserve the matter segment revision separately');
  const original = await f.read(ref);
  assert.equal(original.status, 'ok');
  assert.equal(original.data.message.content, f.source.content);
  assert.match(original.data.message.contentRevision, /^[a-f0-9]{64}$/);
  assert.notEqual(original.data.message.contentRevision, ref.sourceSelection.expectedRevision);
  assert.deepEqual(original.data.message.sourceParts, [{ part: { kind: 'body' }, length: f.source.content.length }]);
  assert.equal(f.calls(), 2, 'page and source require one callback each, without an extra ref lookup');
  const events = f.evidence.getDb().prepare('SELECT consumption_outcome FROM memory_cue_events').all();
  assert.deepEqual(
    events.map((event) => event.consumption_outcome),
    ['presented', 'drilled'],
  );
});

test('a stale page ref fails before its receipt and an exact source ref cannot cross owners', async (t) => {
  const f = await fixture(t);
  const ref = (await f.catalog()).items[0].readRef;
  await f.matters.write(f.actor, {
    operation: 'edit',
    requestId: 'revision-two',
    matterId: ref.matterId,
    expectedRevision: ref.expectedRevision,
    title: 'Changed',
    description: 'New interpretation.',
  });
  const stale = await f.read(ref);
  assert.equal(stale.status, 'source_changed');
  assert.equal(stale.data, undefined);
  assert.equal(f.evidence.getDb().prepare('SELECT COUNT(*) AS n FROM memory_cue_events').get().n, 0);
  const foreign = await f.registry.create('other-owner', 'codex61-sol', f.target.id);
  const denied = await f.read({ kind: 'message', threadId: f.origin.id, messageId: f.source.id }, foreign);
  assert.equal(denied.status, 'not_available');
  assert.equal(denied.data, undefined);
});

test('a forged source selection cannot become a current original', async (t) => {
  const f = await fixture(t);
  const page = await f.read((await f.catalog()).items[0].readRef);
  const ref = page.sources[0];
  const changed = await f.read({
    ...ref,
    sourceSelection: { ...ref.sourceSelection, expectedRevision: 'sha256:' + '0'.repeat(64) },
  });
  assert.equal(changed.status, 'source_changed');
  assert.equal(changed.data, undefined);
});

test('a bounded person card keeps every returned fact source available through the original reader', async (t) => {
  const f = await fixture(t);
  const originals = Array.from({ length: 4 }, (_, index) =>
    f.messages.append({
      userId: 'owner',
      threadId: f.origin.id,
      from: { kind: 'user', userId: 'owner' },
      content: `Original fact evidence ${index + 1}.`,
      mentions: [],
      timestamp: 2000 + index,
    }),
  );
  const refs = originals.map((message) => ({ kind: 'message', threadId: f.origin.id, messageId: message.id }));
  const authority = { kind: 'card_approval', candidateId: 'candidate', draftId: 'draft', authorizedAt: 100 };
  const relationship = {
    relationshipId: 'relationship_recall',
    ownerUserId: 'owner',
    personId: 'person_recall',
    status: 'current',
    materializedBy: authority,
    createdAt: 100,
    sourceRefs: [refs[0]],
    transitions: [{ status: 'current', recordedAt: 100, materializedBy: authority, sourceRefs: [refs[0]] }],
  };
  const claim = (id, recordedAt, sourceRefs) => ({
    claimId: `person_claim_${id}`,
    personId: 'person_recall',
    ownerUserId: 'owner',
    status: 'current',
    recordedAt,
    sourceRefs,
    materializedBy: authority,
    payload: { kind: 'reported_fact', predicate: 'organization_unit', value: id, assertedBy: 'owner' },
  });
  const card = boundedRelationshipCard({
    personId: 'person_recall',
    displayName: 'Test',
    relationship,
    claims: [claim('first', 200, refs.slice(0, 3)), claim('second', 100, [refs[3], refs[0]])],
    events: [],
  });
  assert.equal(card.provenanceRefs.length, 3, 'the real card caps its top-level provenance');
  assert.ok(card.facts[1].provenanceRefs.some((ref) => ref.messageId === originals[3].id));
  const sources = memoryReadSources({ payload: card }, 'cue');
  assert.deepEqual(sources, refs, 'collect all returned fact sources and deduplicate repeated coordinates');
  assert.equal(f.calls(), 0, 'source projection performs no callback or extra lookup');
  const original = await f.read(sources[3]);
  assert.equal(original.data.message.content, originals[3].content);
  assert.equal(f.calls(), 1, 'the previously omitted source uses its one original read');
  const foreign = await f.registry.create('other-owner', 'codex61-sol', f.target.id);
  assert.equal((await f.read(sources[3], foreign)).status, 'not_available', 'the original owner check still applies');
});
