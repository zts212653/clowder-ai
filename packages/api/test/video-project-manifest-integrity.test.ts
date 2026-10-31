import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';

for (const corruption of ['scope', 'operation-digest', 'null-operation'] as const) {
  test(`canonical manifest reading rejects project ${corruption} before direct or catalogue disclosure`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'f326-manifest-'));
    const contentRef = 'video-project:manifest';
    try {
      const owner = new ProjectContentOwnerService({ dataDir });
      await owner.importContent({
        contentRef,
        mediaType: 'application/vnd.cat-cafe.video-project+json',
        bytes: Buffer.from('{}'),
        operationId: 'create',
        actor: { kind: 'human', actorId: 'operator' },
        projectScope: { kind: 'video-project', ownerUserId: 'operator', projectId: 'manifest' },
        operationContext: { kind: 'video-project:create', requestDigest: `sha256:${'1'.repeat(64)}` },
      });
      const manifest = join(
        dataDir,
        'projects',
        'content-owner-v1',
        createHash('sha256').update(contentRef).digest('hex'),
        'state.json',
      );
      const stored = JSON.parse(await readFile(manifest, 'utf8')) as {
        projectScope: { projectId: string };
        receipts: { operationContext?: unknown }[];
      };
      if (corruption === 'scope') stored.projectScope.projectId = 'foreign';
      else if (corruption === 'operation-digest')
        stored.receipts[0].operationContext = { kind: 'video-project:create', requestDigest: 'invalid' };
      else stored.receipts[0].operationContext = null;
      await writeFile(manifest, JSON.stringify(stored));
      const restarted = new ProjectContentOwnerService({ dataDir });
      await assert.rejects(restarted.describe(contentRef), /video project/i);
      await assert.rejects(restarted.listVideoProjects('operator'), /video project/i);
      await assert.rejects(
        restarted.findSourcePublications({
          ownerUserId: 'operator',
          sourceRef: 'source',
          artifactRef: 'asset',
          revisions: ['1'],
        }),
        /video project/i,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
