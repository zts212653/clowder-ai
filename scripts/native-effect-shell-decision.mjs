import { executedInvocations, executionChainInvocations } from './lib/shell-invocation.mjs';
import { scanShellText, shellSubstitutions } from './lib/shell-lexical.mjs';
import { SUBSTITUTION } from './lib/shell-text.mjs';
import { copyNamespaceStability, shellTextPreservesCopyNamespace } from './native-effect-copy-namespace.mjs';
import { contextualGitMutationCandidates } from './native-effect-git-context.mjs';
import { constrainedGhApiOperation } from './native-effect-github-classifier.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';
import { withoutInterpreterSource } from './native-effect-interpreter-source.mjs';
import {
  explicitCopyRoles,
  isConstrainedLocalMediaObservation,
  isLocalMediaObservationCommand,
} from './native-effect-media-classifier.mjs';
import { decideNativeEffect, deny } from './native-effect-policy.mjs';
import { protectedManagedPreviewBoundary } from './native-effect-preview-boundary.mjs';
import { managedPreviewOperationDecision } from './native-effect-preview-classifier.mjs';
import { gitSubcommandArgs } from './native-effect-repository-classifier.mjs';
import { isShellStructure, segmentCommandText, segmentContexts } from './native-effect-segment-locations.mjs';
import { segmentView } from './native-effect-segment-view.mjs';
import {
  classifyShellSegment,
  constrainedGhPullRequestOperation,
  explicitTemporaryWorktreeTarget,
  isDataDrivenPipelineConsumer,
  SHELL_EFFECT_PRIORITY,
  shellExecutionEvidence,
  splitPipelineSegments,
  splitShellExecutionSegmentsWithSeparators,
} from './native-effect-shell-classifier.mjs';
import { hasConcurrentShellExecution, pipelineChainStart } from './native-effect-shell-concurrency.mjs';
import { expandSegmentBindings, isShellBinding } from './native-effect-shell-expansion.mjs';
import { classifyNativeTarget as classifyTarget, insideMainCheckout } from './native-effect-target-classifier.mjs';
import { worktreeRemovalDecision } from './native-effect-worktree-removal.mjs';

// Provenance: F306 AC-C7 -- how a shell command becomes candidates (per segment, per
// directory it can run in), moved out of native-effect-target-guard.mjs (slice 2b, pure move).

