import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ArtifactReviewStore } from '../../dist/domains/collaborative-content/artifact-review/store.js';
import { LivingWorkService } from '../../dist/domains/collaborative-content/works/service.js';
import { ProjectContentOwnerService } from '../../dist/domains/video-studio/content-owner/service.js';

export const principal = (threadId = 'selected-thread', userId = 'owner') => ({
  userId,
  threadId,
  actor: { kind: 'human', actorId: userId },
});

/** Real owner files, annotations and catalogue; workspace bytes and external admission are synthetic. */
export async function workCatalogueFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task229-work-catalogue-'));
  const owner = new ProjectContentOwnerService({ dataDir: root });
  const store = new ArtifactReviewStore(join(root, 'reviews.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  let authorize = async ({ principal: caller, scope }) => {
    if (scope) assert.equal(scope.ownerUserId, caller.userId);
  };
  const command = (id) => {
    const digest = `sha256:${createHash('sha256').update(id).digest('hex')}`;
    return {
      action: 'create',
      operationId: id,
      title: `Film ${id}`,
      changeSummary: 'Synthetic version',
      source: { worktreeId: 'fixture', path: id, expectedSourceRevision: digest },
    };
  };
  const service = new LivingWorkService({
    owner,
    changed: options.changed,
    versions: store.works,
    authorize: (input) => authorize(input),
    source: {
      openCurrent: async () => {
        throw new Error('catalogue must not open current workspace files');
      },
      open: async ({ source }) => {
        const bytes = Buffer.from(source.path);
        return {
          stream: Readable.from([bytes]),
          byteLength: bytes.length,
          blobDigest: source.expectedSourceRevision,
          mediaType: 'video/mp4',
          publication: {
            sourceRef: `workspace:fixture:${source.path}`,
            artifactRef: source.path,
            revision: source.expectedSourceRevision,
          },
          revalidate: async () => undefined,
        };
      },
      inspect: async () => {
        throw new Error('catalogue must not inspect workspace bytes');
      },
    },
  });
  return {
    root,
    owner,
    store,
    service,
    command,
    create: (id, threadId = 'selected-thread', userId = 'owner') =>
      service.commit(command(id), principal(threadId, userId)),
    update: (reference, id) =>
      service.commit(
        {
          ...command(id),
          action: 'submit',
          contentRef: reference.contentRef,
          expectedOwnerRevision: reference.ownerRevision,
        },
        principal(),
      ),
    setAuthorize: (callback) => {
      authorize = callback;
    },
    statePath: (contentRef) =>
      join(root, 'projects', 'content-owner-v1', createHash('sha256').update(contentRef).digest('hex'), 'state.json'),
    countReads() {
      let stateReads = 0;
      let manifestBytes = 0;
      const originalRead = fs.readFile;
      fs.readFile = async (path, ...args) => {
        const value = await originalRead(path, ...args);
        if (String(path).startsWith(join(root, 'projects', 'content-owner-v1'))) {
          assert.ok(String(path).endsWith('/state.json'), 'catalogue never reads retained blob bytes');
          stateReads++;
          manifestBytes += Buffer.byteLength(value);
        }
        return value;
      };
      syncBuiltinESMExports();
      t.after(() => {
        fs.readFile = originalRead;
        syncBuiltinESMExports();
      });
      return {
        reset: () => {
          stateReads = 0;
          manifestBytes = 0;
        },
        stats: () => ({ stateReads, manifestBytes }),
      };
    },
  };
}
