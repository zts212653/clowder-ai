import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProfileCueResolver } from '../../dist/domains/memory/cue/resolvers/ProfileCueResolver.js';
import {
  CURRENT_RELATIONSHIP_PROFILE_URI,
  ProfileMemoryCueSource,
} from '../../dist/domains/memory/cue/sources/ProfileMemoryCueSource.js';

const ownerUserId = 'owner-1';
const scope = { ownerUserId, threadId: 'thread-1', invocationId: 'invocation-1' };

function harness() {
  let capsule = '# Owner profile\n\nPrefers evidence-backed, warm explanations.\n';
  let corpus = null;
  const terminalRevisions = new Set();
  const source = new ProfileMemoryCueSource({
    ownerUserId,
    repository: {
      readCapsule(userId) {
        return userId === ownerUserId && capsule !== null
          ? { content: capsule, path: '/private/profiles/owner-1/operator-capsule.md' }
          : null;
      },
      readCorpus(userId) {
        return userId === ownerUserId && corpus !== null
          ? { content: corpus, path: '/data/profiles/owner-1/corpus/shared-facts.md' }
          : null;
      },
    },
    episodeStore: {
      hasTerminalConsumptionForSource(input) {
        return terminalRevisions.has(input.sourceRevision);
      },
    },
  });
  return {
    source,
    terminalRevisions,
    setCapsule(value) {
      capsule = value;
    },
    setCorpus(value) {
      corpus = value;
    },
  };
}

