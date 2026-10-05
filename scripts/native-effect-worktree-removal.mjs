import { isAbsolute, resolve } from 'node:path';
import {
  gitInvocationArguments,
  isTemporaryWorktreePath,
  isWorktreeRemoval,
  worktreeRemovalOperand,
} from './lib/git-invocation.mjs';
import { kernelPath, unfoldedJoin } from './lib/shell-directory.mjs';
import { executedInvocations } from './lib/shell-invocation.mjs';
import { extractSubstitutions } from './lib/shell-text.mjs';
import { worktreeRemoveCandidate } from './native-effect-git-context.mjs';
import { decideNativeEffect, deny } from './native-effect-policy.mjs';
import { isShellStructure, segmentCommandText, segmentContexts } from './native-effect-segment-locations.mjs';
import { splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { expandSegmentBindings } from './native-effect-shell-expansion.mjs';
import { shellInvocation } from './native-effect-shell-tokenizer.mjs';
import { classifyNativeTarget } from './native-effect-target-classifier.mjs';

/** Known removals cannot lose their target through wrappers, selectors or nested shells. */
export function worktreeRemovalDecision(segment, cwd, source, argvPreserved) {
  const inspected = inspectSegment(segment, cwd, 0);
  const decisions = inspected.candidates.map((candidate) =>
    candidate.unresolved
      ? deny({ ...candidate, source }, 'unresolved_worktree_removal')
      : decideNativeEffect({ ...candidate, source }),
  );
  const denied = decisions.find((decision) => decision.decision === 'deny');
  if (denied) return denied;
  // An exact standalone removal can name its own target. Otherwise its safe
  // result never suppresses redirections, generated code, or other effects.
  return argvPreserved && inspected.exact ? decisions[0] : null;
}

function inspectSegment(segment, cwd, depth, origin = segment) {
  const reader = executedInvocations(segment, { cwd });
  if (depth > 8) return { candidates: recognizedRemovals(reader).map(unresolvedRemoval), exact: false };
  const substitutions = extractSubstitutions(segment);
  const candidates = substitutions.inner.flatMap((script) => scriptRemovals(script, cwd, depth + 1));
  const calls = reader.directInvocations;
  candidates.push(
    ...calls.flatMap((call) => inspectCall(call, reader, substitutions.inner.length > 0, cwd, depth, origin)),
  );
  // Source identity only matches already-recognized execution sites. It never
  // discovers a command from prose. A parameter-resolved child that our path
  // walk could not attest must not silently disappear from the decision.
  const covered = new Set(candidates.map((candidate) => candidate.origin));
  const direct = new Set(calls);
  for (const call of recognizedRemovals(reader)) {
    if (!direct.has(call) && !covered.has(segmentCommandText(call.text)))
      candidates.push({ ...unresolvedRemoval(), origin: segmentCommandText(call.text) });
  }
  const exact =
    reader.complete &&
    calls.length === 1 &&
    calls[0].name === 'git' &&
    candidates.length === 1 &&
    substitutions.inner.length === 0 &&
    shellInvocation(segment).redirections.length === 0;
  return { candidates, exact };
}

function inspectCall(call, reader, hasSubstitutions, cwd, depth, origin) {
  const location = resolveDirectories(cwd, call.directoryOperands);
  if (call.name === 'git') {
    const parsed = gitInvocationArguments(call.operands);
    return isWorktreeRemoval(parsed.args) ? [{ ...removalCandidate(call, parsed, location), origin }] : [];
  }
  if (call.script !== undefined) {
    const directory = call.coordinateKnown ? location?.unfolded : undefined;
    return scriptRemovals(call.script, directory, depth + 1);
  }
  // Delegated argv may be recognized without a provable execution directory.
  return hasSubstitutions ? [] : recognizedRemovals(reader).map(unresolvedRemoval);
}

/** Each nested script gets its own shell path/variable walk, never the reader's outer cwd. */
function scriptRemovals(script, cwd, depth) {
  const parts = splitShellExecutionSegmentsWithSeparators(script);
  const contexts = segmentContexts(parts, cwd);
  return parts.flatMap((part, index) => {
    if (isShellStructure(part.text)) return [];
    const segment = segmentCommandText(part.text);
    return contexts[index].flatMap(({ directory, bindings }) =>
      expandSegmentBindings(segment, bindings).flatMap(
        ({ text }) => inspectSegment(text, directory, depth, segment).candidates,
      ),
    );
  });
}

function recognizedRemovals(reader) {
  return reader.pipelines
    .flat()
    .filter((call) => call.name === 'git' && isWorktreeRemoval(gitInvocationArguments(call.operands).args));
}

function removalCandidate(call, parsed, wrapperLocation) {
  const operand = worktreeRemovalOperand(parsed.args);
  if (!call.argvComplete || !call.coordinateKnown || !parsed.coordinateKnown || !wrapperLocation || operand === null)
    return unresolvedRemoval();
  const location = resolveDirectories(wrapperLocation.unfolded, parsed.directories, wrapperLocation.lexical);
  if (!location) return unresolvedRemoval();
  const candidate = worktreeRemoveCandidate(operand, { directories: [location.physical] });
  if (candidate && candidate.target.kind !== 'ordinary') return candidate;
  const runtime = [location.lexical, location.physical].find((path) => targetKind(path) === 'runtime_sanctuary');
  if (runtime && !isTemporaryWorktreePath(operand))
    return { effect: 'repository_rewrite', target: { kind: 'runtime_sanctuary', value: runtime } };
  return candidate ?? unresolvedRemoval();
}

/** Wrapper and Git chdir operands are applied in order, before any lexical normalization. */
function resolveDirectories(cwd, operands, lexical = cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
  let physical = kernelPath(cwd);
  if (!physical) return null;
  let unfolded = cwd;
  for (const operand of operands) {
    if (typeof operand !== 'string' || !operand || /[$~*?[\]{}]/.test(operand)) return null;
    physical = kernelPath(unfoldedJoin(physical, operand));
    if (!physical) return null;
    unfolded = unfoldedJoin(unfolded, operand);
    lexical = resolve(lexical, operand);
  }
  return { physical, lexical, unfolded };
}

function targetKind(path) {
  return classifyNativeTarget(path, undefined, 'repository_rewrite', path).kind;
}

function unresolvedRemoval() {
  return {
    effect: 'repository_rewrite',
    target: { kind: 'ordinary', value: '<unresolved worktree removal>' },
    unresolved: true,
  };
}
