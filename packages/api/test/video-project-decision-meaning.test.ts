import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type VideoProjectDocumentV1, videoProjectDocumentSchema } from '@cat-cafe/shared';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectHumanFixture as human, projectDocumentFixture } from './helpers/video-project-fixture.js';

const cat = {
  userId: human.userId,
  actor: { kind: 'cat' as const, actorId: 'codex61-sol' },
  invocationId: 'test-delegate',
};

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-decision-meaning-'));
  const document = videoProjectDocumentSchema.parse(projectDocumentFixture);
  document.assets.push({
    id: 'art',
    name: 'declared test material',
    kind: 'image',
    versions: ['v1', 'v2'].map((id, index) => ({
      id,
      mediaType: 'image/png',
      byteLength: 20,
      sha256: `sha256:${String(index + 1).repeat(64)}` as const,
      locator: { kind: 'workspace', rootId: 'declared-test-root', path: `${id}.png` },
      recordedAt: document.origin.at,
      origin: document.origin,
    })),
  });
  document.decisions.push({
    id: 'collar',
    question: '项圈选哪种？',
    context: '影响同一批镜头',
    options: [
      { id: 'a', text: '棕色放大镜', assetVersionRefs: ['v1'] },
      { id: 'b', text: '紫色星星', assetVersionRefs: ['v2'] },
    ],
    targets: { sceneIds: ['s1'], segmentIds: ['C01'], assetIds: ['art'] },
    proposer: human.actor,
    decider: human.actor,
    origin: document.origin,
    state: 'open',
    history: [{ kind: 'proposed', actor: human.actor, at: document.origin.at, operationId: 'create' }],
  });
  // Explicit test-only asset verifier; these decision tests make no real-file claim.
  const assets = {
    async inspect(locator: (typeof document.assets)[number]['versions'][number]['locator']) {
      const version = document.assets[0].versions.find((v) => v.locator.path === locator.path);
      assert.ok(version);
      return { locator, sha256: version.sha256, byteLength: version.byteLength };
    },
    async read() {
      return { state: 'missing' as const };
    },
  };
  const options = { ownerUserId: human.userId, assets, authorizeCat: async () => {} };
  const projects = new VideoProjectService({ ...options, owner: new ProjectContentOwnerService({ dataDir }) });
  const created = await projects.create({ principal: human, operationId: 'create', document });
  return { dataDir, projects, options, contentRef: created.contentRef };
}

const mutations: { name: string; apply: (document: VideoProjectDocumentV1) => void }[] = [
  {
    name: 'question',
    apply: (d) => {
      d.decisions[0].question = '我已选紫色星星';
    },
  },
  {
    name: 'context',
    apply: (d) => {
      d.decisions[0].context = '换了决定上下文';
    },
  },
  {
    name: 'option-text',
    apply: (d) => {
      d.decisions[0].options![0].text = '紫色星星';
    },
  },
  {
    name: 'option-deletion',
    apply: (d) => {
      d.decisions[0].options!.splice(0, 1);
    },
  },
  {
    name: 'option-id-reuse',
    apply: (d) => {
      d.decisions[0].options![0] = { id: 'a', text: '全新含义' };
    },
  },
  {
    name: 'selected-artwork',
    apply: (d) => {
      d.decisions[0].options![0].assetVersionRefs = ['v2'];
    },
  },
  {
    name: 'targets',
    apply: (d) => {
      d.decisions[0].targets.segmentIds = [];
    },
  },
  {
    name: 'provenance',
    apply: (d) => {
      d.decisions[0].origin = { ...d.decisions[0].origin, actor: cat.actor };
    },
  },
];

for (const reopened of [false, true])
  for (const mutation of mutations) {
    test(`decided meaning survives ${reopened ? 'Human reopen then' : 'ordinary'} ${mutation.name} editing`, async () => {
      const f = await fixture();
      try {
        await f.projects.decide({
          principal: human,
          contentRef: f.contentRef,
          expectedOwnerRevision: 1,
          operationId: 'human-choice',
          decisionId: 'collar',
          action: 'decide',
          optionId: 'a',
        });
        if (reopened)
          await f.projects.decide({
            principal: human,
            contentRef: f.contentRef,
            expectedOwnerRevision: 2,
            operationId: 'human-reopen',
            decisionId: 'collar',
            action: 'reopen',
            reason: '再比较原候选',
          });
        const before = await f.projects.load({ principal: cat, contentRef: f.contentRef });
        const edited = structuredClone(before.document);
        mutation.apply(edited);
        await assert.rejects(
          f.projects.save({
            principal: cat,
            contentRef: f.contentRef,
            expectedOwnerRevision: before.ownerRevision,
            operationId: 'reinterpret',
            document: edited,
          }),
          /meaning.*frozen/i,
        );
        const rebuilt = new VideoProjectService({
          ...f.options,
          owner: new ProjectContentOwnerService({ dataDir: f.dataDir }),
        });
        assert.deepEqual(await rebuilt.load({ principal: human, contentRef: f.contentRef }), before);
        assert.equal(
          (await rebuilt.load({ principal: human, contentRef: f.contentRef, ownerRevision: 2 })).document.decisions[0]
            .options![0].text,
          '棕色放大镜',
        );
      } finally {
        await rm(f.dataDir, { recursive: true, force: true });
      }
    });
  }

test('open proposals can evolve; Human reopens fixed choices and Cat makes a separate changed-meaning proposal', async () => {
  const f = await fixture();
  try {
    const open = await f.projects.load({ principal: cat, contentRef: f.contentRef });
    open.document.decisions[0].context = '未选择前补充上下文';
    await f.projects.save({
      principal: cat,
      contentRef: f.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'draft',
      document: open.document,
    });
    await f.projects.decide({
      principal: human,
      contentRef: f.contentRef,
      expectedOwnerRevision: 2,
      operationId: 'choose-a',
      decisionId: 'collar',
      action: 'decide',
      optionId: 'a',
    });
    await f.projects.decide({
      principal: human,
      contentRef: f.contentRef,
      expectedOwnerRevision: 3,
      operationId: 'reopen',
      decisionId: 'collar',
      action: 'reopen',
      reason: '改选另一原候选',
    });
    await f.projects.decide({
      principal: human,
      contentRef: f.contentRef,
      expectedOwnerRevision: 4,
      operationId: 'choose-b',
      decisionId: 'collar',
      action: 'decide',
      optionId: 'b',
    });
    const next = (await f.projects.load({ principal: cat, contentRef: f.contentRef })).document;
    next.decisions.push({
      ...structuredClone(next.decisions[0]),
      id: 'new-collar',
      question: '新问题、新候选',
      options: [{ id: 'a', text: '这是新提案的a' }],
      proposer: cat.actor,
      origin: { ...next.origin, actor: cat.actor },
      state: 'open',
      history: [{ kind: 'proposed', actor: cat.actor, at: next.origin.at, operationId: 'new-proposal' }],
    });
    await f.projects.save({
      principal: cat,
      contentRef: f.contentRef,
      expectedOwnerRevision: 5,
      operationId: 'new-proposal',
      document: next,
    });
    const saved = (await f.projects.load({ principal: human, contentRef: f.contentRef })).document;
    assert.deepEqual(
      saved.decisions[0].history.filter((e) => e.kind === 'decided').map((e) => e.optionId),
      ['a', 'b'],
    );
    assert.equal(saved.decisions[0].options![0].text, '棕色放大镜');
    assert.equal(saved.decisions[1].options![0].text, '这是新提案的a');
  } finally {
    await rm(f.dataDir, { recursive: true, force: true });
  }
});
