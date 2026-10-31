import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';

import { projectDocumentFixture as document, projectHumanFixture as human } from './helpers/video-project-fixture.js';

test('typed project creation authenticates Human identity before any owner commit', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-access-'));
  try {
    const owner = new ProjectContentOwnerService({ dataDir });
    const projects = new VideoProjectService({ owner, ownerUserId: 'operator' });
    await assert.rejects(
      projects.create({
        document,
        operationId: 'forged-human',
        principal: { userId: 'operator', actor: { kind: 'human', actorId: 'other' } },
      }),
      /access denied/i,
    );
    await assert.rejects(
      projects.create({
        document,
        operationId: 'untrusted-cat',
        principal: { userId: 'operator', actor: { kind: 'cat', actorId: 'codex61-sol' }, invocationId: 'claimed' },
      }),
      /authorization/i,
    );
    assert.deepEqual(await owner.listVideoProjects('operator'), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('project schema/ref rejection leaves no committed project', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-schema-'));
  try {
    const owner = new ProjectContentOwnerService({ dataDir });
    const projects = new VideoProjectService({ owner, ownerUserId: 'operator' });
    const invalid = structuredClone(document);
    invalid.timeline.segments[0].sceneId = 'unknown-scene';
    await assert.rejects(projects.create({ principal: human, document: invalid, operationId: 'bad-document' }));
    assert.deepEqual(await owner.listVideoProjects('operator'), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
