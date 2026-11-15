import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_CAPABILITY_WAKEUP_RULES,
  getCapabilityWakeupRules,
} from '../../dist/infrastructure/harness-eval/capability-wakeup/capability-wakeup-rules.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const autonomousCardRuleId = 'code-as-harness-confirmed-repeat-autonomous-card';
const cvoDecisionRuleId = 'code-as-harness-confirmed-repeat-cvo-interactive';

describe('CapabilityWakeupRulesRegistry (砚砚 R1 P2)', () => {
  describe('DEFAULT_CAPABILITY_WAKEUP_RULES', () => {
    it('covers L0 §8 Tier 1 capability wakeup entries (AC-F7)', () => {
      const expected = [
        'rich-messaging',
        'browser-preview',
        'image-generation',
        'workspace-navigator',
        'convention-graph-discovery',
        'pencil-design',
        'guide-interaction',
        'expert-panel',
        'propose-thread',
        'external-runtime-sessions',
        'cli-diagnostics',
        'memory-drilldown',
        'update-workflow',
      ];
      const capabilities = new Set(DEFAULT_CAPABILITY_WAKEUP_RULES.map((r) => r.capability));
      for (const capability of expected) {
        assert.ok(capabilities.has(capability), `missing ${capability}`);
      }
    });

    it('does not demand old-platform verdicts for ordinary harness work', () => {
      assert.equal(
        DEFAULT_CAPABILITY_WAKEUP_RULES.some((rule) => rule.capability === 'eval-verdict'),
        false,
      );
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

    it('routes visible Chat artifact intent to rich messaging without requiring the words 富文本', () => {
      const rule = DEFAULT_CAPABILITY_WAKEUP_RULES.find((r) => r.id === 'rich-messaging-visible-artifact-request');
      assert.ok(rule, 'missing visible artifact delivery rule');
      assert.equal(rule.predicate.type, 'text_pattern_then_capability');
      const pattern = new RegExp(rule.predicate.patterns[0], 'i');

      for (const request of ['画个 HTML 展示给我', '做一张 demo 卡给我看', '截图给我看看', 'show this in Chat']) {
        assert.equal(pattern.test(request), true, `expected visible delivery match: ${request}`);
      }
      for (const discussion of ['讨论一下 HTML 渲染原理', '修改 index.html 文件', '把 localhost 页面运行起来看']) {
        assert.equal(pattern.test(discussion), false, `must not steal non-inline route: ${discussion}`);
      }
    });

    it('keeps screenshot delivery out of external-runtime lost-session routing', () => {
      const rule = DEFAULT_CAPABILITY_WAKEUP_RULES.find((r) => r.id === 'external-runtime-sessions-lost-session');
      assert.ok(rule, 'missing external runtime sessions rule');
      assert.equal(rule.predicate.type, 'text_pattern_then_capability');
      const pattern = new RegExp(rule.predicate.patterns[0], 'i');

      assert.equal(pattern.test('截图给我看'), false);
      assert.equal(pattern.test('Antigravity 的会话丢了'), true);
    });

    it('wakes convention graph on convention-surface file changes', () => {
      const rule = DEFAULT_CAPABILITY_WAKEUP_RULES.find(
        (r) => r.id === 'convention-graph-before-convention-surface-edit',
      );
      assert.ok(rule, 'missing convention graph adoption rule');
      assert.equal(rule.capability, 'convention-graph-discovery');
      assert.equal(rule.predicate.type, 'file_change_then_capability');
      assert.ok(
        rule.predicate.includeGlobs.includes('packages/mcp-server/src/tools/*.ts'),
        'must cover extractor-backed MCP tool implementation files',
      );
      assert.ok(
        rule.predicate.includeGlobs.includes('packages/mcp-server/src/server-toolsets.ts'),
        'must cover MCP server toolset registry',
      );
      assert.ok(rule.predicate.includeGlobs.includes('cat-cafe-skills/*/SKILL.md'), 'must cover skill manifests');
    });

    it('does not wake convention graph for surfaces current extractors do not index', () => {
      const rule = DEFAULT_CAPABILITY_WAKEUP_RULES.find(
        (r) => r.id === 'convention-graph-before-convention-surface-edit',
      );
      assert.ok(rule, 'missing convention graph adoption rule');
      assert.equal(rule.predicate.type, 'file_change_then_capability');
      assert.deepEqual(
        rule.predicate.includeGlobs.filter(
          (glob) =>
            glob === 'cat-cafe-skills/manifest.yaml' ||
            glob === 'packages/mcp-server/src/tools/**' ||
            glob.startsWith('packages/api/src/routes/') ||
            glob.startsWith('packages/api/src/domains/'),
        ),
        [],
      );
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

  describe('Code-as-Harness correction route', () => {
    it('retires the rules that required a diagnostic rich block for confirmed repetition', () => {
      assert.deepEqual(getCapabilityWakeupRules({ ruleIds: [autonomousCardRuleId, cvoDecisionRuleId] }), []);
    });

    it('keeps skill and manifest aligned while leaving the generated index to its finalizer', () => {
      const skill = readFileSync(resolve(repoRoot, 'cat-cafe-skills/code-as-harness/SKILL.md'), 'utf8');
      const manifest = parseYaml(readFileSync(resolve(repoRoot, 'cat-cafe-skills/manifest.yaml'), 'utf8'));
      const manifestEntry = manifest.skills?.['code-as-harness'];
      const index = readFileSync(resolve(repoRoot, 'cat-cafe-skills/index.md'), 'utf8');
      const generator = readFileSync(resolve(repoRoot, 'scripts/docs-discovery/generate-index.mjs'), 'utf8');
      assert.ok(manifestEntry, 'missing code-as-harness manifest entry');
      assert.match(skill, /不发诊断卡/);
      assert.match(skill, /错题本那一行的编号/);
      assert.equal(manifestEntry.output, '错题本一行、按断点选的修法、退役条件');
      assert.doesNotMatch(manifestEntry.description, /kind=interactive|kind=card/);
      assert.match(index, /generated:\s*true/);
      assert.match(index, /directory:\s*cat-cafe-skills\//);
      assert.match(generator, /outputPath:\s*'cat-cafe-skills\/index\.md'/);
      assert.match(generator, /description:\s*normalizeHomeBrandText\(entry\.description/);
    });
  });
});
