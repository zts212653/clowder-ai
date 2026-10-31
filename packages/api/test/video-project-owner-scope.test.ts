import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';

test('ordinary operation IDs cannot collide with inherited JavaScript object names', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-operation-keys-'));
  try {
    const owner = new ProjectContentOwnerService({ dataDir });
    const created = await owner.importContent({
      contentRef: 'video-project:keys',
      bytes: Buffer.from('{}'),
      mediaType: 'application/vnd.cat-cafe.video-project+json',
      operationId: 'create',
      actor: { kind: 'human', actorId: 'operator' },
      projectScope: { kind: 'video-project', ownerUserId: 'operator', projectId: 'keys' },
    });
    const input = {
      contentRef: created.contentRef,
      bytes: Buffer.from('{"saved":true}'),
      expectedOwnerRevision: 1,
      actor: { kind: 'human' as const, actorId: 'operator' },
      operationId: 'constructor',
    };
    const saved = await owner.settle(input);
    assert.equal(saved.ownerRevision, 2);
    assert.deepEqual(await owner.settle(input), saved);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('video project scope survives settlement and a new owner instance', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-scope-'));
  try {
    const owner = new ProjectContentOwnerService({ dataDir });
    const projectScope = { kind: 'video-project' as const, ownerUserId: 'operator', projectId: 'alpha' };
    const request = {
      contentRef: 'video-project:alpha',
      bytes: Buffer.from('{}'),
      mediaType: 'application/vnd.cat-cafe.video-project+json',
      actor: { kind: 'human' as const, actorId: 'operator' },
      operationId: 'create',
      projectScope,
    };
    const first = await owner.importContent(request);
    assert.deepEqual((await owner.load(request.contentRef)).projectScope, projectScope);
    await assert.rejects(
      owner.importContent({ ...request, projectScope: { ...projectScope, ownerUserId: 'other' } }),
      /reused/,
    );
    await owner.settle({
      contentRef: request.contentRef,
      bytes: Buffer.from('{"edit":true}'),
      actor: request.actor,
      operationId: 'save',
      expectedOwnerRevision: first.ownerRevision,
    });
    const reopened = new ProjectContentOwnerService({ dataDir });
    assert.deepEqual((await reopened.load(request.contentRef)).projectScope, projectScope);
    assert.deepEqual((await reopened.load(request.contentRef, 1)).projectScope, projectScope);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('project scope cannot impersonate another content identity or publication authority', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-scope-invalid-'));
  try {
    const owner = new ProjectContentOwnerService({ dataDir });
    const request = {
      contentRef: 'video-project:alpha',
      bytes: Buffer.from('{}'),
      mediaType: 'application/vnd.cat-cafe.video-project+json',
      actor: { kind: 'human' as const, actorId: 'operator' },
      operationId: 'invalid',
      projectScope: { kind: 'video-project' as const, ownerUserId: 'operator', projectId: 'other' },
    };
    await assert.rejects(owner.importContent(request), /project scope/i);
    await assert.rejects(owner.load(request.contentRef), /not found/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
