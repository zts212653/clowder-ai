import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { videoProjectDocumentSchema } from '@cat-cafe/shared';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectHumanFixture as principal } from './helpers/video-project-fixture.js';

for (const name of ['ep0', 'parallel-world']) {
  test(`frozen ${name} generic envelope persists, edits, and recovers without a Home dependency`, async () => {
    const document = videoProjectDocumentSchema.parse(
      JSON.parse(await readFile(new URL(`./fixtures/video-project/${name}.json`, import.meta.url), 'utf8')),
    );
    const dataDir = await mkdtemp(join(tmpdir(), `f326-fixture-${name}-`));
    // An explicit test-only source port. Real filesystem/digest behavior is tested separately;
    // the external source replay is recorded alongside these frozen extraction fixtures.
    const versions = document.assets.flatMap((asset) => asset.versions);
    const assets = {
      async inspect(locator: (typeof versions)[number]['locator']) {
        const version = versions.find(
          (value) => value.locator.rootId === locator.rootId && value.locator.path === locator.path,
        );
        assert.ok(version, 'only fixture-declared locations are known to this test source');
        return { locator, sha256: version.sha256, byteLength: version.byteLength };
      },
      async read() {
        return { state: 'missing' as const };
      },
    };
    try {
      const projects = new VideoProjectService({
        ownerUserId: principal.userId,
        owner: new ProjectContentOwnerService({ dataDir }),
        assets,
      });
      const receipt = await projects.create({ principal, document, operationId: `import-${name}` });
      assert.deepEqual((await projects.load({ principal, contentRef: receipt.contentRef })).document, document);
      const edited = structuredClone(document);
      edited.title += ' · editing draft';
      const segment = edited.timeline.segments[edited.timeline.segments.length - 1];
      segment.durationTicks += 5;
      edited.timeline.durationTicks += 5;
      if (segment.visuals.length) segment.visuals[segment.visuals.length - 1].endTick += 5;
      await projects.save({
        principal,
        contentRef: receipt.contentRef,
        expectedOwnerRevision: 1,
        operationId: `edit-${name}`,
        document: edited,
      });
      const restarted = new VideoProjectService({
        ownerUserId: principal.userId,
        owner: new ProjectContentOwnerService({ dataDir }),
        assets,
      });
      assert.deepEqual((await restarted.load({ principal, contentRef: receipt.contentRef })).document, edited);
      assert.deepEqual(
        (await restarted.load({ principal, contentRef: receipt.contentRef, ownerRevision: 1 })).document,
        document,
      );
      assert.deepEqual(
        (await restarted.operationReceipt({ principal, contentRef: receipt.contentRef, operationId: `edit-${name}` }))
          ?.ownerRevision,
        2,
      );
      if (name === 'ep0') {
        assert.equal(document.timeline.segments.length, 100);
        assert.equal(document.checkResults.length, 36);
        const cut = document.timeline.segments.find((segment) => segment.id === 'C08');
        assert.ok(cut);
        assert.equal(cut.startTick + cut.visuals[2].startTick, 1429);
      } else {
        assert.equal(document.timeline.segments.length, 8);
        assert.equal(document.timeline.durationTicks, 1035);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
