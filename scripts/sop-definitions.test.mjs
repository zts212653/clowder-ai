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

// Rule IDs bind runtime evidence and must survive copy edits. Text comes from the
// canonical YAML and is checked by the generated-surface round trip below.
const EXPECTED_PORTED_RULE_IDS = [
  'kickoff-ac-checklist',
  'kickoff-no-unconfirmed-implementation',
  'impl-main-sync-before-worktree',
  'impl-redis-6398-only',
  'impl-risk-route-before-action',
  'impl-user-journey-missing',
  'impl-co-creation-docs-lane',
  'impl-design-gate-evidence',
  'impl-post-compact-recall-loss',
  'impl-convention-graph-before-convention-edit',
  'quality-gate-vision-coverage',
  'quality-gate-confirmed-test-value',
  'quality-gate-risk-matched-evidence',
  'fresh-context-not-approval',
  'review-no-self-review',
  'review-original-requirements',
  'review-retrigger-after-p1',
  'merge-github-squash-only',
  'merge-cloud-review-sha-dedup',
  'merge-feature-doc-truth',
  'merge-runtime-activation-truth',
  'merge-local-squash-close',
  'merge-runtime-update-after-merge',
  'completion-vision-guardian',
  'completion-pr-merged-feature-check',
  'completion-missing-guardian-handoff',
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
  'design_gate_evidence',
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

  it('preserves development rule identities and their evidence predicates', () => {
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
    assert.deepEqual(
      rules.map((rule) => rule.id),
      EXPECTED_PORTED_RULE_IDS,
    );

    for (const rule of rules) {
      assert.ok(rule.id, `rule missing id: ${rule.text}`);
      assert.ok(['blocker', 'warn', 'info'].includes(rule.severity), `invalid severity: ${rule.text}`);
      assert.ok(rule.predicate, `rule missing predicate: ${rule.text}`);
      assert.ok(EXPECTED_PREDICATE_TYPES.has(rule.predicate.type), `invalid predicate type: ${rule.text}`);
    }

    const testValueRule = rules.find((rule) => rule.id === 'quality-gate-confirmed-test-value');
    assert.equal(testValueRule?.predicate.type, 'manual_only', 'command success cannot certify test detection power');

    const compressionPitfall = rules.find((rule) => rule.id === 'impl-post-compact-recall-loss');
    assert.equal(compressionPitfall?.predicate.type, 'manual_only');
    assert.equal(compressionPitfall?.predicate.futureCandidate, 'trace_pattern_post_compact_recall');

    const runtimePitfall = rules.find((rule) => rule.id === 'merge-runtime-update-after-merge');
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

    const designGateRule = rules.find((rule) => rule.id === 'impl-design-gate-evidence');
    assert.equal(designGateRule?.predicate.type, 'design_gate_evidence');
    assert.ok(designGateRule?.predicate.consumerGlobs?.includes('packages/*/src/routes/**/*.ts'));
    assert.match(designGateRule?.predicate.canonicalHelperPattern ?? '', /ownership/);
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

  it('rejects design-gate predicates that disable their own admission surface', () => {
    const { runtimeDefinitions } = loadSopDefinitionCatalog();
    const emptyGlobs = structuredClone(runtimeDefinitions[0]);
    const emptyRule = emptyGlobs.stages
      .flatMap((stage) => [...stage.hardRules, ...stage.pitfalls])
      .find((rule) => rule.id === 'impl-design-gate-evidence');
    emptyRule.predicate.consumerGlobs = [];

    assert.throws(
      () => validateSopDefinition(emptyGlobs, { sourcePath: 'inline-empty-design-gate.yaml' }),
      /non-empty consumer_globs/,
    );

    const invalidPattern = structuredClone(runtimeDefinitions[0]);
    const invalidRule = invalidPattern.stages
      .flatMap((stage) => [...stage.hardRules, ...stage.pitfalls])
      .find((rule) => rule.id === 'impl-design-gate-evidence');
    invalidRule.predicate.canonicalHelperPattern = '(';

    assert.throws(
      () => validateSopDefinition(invalidPattern, { sourcePath: 'inline-invalid-design-gate.yaml' }),
      /valid regular expression/,
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
