import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CO_CREATION_DOC_INCLUDE_GLOBS } from './co-creation-docs-lane.mjs';
import { buildGeneratedSopDefinitionsSource } from './lib/sop-definition-codegen.mjs';
import { loadSopDefinitionCatalog, validateSopDefinition } from './sop-definitions.mjs';

const EXPECTED_DEVELOPMENT_STAGES = [
  'kickoff',
  'impl',
  'quality_gate',
  'fresh_context',
  'review',
  'merge',
  'completion',
];

const EXPECTED_PORTED_RULE_TEXTS = [
  'Feature spec 必须有 AC + 需求点 checklist',
  '没有co-creator确认就直接开始实现',
  'worktree 开之前必须 main 双向同步 (ahead=0 behind=0)',
  'Redis 只用 6398，禁碰 6399',
  '实现前未按行为面 / 数据 / 安全 / 契约 / 不可逆五轴判断风险，就机械套用或机械跳过流程',
  '用户可感知 Feature 缺 User Journey 段（或 user_journey_exempt）',
  '共创型 docs-only 可自决直推；进入 worktree / PR / cloud / full gate 前才必须用 classifier 证明风险，且不得越过结果支付代码级流程税',
  '压缩后忘了当前在做什么',
  '改 MCP tool / skill manifest 等当前已索引约定面前，先用 convention graph 查影响面；stale=true 先 reindex',
  '自检报告必须包含愿景覆盖度',
  '声称完成但没有与风险面匹配的验证证据（至少 targeted；高风险才要求 full gate）',
  'Fresh-context 是 finding generator，不是 approval authority——不产出 verdict，不记入 Review Provenance Matrix',
  '同一个体不能 review 自己的代码',
  '涉及用户意图或愿景的 Review 请求必须附原始需求摘录',
  'ChatGPT 提交代码进入专属多猫 Review round；至少两只非作者猫先独立检视，全部完成前不得互看意见',
  'ChatGPT Review 的独立检视与交叉检视阶段只读；任何猫不得 commit、push、rebase 或修改共享分支',
  '全部独立检视完成后才进入交叉检视；争议必须基于证据收敛，价值分歧交给co-creator',
  '每轮只有co-creator指定的记录猫可以将共识 ledger 提交并推送到 Git；写回成功才算本轮结束',
  'ChatGPT 按 ledger 修复后提交新 code HEAD 并开始下一轮；最新轮 open findings 非零不得合入',
  'P1/P2 修复后的实质内容未被对应 review source 覆盖；SHA-only / 可证明机械变化用 continuityProof，不重开 reviewer',
  '必须用 gh pr merge --squash（禁止本地 squash）',
  'ChatGPT 仅在最新共识 ledger 为 approved_for_merge、openFindings=0 且风险门禁全绿时合入 main；合入后等待co-creator亲自验收',
  '云端 review 同一 SHA 不重复触发',
  'merge 前核对 feature doc 是否说真话（Status/AC/Phase vs 代码现实），merge 后记录已合入状态',
  '触及 runtime 加载面的 PR 合入后必须分开声明 main 与 live runtime 状态；未获co-creator授权时记录 live=dormant，不得冒充已生效',
  '本地 squash + push + gh pr close（PR 显示 closed 不是 merged）',
  '合入后擅自更新 runtime',
  '用户可见或愿景变化的 feat close 前必须有独立愿景守护',
  'PR merged + check:features 通过',
  '用户可见或愿景变化的 feat 没有 @ 独立守护猫就直接 close',
];

const EXPECTED_PREDICATE_TYPES = new Set([
  'changed_files_require_command',
  'command_pattern',
  'command_sequence',
  'sha_dedup',
  'env_check',
  'git_state_predicate',
  'handle_check',
  'manual_only',
  'co_creation_docs_lane',
]);

