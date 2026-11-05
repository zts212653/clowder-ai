import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { fixture, scope, text } from './collective-markdown.fixture.js';

test('scoped content transfer preserves full owner revisions, exact receipts and operation fingerprints', async (t) => {
  const f = await fixture(t);
  const scopeRef = collectiveContentScopeRef(scope);
  // Deliberately use the production apply context order; normalizing object order would invalidate its historical fingerprint.
  await f.owner.settle({
    contentRef: scope.contentRef,
    expectedOwnerRevision: 1,
    bytes: Buffer.from(`${text}\nNext version.\n`),
    actor: { kind: 'human', actorId: 'human-bob' },
    operationId: 'second-shared-version',
    operationContext: {
      kind: 'collective-artifact:apply',
      actorHumanId: 'human-bob',
      scopeRef,
      custodyRevision: 1,
      dispositionId: 'disposition:second-version',
      requestDigest: `sha256:${'c'.repeat(64)}`,
    },
    authorizeEffect: async () => {},
  });
  const snapshot = await f.owner.collectiveCustody.exportSnapshot(scope.contentRef, scopeRef);
  assert.equal(snapshot.manifest.revisions.length, 2);
  assert.deepEqual(snapshot.manifest.receipts, await f.owner.listOutbox(scope.contentRef));
  assert.equal(snapshot.blobs.length, 2);
  const validated = f.owner.collectiveCustody.validateSnapshot(snapshot, scopeRef);
  assert.deepEqual(validated.manifest.operations, snapshot.manifest.operations);
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
  const changed = structuredClone(snapshot);
  changed.blobs[0].base64 = Buffer.from('wrong bytes').toString('base64');
  assert.throws(() => f.owner.collectiveCustody.validateSnapshot(changed, scopeRef));
  const wrongReceipt = structuredClone(snapshot);
  wrongReceipt.manifest.operations['second-shared-version'].fingerprint = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => f.owner.collectiveCustody.validateSnapshot(wrongReceipt, scopeRef));
  assert.throws(() => f.owner.collectiveCustody.validateSnapshot({ ...snapshot, taskId: 'private-task' }, scopeRef));
  assert.throws(() => f.owner.collectiveCustody.validateSnapshot(snapshot, 'wrong-scope'));
  const dataDir = await mkdtemp(join(tmpdir(), 'f290-content-target-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const target = new ProjectContentOwnerService({ dataDir });
  await target.collectiveCustody.assertTargetAvailable(snapshot, scopeRef);
  const binding = { contentRef: scope.contentRef, scopeRef, transferId: 'target-content-transfer', custodyRevision: 2 };
  await target.collectiveCustody.fence.stageTarget(binding, async () => {});
  await assert.rejects(
    target.collectiveCustody.installSnapshot(snapshot, scopeRef, async () => {
      throw new Error('commit not authorized');
    }),
  );
  await assert.rejects(target.describe(scope.contentRef));
  await target.collectiveCustody.installSnapshot(snapshot, scopeRef, async () => {});
  const reopened = new ProjectContentOwnerService({ dataDir });
  await reopened.collectiveCustody.installSnapshot(snapshot, scopeRef, async () => {});
  assert.deepEqual(await reopened.collectiveCustody.exportSnapshot(scope.contentRef, scopeRef), snapshot);
  assert.deepEqual(await reopened.listOutbox(scope.contentRef), await f.owner.listOutbox(scope.contentRef));
  assert.equal((await reopened.load(scope.contentRef, 1)).bytes.toString('utf8'), text);
  assert.equal((await reopened.load(scope.contentRef, 2)).bytes.toString('utf8'), `${text}\nNext version.\n`);
  await assert.rejects(reopened.collectiveCustody.fence.assertReadable(scope.contentRef, scopeRef, 2));
  await reopened.collectiveCustody.fence.activateTarget(
    { ...binding, ownerRevision: 2, blobDigest: snapshot.manifest.revisions[1].blobDigest },
    async () => {},
  );
  await assert.rejects(reopened.collectiveCustody.fence.assertEffectAvailable(scope.contentRef, scopeRef, 1));
  const next = await reopened.settle({
    contentRef: scope.contentRef,
    expectedOwnerRevision: 2,
    bytes: Buffer.from(`${text}\nNext version.\nFinal.\n`),
    actor: { kind: 'human', actorId: 'human-bob' },
    operationId: 'target-next-version',
    operationContext: {
      kind: 'collective-artifact:apply',
      actorHumanId: 'human-bob',
      scopeRef,
      custodyRevision: 2,
      dispositionId: 'target-next-disposition',
      requestDigest: `sha256:${'e'.repeat(64)}`,
    },
    authorizeEffect: async () => {},
  });
  assert.equal(next.ownerRevision, 3);
  await assert.rejects(reopened.collectiveCustody.installSnapshot(snapshot, scopeRef, async () => {}));
  assert.equal((await reopened.describe(scope.contentRef)).currentOwnerRevision, 3);
});

test('a custody snapshot cannot export private or another Collective content', async (t) => {
  const f = await fixture(t);
  await f.owner.importContent({
    contentRef: 'private-content',
    mediaType: 'text/markdown',
    bytes: Buffer.from('private source bytes'),
    actor: { kind: 'human', actorId: 'human-alice' },
    operationId: 'private-import',
  });
  await assert.rejects(f.owner.collectiveCustody.exportSnapshot('private-content', collectiveContentScopeRef(scope)));
  await assert.rejects(f.owner.collectiveCustody.exportSnapshot(scope.contentRef, 'another-collective-scope'));
});
