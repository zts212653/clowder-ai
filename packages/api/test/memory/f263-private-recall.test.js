import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeResolver } from '../../dist/domains/memory/KnowledgeResolver.js';
import { LibraryCatalog } from '../../dist/domains/memory/LibraryCatalog.js';

function manifest(id, sensitivity, ownerUserId) {
  const [kind, name] = id.split(':');
  return {
    id,
    kind,
    name,
    displayName: name,
    root: `/synthetic/${name}`,
    sensitivity,
    ...(ownerUserId ? { ownerUserId } : {}),
    scannerLevel: 0,
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
    createdAt: '2026-07-14T00:00:00Z',
    updatedAt: '2026-07-14T00:00:00Z',
  };
}

function store(anchor, body) {
  const calls = [];
  return {
    calls,
    search: async () => {
      calls.push(anchor);
      return [
        {
          anchor,
          kind: 'profile',
          status: 'active',
          title: 'Synthetic private canonical source',
          summary: body,
          updatedAt: '2026-07-14T00:00:00Z',
        },
      ];
    },
  };
}

describe('F263 AC-B3/B4 private recall policy', () => {
  function fixture() {
    const catalog = new LibraryCatalog();
    catalog.register(manifest('project:docs', 'internal'));
    catalog.register(manifest('domain:user-profile', 'private', 'owner-1'));
    catalog.register(manifest('domain:user-journal', 'private', 'owner-1'));

    const project = store('docs/feature.md', 'public body');
    const profile = store('domain:user-profile/relationships/current.md', 'SYNTHETIC_PROFILE_BODY');
    const journal = store('domain:user-journal/2026-07-14.md', 'SYNTHETIC_JOURNAL_BODY');
    const resolver = new KnowledgeResolver({
      projectStore: project,
      catalog,
      stores: new Map([
        ['project:docs', project],
        ['domain:user-profile', profile],
        ['domain:user-journal', journal],
      ]),
    });
    return { resolver, project, profile, journal };
  }

  it('unauthorized explicit request cannot reach a private canonical store', async () => {
    const { resolver, profile } = fixture();
    const result = await resolver.resolve('relationship', {
      dimension: 'collection',
      collections: ['domain:user-profile'],
      authorizedCollections: [],
    });

    assert.equal(profile.calls.length, 0);
    assert.equal(result.results.length, 0);
  });

  it('owner-authorized caller can explicitly reach profile and journal canonical collections', async () => {
    const { resolver, profile, journal } = fixture();
    const result = await resolver.resolve('private source', {
      dimension: 'collection',
      collections: ['domain:user-profile', 'domain:user-journal'],
      authorizedCollections: ['domain:user-profile', 'domain:user-journal'],
    });

    assert.equal(profile.calls.length, 1);
    assert.equal(journal.calls.length, 1);
    assert.deepEqual(result.collectionGroups.map((group) => group.collectionId).sort(), [
      'domain:user-journal',
      'domain:user-profile',
    ]);
  });

  it('expedition/default library context excludes private collections even for their owner', async () => {
    const { resolver, project, profile, journal } = fixture();
    await resolver.resolve('context for a foreign project', {
      dimension: 'library',
      authorizedCollections: ['domain:user-profile', 'domain:user-journal'],
    });

    assert.equal(project.calls.length, 1);
    assert.equal(profile.calls.length, 0, 'expedition context must not inherit personal profile recall');
    assert.equal(journal.calls.length, 0, 'expedition context must not inherit personal journal recall');
  });
});
