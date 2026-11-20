import { executedInvocations } from './lib/shell-invocation.mjs';
import { leadingShellControl, nativeBuiltinContext } from './lib/shell-program-tokens.mjs';
import { extractSubstitutions } from './lib/shell-text.mjs';
import { isShellStructure, segmentCommandText } from './native-effect-segment-locations.mjs';
import { classifyShellSegment, splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { isLocalProgramBinding, isShellBinding } from './native-effect-shell-expansion.mjs';

/** Whether the physical copy-target observations remain valid before each unit. */
export function copyNamespaceStability(units, initial = true, programContexts = [], concurrent = false) {
  let stable = initial;
  const beforeEach = units.map(({ segment }, index) => {
    const before = stable;
    stable &&= segmentPreservesCopyNamespace(segment, programContexts[index] ?? false);
    return before;
  });
  return concurrent && !stable ? beforeEach.fill(false) : beforeEach;
}

function unitPreservesProgramNamespace(segment, stable) {
  if (isShellStructure(segment)) return true;
  if (/^\s*(?:(?:do|then|else|elif)\s+)*(?:function\b|[A-Za-z_]\w*\s*\(\s*\))/.test(segment)) return false;
  const control = leadingShellControl(segment);
  if (control === 'for') return isLocalProgramBinding(segment);
  if (control && !['do', 'then', 'else', 'elif'].includes(control)) return false;
  const command = segmentCommandText(segment);
  return (
    isLocalProgramBinding(command) ||
    (!isShellBinding(command) &&
      (!command.trim() ||
        (classifyShellSegment(command, { builtinContext: stable }) === 'read' &&
          segmentPreservesCopyNamespace(command, stable))))
  );
}

/** Filesystem topology and command environment are separate observations. */
export function programNamespaceStability(units, initial = true) {
  let stable = nativeBuiltinContext(initial);
  const firstLoopIndex = units.findIndex(({ segment }) =>
    ['for', 'while', 'until'].includes(leadingShellControl(segment)),
  );
  if (firstLoopIndex >= 0) {
    let loopStable = stable;
    for (let i = firstLoopIndex; i < units.length; i++) {
      loopStable &&= unitPreservesProgramNamespace(units[i].segment, loopStable);
    }
    if (!loopStable) {
      return units.map(({ segment }, index) => {
        if (index >= firstLoopIndex) return false;
        const before = stable;
        stable &&= unitPreservesProgramNamespace(segment, stable);
        return before;
      });
    }
  }
  return units.map(({ segment }) => {
    const before = stable;
    stable &&= unitPreservesProgramNamespace(segment, stable);
    return before;
  });
}

/** Fold every executed segment, including a substitution body, into one stability fact. */
export function shellTextPreservesCopyNamespace(raw, builtinContext = false) {
  const parts = splitShellExecutionSegmentsWithSeparators(raw);
  if (parts.length === 0) return raw.trim() === '';
  const contexts = programNamespaceStability(
    parts.map(({ text }) => ({ segment: text })),
    builtinContext,
  );
  return parts.every(({ text }, index) => segmentPreservesCopyNamespace(segmentCommandText(text), contexts[index]));
}

export function segmentPreservesCopyNamespace(segment, builtinContext = false) {
  const { inner } = extractSubstitutions(segment);
  return [segment, ...inner].every(
    (text) => !executedInvocations(text, { builtinContext }).pipelines.flat().some(changesCopyNamespace),
  );
}

function changesCopyNamespace(call) {
  if (call.lookupOnly) return false;
  if (call.name === 'ln' || call.name === 'mv') return true;
  if (call.name !== 'cp') return false;
  const operands = call.programOperands ?? call.operands;
  const separator = operands.indexOf('--');
  return operands
    .slice(0, separator < 0 ? undefined : separator)
    .some((word) => word === '--link' || word === '--symbolic-link' || /^-[^-]*[ls]/.test(word));
}