export function decideShellHookPayload(view, cwd, source, depth = 0, initialCopyNamespaceStable = true) {
  const lexical = scanShellText(view.judged);
  const raw = lexical.text;
  if (depth > 8) return decideNativeEffect({ effect: 'unknown', target: classifyTarget(raw, cwd, 'unknown'), source });
  const pipelineBoundary = dataDrivenPipelineDecision(raw, cwd, source);
  if (pipelineBoundary?.decision === 'deny') return pipelineBoundary;
  const parts = splitShellExecutionSegmentsWithSeparators(raw);
  const segments = parts.map((part) => part.text);
  const mediaObservation = segments.find(isLocalMediaObservationCommand);
  let mediaUncertainty;
  if (mediaObservation && (segments.length !== 1 || !isConstrainedLocalMediaObservation(mediaObservation))) {
    const candidate = { effect: 'unknown', target: classifyTarget(raw, cwd, 'unknown'), source };
    mediaUncertainty = candidate;
    if (decideNativeEffect(candidate).decision === 'deny') {
      return deny(candidate, 'unbounded_local_media_observation');
    }
  }
  // Each segment is judged in every directory it can run in (after its preceding `cd`s),
  // against its own target only. Nothing else in the text is its target (2026-09-27).
  const contexts = segmentContexts(parts, cwd);
  const executionBoundary = codeInputBoundary(raw, parts, contexts, cwd, source);
  const units = (parts.length > 0 ? parts : [{ text: '', separator: null }]).map((part, index) => ({
    segment: isShellStructure(part.text) ? '' : segmentCommandText(part.text),
    contexts: contexts[index] ?? [{ directory: cwd, bindings: new Map() }],
  }));
  // Concurrent segments have no text-order happens-before relation: a later alias
  // creator can run before an earlier delayed copy, so no snapshot in this shell is stable.
  const copyNamespaceStable = copyNamespaceStability(
    units,
    initialCopyNamespaceStable && !hasConcurrentShellExecution(lexical, raw),
  );
  // A separate pipeline does not run concurrently with its sequential predecessor.
  const sequentialRead =
    !hasConcurrentShellExecution(lexical, raw, true) &&
    parts.every((part, index) => part.text === units[index].segment);
  const readProgramNamespaceStable = copyNamespaceStability(
    units,
    initialCopyNamespaceStable && (!hasConcurrentShellExecution(lexical, raw) || sequentialRead),
  );
  for (let index = 0; index < parts.length; index++) {
    if (!['|', '|&'].includes(parts[index + 1]?.separator)) continue;
    const start = pipelineChainStart(parts, index);
    let end = index;
    while (['|', '|&'].includes(parts[end + 1]?.separator)) end++;
    readProgramNamespaceStable.fill(false, start, end + 1);
    index = end;
  }
  const previewDecisions = units.map(({ segment, contexts }) =>
    segmentPreviewDecision(
      segment,
      contexts.map(({ directory }) => directory),
    ),
  );
  const previewBoundary = protectedManagedPreviewBoundary(previewDecisions, segments, cwd, source);
  if (previewBoundary) return previewBoundary;
  const expanded = units.map(({ segment, contexts }) =>
    contexts.flatMap(({ directory, bindings }) =>
      expandSegmentBindings(withoutInterpreterSource(segment), bindings).map((variant) => ({ ...variant, directory })),
    ),
  );
  const candidates = expanded.flatMap((variants, index) =>
    variants.flatMap(({ text, argvPreserved, unresolvedBindings = [], directory }) => {
      const execution = shellSubstitutions(text, SUBSTITUTION);
      const nested = nestedSubstitutionDecisions(execution.inner, directory, source, depth, copyNamespaceStable[index]);
      // The substitution executes in a child shell; only its output is an outer operand.
      // Echo/printf consume data. Other programs cannot certify generated argv as literal.
      const dataConsumer = /^\s*(?:echo|printf)\b/.test(execution.text);
      const preserved = dataConsumer || (argvPreserved && !execution.inner.length);
      const targetEvidence = dataConsumer ? text : [text, ...unresolvedBindings].join(' ').replace(/\r?\n/g, ' ');
      return [
        ...nested,
        segmentCandidate(
          isShellBinding(execution.text) ? '' : execution.text,
          directory,
          previewDecisions[index]?.operation,
          source,
          preserved,
          targetEvidence,
          !preserved && (execution.inner.length > 0 || unresolvedBindings.length > 0),
          units[index].segment,
          copyNamespaceStable[index],
          readProgramNamespaceStable[index],
        ),
      ];
    }),
  );
  if (executionBoundary) candidates.push(executionBoundary);
  if (mediaUncertainty) candidates.push(mediaUncertainty);
  if (pipelineBoundary) candidates.push(pipelineBoundary);
  // Child policy decisions may deny an otherwise ordinary target (for example
  // an unbounded managed-preview operation). Do not reinterpret them as candidates.
  const decisions = candidates.map((candidate) => (candidate.decision ? candidate : decideNativeEffect(candidate)));
  const rank = (candidate) => SHELL_EFFECT_PRIORITY.get(candidate.effect) ?? -1;
  const denials = decisions.filter((decision) => decision.decision === 'deny');
  if (denials.length) return denials.reduce((best, candidate) => (rank(candidate) > rank(best) ? candidate : best));
  if (!lexical.complete) {
    const candidate = { effect: 'unknown', target: classifyTarget(raw, cwd, 'unknown'), source };
    return candidate.target.kind === 'protected_branch'
      ? deny(candidate, 'protected_target_unparsed')
      : decideNativeEffect(candidate);
  }
  return decisions.reduce((best, candidate) => (rank(candidate) > rank(best) ? candidate : best));
}
function dataDrivenPipelineDecision(raw, cwd, source) {
  const consumer = splitPipelineSegments(raw).slice(1).find(isDataDrivenPipelineConsumer);
  if (!consumer) return null;
  const effect = classifyShellSegment(consumer);
  return decideNativeEffect({ effect, target: classifyTarget(raw, cwd, effect), source });
}

