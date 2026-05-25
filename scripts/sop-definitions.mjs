#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { buildGeneratedSopDefinitionsSource } from './lib/sop-definition-codegen.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');
const DEFAULT_OUTPUT_PATH = 'packages/shared/src/types/sop-definition.generated.ts';
const RUNTIME_DIR = 'sop-definitions';
const STUB_DIR = 'sop-definitions/stubs';
const VALID_SEVERITIES = new Set(['blocker', 'warn', 'info']);
const VALID_OWNER_TYPES = new Set(['stage_suggested_skill', 'skill']);
const VALID_PREDICATE_TYPES = new Set([
  'command_pattern',
  'command_sequence',
  'sha_dedup',
  'env_check',
  'git_state_predicate',
  'handle_check',
  'manual_only',
]);

function toCamelRule(raw, kind, stageSuggestedSkill) {
  const predicate = raw?.predicate && typeof raw.predicate === 'object' ? { ...raw.predicate } : undefined;
  if (predicate && Object.hasOwn(predicate, 'future_candidate')) {
    predicate.futureCandidate = predicate.future_candidate;
    delete predicate.future_candidate;
  }
  if (predicate && Object.hasOwn(predicate, 'must_include')) {
    predicate.mustInclude = predicate.must_include;
    delete predicate.must_include;
  }
  if (predicate && Object.hasOwn(predicate, 'must_not_include')) {
    predicate.mustNotInclude = predicate.must_not_include;
    delete predicate.must_not_include;
  }
  if (predicate && Object.hasOwn(predicate, 'must_match')) {
    predicate.mustMatch = predicate.must_match;
    delete predicate.must_match;
  }
  if (predicate && Object.hasOwn(predicate, 'must_not_match')) {
    predicate.mustNotMatch = predicate.must_not_match;
    delete predicate.must_not_match;
  }
  if (predicate && Object.hasOwn(predicate, 'anti_pattern')) {
    predicate.antiPattern = predicate.anti_pattern;
    delete predicate.anti_pattern;
  }
  if (predicate && Object.hasOwn(predicate, 'cwd_contains')) {
    predicate.cwdContains = predicate.cwd_contains;
    delete predicate.cwd_contains;
  }
  if (predicate && Object.hasOwn(predicate, 'before_command')) {
    predicate.beforeCommand = predicate.before_command;
    delete predicate.before_command;
  }

  return {
    id: raw?.id,
    kind,
    text: raw?.text,
    severity: raw?.severity ?? 'warn',
    owner: raw?.owner ?? { type: 'stage_suggested_skill', skill: stageSuggestedSkill },
    predicate,
  };
}

function normalizeDefinition(raw, sourcePath) {
  const stages = Array.isArray(raw?.stages)
    ? raw.stages.map((stage) => {
        const suggestedSkill = stage?.suggested_skill ?? stage?.suggestedSkill;
        return {
          id: stage?.id,
          label: stage?.label,
          suggestedSkill,
          hardRules: Array.isArray(stage?.hard_rules)
            ? stage.hard_rules.map((rule) => toCamelRule(rule, 'hard_rule', suggestedSkill))
            : [],
          pitfalls: Array.isArray(stage?.pitfalls)
            ? stage.pitfalls.map((rule) => toCamelRule(rule, 'pitfall', suggestedSkill))
            : [],
        };
      })
    : [];

  return {
    id: raw?.id,
    domain: raw?.domain,
    label: raw?.label,
    description: raw?.description,
    stages,
    sourcePath,
  };
}

function collectYamlFiles(dirPath) {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => join(dirPath, entry.name))
    .sort();
}

function loadDefinitionFile(repoRoot, filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = YAML.parse(raw);
  return normalizeDefinition(parsed, relative(repoRoot, filePath));
}

