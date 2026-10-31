import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';

const scope = {
  kind: 'collective-artifact',
  serviceInstanceId: 'service-shared',
  collectiveId: 'collective-shared',
  artifactId: 'artifact-shared',
  contentRef: 'collective-content:shared',
  sourceEventId: 'source-shared',
  publishedByHumanId: 'human-alice',
} as const;
const actor = { kind: 'human', actorId: 'human-alice' } as const;

test('shared Markdown requires immutable owner scope and fresh authority, including receipt replay', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f290-content-owner-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir });
  const input = {
    contentRef: scope.contentRef,
    bytes: Buffer.from('# Shared\nInitial owner bytes.'),
    mediaType: 'text/markdown',
    actor,
    operationId: 'shared-import',
    collectiveScope: scope,
  };
  await assert.rejects(owner.importContent(input), /authority|context/i);
  let allowed = true;
  let checks = 0;
  const authorizeEffect = async () => {
    checks += 1;
    if (!allowed) throw new Error('fresh authority denied');
  };
  const operationContext = {
    kind: 'collective-artifact:publish',
    scopeRef: collectiveContentScopeRef(scope),
    requestDigest: `sha256:${'1'.repeat(64)}`,
    actorHumanId: actor.actorId,
    custodyRevision: 1,
    dispositionId: 'publish-shared',
  } as const;
  const imported = await owner.importContent({ ...input, operationContext, authorizeEffect });
  assert.equal(checks, 2, 'authority must be fresh again at the manifest commit');
  assert.deepEqual((await owner.load(scope.contentRef)).collectiveScope, scope);
  assert.deepEqual(await owner.importContent({ ...input, operationContext, authorizeEffect }), imported);
  allowed = false;
  await assert.rejects(owner.importContent({ ...input, operationContext, authorizeEffect }), /denied/);
  const restarted = new ProjectContentOwnerService({ dataDir });
  assert.deepEqual((await restarted.load(scope.contentRef)).collectiveScope, scope);
  await assert.rejects(
    restarted.settle({
      contentRef: scope.contentRef,
      bytes: Buffer.from('forged'),
      actor,
      operationId: 'missing-apply-authority',
      expectedOwnerRevision: 1,
    }),
    /context|authority/i,
  );
  const apply = {
    contentRef: scope.contentRef,
    bytes: Buffer.from('# Shared\nAdopted bytes.'),
    actor,
    operationId: 'apply-shared',
    expectedOwnerRevision: 1,
    authorizeEffect,
    operationContext: {
      ...operationContext,
      kind: 'collective-artifact:apply',
      dispositionId: 'adopt-proposal-1',
    } as const,
  };
  await assert.rejects(restarted.settle(apply), /denied/);
  assert.equal((await restarted.load(scope.contentRef)).ownerRevision, 1);
  allowed = true;
  const settled = await restarted.settle(apply);
  assert.equal(settled.ownerRevision, 2);
  assert.deepEqual(await restarted.settle(apply), settled);
  assert.equal((await restarted.load(scope.contentRef, 1)).bytes.toString(), input.bytes.toString());
  assert.equal((await restarted.listOutbox(scope.contentRef)).length, 2);
});

test('private content cannot be promoted by attaching a Collective scope to settlement', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f290-content-scope-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir });
  await owner.importContent({
    contentRef: 'private:guide',
    bytes: Buffer.from('private'),
    mediaType: 'text/markdown',
    actor,
    operationId: 'private-import',
  });
  await assert.rejects(
    owner.settle({
      contentRef: 'private:guide',
      bytes: Buffer.from('leaked'),
      actor,
      operationId: 'forged-scope',
      expectedOwnerRevision: 1,
      collectiveScope: scope,
    }),
    /scope/i,
  );
  assert.equal((await owner.load('private:guide')).bytes.toString(), 'private');
});

test('revocation at the final manifest boundary leaves no accepted version or broken owner catalogue', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f290-content-effect-fence-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir });
  let checks = 0;
  const input = {
    contentRef: scope.contentRef,
    collectiveScope: scope,
    bytes: Buffer.from('# Scoped'),
    mediaType: 'text/markdown',
    actor,
    operationId: 'fenced-import',
    operationContext: {
      kind: 'collective-artifact:publish',
      scopeRef: collectiveContentScopeRef(scope),
      requestDigest: `sha256:${'2'.repeat(64)}`,
      actorHumanId: actor.actorId,
      custodyRevision: 1,
      dispositionId: 'fenced-import',
    } as const,
    authorizeEffect: async () => {
      checks += 1;
      if (checks === 2) throw new Error('revoked at commit');
    },
  };
  await assert.rejects(owner.importContent(input), /revoked at commit/);
  await assert.rejects(owner.load(scope.contentRef), { code: 'CONTENT_NOT_FOUND' });
  const catalogue = await owner.findSourcePublicationsBatch([
    {
      lookupId: 'unrelated',
      ownerUserId: 'operator',
      sourceRef: 'message:private',
      artifactRef: '/uploads/private.png',
      revisions: ['1'],
    },
  ]);
  assert.deepEqual(catalogue.get('unrelated'), []);
  const receipt = await owner.importContent({ ...input, authorizeEffect: async () => {} });
  assert.equal(receipt.ownerRevision, 1);
});
