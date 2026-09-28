import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  ContentOwnerConflictError,
  ContentOwnerIdempotencyError,
  ProjectContentOwnerService,
} from '../dist/domains/video-studio/content-owner/service.js';

const roots = new Set();

async function createService(now) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-f309-content-owner-'));
  roots.add(dataDir);
  return { dataDir, service: new ProjectContentOwnerService({ dataDir, now }) };
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('ProjectContentOwnerService', () => {
  it('imports, loads, settles, and recovers the authoritative DOCX revision after restart', async () => {
    const clock = ['2026-09-04T08:00:00.000Z', '2026-09-04T08:01:00.000Z'];
    const { dataDir, service } = await createService(() => clock.shift() ?? '2026-09-04T08:02:00.000Z');
    const contentRef = 'project:alpha/assets/proposal.docx';
    const mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    const imported = await service.importContent({
      contentRef,
      bytes: Buffer.from('docx-v1'),
      mediaType,
      operationId: 'import-1',
      actor: { kind: 'human', actorId: 'operator' },
    });
    assert.equal(imported.previousOwnerRevision, 0);
    assert.equal(imported.ownerRevision, 1);
    assert.equal(imported.outboxSequence, 1);

    const firstLoad = await service.load(contentRef);
    assert.equal(firstLoad.ownerRevision, 1);
    assert.deepEqual(firstLoad.bytes, Buffer.from('docx-v1'));

    const settled = await service.settle({
      contentRef,
      expectedOwnerRevision: 1,
      bytes: Buffer.from('docx-v2'),
      operationId: 'settle-cat-1',
      actor: { kind: 'cat', actorId: 'codex-sol' },
    });
    assert.equal(settled.ownerRevision, 2);
    assert.equal(settled.previousOwnerRevision, 1);
    assert.equal(settled.outboxSequence, 2);

    const restarted = new ProjectContentOwnerService({ dataDir });
    const recovered = await restarted.load(contentRef);
    assert.equal(recovered.ownerRevision, 2);
    assert.deepEqual(recovered.bytes, Buffer.from('docx-v2'));
    assert.deepEqual(await restarted.listOutbox(contentRef), [imported, settled]);
  });

  it('rejects stale CAS before creating a blob, revision, receipt, or outbox entry', async () => {
    const { dataDir, service } = await createService();
    const contentRef = 'project:alpha/assets/conflict.docx';
    await service.importContent({
      contentRef,
      bytes: Buffer.from('base'),
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      operationId: 'import-conflict',
      actor: { kind: 'human', actorId: 'operator' },
    });

    const contentRoot = join(
      dataDir,
      'projects',
      'content-owner-v1',
      createHash('sha256').update(contentRef).digest('hex'),
    );
    const blobsBefore = await readdir(join(contentRoot, 'blobs'));
    await assert.rejects(
      service.settle({
        contentRef,
        expectedOwnerRevision: 0,
        bytes: Buffer.from('stale-candidate'),
        operationId: 'stale-1',
        actor: { kind: 'cat', actorId: 'codex-sol' },
      }),
      (error) => error instanceof ContentOwnerConflictError && error.actualOwnerRevision === 1,
    );
    assert.deepEqual(await readdir(join(contentRoot, 'blobs')), blobsBefore);
    assert.equal((await service.load(contentRef)).ownerRevision, 1);
    assert.equal((await service.listOutbox(contentRef)).length, 1);
  });

  it('replays an identical operation once and rejects mismatched reuse of its idempotency key', async () => {
    const { service } = await createService();
    const contentRef = 'project:alpha/assets/idempotent.docx';
    const request = {
      contentRef,
      bytes: Buffer.from('base'),
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      operationId: 'import-idempotent',
      actor: { kind: 'human', actorId: 'operator' },
    };
    const first = await service.importContent(request);
    assert.deepEqual(await service.importContent(request), first);
    assert.equal((await service.listOutbox(contentRef)).length, 1);

    await assert.rejects(
      service.importContent({ ...request, bytes: Buffer.from('different') }),
      (error) => error instanceof ContentOwnerIdempotencyError,
    );
    await assert.rejects(
      service.importContent({ ...request, actor: { kind: 'cat', actorId: 'codex-sol' } }),
      (error) => error instanceof ContentOwnerIdempotencyError,
    );
    assert.equal((await service.load(contentRef)).ownerRevision, 1);
  });

  it('serializes concurrent human and cat settlements so exactly one revision wins', async () => {
    const { service } = await createService();
    const contentRef = 'project:alpha/assets/race.docx';
    await service.importContent({
      contentRef,
      bytes: Buffer.from('base'),
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      operationId: 'import-race',
      actor: { kind: 'human', actorId: 'operator' },
    });

    const [human, cat] = await Promise.allSettled([
      service.settle({
        contentRef,
        expectedOwnerRevision: 1,
        bytes: Buffer.from('human-edit'),
        operationId: 'human-edit-1',
        actor: { kind: 'human', actorId: 'operator' },
      }),
      service.settle({
        contentRef,
        expectedOwnerRevision: 1,
        bytes: Buffer.from('cat-edit'),
        operationId: 'cat-edit-1',
        actor: { kind: 'cat', actorId: 'codex-sol' },
      }),
    ]);

    assert.equal([human, cat].filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = [human, cat].find((result) => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.ok(rejected.reason instanceof ContentOwnerConflictError);
    assert.equal((await service.load(contentRef)).ownerRevision, 2);
    assert.equal((await service.listOutbox(contentRef)).length, 2);
  });
});
