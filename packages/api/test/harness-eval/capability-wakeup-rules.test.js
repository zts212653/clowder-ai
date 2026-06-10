import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CAPABILITY_WAKEUP_RULES,
  getCapabilityWakeupRules,
} from '../../dist/infrastructure/harness-eval/capability-wakeup/capability-wakeup-rules.js';

/**
 * F192 Phase H 收尾 PR-2 — capability-wakeup rules registry tests.
 *
 * 砚砚 R1 P2 lock: registry MUST cover 3 capabilities the normalizer already
 * classifies (rich-messaging / workspace-navigator / browser-preview).
 * 否则 domain instruction 说 prioritize workspace-navigator 但 publish 只支持
 * rich → 形成新 501/empty-trials 变体.
 */
describe('CapabilityWakeupRulesRegistry (砚砚 R1 P2)', () => {
  describe('DEFAULT_CAPABILITY_WAKEUP_RULES', () => {
    it('covers all 13 L0 §8 Tier 1 capability wakeup entries (AC-F7)', () => {
      const expected = [
        'rich-messaging',
        'browser-preview',
        'image-generation',
        'workspace-navigator',
        'pencil-design',
        'guide-interaction',
        'expert-panel',
        'propose-thread',
        'external-runtime-sessions',
        'cli-diagnostics',
        'eval-verdict',
        'memory-drilldown',
        'update-workflow',
      ];
      const capabilities = new Set(DEFAULT_CAPABILITY_WAKEUP_RULES.map((r) => r.capability));
      for (const capability of expected) {
        assert.ok(capabilities.has(capability), `missing ${capability}`);
      }
    });

    it('covers all 3 capabilities the normalizer classifies', () => {
      const capabilities = new Set(DEFAULT_CAPABILITY_WAKEUP_RULES.map((r) => r.capability));
      assert.ok(capabilities.has('rich-messaging'), 'missing rich-messaging');
      assert.ok(capabilities.has('workspace-navigator'), 'missing workspace-navigator');
      assert.ok(capabilities.has('browser-preview'), 'missing browser-preview');
    });

    it('every rule has a stable kebab-case id', () => {
      for (const rule of DEFAULT_CAPABILITY_WAKEUP_RULES) {
        assert.match(rule.id, /^[a-z][a-z0-9-]*$/, `bad id: ${rule.id}`);
      }
    });

    it('every rule predicate.capability matches rule.capability (self-consistency)', () => {
      for (const rule of DEFAULT_CAPABILITY_WAKEUP_RULES) {
        assert.equal(
          rule.predicate.capability,
          rule.capability,
          `rule ${rule.id} predicate.capability !== rule.capability`,
        );
      }
    });

    it('rule ids are unique', () => {
      const ids = DEFAULT_CAPABILITY_WAKEUP_RULES.map((r) => r.id);
      const unique = new Set(ids);
      assert.equal(unique.size, ids.length, 'duplicate rule ids');
    });

    it('every predicate.type is one of the 4 supported predicate types', () => {
      const SUPPORTED = new Set([
        'scenario_then_capability_predicate',
        'text_pattern_then_capability',
        'multi_msg_text_volume_threshold',
        'file_change_then_capability',
      ]);
      for (const rule of DEFAULT_CAPABILITY_WAKEUP_RULES) {
        assert.ok(SUPPORTED.has(rule.predicate.type), `bad predicate.type: ${rule.predicate.type}`);
      }
    });

    it('expert-panel trigger requires multi-perspective intent, not ordinary analysis wording', () => {
      const rule = DEFAULT_CAPABILITY_WAKEUP_RULES.find((r) => r.id === 'expert-panel-multi-perspective-request');
      assert.ok(rule, 'missing expert-panel rule');
      assert.equal(rule.predicate.type, 'text_pattern_then_capability');
      const pattern = new RegExp(rule.predicate.patterns[0], 'i');

      assert.equal(pattern.test('帮我分析一下这个 bug'), false);
      assert.equal(pattern.test('多视角分析一下这个架构决定'), true);
    });
  });

  describe('getCapabilityWakeupRules (filter API)', () => {
    it('returns full registry when no filter', () => {
      const rules = getCapabilityWakeupRules();
      assert.equal(rules.length, DEFAULT_CAPABILITY_WAKEUP_RULES.length);
    });

    it('filters by capability', () => {
      const rules = getCapabilityWakeupRules({ capability: 'rich-messaging' });
      assert.ok(rules.length >= 1, 'expected at least 1 rich-messaging rule');
      for (const rule of rules) {
        assert.equal(rule.capability, 'rich-messaging');
      }
    });

    it('returns empty when capability has no rules', () => {
      const rules = getCapabilityWakeupRules({ capability: 'nonexistent-capability' });
      assert.deepEqual(rules, []);
    });

    it('filters by ruleIds', () => {
      const ids = DEFAULT_CAPABILITY_WAKEUP_RULES.slice(0, 1).map((r) => r.id);
      const rules = getCapabilityWakeupRules({ ruleIds: ids });
      assert.equal(rules.length, 1);
      assert.equal(rules[0].id, ids[0]);
    });

    it('returns empty when ruleIds entries do not match any rule', () => {
      const rules = getCapabilityWakeupRules({ ruleIds: ['no-such-rule', 'also-missing'] });
      assert.deepEqual(rules, []);
    });

    it('intersects capability + ruleIds (both must match)', () => {
      const richRule = DEFAULT_CAPABILITY_WAKEUP_RULES.find((r) => r.capability === 'rich-messaging');
      assert.ok(richRule, 'fixture invariant: registry has at least one rich-messaging rule');
      const rules = getCapabilityWakeupRules({
        capability: 'rich-messaging',
        ruleIds: [richRule.id],
      });
      assert.equal(rules.length, 1);
      assert.equal(rules[0].id, richRule.id);
    });

    it('returns empty when capability + ruleIds intersection is empty', () => {
      const wsNavRule = DEFAULT_CAPABILITY_WAKEUP_RULES.find((r) => r.capability === 'workspace-navigator');
      assert.ok(wsNavRule, 'fixture invariant: registry has at least one workspace-navigator rule');
      // ask for rich-messaging capability + workspace-navigator rule id → no match
      const rules = getCapabilityWakeupRules({
        capability: 'rich-messaging',
        ruleIds: [wsNavRule.id],
      });
      assert.deepEqual(rules, []);
    });

    it('empty ruleIds array returns full set (treated as no narrowing)', () => {
      const rules = getCapabilityWakeupRules({ ruleIds: [] });
      assert.equal(rules.length, DEFAULT_CAPABILITY_WAKEUP_RULES.length);
    });
  });
});
