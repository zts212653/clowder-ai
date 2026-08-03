import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const roots = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function vignette({ dimension, quote, scene, privacy }) {
  return `---
status: approved
when: "reviewing a consequential system change"
quotes:
  - "${quote}"
scene: "${scene}"
tags:
  - review
dimension: ${dimension}
${privacy ? `privacy: ${privacy}\n` : ''}---
`;
}

function createTasteRoot() {
  const root = mkdtempSync(join(tmpdir(), 'f287-taste-map-'));
  roots.push(root);
  mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
  mkdirSync(join(root, 'private/taste'), { recursive: true });
  writeFileSync(
    join(root, 'docs/taste/vignettes/cognitive.md'),
    vignette({
      dimension: 'cognitive-honesty',
      quote: 'Name the missing evidence before making the claim.',
      scene: 'The review separates observed behavior from an attractive inference.',
    }),
  );
  writeFileSync(
    join(root, 'docs/taste/vignettes/architecture.md'),
    vignette({
      dimension: 'architecture-aesthetics',
      quote: 'The straight path should remain visible.',
      scene: 'The design keeps one canonical source and a bounded projection.',
    }),
  );
  writeFileSync(
    join(root, 'private/taste/private-cognitive.md'),
    vignette({
      dimension: 'cognitive-honesty',
      quote: 'Private judgment remains owner-scoped.',
      scene: 'The drill authenticates the owner before returning the complete payload.',
      privacy: 'sensitive',
    }),
  );
  return root;
}

describe('F287 D3 Taste map golden journey', () => {
  test('producer admits only explicit writing/review selections', async () => {
    const { judgmentSurfaceCueSeeds } = await import(
      '../../dist/domains/cats/services/agents/routing/route-helpers.js'
    );
    const occurredAt = 1_785_600_000_000;
    const override = judgmentSurfaceCueSeeds({
      sopStageHint: {
        stage: 'review',
        suggestedSkill: 'request-review',
        suggestedSkillSource: 'override',
        featureId: 'F287',
      },
      occurredAt,
    });
    assert.equal(override[0].payload.selectionSource, 'override');

    const promptTag = judgmentSurfaceCueSeeds({
      sopStageHint: {
        stage: 'quality_gate',
        suggestedSkill: 'quality-gate',
        suggestedSkillSource: 'definition',
        featureId: 'F287',
      },
      promptTags: ['skill:writing-plans'],
      occurredAt,
    });
    assert.equal(promptTag[0].payload.selectionSource, 'explicit_prompt_tag');
    assert.equal(promptTag[0].payload.selectedSkill, 'writing-plans');

    const negatives = [
      {
        sopStageHint: {
          stage: 'review',
          suggestedSkill: 'request-review',
          suggestedSkillSource: 'definition',
          featureId: 'F287',
        },
      },
      {
        sopStageHint: {
          stage: 'impl',
          suggestedSkill: 'request-review',
          suggestedSkillSource: 'override',
          featureId: 'F287',
        },
      },
      {
        sopStageHint: {
          stage: 'review',
          suggestedSkill: 'tdd',
          suggestedSkillSource: 'override',
          featureId: 'F287',
        },
      },
      {
        sopStageHint: {
          stage: 'review',
          suggestedSkill: 'request-review',
          suggestedSkillSource: 'definition',
          featureId: 'F287',
        },
        promptTags: ['skill:writing-plans-x'],
      },
    ];
    for (const negative of negatives) {
      assert.deepEqual(judgmentSurfaceCueSeeds({ ...negative, occurredAt }), []);
    }
  });

  test('resolver returns a dimension directory while drill returns complete approved payloads', async () => {
    const root = createTasteRoot();
    const repository = { canonicalRoot: () => root, approvalLockKey: () => join(root, 'docs/taste/index.md') };
    const { CanonicalTasteMemoryCueSource } = await import(
      '../../dist/domains/memory/cue/sources/TasteMemoryCueSource.js'
    );
    const source = new CanonicalTasteMemoryCueSource(repository, 'owner-1');
    const projection = await source.resolve({
      ownerUserId: 'owner-1',
      stage: 'review',
      selectedSkill: 'request-review',
      featureId: 'F287',
    });
    assert.deepEqual(projection.dimensions, ['architecture-aesthetics', 'cognitive-honesty']);
    assert.equal(projection.visibility, 'owner_private');
    assert.equal(Object.hasOwn(projection, 'vignette'), false);
    assert.equal(Object.hasOwn(projection, 'conclusion'), false);
    assert.equal(
      await source.resolve({
        ownerUserId: 'other-owner',
        stage: 'review',
        selectedSkill: 'request-review',
        featureId: 'F287',
      }),
      null,
    );

    const anchor = `taste-dimensions:${projection.dimensions.join(',')}`;
    const drilled = await source.read({ ownerUserId: 'owner-1', anchor, expectedRevision: projection.revision });
    assert.equal(drilled.status, 'ok');
    assert.equal(drilled.payload.totalCount, 3);
    assert.equal(drilled.payload.vignettes.length, 3);
    assert.ok(drilled.payload.vignettes.every((item) => item.payload.quotes.length > 0 && item.payload.scene));
    assert.equal(
      (await source.read({ ownerUserId: 'other-owner', anchor, expectedRevision: projection.revision })).status,
      'not_available',
    );

    writeFileSync(
      join(root, 'docs/taste/vignettes/cognitive.md'),
      vignette({
        dimension: 'cognitive-honesty',
        quote: 'Corrected judgment evidence.',
        scene: 'The source revision changes after an approved vignette correction.',
      }),
    );
    const stale = await source.read({ ownerUserId: 'owner-1', anchor, expectedRevision: projection.revision });
    assert.deepEqual(stale, { status: 'not_available', invalidationReason: 'source_corrected' });
  });
});
