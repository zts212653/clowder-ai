import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import {
  parseEvalDomainRegistryEntry,
  parseEvalDomainRegistryFile,
} from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';

const validEntry = {
  domainId: 'eval:a2a',
  displayName: 'A2A Harness Eval',
  descriptionForHuman: '猫和猫协作顺不顺——传球掉地上没、@ 被忽略没、跨 thread 断没',
  systemThreadId: 'thread_eval_a2a',
  evalCat: { catId: 'codex', handle: '@codex', model: 'gpt-5.5' },
  frequency: 'daily',
  sourceAdapter: 'f167-runtime-eval',
  sourceRefsKind: 'a2a-snapshot-attribution',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F167', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 24, reevalWithinHours: 72 },
};

describe('Eval Domain Registry — metricGlossary (F248 Phase B)', () => {
  it('accepts registry-driven metricGlossary entries', () => {
    const entry = parseEvalDomainRegistryEntry({
      ...validEntry,
      metricGlossary: {
        'c1.hold_zombie_count': {
          label: '真正卡住的持球',
          means: '已经被新持球替换或满足，却仍然没有关闭的持球数量。',
          goodDirection: 'lower',
          category: 'friction',
          component: 'C1',
          badWhen: '大于 0 时，说明球权生命周期有清理缺口。',
          source: 'docs/harness-feedback/bundles/*/snapshot.json',
          ownerHint: '优先检查 hold lifecycle cleanup。',
        },
      },
    });

    assert.equal(entry.metricGlossary?.['c1.hold_zombie_count']?.label, '真正卡住的持球');
    assert.equal(entry.metricGlossary?.['c1.hold_zombie_count']?.goodDirection, 'lower');
    assert.equal(entry.metricGlossary?.['c1.hold_zombie_count']?.category, 'friction');
    assert.equal(entry.metricGlossary?.['c1.hold_zombie_count']?.component, 'C1');
  });

  it('rejects invalid metricGlossary entries', () => {
    assert.throws(() =>
      parseEvalDomainRegistryEntry({
        ...validEntry,
        metricGlossary: {
          'c1.hold_zombie_count': {
            label: '真正卡住的持球',
            means: '已经被新持球替换或满足，却仍然没有关闭的持球数量。',
            goodDirection: 'up',
          },
        },
      }),
    );
  });

  it('accepts local metricGlossaryRef filenames and rejects traversal', () => {
    const entry = parseEvalDomainRegistryEntry({
      ...validEntry,
      metricGlossaryRef: 'eval-a2a.metrics.yaml',
    });
    assert.equal(entry.metricGlossaryRef, 'eval-a2a.metrics.yaml');

    assert.throws(() => parseEvalDomainRegistryEntry({ ...validEntry, metricGlossaryRef: '../eval-a2a.metrics.yaml' }));
  });

  it('eval:a2a ships registry-driven metricGlossary for recent metric refs (F248-B production guard)', async () => {
    const raw = await readFile(
      new URL('../../../../docs/harness-feedback/eval-domains/eval-a2a.yaml', import.meta.url),
      'utf8',
    );
    const entry = parseEvalDomainRegistryFile(parse(raw));

    assert.ok(entry.metricGlossary, 'eval:a2a must define metricGlossary for F248-B');
    assert.equal(entry.metricGlossary['c1.hold_zombie_count']?.label, '真正卡住的持球');
    assert.equal(entry.metricGlossary['c2.verdict_without_pass_count']?.goodDirection, 'lower');
    assert.equal(entry.metricGlossary['inline_action.feedback_written']?.category, 'friction');
    assert.equal(entry.metricGlossary['grounding.check_total']?.component, 'grounding');
    assert.equal(entry.metricGlossary['grounding.verdict_total']?.component, 'grounding');
    assert.equal(entry.metricGlossary['grounding.sample_count']?.category, 'context');
    assert.equal(entry.metricGlossary['grounding.mismatch_sample_count']?.goodDirection, 'lower');
  });

  it('explains every Phase T turn-custody metric used by the cutover verdict', async () => {
    const raw = await readFile(
      new URL('../../../../docs/harness-feedback/eval-domains/eval-a2a.yaml', import.meta.url),
      'utf8',
    );
    const glossary = parseEvalDomainRegistryFile(parse(raw)).metricGlossary;
    assert.ok(glossary, 'eval:a2a must define the Phase T metric glossary inline');
    const expected = [
      'turn_custody.projections_total',
      'turn_custody.covered_active_total',
      'turn_custody.covered_empty_total',
      'turn_custody.unknown_legacy_total',
      'turn_custody.unknown_legacy_rate',
      'turn_custody.agree_allow_total',
      'turn_custody.agree_block_total',
      'turn_custody.agreements_total',
      'turn_custody.disagreements_total',
      'turn_custody.shadow_old_block_total',
      'turn_custody.shadow_new_block_total',
      'turn_custody.old_only_block_total',
      'turn_custody.new_only_block_total',
      'turn_custody.projected_block_increase_total',
      'turn_custody.new_only_classified_total',
      'turn_custody.new_only_justified_total',
      'turn_custody.new_only_unjustified_total',
      'turn_custody.new_only_unexplained_total',
      'turn_custody.new_only_classification_gap_total',
      'turn_custody.protocol_action_without_custody_total',
      'turn_custody.user_nudge_required_total',
      'turn_custody.legacy_guard_without_active_custody_total',
      'turn_custody.same_subject_post_terminal_enqueue_total',
      'turn_custody.lease_succeeded_subject_nonterminal_total',
    ];

    assert.deepEqual(
      Object.keys(glossary)
        .filter((key) => key.startsWith('turn_custody.'))
        .sort(),
      expected.sort(),
    );
    assert.equal(glossary['turn_custody.projected_block_increase_total'].goodDirection, 'neutral');
    assert.equal(glossary['turn_custody.new_only_classification_gap_total'].goodDirection, 'lower');
    assert.equal(glossary['turn_custody.old_only_block_total'].component, 'turn-custody-stop-gate');
  });
});
