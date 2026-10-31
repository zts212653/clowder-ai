import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { createReceiptId } from '../src/domains/video-studio/content-owner/operation-identity.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { ProjectContentOwnerStore } from '../src/domains/video-studio/content-owner/store.js';

test('the last catalogue slot commits and replays, while version 10001 leaves no owner effect', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f290-owner-capacity-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir });
  const storage = new ProjectContentOwnerStore(dataDir);
  const scope = {
    kind: 'collective-artifact',
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: 'artifact',
    contentRef: 'collective-content:capacity',
    sourceEventId: 'source',
    publishedByHumanId: 'human',
  } as const;
  const actor = { kind: 'human', actorId: 'human' } as const;
  const context = {
    kind: 'collective-artifact:publish',
    scopeRef: collectiveContentScopeRef(scope),
    requestDigest: `sha256:${'a'.repeat(64)}`,
    actorHumanId: 'human',
    custodyRevision: 1,
    dispositionId: 'publication',
  } as const;
  await owner.importContent({
    contentRef: scope.contentRef,
    collectiveScope: scope,
    bytes: Buffer.from('initial'),
    mediaType: 'text/markdown',
    actor,
    operationId: 'initial',
    operationContext: context,
    authorizeEffect: async () => {},
  });
  const first = await storage.readState(scope.contentRef);
  assert.ok(first);
  const initialRevision = first.revisions[0],
    initialReceipt = first.receipts[0],
    initialOperation = first.operations.initial;
  assert.ok(initialRevision);
  assert.ok(initialReceipt);
  assert.ok(initialOperation);
  // Seed a complete, parser-validated chain. This avoids 9,999 fsyncs without mocking the commit boundary.
  const revisions = Array.from({ length: 9999 }, (_, i) => ({
    ...initialRevision,
    ownerRevision: i + 1,
    parentRevision: i ? i : null,
    operationId: i ? `seed-${i + 1}` : 'initial',
  }));
  const receipts = revisions.map((revision) => ({
    ...initialReceipt,
    operationId: revision.operationId,
    previousOwnerRevision: revision.ownerRevision - 1,
    ownerRevision: revision.ownerRevision,
    outboxSequence: revision.ownerRevision,
    receiptId: createReceiptId(scope.contentRef, revision.operationId, revision.ownerRevision, revision.blobDigest),
  }));
  const operations = Object.fromEntries(
    receipts.map((receipt) => [
      receipt.operationId,
      { fingerprint: initialOperation.fingerprint, receiptId: receipt.receiptId },
    ]),
  );
  await storage.writeState(scope.contentRef, { ...first, currentOwnerRevision: 9999, revisions, receipts, operations });
  const input = {
    contentRef: scope.contentRef,
    bytes: Buffer.from('last permitted'),
    actor,
    operationId: 'last-slot',
    expectedOwnerRevision: 9999,
    authorizeEffect: async () => {},
    operationContext: { ...context, kind: 'collective-artifact:apply', dispositionId: 'last-slot' } as const,
  };
  const last = await owner.settle(input);
  assert.equal(last.ownerRevision, 10000);
  const before = await storage.readState(scope.contentRef);
  await assert.rejects(
    owner.settle({
      ...input,
      bytes: Buffer.from('must never commit'),
      operationId: 'overflow',
      expectedOwnerRevision: 10000,
    }),
    /version.*limit|capacity/i,
  );
  assert.deepEqual(await storage.readState(scope.contentRef), before);
  assert.equal((await owner.listOutbox(scope.contentRef)).length, 10000);
  assert.deepEqual(await owner.settle(input), last);
  assert.equal((await owner.load(scope.contentRef)).bytes.toString(), 'last permitted');
});