describe('SOP definition catalog', () => {
  it('loads development as the only runtime definition and keeps stubs schema-only', () => {
    const catalog = loadSopDefinitionCatalog();

    assert.deepEqual(
      catalog.runtimeDefinitions.map((definition) => definition.id),
      ['development'],
    );
    assert.ok(
      catalog.stubDefinitions.map((definition) => definition.id).includes('video-cocreation'),
      'video-cocreation stub should validate without entering runtime codegen',
    );
  });

  it('ports all 30 development SOP rules into development.yaml with predicates', () => {
    const { runtimeDefinitions } = loadSopDefinitionCatalog();
    const development = runtimeDefinitions[0];

    assert.equal(development.id, 'development');
    assert.equal(development.domain, 'engineering');
    assert.deepEqual(
      development.stages.map((stage) => stage.id),
      EXPECTED_DEVELOPMENT_STAGES,
    );
    assert.match(development.description, /Risk-routed development lane catalog/);
    assert.equal(development.stages.find((stage) => stage.id === 'impl')?.suggestedSkill, 'worktree');

    const rules = development.stages.flatMap((stage) => [...stage.hardRules, ...stage.pitfalls]);
    assert.equal(rules.length, 30);
    assert.deepEqual(
      rules.map((rule) => rule.text),
      EXPECTED_PORTED_RULE_TEXTS,
    );

    for (const rule of rules) {
      assert.ok(rule.id, `rule missing id: ${rule.text}`);
      assert.ok(['blocker', 'warn', 'info'].includes(rule.severity), `invalid severity: ${rule.text}`);
      assert.ok(rule.predicate, `rule missing predicate: ${rule.text}`);
      assert.ok(EXPECTED_PREDICATE_TYPES.has(rule.predicate.type), `invalid predicate type: ${rule.text}`);
    }

    const compressionPitfall = rules.find((rule) => rule.text === '压缩后忘了当前在做什么');
    assert.equal(compressionPitfall?.predicate.type, 'manual_only');
    assert.equal(compressionPitfall?.predicate.futureCandidate, 'trace_pattern_post_compact_recall');

    const runtimePitfall = rules.find((rule) => rule.text === '合入后擅自更新 runtime');
    assert.equal(runtimePitfall?.predicate.type, 'command_sequence');

    const runtimeActivationRule = rules.find((rule) => rule.id === 'merge-runtime-activation-truth');
    assert.equal(runtimeActivationRule?.predicate.type, 'manual_only');
    assert.equal(runtimeActivationRule?.predicate.futureCandidate, 'runtime_activation_receipt');

    const conventionGraphPitfall = rules.find((rule) => rule.id === 'impl-convention-graph-before-convention-edit');
    assert.equal(conventionGraphPitfall?.predicate.type, 'changed_files_require_command');
    assert.ok(
      conventionGraphPitfall?.predicate.includeGlobs?.includes('packages/mcp-server/src/tools/*.ts'),
      'F242 gate should cover extractor-backed MCP tool surfaces',
    );
    assert.ok(
      conventionGraphPitfall?.predicate.includeGlobs?.includes('packages/mcp-server/src/server-toolsets.ts'),
      'F242 gate should cover MCP server toolset registry',
    );
    assert.deepEqual(
      conventionGraphPitfall?.predicate.includeGlobs?.filter(
        (glob) =>
          glob === 'cat-cafe-skills/manifest.yaml' ||
          glob === 'packages/mcp-server/src/tools/**' ||
          glob.startsWith('packages/api/src/routes/') ||
          glob.startsWith('packages/api/src/domains/'),
      ),
      [],
      'F242 gate must not require graph evidence for surfaces current extractors do not index',
    );
    assert.match(conventionGraphPitfall?.predicate.mustMatch ?? '', /convention-graph:code-consumers/);

    const coCreationDocsRule = rules.find((rule) => rule.id === 'impl-co-creation-docs-lane');
    assert.equal(coCreationDocsRule?.predicate.type, 'co_creation_docs_lane');
    assert.deepEqual(coCreationDocsRule?.predicate.includeGlobs, CO_CREATION_DOC_INCLUDE_GLOBS);
    assert.ok(coCreationDocsRule?.predicate.classifierRequiredGlobs?.includes('docs/SOP.md'));
    assert.ok(coCreationDocsRule?.predicate.classifierRequiredGlobs?.includes('docs/decisions/**'));
    assert.deepEqual(coCreationDocsRule?.owner, { type: 'skill', skill: 'co-creation-docs' });
  });

  it('rejects invalid owner and predicate shapes loudly', () => {
    const { runtimeDefinitions } = loadSopDefinitionCatalog();
    const invalid = structuredClone(runtimeDefinitions[0]);
    invalid.stages[0].hardRules[0].owner = { type: 'feature_owner' };
    invalid.stages[0].hardRules[0].predicate = { type: 'command_pattern' };

    assert.throws(
      () => validateSopDefinition(invalid, { sourcePath: 'inline-invalid.yaml', includeRuntimeOnlyRules: true }),
      /owner.*feature_owner|predicate.*command/i,
    );
  });

  it('generates a stable runtime TypeScript surface from runtime definitions only', () => {
    const catalog = loadSopDefinitionCatalog();
    const generated = buildGeneratedSopDefinitionsSource(catalog.runtimeDefinitions);

    assert.match(generated, /export const SOP_DEFINITION_IDS = \['development'\] as const;/);
    assert.match(generated, /export type SopDefinitionId = \(typeof SOP_DEFINITION_IDS\)\[number\];/);
    assert.match(generated, /export type DevelopmentSopStageId = \(typeof DEVELOPMENT_SOP_STAGE_IDS\)\[number\];/);
    assert.match(generated, /impl[\s\S]*suggestedSkill: 'worktree'/);
    assert.doesNotMatch(generated, /video-cocreation/);
  });

  it('derives the default SOP definition id from the generated runtime catalog', () => {
    const catalog = loadSopDefinitionCatalog();
    const runtimeOnly = structuredClone(catalog.runtimeDefinitions[0]);
    runtimeOnly.id = 'family-office';

    const generated = buildGeneratedSopDefinitionsSource([runtimeOnly]);

    assert.match(generated, /export const SOP_DEFINITION_IDS = \['family-office'\] as const;/);
    assert.match(generated, /export const DEFAULT_SOP_DEFINITION_ID = SOP_DEFINITION_IDS\[0\];/);
    assert.match(generated, /return value && isSopDefinitionId\(value\) \? value : DEFAULT_SOP_DEFINITION_ID;/);
    assert.doesNotMatch(generated, /return value && isSopDefinitionId\(value\) \? value : 'development';/);
  });

  it('quotes generated SOP_DEFINITIONS keys for hyphenated runtime ids', () => {
    const catalog = loadSopDefinitionCatalog();
    const hyphenated = structuredClone(catalog.runtimeDefinitions[0]);
    hyphenated.id = 'video-cocreation';

    const generated = buildGeneratedSopDefinitionsSource([hyphenated]);

    assert.match(generated, /'video-cocreation': VIDEO_COCREATION_SOP_DEFINITION/);
    assert.doesNotMatch(generated, /^\s+video-cocreation:/m);
  });

  it('keeps the checked-in generated file in sync', () => {
    const catalog = loadSopDefinitionCatalog();
    const expected = buildGeneratedSopDefinitionsSource(catalog.runtimeDefinitions);
    const actual = readFileSync('packages/shared/src/types/sop-definition.generated.ts', 'utf-8');

    assert.equal(actual, expected);
  });
});