function nestedSubstitutionDecisions(innerCommands, directory, source, depth, initialCopyNamespaceStable) {
  let stable = initialCopyNamespaceStable;
  return innerCommands.map((inner) => {
    const decision = decideShellHookPayload(hereDocumentView(inner), directory, source, depth + 1, stable);
    stable &&= shellTextPreservesCopyNamespace(inner);
    return decision;
  });
}

/** Original-source roles precede env/path expansion; evidence stays on its execution chain. */
function codeInputBoundary(raw, parts, contexts, cwd, source) {
  const root = executedInvocations(withoutInterpreterSource(raw), { cwd });
  const original = protectedBranchBoundary(root, cwd, source);
  if (original) return original;
  for (let index = 0; index < parts.length; index++) {
    const start = pipelineChainStart(parts, index);
    let end = index;
    while (['|', '|&'].includes(parts[end + 1]?.separator)) end++;
    const chain = raw.slice(parts[start].start, parts[end].end);
    for (const { directory, bindings } of contexts[start] ?? [{ directory: cwd }]) {
      const reader = executionChainInvocations(withoutInterpreterSource(chain), { cwd: directory, bindings });
      const branch = protectedBranchBoundary(reader, directory, source);
      if (branch) return branch;
      const unproved = reader.pipelines.flat().find((call) => call.generatedCode && insideMainCheckout(call.cwd));
      if (unproved)
        return deny(
          { effect: 'unknown', target: { kind: 'broad_root', value: unproved.cwd }, source },
          'protected_target_unparsed',
        );
    }
    index = end;
  }
  return null;
}

function protectedBranchBoundary(reader, cwd, source) {
  const evidence = [
    ...reader.pipelines.flat().flatMap((call) => shellExecutionEvidence(call, cwd)),
    ...(reader.unresolvedEvidence ?? []).map((text) => ({ text, cwd })),
  ];
  for (const item of evidence) {
    const effect = item.effect ?? 'unknown';
    const target = classifyTarget(item.text, item.cwd, effect);
    if (target.kind === 'protected_branch')
      return effect === 'unknown'
        ? deny({ effect, target, source }, 'protected_target_unparsed')
        : decideNativeEffect({ effect, target, source });
  }
  return null;
}

/** A preview operation is admitted only if every directory the segment can run in admits it. */
function segmentPreviewDecision(segment, locations) {
  const decisions = locations.map((location) => managedPreviewOperationDecision(segment, location));
  const decision = decisions.find((entry) => entry?.status === 'deny') ?? decisions[0];
  // Failed typed attribution is uncertainty, not a mutation of configuration paths.
  return decision?.status === 'deny'
    ? { ...decision, operation: { effect: 'unknown', target: 'preview://unattributed' } }
    : decision;
}

