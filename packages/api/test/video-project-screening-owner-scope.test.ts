import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';

const scope = {
  kind: 'video-project-screening' as const,
  ownerUserId: 'operator',
  projectContentRef: 'video-project:alpha',
  screeningId: 'screening-1',
  input: { contentRef: 'video-project:alpha', ownerRevision: 1, blobDigest: `sha256:${'a'.repeat(64)}` as const },
  source: { locator: { worktreeId: 'root', path: 'movie.mp4' }, expectedSourceRevision: `sha256:${'b'.repeat(64)}` },
  sourceContentRef: 'workspace-content:movie',
  snapshotOperationId: 'register-1',
  requestDigest: `sha256:${'c'.repeat(64)}` as const,
  registeredBy: { kind: 'human' as const, actorId: 'operator' },
  registeredAt: '2026-10-10T00:00:00.000Z',
};

test('project media import preserves a distinct immutable scope across owner restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-screening-scope-'));
  try {
    const owner = new ProjectContentOwnerService({ dataDir });
    const request = {
      contentRef: 'video-project-media:alpha',
      bytes: Buffer.from('snapshot'),
      mediaType: 'video/mp4',
      actor: scope.registeredBy,
      operationId: 'register-1',
      projectMediaScope: scope,
    };
    await owner.importContent(request);
    const restored = await new ProjectContentOwnerService({ dataDir }).load(request.contentRef, 1);
    assert.deepEqual(restored.projectMediaScope, scope);
    await assert.rejects(
      owner.importContent({ ...request, projectMediaScope: { ...scope, screeningId: 'other' } }),
      /reused/,
    );
    await assert.rejects(
      owner.settle({
        contentRef: request.contentRef,
        expectedOwnerRevision: 1,
        operationId: 'mutate',
        actor: request.actor,
        bytes: Buffer.from('changed'),
      }),
      /immutable/i,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
