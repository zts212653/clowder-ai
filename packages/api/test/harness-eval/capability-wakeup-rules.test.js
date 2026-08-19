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
import {
  buildCapabilityTrace,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-adapter.js';
import { toolEvent, transcriptEvent } from './capability-wakeup-test-helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const autonomousCardRuleId = 'code-as-harness-confirmed-repeat-autonomous-card';
const cvoDecisionRuleId = 'code-as-harness-confirmed-repeat-cvo-interactive';
const outputContractClauses = [
  '重复未确认=不强制 Rich Block',
  '重复已确认且仍需 operator 决策=kind=interactive',
  '重复已确认且无需 operator 决策=直接行动后 kind=card',
];

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

  describe('Code-as-Harness two-layer structured output contract', () => {
    it('confirmed repeat without a operator decision emits create_rich_block(kind=card)', () => {
      const block = {
        id: 'code-as-harness-autonomous-result',
        kind: 'card',
        v: 1,
        title: '重复摩擦诊断与结果',
        bodyMarkdown: '已按授权完成修复。',
        tone: 'success',
        fields: [
          { label: '根因', value: '结构化输出契约漂移' },
          { label: '证据', value: '同类问题跨两个 thread 重复出现' },
          { label: '处置/结果', value: '已修复并通过 targeted checks' },
        ],
      };
      const trace = buildCodeAsHarnessTrace({
        text: '重复已确认且无需 operator 决策，直接行动后回报结果。',
        block,
      });
      const rules = getCapabilityWakeupRules({ ruleIds: [autonomousCardRuleId] });
      assert.equal(rules.length, 1, `missing ${autonomousCardRuleId}`);
      const trials = evaluateCapabilityWakeupTrace(trace, rules);
      assert.equal(trials.length, 1);
      assert.equal(trials[0].outcome, 'negative');
      assert.deepEqual(readRichBlock(trace), block);
      assert.deepEqual(
        block.fields.map((field) => field.label),
        ['根因', '证据', '处置/结果'],
      );
    });

    it('confirmed repeat requiring a operator decision emits the interactive three-choice contract', () => {
      const block = {
        id: 'code-as-harness-cvo-decision',
        kind: 'interactive',
        v: 1,
        interactiveType: 'select',
        title: '重复摩擦诊断',
        description: '根因：契约漂移\n证据：重复出现\n建议：恢复结构化输出',
        options: [
          { id: 'agree', label: '同意，按建议执行', icon: 'check' },
          {
            id: 'disagree',
            label: '不同意',
            icon: 'cross',
            customInput: true,
            customInputPlaceholder: '请写明不同意的原因或修正方向…',
          },
          {
            id: 'other',
            label: '其他处理',
            icon: 'idea',
            customInput: true,
            customInputPlaceholder: '请写下你希望的处理方式…',
          },
        ],
        messageTemplate: '诊断决定：{selection}',
      };
      const trace = buildCodeAsHarnessTrace({
        text: '重复已确认且仍需 operator 决策，等待结构化选择。',
        block,
      });
      const rules = getCapabilityWakeupRules({ ruleIds: [cvoDecisionRuleId] });
      assert.equal(rules.length, 1, `missing ${cvoDecisionRuleId}`);
      const trials = evaluateCapabilityWakeupTrace(trace, rules);
      assert.equal(trials.length, 1);
      assert.equal(trials[0].outcome, 'negative');
      assert.deepEqual(readRichBlock(trace), block);
      assert.deepEqual(
        block.options.map((option) => option.id),
        ['agree', 'disagree', 'other'],
      );
      assert.equal(block.options[0].customInput, undefined);
      for (const option of block.options.slice(1)) {
        assert.equal(option.customInput, true);
        assert.ok(option.customInputPlaceholder);
      }
    });

    it('does not force a rich block when repetition is unconfirmed', () => {
      const trace = buildCodeAsHarnessTrace({
        text: '搜证据后未确认历史重复，按一次性问题正常处理。',
      });
      const rules = getCapabilityWakeupRules({
        ruleIds: [autonomousCardRuleId, cvoDecisionRuleId],
      });
      assert.equal(rules.length, 2, 'fixture invariant: both confirmed-repeat rules exist');
      assert.deepEqual(evaluateCapabilityWakeupTrace(trace, rules), []);
      assert.equal(findRichBlockToolUse(trace), undefined);
    });

    it('keeps skill and manifest aligned with the generated-index source contract', () => {
      const skill = readFileSync(resolve(repoRoot, 'cat-cafe-skills/code-as-harness/SKILL.md'), 'utf8');
      const manifest = parseYaml(readFileSync(resolve(repoRoot, 'cat-cafe-skills/manifest.yaml'), 'utf8'));
      const manifestEntry = manifest.skills?.['code-as-harness'];
      const index = readFileSync(resolve(repoRoot, 'cat-cafe-skills/index.md'), 'utf8');
      const generator = readFileSync(resolve(repoRoot, 'scripts/docs-discovery/generate-index.mjs'), 'utf8');
      assert.ok(manifestEntry, 'missing code-as-harness manifest entry');
      const surfaces = {
        skill,
        manifest: `${manifestEntry.description}\n${manifestEntry.output}`,
      };
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        for (const clause of outputContractClauses) {
          assert.match(surface, new RegExp(escapeRegExp(clause)), `${surfaceName} missing contract clause: ${clause}`);
        }
      }
      assert.match(index, /generated:\s*true/);
      assert.match(index, /directory:\s*cat-cafe-skills\//);
      assert.match(generator, /outputPath:\s*'cat-cafe-skills\/index\.md'/);
      assert.match(generator, /description:\s*normalizeHomeBrandText\(entry\.description/);
    });
  });
});
function buildCodeAsHarnessTrace({ text, block }) {
  const invocationId = 'inv-code-as-harness-dogfood';
  const transcriptEvents = [transcriptEvent(0, invocationId, { type: 'text', content: text })];
  const toolEvents = [];
  if (block) {
    transcriptEvents.push(
      transcriptEvent(1, invocationId, {
        type: 'tool_use',
        toolName: 'cat_cafe_create_rich_block',
        toolInput: { block: JSON.stringify(block) },
      }),
    );
    toolEvents.push(toolEvent({ invocationId, toolName: 'cat_cafe_create_rich_block' }));
  }
  return buildCapabilityTrace({
    sessionId: 'session-cap',
    threadId: 'thread-cap',
    catId: 'gpt52',
    transcriptEvents,
    toolEvents,
  });
}
function findRichBlockToolUse(trace) {
  return trace.invocations
    .flatMap((invocation) => invocation.transcriptToolUses)
    .find((toolUse) => toolUse.normalizedToolName === 'create_rich_block');
}
function readRichBlock(trace) {
  const toolUse = findRichBlockToolUse(trace);
  assert.ok(toolUse, 'missing normalized create_rich_block transcript event');
  return JSON.parse(toolUse.toolInput.block);
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