function segmentCandidate(
  segment,
  cwd,
  managedPreview,
  source,
  argvPreserved,
  unresolvedText = segment,
  generatedExecution = false,
  roleSource = segment,
  copyNamespaceStable = true,
  readProgramNamespaceStable = copyNamespaceStable,
) {
  // Pure shell structure (`fi`, `done`, `}`) runs nothing of its own.
  if (!segment.trim()) return { effect: 'read', target: { kind: 'ordinary', value: cwd ?? '' }, source };
  const removal = worktreeRemovalDecision(segment, cwd, source, argvPreserved);
  if (removal) return removal;
  // A benign prefix can prevent the whole command from being a pure Git chain.
  // Its mutation segment still needs the same checkout/ancestor protection.
  const contextual = argvPreserved ? contextualGitMutationCandidates(segment, cwd) : null;
  if (contextual?.length === 1) return { ...contextual[0], source };
  const { command, location, targetCwd, targetText, roles, unprovedReadProgram } = argvPreserved
    ? segmentView(segment, cwd, roleSource, readProgramNamespaceStable)
    : { command: segment, location: cwd, targetCwd: cwd };
  const observedEffect = bindingViewEffect(command, managedPreview, argvPreserved);
  const effect = observedEffect === 'read' && unprovedReadProgram ? 'unknown' : observedEffect;
  const remoteOperation =
    argvPreserved &&
    !unprovedReadProgram &&
    (constrainedGhApiOperation(command) ?? constrainedGhPullRequestOperation(command));
  const copy = argvPreserved ? explicitCopyRoles(command) : null;
  const explicitTarget = argvPreserved ? (explicitTemporaryWorktreeTarget(command) ?? copy?.destination) : undefined;
  const locatedSource = location ? { ...source, cwd: location } : source;
  if (copy && (!copy.complete || !copyNamespaceStable)) {
    return deny(
      { effect: 'unknown', target: { kind: 'ordinary', value: copy.destination }, source: locatedSource },
      'protected_target_unparsed',
    );
  }
  if (managedPreview)
    return { effect, target: { kind: 'ordinary', value: managedPreview.target }, source: locatedSource };
  if (remoteOperation)
    return { effect, target: { kind: 'remote_repository', value: remoteOperation.target }, source: locatedSource };
  const target = classifyTarget(
    copy?.targetText ??
      explicitTarget ??
      observedSegmentTarget(segment, unresolvedText, targetText ?? command, roles, effect),
    explicitTarget ? undefined : targetCwd,
    effect,
    explicitTarget,
  );
  const candidate = { effect, target, source: locatedSource };
  // Target evidence does not certify generated argv. Main-checkout conservatism
  // applies to unknown executable/control positions, not every generated operand.
  if (target.kind === 'protected_branch') {
    const boundary = protectedBranchBoundary(executedInvocations(command, { cwd }), cwd, source);
    if (boundary) return boundary;
  }
  if (
    ['unknown', 'repository_rewrite'].includes(effect) &&
    insideMainCheckout(targetCwd) &&
    unprovedExecutionControl(command, generatedExecution)
  )
    return deny({ ...candidate, target: { kind: 'broad_root', value: targetCwd } }, 'protected_target_unparsed');
  return candidate;
}

function bindingViewEffect(command, managedPreview, argvPreserved) {
  const observed = managedPreview?.effect ?? classifyShellSegment(command);
  // A target-only view cannot prove a read, refresh or remote-only operation.
  // Keep recognised destructive effects so uncertain argv never downgrades a root denial.
  return !argvPreserved && ['read', 'repository_refresh', 'remote_mutation'].includes(observed) ? 'unknown' : observed;
}

/** Keep unresolved source and add observed write aliases; observation never removes a target. */
function observedSegmentTarget(original, unresolved, observed, hasRoles, effect) {
  if (hasRoles || unresolved === original) return observed;
  return effect === 'write' ? `${unresolved} ${observed}` : unresolved;
}

const GIT_CONTROL_COMMANDS = new Set([
  'reset',
  'clean',
  'checkout',
  'switch',
  'restore',
  'rebase',
  'merge',
  'branch',
  'update-ref',
  'push',
  'fetch',
  'pull',
]);
const generatedWord = (word) => word.includes(SUBSTITUTION) || /\$\w|\$\{/.test(word);

/** Read actual execution roles; generated positionals do not invent a main rewrite. */
function unprovedExecutionControl(command, generatedExecution) {
  const parsed = executedInvocations(command);
  const calls = parsed.pipelines.flat();
  if (calls.some(({ generatedCode }) => generatedCode)) return true;
  if (!generatedExecution) return false;
  if (!calls.length) return !parsed.complete;
  return calls.some(({ name, operands }) => {
    if (!name) return true;
    if (name !== 'git') return false;
    const args = gitSubcommandArgs(operands);
    if (!args?.length || generatedWord(args[0])) return true;
    if (args[0] === 'worktree' && generatedWord(args[1] ?? '')) return true;
    const selectors = operands.slice(0, operands.length - args.length);
    return selectors.some(generatedWord) || (GIT_CONTROL_COMMANDS.has(args[0]) && args.some(generatedWord));
  });
}
