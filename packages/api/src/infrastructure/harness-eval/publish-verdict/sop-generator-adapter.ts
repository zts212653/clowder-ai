/**
 * F192 sop-wiring: SOP verdict generator adapter.
 *
 * Mirrors task-outcome-generator-adapter.ts pattern:
 *   1. Validate sourceRefs is sop-trace-eval kind
 *   2. Build SopTrace from selector's trace data
 *   3. Load SOP definition from shared catalog
 *   4. Run evaluateSopDefinition → SopEvalResult[]
 *   5. Call generateSopLiveVerdict → writes bundle + verdict.md
 *   6. Return verdictPath + bundleDir + extraStagedPaths
 */

import { getSopDefinition, isSopDefinitionId } from '@cat-cafe/shared';
import { generateSopLiveVerdict } from '../sop/eval-sop-live-verdict.js';
import { evaluateSopDefinition } from '../sop/sop-predicate-evaluator.js';
import { buildSopTrace } from '../sop/sop-trace-adapter.js';
import type { SopTraceSourceSelector, VerdictGenerator } from './types.js';
import { isSopSourceRefs } from './validation.js';

export function createSopGeneratorAdapter(): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    if (!isSopSourceRefs(sourceRefs)) {
      const kind = (sourceRefs as { kind?: string }).kind;
      throw new Error(
        `sop_adapter_wrong_kind: received sourceRefs with kind='${kind ?? '(omitted)'}'; expected 'sop-trace-eval'`,
      );
    }

    const selector = sourceRefs as SopTraceSourceSelector;

    // Validate SOP definition exists in catalog
    if (!isSopDefinitionId(selector.sopDefinitionId)) {
      throw new Error(
        `sop_adapter_unknown_definition: sopDefinitionId '${selector.sopDefinitionId}' not found in SOP catalog`,
      );
    }

    // Build trace from selector data (validates via Zod schema)
    const trace = buildSopTrace({
      ...selector.trace,
      sopDefinitionId: selector.sopDefinitionId,
    });

    // Load SOP definition and evaluate
    const sopDefinition = getSopDefinition(selector.sopDefinitionId);
    const evalResults = evaluateSopDefinition(sopDefinition, trace);

    // Generate live verdict artifacts (file-writer)
    const artifact = generateSopLiveVerdict({
      verdictId: packet.id,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      trace,
      evalResults,
      submittedPacket: packet,
    });

    return {
      verdictPath: artifact.path,
      bundleDir: artifact.bundleDir,
      extraStagedPaths: [artifact.rawInputDir],
    };
  };
}
