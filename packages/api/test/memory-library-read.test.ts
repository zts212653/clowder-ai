import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryLibraryFeed, visibleMemoryCollections } from '../src/routes/memory-library-read.js';

const base = {
  kind: 'project' as const,
  name: 'name',
  displayName: '库',
  root: '/private-path',
  scannerLevel: 0 as const,
  indexPolicy: { autoRebuild: false },
  reviewPolicy: { authorityCeiling: 'observed' as const, requireOwnerApproval: true },
  createdAt: '',
  updatedAt: '',
};
const manifests = [
  { ...base, id: 'project:public', sensitivity: 'public' as const },
  { ...base, id: 'project:internal', sensitivity: 'internal' as const },
  { ...base, id: 'project:mine', sensitivity: 'private' as const, ownerUserId: 'owner' },
  { ...base, id: 'project:theirs', sensitivity: 'private' as const, ownerUserId: 'other' },
  { ...base, id: 'project:restricted', sensitivity: 'restricted' as const, ownerUserId: 'other' },
  { ...base, id: 'project:unbound', sensitivity: 'private' as const },
];
test('normal read has public/internal collections, private titles require the existing authorization principal', () => {
  assert.deepEqual(
    visibleMemoryCollections(manifests, null).map((m) => m.id),
    ['project:public', 'project:internal'],
  );
  assert.deepEqual(
    visibleMemoryCollections(manifests, 'owner').map((m) => m.id),
    ['project:public', 'project:internal', 'project:mine'],
  );
});
test('unscoped private and restricted candidates stay withheld while ordinary shared candidates remain visible', () => {
  const marker = {
    id: 'm',
    content: '内容',
    source: 'raw source',
    status: 'captured' as const,
    createdAt: '2026-10-01',
  };
  const result = memoryLibraryFeed(
    [
      { ...marker, id: 'private', sourceSensitivity: 'private' },
      { ...marker, id: 'restricted', sourceSensitivity: 'restricted' },
      { ...marker, id: 'internal', sourceSensitivity: 'internal' },
      { ...marker, id: 'legacy' },
    ],
    manifests,
  );
  assert.deepEqual(result.pending.map((row) => row.id).sort(), ['internal', 'legacy']);
});
