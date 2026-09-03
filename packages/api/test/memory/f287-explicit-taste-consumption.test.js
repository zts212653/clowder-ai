import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

describe('F287 explicit approved Taste consumption', () => {
  test('direct owner ELI5 produces one closed seed while structural history and non-owner ingress stay zero', async () => {
    const { explicitApprovedTasteCueSeeds } = await import(
      '../../dist/domains/cats/services/agents/routing/route-helpers.js'
    );
    const occurredAt = 1_788_000_000_000;

    assert.deepEqual(
      explicitApprovedTasteCueSeeds({
        message: [
          '> L0 Staging Layer (ADR-038)',
          '> metadata',
          '---',
          '[对话历史增量 - 1 条]',
          '以前有人说过 ELI5',
          '[/对话历史]',
          '',
          '用 eli5 告诉我这个系统怎么工作。',
        ].join('\n'),
        sourceMessageId: 'message-owner-eli5',
        ownerOriginEligible: true,
        occurredAt,
      }),
      [
        {
          kind: 'approved_taste_invoked',
          producer: 'owner_message',
          occurredAt,
          payload: {
            triggerKey: 'ELI5',
            sourceMessageId: 'message-owner-eli5',
          },
        },
      ],
    );

    for (const candidate of [
      {
        message: '[对话历史增量 - 1 条]\n用 ELI5 解释\n[/对话历史]\n当前只要普通回答',
        sourceMessageId: 'message-history-only',
        ownerOriginEligible: true,
      },
      {
        message: '用 ELI5 解释',
        sourceMessageId: 'message-connector',
        ownerOriginEligible: false,
      },
      {
        message: '用 ELI5 解释',
        sourceMessageId: undefined,
        ownerOriginEligible: true,
      },
      {
        message: '用一个未知的解释模式',
        sourceMessageId: 'message-unknown',
        ownerOriginEligible: true,
      },
    ]) {
      assert.deepEqual(explicitApprovedTasteCueSeeds({ ...candidate, occurredAt }), []);
    }
  });

  test('exact F221 vignette resolves content-free, then drills a typed HTML application contract', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'f287-explicit-taste-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const sourcePath = 'docs/taste/vignettes/visual-quality-ELI5-pcpjsd.md';
    mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
    const writeVignette = (tags) =>
      writeFileSync(
        join(root, sourcePath),
        [
          '---',
          'when: 2026-08-26',
          'quotes:',
          '  - "以后我一旦提到这个skills时，你就要画那个HTML的富文本给我展示。"',
          'scene: "When ELI5 is requested, show an HTML rich explanation instead of Markdown only."',
          `tags: [${tags.map((tag) => `"${tag}"`).join(', ')}]`,
          'dimension: visual-quality',
          'privacy: public',
          'catId: codex-sol',
          'proposalId: proposal_mt9j84zr3tpcpjsd',
          '---',
          '',
        ].join('\n'),
      );
    writeVignette(['ELI5', 'HTML富文本', '概念对比', '可视化优先']);

    const { CanonicalTasteMemoryCueSource } = await import(
      '../../dist/domains/memory/cue/sources/TasteMemoryCueSource.js'
    );
    const { TasteCueResolver } = await import('../../dist/domains/memory/cue/resolvers/TasteCueResolver.js');
    const { renderMemoryCuePointer } = await import('../../dist/domains/memory/cue/format-memory-cues.js');
    const source = new CanonicalTasteMemoryCueSource(
      { canonicalRoot: () => root, approvalLockKey: () => join(root, 'taste.lock') },
      'owner-1',
    );
    const projection = await source.resolveExplicit({ ownerUserId: 'owner-1', triggerKey: 'ELI5' });
    assert.deepEqual(
      Object.keys(projection).sort(),
      ['revision', 'sourcePath', 'triggerKey', 'visibility'],
      'projection must remain content-free',
    );
    assert.equal(projection.sourcePath, sourcePath);
    assert.equal(projection.visibility, 'owner_public');

    const opportunity = {
      v: 1,
      kind: 'approved_taste_invoked',
      opportunityId: 'opportunity-eli5',
      producer: 'owner_message',
      consumer: 'agent_route',
      scope: { ownerUserId: 'owner-1', threadId: 'thread-1', invocationId: 'invocation-1' },
      occurredAt: 1_788_000_000_000,
      payload: { triggerKey: 'ELI5', sourceMessageId: 'message-owner-eli5' },
    };
    const [cue] = await new TasteCueResolver(source).resolve(opportunity, {
      now: opportunity.occurredAt,
      expiresAt: opportunity.occurredAt + 300_000,
      createDrillHandle: () => 'opaque-handle',
    });
    assert.equal(cue.source.anchor, `taste-vignette:${sourcePath}`);
    assert.match(renderMemoryCuePointer(cue), /Drill before responding/);

    const drilled = await source.read({
      ownerUserId: 'owner-1',
      anchor: cue.source.anchor,
      expectedRevision: cue.source.revision,
    });
    assert.equal(drilled.status, 'ok');
    assert.deepEqual(drilled.payload.applicationContract, {
      v: 1,
      tool: 'cat_cafe_create_rich_block',
      requiredRichBlockKind: 'html_widget',
      plainMarkdownSatisfies: false,
    });
    assert.equal(drilled.payload.vignette.quotes.length, 1);

    writeVignette(['ELI5', 'HTML富文本']);
    assert.deepEqual(
      await source.read({
        ownerUserId: 'owner-1',
        anchor: cue.source.anchor,
        expectedRevision: cue.source.revision,
      }),
      { status: 'not_available', invalidationReason: 'source_corrected' },
    );
  });
});
