import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectHumanFixture as principal, projectDocumentFixture } from './helpers/video-project-fixture.js';

for (const field of ['screenings', 'selfReviews'] as const) {
  test(`ordinary project save cannot manufacture ${field} evidence`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'f326-register-facts-'));
    try {
      const projects = new VideoProjectService({
        owner: new ProjectContentOwnerService({ dataDir }),
        ownerUserId: principal.userId,
      });
      const receipt = await projects.create({ principal, operationId: 'project', document: projectDocumentFixture });
      const input = { contentRef: receipt.contentRef, ownerRevision: 1, blobDigest: receipt.blobDigest };
      const document = structuredClone(projectDocumentFixture);
      const facts =
        field === 'selfReviews'
          ? [
              {
                id: 'made-up-review',
                input,
                actor: { kind: 'cat', actorId: 'another-cat' },
                at: '2026-10-10T00:00:00Z',
                operationId: 'save',
                segmentIds: ['C01'],
                conclusion: 'pass',
                refs: ['invented-source'],
              },
            ]
          : [
              {
                id: 'made-up-screening',
                title: 'Old output',
                input,
                media: {
                  contentRef: 'unknown-media',
                  ownerRevision: 1,
                  blobDigest: `sha256:${'a'.repeat(64)}`,
                  byteLength: 100,
                  media: {
                    kind: 'video',
                    width: 1280,
                    height: 720,
                    codedWidth: 1280,
                    codedHeight: 720,
                    rotation: 0,
                    pixelAspectRatio: { numerator: 1, denominator: 1 },
                    streamId: 'v0',
                    streamIndex: 0,
                    timebase: { numerator: 1, denominator: 15360 },
                    startTick: 0,
                    durationTicks: 15360,
                    containerStartSeconds: 0,
                  },
                },
                mapping: {
                  segments: [
                    {
                      mediaStartPts: 0,
                      mediaEndPts: 15360,
                      projectStartTick: 0,
                      projectEndTick: 30,
                      refs: ['invented-source'],
                    },
                  ],
                  frame: { displayWidth: 1280, displayHeight: 720, canvasWidth: 1920, canvasHeight: 1080, rotation: 0 },
                },
                actor: principal.actor,
                at: '2026-10-10T00:00:00Z',
                operationId: 'save',
                refs: ['invented-source'],
              },
            ];
      await assert.rejects(
        projects.save({
          principal,
          contentRef: receipt.contentRef,
          expectedOwnerRevision: 1,
          operationId: 'save',
          document: { ...document, [field]: facts },
        }),
        /dedicated|registration|facts|attestation/,
      );
      assert.equal((await projects.load({ principal, contentRef: receipt.contentRef })).ownerRevision, 1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