describe('F312 Profile cue vertical slice', () => {
  it('emits one revision-bound standing seed until applied or dismissed', async () => {
    const h = harness();
    const first = await h.source.prepareOpportunity({ ownerUserId, occurredAt: 1_000 });
    assert.equal(first?.kind, 'profile_revision_available');
    assert.equal(first?.producer, 'profile_repository');
    assert.equal(first?.payload.profileUri, CURRENT_RELATIONSHIP_PROFILE_URI);
    assert.match(first?.payload.sourceRevision ?? '', /^sha256:/);

    h.terminalRevisions.add(first.payload.sourceRevision);
    assert.equal(await h.source.prepareOpportunity({ ownerUserId, occurredAt: 2_000 }), null);

    h.setCapsule('# Owner profile\n\nNow prefers concise evidence packets.\n');
    const revised = await h.source.prepareOpportunity({ ownerUserId, occurredAt: 3_000 });
    assert.notEqual(revised?.payload.sourceRevision, first.payload.sourceRevision);
  });

  it('resolves and drills only the current owner-visible Profile revision', async () => {
    const h = harness();
    const seed = await h.source.prepareOpportunity({ ownerUserId, occurredAt: 1_000 });
    const opportunity = {
      v: 1,
      opportunityId: 'profile-opportunity-1',
      consumer: 'agent_route',
      scope,
      occurredAt: seed.occurredAt,
      ...seed,
    };
    const resolver = new ProfileCueResolver(h.source);
    const cues = await resolver.resolve(opportunity, {
      now: 1_000,
      expiresAt: 301_000,
      createDrillHandle: ({ family }) => `opaque:${family}`,
    });
    assert.equal(cues.length, 1);
    assert.equal(cues[0].resolverFamily, 'profile');
    assert.equal(cues[0].drill.family, 'profile');
    assert.equal(cues[0].source.revision, seed.payload.sourceRevision);

    const drilled = await h.source.read({
      ownerUserId,
      anchor: cues[0].source.anchor,
      expectedRevision: cues[0].source.revision,
    });
    assert.equal(drilled.status, 'ok');
    assert.match(drilled.payload.content, /evidence-backed/);

    h.setCapsule('# Owner profile\n\nCorrected.\n');
    assert.deepEqual(
      await h.source.read({
        ownerUserId,
        anchor: cues[0].source.anchor,
        expectedRevision: cues[0].source.revision,
      }),
      { status: 'not_available', invalidationReason: 'source_corrected' },
    );
    h.setCapsule(null);
    assert.deepEqual(
      await h.source.read({
        ownerUserId,
        anchor: cues[0].source.anchor,
        expectedRevision: cues[0].source.revision,
      }),
      { status: 'not_available', invalidationReason: 'source_forgotten' },
    );
  });

  // --- T9: Phase E corpus anchor ---

  it('prepareOpportunity returns capsule first (maxCues=1 priority), then corpus after terminal', async () => {
    const { CURRENT_CORPUS_PROFILE_URI } = await import('@cat-cafe/shared/profile-contract');
    const h = harness();
    h.setCorpus('# Shared facts\n\nYou likes cats.\n');

    // With both capsule + corpus present, capsule wins (priority order)
    const first = await h.source.prepareOpportunity({ ownerUserId, occurredAt: 1_000 });
    assert.equal(first?.payload.profileUri, CURRENT_RELATIONSHIP_PROFILE_URI, 'capsule first');

    // Terminal on capsule → prepareOpportunity falls through to corpus
    h.terminalRevisions.add(first.payload.sourceRevision);
    const second = await h.source.prepareOpportunity({ ownerUserId, occurredAt: 2_000 });
    assert.equal(second?.payload.profileUri, CURRENT_CORPUS_PROFILE_URI, 'corpus after capsule terminal');
    assert.match(second?.payload.sourceRevision ?? '', /^sha256:/);

    // Terminal on corpus too → null
    h.terminalRevisions.add(second.payload.sourceRevision);
    assert.equal(await h.source.prepareOpportunity({ ownerUserId, occurredAt: 3_000 }), null);
  });

  it('prepareCorpusOpportunity returns corpus seed directly', async () => {
    const { CURRENT_CORPUS_PROFILE_URI } = await import('@cat-cafe/shared/profile-contract');
    const h = harness();
    h.setCorpus('# Shared facts\n\nYou likes cats.\n');

    const corpusSeed = h.source.prepareCorpusOpportunity({ ownerUserId, occurredAt: 1_000 });
    assert.equal(corpusSeed?.kind, 'profile_revision_available');
    assert.equal(corpusSeed?.payload.profileUri, CURRENT_CORPUS_PROFILE_URI);
    assert.match(corpusSeed?.payload.sourceRevision ?? '', /^sha256:/);
  });

  it('prepareOpportunity returns corpus when no capsule exists', async () => {
    const { CURRENT_CORPUS_PROFILE_URI } = await import('@cat-cafe/shared/profile-contract');
    const h = harness();
    h.setCapsule(null);
    h.setCorpus('# Shared facts\n\nYou likes cats.\n');

    const seed = await h.source.prepareOpportunity({ ownerUserId, occurredAt: 1_000 });
    assert.equal(seed?.payload.profileUri, CURRENT_CORPUS_PROFILE_URI, 'corpus when capsule missing');
  });

  it('read dispatches by corpus anchor → returns corpus content', async () => {
    const h = harness();
    h.setCorpus('Shared corpus content');
    const { CURRENT_CORPUS_PROFILE_URI } = await import('@cat-cafe/shared/profile-contract');
    const corpusAnchor = `profile:${CURRENT_CORPUS_PROFILE_URI}`;
    const { profileRevisionOf } = await import('@cat-cafe/shared/profile-revision');
    const expectedRevision = profileRevisionOf('Shared corpus content');

    const result = await h.source.read({
      ownerUserId,
      anchor: corpusAnchor,
      expectedRevision,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.payload.content, 'Shared corpus content');
  });

  it('read with corpus anchor returns source_forgotten when no corpus exists', async () => {
    const h = harness();
    const { CURRENT_CORPUS_PROFILE_URI } = await import('@cat-cafe/shared/profile-contract');
    const corpusAnchor = `profile:${CURRENT_CORPUS_PROFILE_URI}`;

    const result = await h.source.read({
      ownerUserId,
      anchor: corpusAnchor,
      expectedRevision: 'sha256:doesnotmatter',
    });
    assert.equal(result.status, 'not_available');
    assert.equal(result.invalidationReason, 'source_forgotten');
  });

  it('fails closed for another owner without reading their profile path', async () => {
    const h = harness();
    assert.equal(await h.source.prepareOpportunity({ ownerUserId: 'owner-2', occurredAt: 1_000 }), null);
    assert.deepEqual(
      await h.source.read({
        ownerUserId: 'owner-2',
        anchor: `profile:${CURRENT_RELATIONSHIP_PROFILE_URI}`,
        expectedRevision: 'sha256:forged',
      }),
      { status: 'not_available', invalidationReason: 'scope_revoked' },
    );
  });

  it('corpus prepare/resolve fail closed for cross-owner (zero repository reads)', async () => {
    const { CURRENT_CORPUS_PROFILE_URI } = await import('@cat-cafe/shared/profile-contract');
    const { profileRevisionOf } = await import('@cat-cafe/shared/profile-revision');

    // Promiscuous repository: returns corpus for ANY user to prove the guard catches it
    let readCorpusCalls = 0;
    const source = new ProfileMemoryCueSource({
      ownerUserId: 'owner-1',
      repository: {
        readCapsule() {
          return null;
        },
        readCorpus() {
          readCorpusCalls++;
          return { content: 'OWNER-2 SECRET FACTS', path: '/data/profiles/owner-2/corpus/shared-facts.md' };
        },
      },
      episodeStore: {
        hasTerminalConsumptionForSource() {
          return false;
        },
      },
    });

    // prepareCorpusOpportunity for wrong owner: must return null, zero reads
    readCorpusCalls = 0;
    const corpusSeed = source.prepareCorpusOpportunity({ ownerUserId: 'owner-2', occurredAt: 1_000 });
    assert.equal(corpusSeed, null, 'prepareCorpusOpportunity must return null for cross-owner');
    assert.equal(readCorpusCalls, 0, 'zero readCorpus calls for cross-owner prepare');

    // prepareOpportunity for wrong owner: must return null, zero reads
    readCorpusCalls = 0;
    const seed = await source.prepareOpportunity({ ownerUserId: 'owner-2', occurredAt: 1_000 });
    assert.equal(seed, null, 'prepareOpportunity must return null for cross-owner');
    assert.equal(readCorpusCalls, 0, 'zero readCorpus calls for cross-owner prepareOpportunity');

    // resolve for wrong owner with corpus URI: must return null, zero reads
    readCorpusCalls = 0;
    const resolved = await source.resolve({
      ownerUserId: 'owner-2',
      profileUri: CURRENT_CORPUS_PROFILE_URI,
      sourceRevision: profileRevisionOf('OWNER-2 SECRET FACTS'),
    });
    assert.equal(resolved, null, 'resolve must return null for cross-owner corpus');
    assert.equal(readCorpusCalls, 0, 'zero readCorpus calls for cross-owner resolve');
  });
});
