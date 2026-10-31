import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type VideoProjectDocumentV1, videoProjectDocumentSchema } from '@cat-cafe/shared';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { checkPageDefinitionDigest } from '../src/domains/video-studio/project/check-results.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectHumanFixture as principal } from './helpers/video-project-fixture.js';
import { document as mediaDocument } from './workspace-review-video-project.fixture.js';

function checkedDocument(): VideoProjectDocumentV1 {
  const document = mediaDocument();
  document.checkPages.push({
    id: 'face',
    name: '脸部 🐾',
    criteria: '看眼神',
    references: ['image-v1'],
    scope: { kind: 'selectedScenes', sceneIds: ['scene-1'] },
    assignee: null,
    origin: document.origin,
  });
  document.checkResults.push({
    id: 'face-result',
    kind: 'sheet',
    pageId: 'face',
    sceneId: 'scene-1',
    inputOwnerRevision: 1,
    definitionDigest: checkPageDefinitionDigest(document.checkPages[0]),
    assetVersionRefs: ['image-v1'],
    origin: document.origin,
  });
  return document;
}

test('the definition SHA-256 matches a Python UTF-8 Unicode vector', () => {
  const page = {
    id: 'face',
    name: '脸部 🐾',
    criteria: '看 "眼神"\\原样\n下一行\u2028é',
    references: ['图2', '图1'],
    scope: { kind: 'allScenes' as const },
    assignee: null,
    origin: { kind: 'imported' as const, actor: null, at: '2026-10-08T00:00:00.000Z', refs: ['原稿'] },
  };
  assert.equal(
    checkPageDefinitionDigest(page),
    'sha256:c390c08f9ecfee502144f0ecd15dea78633213c3342ecc4bd07b9f672f566250',
  );
});

test('all 36 imported EP0 results identify their exact unchanged check-page definition', async () => {
  const document = videoProjectDocumentSchema.parse(
    JSON.parse(await readFile(new URL('./fixtures/video-project/ep0.json', import.meta.url), 'utf8')),
  );
  assert.equal(document.checkResults.length, 36);
  const mismatches = document.checkResults.filter((result) => {
    const page = document.checkPages.find((page) => page.id === result.pageId);
    assert.ok(page);
    return result.definitionDigest !== checkPageDefinitionDigest(page);
  });
  assert.equal(mismatches.length, 0, 'importer and Host must hash the same UTF-8 sorted-key page definition');
});

test('initial import rejects stale input, digest and page scope before creating owner state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-initial-checks-'));
  const owner = new ProjectContentOwnerService({ dataDir });
  const original = checkedDocument();
  const version = original.assets[0].versions[0];
  // Explicit synthetic verifier isolates admission checks; it does not claim real source-file authority.
  const projects = new VideoProjectService({
    owner,
    ownerUserId: principal.userId,
    assets: {
      inspect: async (locator) => ({ locator, sha256: version.sha256, byteLength: version.byteLength }),
      read: async () => ({ state: 'missing' }),
    },
  });
  const mutations = [
    (doc: VideoProjectDocumentV1) => {
      doc.checkResults[0].definitionDigest = `sha256:${'b'.repeat(64)}`;
    },
    (doc: VideoProjectDocumentV1) => {
      doc.checkResults[0].inputOwnerRevision = 2;
    },
    (doc: VideoProjectDocumentV1) => {
      doc.timeline.scenes.push({ id: 'scene-2', label: 'Other scene' });
      doc.checkResults[0].sceneId = 'scene-2';
    },
    (doc: VideoProjectDocumentV1) => {
      doc.checkPages[0].archivedAt = doc.origin.at;
      doc.checkResults[0].definitionDigest = checkPageDefinitionDigest(doc.checkPages[0]);
    },
  ];
  try {
    for (const [index, mutate] of mutations.entries()) {
      const document = structuredClone(original);
      mutate(document);
      await assert.rejects(projects.create({ principal, operationId: `bad-import-${index}`, document }), /Check/);
      assert.deepEqual(await owner.listVideoProjects(principal.userId), []);
    }
    const created = await projects.create({ principal, operationId: 'valid-import', document: original });
    const restarted = new VideoProjectService({
      owner: new ProjectContentOwnerService({ dataDir }),
      ownerUserId: principal.userId,
    });
    assert.deepEqual(
      (await restarted.load({ principal, contentRef: created.contentRef })).document.checkResults,
      original.checkResults,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('initial coveredBy results require both check pages to apply to their input scene', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-initial-coverage-'));
  const owner = new ProjectContentOwnerService({ dataDir });
  const document = checkedDocument();
  document.timeline.scenes.push({ id: 'scene-2', label: 'Other scene' });
  document.checkPages.push({
    ...document.checkPages[0],
    id: 'cover',
    scope: { kind: 'selectedScenes', sceneIds: ['scene-2'] },
  });
  document.checkResults = [
    {
      id: 'covered-result',
      kind: 'coveredBy',
      pageId: 'face',
      sceneId: 'scene-1',
      inputOwnerRevision: 1,
      definitionDigest: checkPageDefinitionDigest(document.checkPages[0]),
      coveredByPageId: 'cover',
      reason: '这个页面可以覆盖',
      origin: document.origin,
    },
  ];
  const version = document.assets[0].versions[0];
  const projects = new VideoProjectService({
    owner,
    ownerUserId: principal.userId,
    assets: {
      inspect: async (locator) => ({ locator, sha256: version.sha256, byteLength: version.byteLength }),
      read: async () => ({ state: 'missing' }),
    },
  });
  try {
    await assert.rejects(
      projects.create({ principal, operationId: 'bad-coverage-import', document }),
      /Check page does not apply/,
    );
    assert.deepEqual(await owner.listVideoProjects(principal.userId), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
