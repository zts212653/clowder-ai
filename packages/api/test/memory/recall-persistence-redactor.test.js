import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('RecallPersistenceRedactor', () => {
  let redactGroupsForPersistence;

  it('redacts private collection items to metadata-only', async () => {
    ({ redactGroupsForPersistence } = await import('../../dist/domains/memory/RecallPersistenceRedactor.js'));

    const groups = [
      {
        collectionId: 'world:lexander',
        sensitivity: 'private',
        status: 'ok',
        durationMs: 1,
        items: [
          {
            anchor: 'world:lexander:doc/secret-plot',
            title: 'Secret Plot About Dragons',
            kind: 'lore',
            status: 'active',
            updatedAt: '2026-05-01',
          },
        ],
      },
      {
        collectionId: 'project:cat-cafe',
        sensitivity: 'internal',
        status: 'ok',
        durationMs: 1,
        items: [
          {
            anchor: 'project:cat-cafe:doc/f186',
            title: 'F186 Library Memory',
            kind: 'feature',
            status: 'active',
            updatedAt: '2026-05-01',
          },
        ],
      },
    ];

    const result = redactGroupsForPersistence(groups);
    assert.equal(result.length, 2);

    // Private collection items are redacted
    assert.equal(result[0].items[0].title, '[redacted — private collection]');
    assert.equal(result[0].items[0].anchor, 'world:lexander:doc/secret-plot');
    assert.equal(result[0].items[0].kind, 'lore');

    // Internal collection items are preserved
    assert.equal(result[1].items[0].title, 'F186 Library Memory');
  });

  it('passes through public and internal groups unchanged', async () => {
    ({ redactGroupsForPersistence } = await import('../../dist/domains/memory/RecallPersistenceRedactor.js'));

    const groups = [
      {
        collectionId: 'project:cat-cafe',
        sensitivity: 'public',
        status: 'ok',
        durationMs: 1,
        items: [{ anchor: 'a', title: 'Public Doc', kind: 'doc', status: 'active', updatedAt: '2026-05-01' }],
      },
      {
        collectionId: 'project:internal',
        sensitivity: 'internal',
        status: 'ok',
        durationMs: 1,
        items: [{ anchor: 'b', title: 'Internal Doc', kind: 'doc', status: 'active', updatedAt: '2026-05-01' }],
      },
    ];

    const result = redactGroupsForPersistence(groups);
    assert.equal(result[0].items[0].title, 'Public Doc');
    assert.equal(result[1].items[0].title, 'Internal Doc');
  });

  it('redacts restricted collection items', async () => {
    ({ redactGroupsForPersistence } = await import('../../dist/domains/memory/RecallPersistenceRedactor.js'));

    const groups = [
      {
        collectionId: 'domain:medical',
        sensitivity: 'restricted',
        status: 'ok',
        durationMs: 1,
        items: [
          {
            anchor: 'domain:medical:doc/patient-1',
            title: 'Patient Record',
            kind: 'record',
            status: 'active',
            updatedAt: '2026-05-01',
          },
        ],
      },
    ];

    const result = redactGroupsForPersistence(groups);
    assert.equal(result[0].items[0].title, '[redacted — restricted collection]');
    assert.equal(result[0].items[0].anchor, 'domain:medical:doc/patient-1');
  });
});
