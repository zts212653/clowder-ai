import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { videoProjectDocumentSchema } from '@cat-cafe/shared';
import {
  ContentOwnerConflictError,
  ProjectContentOwnerService,
} from '../src/domains/video-studio/content-owner/service.js';
import { type VideoProjectPrincipal, VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectHumanFixture as human, projectDocumentFixture } from './helpers/video-project-fixture.js';

const cat = {
  userId: 'operator',
  actor: { kind: 'cat' as const, actorId: 'codex61-sol' },
  invocationId: 'live-invocation',
};
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-persistence-'));
  const owner = new ProjectContentOwnerService({ dataDir });
  const options = {
    owner,
    ownerUserId: 'operator',
    authorizeCat: async ({ principal }: { principal: VideoProjectPrincipal }) => {
      assert.equal(principal.invocationId, 'live-invocation');
      assert.equal(principal.actor.actorId, 'codex61-sol');
    },
  };
  const projects = new VideoProjectService(options);
  const document = videoProjectDocumentSchema.parse(projectDocumentFixture);
  document.checkPages.push({
    id: 'tops',
    name: '  头顶原名  ',
    criteria: '呆毛只长在砚砚头上',
    references: [],
    scope: { kind: 'allScenes' },
    assignee: cat.actor,
    origin: document.origin,
  });
  document.decisions.push({
    id: 'collar',
    question: '项圈选哪一种？',
    context: '影响当前镜头',
    options: [
      { id: 'a', text: '放大镜' },
      { id: 'b', text: '星星' },
    ],
    targets: { sceneIds: ['s1'], segmentIds: ['C01'], assetIds: [] },
    proposer: human.actor,
    decider: human.actor,
    origin: document.origin,
    state: 'open',
    history: [{ kind: 'proposed', actor: human.actor, at: document.origin.at, operationId: 'create-project' }],
  });
  const receipt = await projects.create({ principal: human, document, operationId: 'create-project' });
  return { dataDir, owner, projects, options, document, receipt };
}

test('project drafts, CAS, key replay, immutable history and restart share one F138 owner', async () => {
  const f = await fixture();
  try {
    const draft = structuredClone(f.document);
    draft.timeline.segments[0].durationTicks = 100;
    assert.deepEqual(
      (await f.projects.load({ principal: human, contentRef: f.receipt.contentRef })).document,
      f.document,
    );
    const input = {
      principal: cat,
      contentRef: f.receipt.contentRef,
      document: draft,
      expectedOwnerRevision: 1,
      operationId: 'cat-save',
    };
    const saved = await f.projects.save(input);
    assert.deepEqual(await f.projects.save(input), saved);
    await assert.rejects(f.projects.save({ ...input, document: { ...draft, title: 'different' } }), /reused/);
    const first = await f.projects.load({ principal: human, contentRef: f.receipt.contentRef, ownerRevision: 1 });
    assert.deepEqual(first.document, f.document);
    const [a, b] = await Promise.allSettled([
      f.projects.save({
        ...input,
        principal: human,
        expectedOwnerRevision: 2,
        operationId: 'human-race',
        document: { ...draft, title: 'human' },
      }),
      f.projects.save({
        ...input,
        expectedOwnerRevision: 2,
        operationId: 'cat-race',
        document: { ...draft, title: 'cat' },
      }),
    ]);
    assert.equal([a, b].filter((r) => r.status === 'fulfilled').length, 1);
    const failure = [a, b].find((r) => r.status === 'rejected');
    assert.ok(failure?.status === 'rejected' && failure.reason instanceof ContentOwnerConflictError);
    const restarted = new VideoProjectService({
      ...f.options,
      owner: new ProjectContentOwnerService({ dataDir: f.dataDir }),
    });
    assert.deepEqual(
      await restarted.load({ principal: human, contentRef: f.receipt.contentRef }),
      await f.projects.load({ principal: human, contentRef: f.receipt.contentRef }),
    );
    assert.equal((await restarted.list({ principal: human })).length, 1);
    assert.equal((await f.owner.listOutbox(f.receipt.contentRef)).length, 3);
    const head = await restarted.load({ principal: human, contentRef: f.receipt.contentRef });
    assert.equal(head.document.checkPages[0].name, '  头顶原名  ');
    await assert.rejects(
      restarted.load({
        principal: { userId: 'other', actor: { kind: 'human', actorId: 'other' } },
        contentRef: head.contentRef,
      }),
      /access denied/,
    );
    await assert.rejects(
      restarted.load({ principal: { ...cat, invocationId: 'forged' }, contentRef: head.contentRef }),
    );
  } finally {
    await rm(f.dataDir, { recursive: true, force: true });
  }
});

