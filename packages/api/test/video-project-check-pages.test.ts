import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { videoProjectDocumentSchema } from '@cat-cafe/shared';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectAssetIndex } from '../src/domains/video-studio/project/asset-index.js';
import {
  assertCheckResultsBoundToInput,
  checkPageDefinitionDigest,
} from '../src/domains/video-studio/project/check-results.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectHumanFixture as principal, projectDocumentFixture } from './helpers/video-project-fixture.js';

test('user-defined check pages and frozen results survive edits and restart without becoming current approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f326-check-pages-'));
  try {
    await writeFile(
      join(root, 'sheet.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF6kAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const assets = new VideoProjectAssetIndex({
      resolveRoot: async (rootId) => ({ root, canonicalWorktreeId: rootId }),
    });
    const document = videoProjectDocumentSchema.parse(projectDocumentFixture);
    document.assets.push({
      id: 'sheet',
      name: '检查图',
      kind: 'image',
      versions: [
        {
          id: 'sheet-v1',
          ...(await assets.inspect({ kind: 'workspace', rootId: 'test-root', path: 'sheet.png' })),
          mediaType: 'image/png',
          recordedAt: document.origin.at,
          origin: document.origin,
        },
      ],
    });
    document.checkPages.push({
      id: 'crowns',
      name: '头顶',
      criteria: '原始检查依据',
      references: ['sheet-v1'],
      scope: { kind: 'selectedScenes', sceneIds: ['s1'] },
      assignee: principal.actor,
      origin: document.origin,
    });
    const dataDir = join(root, 'owner');
    const projects = new VideoProjectService({
      owner: new ProjectContentOwnerService({ dataDir }),
      ownerUserId: principal.userId,
      assets,
    });
    const created = await projects.create({ principal, operationId: 'create-pages', document });
    const withResult = structuredClone(document);
    withResult.checkResults.push({
      id: 'crowns-s1-v1',
      kind: 'sheet',
      pageId: 'crowns',
      sceneId: 's1',
      inputOwnerRevision: 1,
      definitionDigest: checkPageDefinitionDigest(document.checkPages[0]),
      assetVersionRefs: ['sheet-v1'],
      origin: document.origin,
    });
    const input = {
      principal,
      contentRef: created.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'sheet-result',
      document: withResult,
    };
    await projects.save(input);
    const revised = structuredClone(withResult);
    revised.checkPages[0].criteria = '本次新检查依据';
    await projects.save({ ...input, expectedOwnerRevision: 2, operationId: 'revise-criteria', document: revised });
    const restarted = new VideoProjectService({
      owner: new ProjectContentOwnerService({ dataDir }),
      ownerUserId: principal.userId,
      assets,
    });
    const current = await restarted.load({ principal, contentRef: created.contentRef });
    assert.deepEqual(current.document, revised);
    assert.equal(current.document.checkResults[0].inputOwnerRevision, 1);
    assert.notEqual(
      current.document.checkResults[0].definitionDigest,
      checkPageDefinitionDigest(current.document.checkPages[0]),
    );
    const historical = await restarted.load({ principal, contentRef: created.contentRef, ownerRevision: 1 });
    assert.equal(historical.document.checkPages[0].criteria, '原始检查依据');
    const overwritten = structuredClone(revised);
    overwritten.checkResults[0].definitionDigest = checkPageDefinitionDigest(revised.checkPages[0]);
    await assert.rejects(
      restarted.save({ ...input, expectedOwnerRevision: 3, operationId: 'overwrite-result', document: overwritten }),
      /immutable/,
    );
    const wrongBase = structuredClone(revised);
    wrongBase.checkResults.push({ ...withResult.checkResults[0], id: 'pretend-current', inputOwnerRevision: 2 });
    await assert.rejects(
      restarted.save({ ...input, expectedOwnerRevision: 3, operationId: 'wrong-base', document: wrongBase }),
      /exact saved input/,
    );
    assert.throws(
      () => assertCheckResultsBoundToInput(current.document, current.document.checkResults, 1),
      /exact saved input/,
    );
    assertCheckResultsBoundToInput(historical.document, current.document.checkResults, 1);
    const mutatedAsset = structuredClone(revised);
    mutatedAsset.assets[0].versions[0].byteLength += 1;
    await assert.rejects(
      restarted.save({ ...input, expectedOwnerRevision: 3, operationId: 'overwrite-asset', document: mutatedAsset }),
      /immutable/,
    );
    assert.deepEqual(await restarted.load({ principal, contentRef: created.contentRef }), current);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
