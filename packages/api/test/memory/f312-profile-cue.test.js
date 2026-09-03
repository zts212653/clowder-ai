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
  const terminalRevisions = new Set();
  const source = new ProfileMemoryCueSource({
    ownerUserId,
    repository: {
      readCapsule(userId) {
        return userId === ownerUserId && capsule !== null
          ? { content: capsule, path: '/private/profiles/owner-1/operator-capsule.md' }
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
});