test('Human decision is version-bound, retained across reopen, and Cats cannot select through save', async () => {
  const f = await fixture();
  try {
    const input = {
      principal: human,
      contentRef: f.receipt.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'choose-a',
      decisionId: 'collar',
      action: 'decide' as const,
      optionId: 'a',
    };
    await assert.rejects(f.projects.decide({ ...input, principal: cat }), /Human owner/);
    const forged = structuredClone(f.document);
    forged.decisions[0].state = 'decided';
    await assert.rejects(
      f.projects.save({
        principal: cat,
        contentRef: input.contentRef,
        expectedOwnerRevision: 1,
        operationId: 'forged-choice',
        document: forged,
      }),
      /authorized decision/,
    );
    const decided = await f.projects.decide(input);
    assert.deepEqual(await f.projects.decide(input), decided);
    await assert.rejects(f.projects.decide({ ...input, optionId: 'b' }), /reused/);
    await f.projects.decide({
      ...input,
      expectedOwnerRevision: 2,
      operationId: 'reopen',
      action: 'reopen',
      optionId: undefined,
      reason: '再看一次',
    });
    const reopened = await f.projects.load({ principal: human, contentRef: input.contentRef });
    assert.equal(reopened.document.decisions[0].state, 'open');
    assert.deepEqual(
      reopened.document.decisions[0].history.map((event) => event.kind),
      ['proposed', 'decided', 'reopened'],
    );
    assert.equal(reopened.document.decisions[0].history[1].optionId, 'a');
    await assert.rejects(
      f.projects.decide({
        ...input,
        expectedOwnerRevision: 3,
        operationId: 'bogus',
        action: 'bogus' as 'decide',
        optionId: undefined,
      }),
    );
    assert.equal((await f.projects.load({ principal: human, contentRef: input.contentRef })).ownerRevision, 3);
  } finally {
    await rm(f.dataDir, { recursive: true, force: true });
  }
});

test('archive/restore preserves identity and rejects an operation key from a different command', async () => {
  const f = await fixture();
  try {
    const input = {
      principal: human,
      contentRef: f.receipt.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'shared-key',
    };
    await f.projects.save({ ...input, document: f.document });
    await assert.rejects(f.projects.archive({ ...input, archived: false }), /reused/);
    const archived = await f.projects.archive({
      ...input,
      expectedOwnerRevision: 2,
      operationId: 'archive',
      archived: true,
    });
    assert.deepEqual(
      await f.projects.archive({ ...input, expectedOwnerRevision: 2, operationId: 'archive', archived: true }),
      archived,
    );
    assert.equal((await f.projects.list({ principal: human })).length, 0);
    assert.equal((await f.projects.list({ principal: human, includeArchived: true })).length, 1);
    await assert.rejects(
      f.projects.save({ ...input, expectedOwnerRevision: 3, operationId: 'archived-edit', document: f.document }),
      /read-only/,
    );
    await f.projects.archive({ ...input, expectedOwnerRevision: 3, operationId: 'restore', archived: false });
    assert.equal((await f.projects.list({ principal: human }))[0].contentRef, input.contentRef);
    assert.deepEqual(
      (await f.projects.load({ principal: human, contentRef: input.contentRef, ownerRevision: 1 })).document,
      f.document,
    );
  } finally {
    await rm(f.dataDir, { recursive: true, force: true });
  }
});

test('opaque extension namespaces can repeat and an unchanged save still preserves both values', async () => {
  const f = await fixture();
  try {
    const document = structuredClone(f.document);
    document.timeline.extensions = [
      { namespace: 'future.renderer', schemaVersion: 1, payload: { alpha: 1 } },
      { namespace: 'future.renderer', schemaVersion: 1, payload: { alpha: 2 } },
    ];
    const saved = await f.projects.save({
      principal: human,
      contentRef: f.receipt.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'add-exts',
      document,
    });
    await f.projects.save({
      principal: human,
      contentRef: f.receipt.contentRef,
      expectedOwnerRevision: saved.ownerRevision,
      operationId: 'keep-exts',
      document,
    });
    assert.deepEqual(
      (await f.projects.load({ principal: human, contentRef: f.receipt.contentRef })).document.timeline.extensions,
      document.timeline.extensions,
    );
  } finally {
    await rm(f.dataDir, { recursive: true, force: true });
  }
});
