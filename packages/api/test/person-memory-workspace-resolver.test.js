import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function entity(overrides = {}) {
  return {
    entityId: 'person:huang-ting-huawei',
    type: 'person',
    canonicalName: '黄挺',
    aliases: ['黄挺'],
    provenance: [{ source: 'test', anchor: 'F276' }],
    visibilityScope: 'workspace',
    status: 'active',
    updatedAt: '2026-07-27T00:00:00Z',
    ...overrides,
  };
}

function match(overrides = {}) {
  return {
    entityId: 'person:huang-ting-huawei',
    type: 'person',
    canonicalName: '黄挺',
    matchedAlias: '黄挺',
    provenance: [{ source: 'test', anchor: 'F276' }],
    ...overrides,
  };
}

function store({ matches = [], entities = [], resolveError, getError } = {}) {
  const byId = new Map(entities.map((record) => [record.entityId, record]));
  return {
    resolveEntityAliases: async () => {
      if (resolveError) throw resolveError;
      return matches;
    },
    getEntity: async (entityId) => {
      if (getError) throw getError;
      return byId.get(entityId) ?? null;
    },
  };
}

describe('F276 workspace person resolver', () => {
  it('converges every normalized identity alias onto one workspace person', async () => {
    const { resolveWorkspacePersonAliasSet } = await import('../dist/domains/memory/people/WorkspacePersonResolver.js');
    const seen = [];
    const resolver = {
      resolve: async (alias) => {
        seen.push(alias);
        return alias === 'H. Ting'
          ? { status: 'not_found' }
          : {
              status: 'resolved',
              entityRef: 'person:huang-ting-huawei',
              canonicalName: '黄挺',
            };
      },
    };

    assert.deepEqual(await resolveWorkspacePersonAliasSet(resolver, ['H. Ting', '黄挺', '  黄挺  ']), {
      status: 'resolved',
      entityRef: 'person:huang-ting-huawei',
      canonicalName: '黄挺',
    });
    assert.deepEqual(seen, ['H. Ting', '黄挺']);
  });

  it('fails the alias set closed on an unhealthy alias or conflicting identity roots', async () => {
    const { resolveWorkspacePersonAliasSet } = await import('../dist/domains/memory/people/WorkspacePersonResolver.js');
    const resolutions = new Map([
      ['H. Ting', { status: 'resolved', entityRef: 'person:huang-ting-huawei', canonicalName: '黄挺' }],
      ['黄挺', { status: 'unavailable' }],
    ]);
    const resolver = { resolve: async (alias) => resolutions.get(alias) ?? { status: 'not_found' } };

    assert.deepEqual(await resolveWorkspacePersonAliasSet(resolver, ['H. Ting', '黄挺']), {
      status: 'unavailable',
    });
    resolutions.set('黄挺', {
      status: 'resolved',
      entityRef: 'person:different',
      canonicalName: '另一位黄挺',
    });
    assert.deepEqual(await resolveWorkspacePersonAliasSet(resolver, ['H. Ting', '黄挺']), {
      status: 'conflict',
    });
  });

  it('resolves one exact-normalized active workspace person and revalidates the canonical record', async () => {
    const { EvidenceStoreWorkspacePersonResolver } = await import(
      '../dist/domains/memory/people/WorkspacePersonResolver.js'
    );
    const resolver = new EvidenceStoreWorkspacePersonResolver(
      store({
        matches: [match({ matchedAlias: '  黄挺  ', canonicalName: 'stale display' })],
        entities: [entity()],
      }),
    );

    assert.deepEqual(await resolver.resolve('黄挺'), {
      status: 'resolved',
      entityRef: 'person:huang-ting-huawei',
      canonicalName: '黄挺',
    });
  });

  it('returns not_found only when the healthy registry reports no alias candidates', async () => {
    const { EvidenceStoreWorkspacePersonResolver } = await import(
      '../dist/domains/memory/people/WorkspacePersonResolver.js'
    );
    const resolver = new EvidenceStoreWorkspacePersonResolver(store());

    assert.deepEqual(await resolver.resolve('不存在的人'), { status: 'not_found' });
  });

  it('fails closed when two exact active workspace person entities match', async () => {
    const { EvidenceStoreWorkspacePersonResolver } = await import(
      '../dist/domains/memory/people/WorkspacePersonResolver.js'
    );
    const second = entity({
      entityId: 'person:huang-ting-second',
      canonicalName: '黄挺二号',
    });
    const resolver = new EvidenceStoreWorkspacePersonResolver(
      store({
        matches: [
          match(),
          match({
            entityId: second.entityId,
            canonicalName: second.canonicalName,
          }),
        ],
        entities: [entity(), second],
      }),
    );

    assert.deepEqual(await resolver.resolve('黄挺'), { status: 'ambiguous' });
  });

  for (const [label, invalid] of [
    ['non-person', entity({ type: 'concept' })],
    ['retired', entity({ status: 'retired' })],
    ['private', entity({ visibilityScope: 'private:user-owner' })],
  ]) {
    it(`fails closed when an exact registry candidate revalidates as ${label}`, async () => {
      const { EvidenceStoreWorkspacePersonResolver } = await import(
        '../dist/domains/memory/people/WorkspacePersonResolver.js'
      );
      const resolver = new EvidenceStoreWorkspacePersonResolver(
        store({
          matches: [match()],
          entities: [invalid],
        }),
      );

      assert.deepEqual(await resolver.resolve('黄挺'), { status: 'unavailable' });
    });
  }

  it('fails closed on substring-only matches instead of treating them as absence', async () => {
    const { EvidenceStoreWorkspacePersonResolver } = await import(
      '../dist/domains/memory/people/WorkspacePersonResolver.js'
    );
    const resolver = new EvidenceStoreWorkspacePersonResolver(
      store({
        matches: [match({ matchedAlias: '黄挺' })],
        entities: [entity()],
      }),
    );

    assert.deepEqual(await resolver.resolve('我昨天和黄挺见面'), { status: 'unavailable' });
  });

  it('fails closed when the read port is missing, throws, or returns a stale pointer', async () => {
    const { EvidenceStoreWorkspacePersonResolver } = await import(
      '../dist/domains/memory/people/WorkspacePersonResolver.js'
    );
    const cases = [
      {},
      { resolveEntityAliases: async () => [] },
      store({ resolveError: new Error('registry offline') }),
      store({ matches: [match()] }),
    ];

    for (const candidateStore of cases) {
      const resolver = new EvidenceStoreWorkspacePersonResolver(candidateStore);
      assert.deepEqual(await resolver.resolve('黄挺'), { status: 'unavailable' });
    }
  });
});
