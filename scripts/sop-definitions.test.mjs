import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildGeneratedSopDefinitionsSource } from './lib/sop-definition-codegen.mjs';
import { loadSopDefinitionCatalog, validateSopDefinition } from './sop-definitions.mjs';

const EXPECTED_DEVELOPMENT_STAGES = ['kickoff', 'impl', 'quality_gate', 'review', 'merge', 'completion'];

const EXPECTED_PORTED_RULE_TEXTS = [
  'Feature spec 必须有 AC + 需求点 checklist',
  '没有铲屎官确认就直接开始实现',
  'worktree 开之前必须 main 双向同步 (ahead=0 behind=0)',
  'Redis 只用 6398，禁碰 6399',
  '跳过 Design Gate 直接写代码',
  '压缩后忘了当前在做什么',
  '自检报告必须包含愿景覆盖度',
  '声称完成但没跑全量测试',
  '同一个体不能 review 自己的代码',
  'Review 请求必须附原始需求摘录',
  '收到 P1 修完后没 re-trigger review',
  '必须用 gh pr merge --squash（禁止本地 squash）',
  '云端 review 同一 SHA 不重复触发',
  '本地 squash + push + gh pr close（PR 显示 closed 不是 merged）',
  '合入后擅自更新 runtime',
  'feat close 前必须跨猫愿景守护',
  'PR merged + check:features 通过',
  '没有 @ 其他猫做愿景守护就直接 close',
];

const EXPECTED_PREDICATE_TYPES = new Set([
  'command_pattern',
  'command_sequence',
  'sha_dedup',
  'env_check',
  'git_state_predicate',
  'handle_check',
  'manual_only',
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

  it('ports all 18 manifest sop_navigation rules into development.yaml with predicates', () => {
    const { runtimeDefinitions } = loadSopDefinitionCatalog();
    const development = runtimeDefinitions[0];

    assert.equal(development.id, 'development');
    assert.equal(development.domain, 'engineering');
    assert.deepEqual(
      development.stages.map((stage) => stage.id),
      EXPECTED_DEVELOPMENT_STAGES,
    );
    assert.equal(development.stages.find((stage) => stage.id === 'impl')?.suggestedSkill, 'writing-plans');

    const rules = development.stages.flatMap((stage) => [...stage.hardRules, ...stage.pitfalls]);
    assert.equal(rules.length, 18);
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
    assert.match(generated, /impl[\s\S]*suggestedSkill: 'writing-plans'/);
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