function requireString(value, path, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${path} must be a non-empty string`);
  }
}

function requireArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
  }
}

function validateOwner(owner, path, errors) {
  if (!owner || typeof owner !== 'object') {
    errors.push(`${path}.owner must be an object`);
    return;
  }
  if (!VALID_OWNER_TYPES.has(owner.type)) {
    errors.push(`${path}.owner.type "${owner.type}" is not supported`);
    return;
  }
  if (owner.type === 'skill') {
    requireString(owner.skill, `${path}.owner.skill`, errors);
  }
}

function hasStringOrArray(value) {
  if (typeof value === 'string' && value.trim()) return true;
  return Array.isArray(value) && value.some((entry) => typeof entry === 'string' && entry.trim());
}

function validatePredicate(predicate, path, errors) {
  if (!predicate || typeof predicate !== 'object') {
    errors.push(`${path}.predicate must be an object`);
    return;
  }
  if (!VALID_PREDICATE_TYPES.has(predicate.type)) {
    errors.push(`${path}.predicate.type "${predicate.type}" is not supported`);
    return;
  }

  switch (predicate.type) {
    case 'command_pattern':
      if (!hasStringOrArray(predicate.mustMatch) && !hasStringOrArray(predicate.mustNotMatch)) {
        errors.push(`${path}.predicate command_pattern requires must_match or must_not_match`);
      }
      break;
    case 'command_sequence':
      if (
        !hasStringOrArray(predicate.mustInclude) &&
        !hasStringOrArray(predicate.antiPattern) &&
        !hasStringOrArray(predicate.absent)
      ) {
        errors.push(`${path}.predicate command_sequence requires must_include, anti_pattern, or absent`);
      }
      break;
    case 'sha_dedup':
      requireString(predicate.scope, `${path}.predicate.scope`, errors);
      break;
    case 'env_check':
      requireString(predicate.key, `${path}.predicate.key`, errors);
      if (!hasStringOrArray(predicate.mustInclude) && !hasStringOrArray(predicate.mustNotInclude)) {
        errors.push(`${path}.predicate env_check requires must_include or must_not_include`);
      }
      break;
    case 'git_state_predicate':
      requireString(predicate.repository, `${path}.predicate.repository`, errors);
      requireArray(predicate.checks, `${path}.predicate.checks`, errors);
      break;
    case 'handle_check':
      requireString(predicate.constraint, `${path}.predicate.constraint`, errors);
      break;
    case 'manual_only':
      requireString(predicate.reason, `${path}.predicate.reason`, errors);
      break;
    default:
      break;
  }
}

export function validateSopDefinition(definition, options = {}) {
  const source = options.sourcePath ?? definition.sourcePath ?? definition.id ?? '<unknown>';
  const errors = [];
  requireString(definition.id, `${source}.id`, errors);
  requireString(definition.domain, `${source}.domain`, errors);
  requireString(definition.label, `${source}.label`, errors);
  requireString(definition.description, `${source}.description`, errors);
  requireArray(definition.stages, `${source}.stages`, errors);

  const stageIds = new Set();
  for (const [stageIndex, stage] of (definition.stages ?? []).entries()) {
    const stagePath = `${source}.stages[${stageIndex}]`;
    requireString(stage.id, `${stagePath}.id`, errors);
    requireString(stage.label, `${stagePath}.label`, errors);
    requireString(stage.suggestedSkill, `${stagePath}.suggested_skill`, errors);
    if (stageIds.has(stage.id)) errors.push(`${stagePath}.id duplicates stage id "${stage.id}"`);
    stageIds.add(stage.id);

    for (const [ruleIndex, rule] of [...(stage.hardRules ?? []), ...(stage.pitfalls ?? [])].entries()) {
      const rulePath = `${stagePath}.rules[${ruleIndex}]`;
      requireString(rule.id, `${rulePath}.id`, errors);
      requireString(rule.text, `${rulePath}.text`, errors);
      if (!['hard_rule', 'pitfall'].includes(rule.kind)) {
        errors.push(`${rulePath}.kind must be hard_rule or pitfall`);
      }
      if (!VALID_SEVERITIES.has(rule.severity)) {
        errors.push(`${rulePath}.severity "${rule.severity}" must be blocker, warn, or info`);
      }
      validateOwner(rule.owner, rulePath, errors);
      validatePredicate(rule.predicate, rulePath, errors);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid SOP definition ${source}:\n- ${errors.join('\n- ')}`);
  }
  return definition;
}

export function loadSopDefinitionCatalog(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
  const runtimeDir = join(repoRoot, RUNTIME_DIR);
  const stubDir = join(repoRoot, STUB_DIR);

  const runtimeDefinitions = collectYamlFiles(runtimeDir).map((filePath) =>
    validateSopDefinition(loadDefinitionFile(repoRoot, filePath)),
  );
  const stubDefinitions = collectYamlFiles(stubDir).map((filePath) =>
    validateSopDefinition(loadDefinitionFile(repoRoot, filePath)),
  );

  const seen = new Set();
  for (const definition of [...runtimeDefinitions, ...stubDefinitions]) {
    if (seen.has(definition.id)) {
      throw new Error(`Duplicate SOP definition id: ${definition.id}`);
    }
    seen.add(definition.id);
  }

  return { repoRoot, runtimeDefinitions, stubDefinitions };
}

function parseArgs(argv) {
  const options = { check: false, repoRoot: defaultRepoRoot, outputPath: DEFAULT_OUTPUT_PATH };
  for (const arg of argv) {
    if (arg === '--check') {
      options.check = true;
    } else if (arg.startsWith('--repo-root=')) {
      options.repoRoot = resolve(arg.slice('--repo-root='.length));
    } else if (arg.startsWith('--output=')) {
      options.outputPath = arg.slice('--output='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = loadSopDefinitionCatalog({ repoRoot: options.repoRoot });
  const generated = buildGeneratedSopDefinitionsSource(catalog.runtimeDefinitions);
  const outputPath = resolve(options.repoRoot, options.outputPath);

  if (options.check) {
    const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf-8') : '';
    if (current !== generated) {
      console.error(`FAIL sop-definitions: ${relative(options.repoRoot, outputPath)} is stale.`);
      console.error('Run: pnpm gen:sop-definitions');
      process.exit(1);
    }
    console.log(
      `PASS sop-definitions: runtime=${catalog.runtimeDefinitions.length} stubs=${catalog.stubDefinitions.length}`,
    );
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, generated, 'utf-8');
  console.log(`Generated ${relative(options.repoRoot, outputPath)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL sop-definitions: ${message}`);
    process.exit(1);
  }
}
