import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { resolveAuthorizedExplorationProgram } from '../dist/infrastructure/capability-evolution/read-model/program-exploration-access.js';
import { readPublishedExplorationMedia } from '../dist/infrastructure/capability-evolution/read-model/program-exploration-media.js';
import {
  experimentRef,
  explorationFixture,
  id,
  objectRef,
  source,
} from './capability-evolution-exploration.helper.mjs';

test('the shared F311 media reader preserves exact record/media identity, owner authorization and original bytes', async () => {
  const bytes = Buffer.from('owner-published-original');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const mediaRef = source('media-original', digest);
  const media = {
    mediaRef,
    kind: 'image',
    contentType: 'image/png',
    label: '原实验截图',
    provenance: 'original',
    sourceRecordRef: source('actual-response'),
  };
  const publication = explorationFixture({ withDetail: true, media }),
    before = structuredClone(publication);
  let workspace = 'user:operator',
    lookups = 0,
    mediaReads = 0;
  const deps = {
    service: { get: async () => ({ program: { programId: id, workspaceId: workspace, objectRef, sequence: 3 } }) },
    adapterRegistry: {
      resolve: () => {
        lookups++;
        return {
          status: 'resolved',
          adapter: {
            explorationReview: async () => publication,
            explorationMedia: async (input) => {
              mediaReads++;
              return { status: 'resolved', mediaRef: input.mediaRef, kind: 'image', contentType: 'image/png', bytes };
            },
          },
        };
      },
    },
  };
  await assert.rejects(resolveAuthorizedExplorationProgram(deps, id, 'other'), (error) => error.status === 404);
  assert.equal(lookups, 0);
  const target = { experimentRef, recordRef: source('record'), mediaRef };
  const resolved = await resolveAuthorizedExplorationProgram(deps, id, 'operator');
  const read = await readPublishedExplorationMedia(resolved, target);
  assert.deepEqual(read.bytes, bytes);
  assert.deepEqual(read.media, media);
  await assert.rejects(
    readPublishedExplorationMedia(resolved, { ...target, mediaRef: source('different-original', digest) }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    readPublishedExplorationMedia(resolved, { ...target, recordRef: source('different-record') }),
    (error) => error.status === 404,
  );
  assert.equal(mediaReads, 1, 'same bytes never merge distinct source objects');
  workspace = 'user:other';
  await assert.rejects(resolveAuthorizedExplorationProgram(deps, id, 'operator'), (error) => error.status === 404);
  assert.deepEqual(publication, before, 'reading for collaboration cannot change the experiment or its media evidence');
});
