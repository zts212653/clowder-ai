import { executedInvocations } from './lib/shell-invocation.mjs';
import { isExactNonRecursiveCopy } from './native-effect-media-classifier.mjs';
import { segmentCommandText } from './native-effect-segment-locations.mjs';
import { classifyShellSegment, splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { isShellBinding } from './native-effect-shell-expansion.mjs';

// These programs may create, truncate, or remove ordinary nodes, but cannot
// create a symlink/hard link or move an existing alias onto a later target.
const TOPOLOGY_PRESERVING_WRITES = new Set([
  'echo',
  'mkdir',
  'printf',
  'rm',
  'rmdir',
  'tee',
  'touch',
  'trash',
  'unlink',
]);
const FIXED_SHELL_OPERATIONS = new Set([':', 'false', 'true']);

/** Whether the physical copy-target observations remain valid before each unit. */
export function copyNamespaceStability(units, initial = true) {
  let stable = initial;
  return units.map(({ segment }) => {
    const before = stable;
    stable &&= segmentPreservesCopyNamespace(segment);
    return before;
  });
}

/** Fold every executed segment, including a substitution body, into one stability fact. */
export function shellTextPreservesCopyNamespace(raw) {
  const parts = splitShellExecutionSegmentsWithSeparators(raw);
  if (parts.length === 0) return raw.trim() === '';
  return parts.every(({ text }) => segmentPreservesCopyNamespace(segmentCommandText(text)));
}

export function segmentPreservesCopyNamespace(segment) {
  if (!segment.trim()) return true;
  if (isShellBinding(segment)) return false;
  const reader = executedInvocations(segment);
  if (!reader.complete || reader.unresolvedEvidence?.length) return false;
  const calls = reader.pipelines.flat();
  return calls.length > 0 && calls.every(invocationPreservesCopyNamespace);
}

function invocationPreservesCopyNamespace(call) {
  if (
    !call.name ||
    call.generatedCode ||
    call.delegated ||
    call.unprovedCodeEvidence?.length ||
    call.environment?.length ||
    call.wrappers?.length
  )
    return false;
  if (call.name === 'printf' && call.operands[0]?.startsWith('-v')) return false;
  if (call.name === 'cp') return isExactNonRecursiveCopy(call.text);
  if (TOPOLOGY_PRESERVING_WRITES.has(call.name) || FIXED_SHELL_OPERATIONS.has(call.name)) return true;
  return classifyShellSegment(call.argvEvidence ?? call.text) === 'read';
}
