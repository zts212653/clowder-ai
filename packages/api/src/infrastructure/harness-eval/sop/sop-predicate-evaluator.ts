/**
 * F192 E-sop AC-E18: Predicate Evaluator.
 *
 * Evaluates SopDefinition predicates against a SopTrace.
 * Predicate-specific mechanics live in focused modules; this file remains the
 * public dispatcher and compatibility export surface.
 */

import { evaluateChangedFilesRequireCommand } from './sop-changed-files-require-command.js';
import { evaluateCoCreationDocsLane } from './sop-co-creation-docs-lane.js';
import { evaluateCommandPattern, evaluateCommandSequence } from './sop-command-predicates.js';
import type {
  RuleOwner,
  SopDefinitionInput,
  SopEvalResult,
  SopPredicate,
  SopRuleKind,
  SopSeverity,
} from './sop-predicate-types.js';
import { evaluateEnvCheck, evaluateGitState, evaluateHandleCheck, evaluateShaDedup } from './sop-state-predicates.js';
import type { SopTrace } from './sop-trace-adapter.js';

export type {
  PredicateChangedFilesRequireCommand,
  PredicateCoCreationDocsLane,
  PredicateCommandPattern,
  PredicateCommandSequence,
  PredicateEnvCheck,
  PredicateGitState,
  PredicateHandleCheck,
  PredicateManualOnly,
  PredicateShaDedup,
  RuleOwner,
  SopDefinitionInput,
  SopEvalResult,
  SopPredicate,
  SopRuleInput,
  SopStageInput,
  SopViolation,
} from './sop-predicate-types.js';

export function evaluatePredicate(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicate: SopPredicate,
  trace: SopTrace,
  owner?: RuleOwner,
): SopEvalResult {
  let result: SopEvalResult;
  switch (predicate.type) {
    case 'manual_only':
      return { ruleId, status: 'skipped', reason: predicate.reason };
    case 'changed_files_require_command':
      result = evaluateChangedFilesRequireCommand(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'co_creation_docs_lane':
      result = evaluateCoCreationDocsLane(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'command_pattern':
      result = evaluateCommandPattern(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'command_sequence':
      result = evaluateCommandSequence(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'sha_dedup':
      result = evaluateShaDedup(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'env_check':
      result = evaluateEnvCheck(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'git_state_predicate':
      result = evaluateGitState(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'handle_check':
      result = evaluateHandleCheck(ruleId, stageId, kind, severity, predicate, trace);
      break;
    default:
      return { ruleId, status: 'skipped', reason: `unknown predicate type: ${(predicate as { type: string }).type}` };
  }

  if (result.violation && owner) {
    return { ...result, violation: { ...result.violation, owner } };
  }
  return result;
}

export function evaluateSopDefinition(definition: SopDefinitionInput, trace: SopTrace): SopEvalResult[] {
  const results: SopEvalResult[] = [];

  for (const stage of definition.stages) {
    const allRules = [...stage.hardRules, ...stage.pitfalls];
    for (const rule of allRules) {
      results.push(evaluatePredicate(rule.id, stage.id, rule.kind, rule.severity, rule.predicate, trace, rule.owner));
    }
  }

  return results;
}
