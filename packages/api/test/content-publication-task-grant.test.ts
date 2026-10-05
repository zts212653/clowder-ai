import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { PublishedMediaSource } from '../src/domains/video-studio/content-owner/published-media-source.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

for (const kind of ['message', 'workspace-snapshot'] as const) {
  for (const operation of ['read', 'publishVersion', 'source-visibility', 'publish-in-same-thread'] as const) {
    test(`${kind}: self-updated Task artifactRefs cannot grant ${operation} across conversations`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'f309-forged-grant-'));
      await writeFile(
        join(root, 'review-input.png'),
        await sharp({
          create: { width: 40, height: 30, channels: 3, background: '#abcdef' },
        })
          .png()
          .toBuffer(),
      );
      const workspace = new WorkspaceContentSourceService({
        ownerUserId: 'operator',
        resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
      });
      const f = await createLiveReviewFixture(root, 'image/png', undefined, workspace);
      t.after(async () => {
        await f.dispatch.close();
        f.store.close();
        await rm(root, { recursive: true, force: true });
      });
      const origin =
        operation === 'publish-in-same-thread' ? f.thread : f.threads.create('operator', '未托付给这只猫的作品', root);
      const message = f.messages.append({
        userId: 'operator',
        threadId: origin.id,
        catId: null,
        mentions: [],
        timestamp: Date.now(),
        content: '上传的图片',
        extra: {
          rich: {
            v: 1,
            blocks: [
              {
                kind: 'media_gallery',
                id: 'origin',
                v: 1,
                items: [{ url: '/uploads/review-input.png', alt: '原作品' }],
              },
            ],
          },
        },
      });
      const description = await workspace.describe({
        principal: f.human,
        locator: { worktreeId: 'work', path: 'review-input.png' },
      });
      const asset = await f.media.prepare({
        principal: f.human,
        operationId: 'open-unrelated',
        source:
          kind === 'message'
            ? {
                kind,
                threadId: origin.id,
                messageId: message.id,
                messageRevision: String(message.timestamp),
                expectedUrl: '/uploads/review-input.png',
                item: { kind: 'media-gallery', blockId: 'origin', itemIndex: 0 },
              }
            : { kind, threadId: origin.id, locator: description.locator, expectedSourceRevision: description.revision },
      });
      // This is the same mutation the authenticated cat's update-entrusted-work callback permits.
      await f.lifecycle.update({
        taskId: f.taskId,
        expectedRevision: 1,
        artifactRefs: [`content:${asset.contentRef}`, f.prepare.artifactRef],
      });
      const principal = { ...f.cat, contentTaskId: f.taskId };
      if (operation === 'read') await assert.rejects(f.media.read(asset.contentRef, 1, principal), /access_denied/);
      else if (operation === 'publishVersion' || operation === 'publish-in-same-thread')
        await assert.rejects(
          f.media.publishVersion({
            ...f.prepare,
            expectedTaskRevision: 2,
            contentRef: asset.contentRef,
            expectedOwnerRevision: 1,
            principal,
            operationId: 'forge-return',
          }),
          /access_denied/,
        );
      else {
        const sources = new PublishedMediaSource({
          access: f.media.access,
          artifacts: f.publications,
          messages: f.messages,
          uploadDir: root,
          workspace,
        });
        const { scope, publication } = await f.media.origin(asset.contentRef, f.human);
        await assert.rejects(sources.assertVisible(scope, publication, principal), /access_denied/);
      }
      assert.equal((await f.owner.describe(asset.contentRef)).currentOwnerRevision, 1);
    });
  }
}
