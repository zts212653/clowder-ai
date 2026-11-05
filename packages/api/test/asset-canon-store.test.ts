import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetCanonRecord } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { indexedVersionRef } from '../src/domains/collaborative-content/asset-canon/identity.js';
import { AssetCanonStore } from '../src/domains/collaborative-content/asset-canon/store.js';

const principal = { userId: 'owner', threadId: 'film-a', actor: { kind: 'cat' as const, actorId: 'director' } };
export function asset(name = 'a.png', digest = 'a'): AssetCanonRecord {
  const version = {
    id: name,
    locator: { kind: 'workspace' as const, rootId: 'films', path: name },
    sha256: `sha256:${digest.repeat(64)}`,
    byteLength: 10,
    mediaType: 'image/png',
    recordedAt: new Date().toISOString(),
    origin: { kind: 'created' as const, actor: principal.actor, at: new Date().toISOString(), refs: [] },
  };
  return {
    indexedVersionRef: indexedVersionRef(principal.userId, version),
    ownerUserId: principal.userId,
    name,
    kind: 'image',
    version,
    creator: principal.actor,
    source: { kind: 'workspace', threadId: 'film-a' },
    createdAt: new Date().toISOString(),
    applicability: [],
    revision: 0,
    status: null,
    judgment: null,
    supersededBy: null,
  };
}

test('the exact file shares one judgment across films without merging a name or changed bytes', () => {
  const db = new Database(':memory:');
  try {
    const store = new AssetCanonStore(db);
    const a = store.index(asset());
    store.mutate(
      {
        action: 'set-asset-status',
        indexedVersionRef: a.indexedVersionRef,
        expectedRevision: 0,
        operationId: 'mark',
        status: 'failed',
        reason: '紫项圈动作是失败样本',
        evidenceRefs: [],
        bindings: [],
      },
      principal,
    );
    assert.equal(store.index({ ...asset(), source: { kind: 'workspace', threadId: 'film-b' } }).status, 'failed');
    assert.equal(store.index(asset('other/a.png')).status, null);
    assert.equal(store.index(asset('a.png', 'b')).status, null);
  } finally {
    db.close();
  }
});
