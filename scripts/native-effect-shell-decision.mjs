import { expandPositionalParameters } from './lib/shell-code-inputs.mjs';
import { executedInvocations, executionChainInvocations } from './lib/shell-invocation.mjs';
import { scanShellText, shellSubstitutions } from './lib/shell-lexical.mjs';
import { extractSubstitutions, SUBSTITUTION } from './lib/shell-text.mjs';
import { codexAuthenticationEffect } from './native-auth-effect.mjs';
import {
  copyNamespaceStability,
  programNamespaceStability,
  shellTextPreservesCopyNamespace,
} from './native-effect-copy-namespace.mjs';
import { contextualGitMutationCandidates } from './native-effect-git-context.mjs';
import { constrainedGhApiOperation } from './native-effect-github-classifier.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';
import { httpOutputTargets } from './native-effect-http-classifier.mjs';
import { withoutInterpreterSource } from './native-effect-interpreter-source.mjs';
import { boundGitDirectoryView, withoutPathTargets } from './native-effect-invocation-targets.mjs';
import {
  explicitCopyRoles,
  isConstrainedLocalMediaObservation,
  isLocalMediaObservationCommand,
} from './native-effect-media-classifier.mjs';
import { decideNativeEffect, deny } from './native-effect-policy.mjs';
import { protectedManagedPreviewBoundary } from './native-effect-preview-boundary.mjs';
import { managedPreviewOperationDecision } from './native-effect-preview-classifier.mjs';
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
import { shellInvocation, stripHarmlessRedirections } from './native-effect-shell-tokenizer.mjs';
import { classifyNativeTarget as classifyTarget } from './native-effect-target-classifier.mjs';
import { worktreeRemovalDecision } from './native-effect-worktree-removal.mjs';

// Provenance: F306 AC-C7 -- how a shell command becomes candidates (per segment, per
// directory it can run in), moved out of native-effect-target-guard.mjs (slice 2b, pure move).

function projectProvenBoundLookupText(text, bindings) {
  if (!bindings?.size) return text;
  const varMatches = [...text.matchAll(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g)];
  if (!varMatches.length) return text;
  const allSafeLiterals = varMatches.every((m) => {
    const name = m[1] ?? m[2];
    const vals = bindings.get(name);
    return (
      Array.isArray(vals) &&
      vals.length > 0 &&
      vals.every((v) => typeof v === 'string' && v.length > 0 && !v.startsWith('-') && !/[\s;&|<>()`$\\]/.test(v))
    );
  });
  if (!allSafeLiterals) return text;
  return text.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, 'catcafe_bound_literal');
}

function isPureReadOnlyLookupConsumer(text, builtinContext, bindings) {
  const cleaned = projectProvenBoundLookupText(stripHarmlessRedirections(text), bindings);
  const inv = shellInvocation(cleaned);
  if (!inv.complete || inv.redirections.length > 0 || inv.words.length === 0) return null;
  const words = inv.words.map((w) => w.value);
  const first = words[0];
  if (first === 'echo' || first === 'printf') {
    return !(first === 'printf' && (words[1]?.startsWith('-v') || (inv.words[1] && !inv.words[1].literal)))
      ? cleaned
      : null;
  }
  if (!builtinContext) return null;
  if (first === 'command') {
    const flags = words.slice(1).filter((w) => w.startsWith('-') && w !== '--');
    return flags.length > 0 && flags.every((f) => /^-[vV]+$/.test(f)) ? cleaned : null;
  }
  if (first === 'which') {
    const flags = words.slice(1).filter((w) => w.startsWith('-') && w !== '--');
    return flags.every((f) => /^-[as]+$/.test(f)) ? cleaned : null;
  }
  if (first === 'type') {
    const flags = words.slice(1).filter((w) => w.startsWith('-') && w !== '--');
    return flags.every((f) => /^-[atpPf]+$/.test(f)) ? cleaned : null;
  }
  return null;
}

export function decideShellHookPayload(
  view,
  cwd,
  source,
  depth = 0,
  initialCopyNamespaceStable = true,
  initialProgramNamespaceStable = true,
  initialScope = {},
) {
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
  const unitTexts = (parts.length > 0 ? parts : [{ text: '', separator: null }]).map((part) =>
    isShellStructure(part.text) ? '' : segmentCommandText(part.text),
  );
  // Concurrent segments have no text-order happens-before relation: a later alias
  // creator can run before an earlier delayed copy, so no snapshot in this shell is stable.
  // A separate pipeline does not run concurrently with its sequential predecessor.
  const sequentialRead =
    !hasConcurrentShellExecution(lexical, raw, true) &&
    parts.every(
      (part, index) =>
        part.text === unitTexts[index] || isShellStructure(part.text) || /^\s*(?:do|then|else|elif)\b/.test(part.text),
    );
  const readProgramNamespaceStable = programNamespaceStability(
    parts.map((part) => ({ segment: part.text })),
    initialProgramNamespaceStable && (!hasConcurrentShellExecution(lexical, raw) || sequentialRead),
  );
  for (let index = 0; index < parts.length; index++) {
    if (!['|', '|&'].includes(parts[index + 1]?.separator)) continue;
    const start = pipelineChainStart(parts, index);
    let end = index;
    while (['|', '|&'].includes(parts[end + 1]?.separator)) end++;
    readProgramNamespaceStable.fill(false, start, end + 1);
    index = end;
  }
  const contexts = segmentContexts(parts, cwd, process.env, readProgramNamespaceStable, initialScope);
  const units = unitTexts.map((segment, index) => ({
    segment,
    contexts: contexts[index] ?? [{ directory: cwd, bindings: new Map() }],
  }));
  const copyNamespaceStable = copyNamespaceStability(
    units,
    initialCopyNamespaceStable,
    readProgramNamespaceStable,
    hasConcurrentShellExecution(lexical, raw),
  );
  const executionBoundary = codeInputBoundary(raw, parts, contexts, cwd, source, readProgramNamespaceStable, depth);
  const previewDecisions = units.map(({ segment, contexts }) =>
    segmentPreviewDecision(
      segment,
      contexts.map(({ directory }) => directory),
    ),
  );
  const previewBoundary = protectedManagedPreviewBoundary(
    previewDecisions,
    segments,
    cwd,
    source,
    readProgramNamespaceStable,
  );
  if (previewBoundary) return previewBoundary;
  const expanded = units.map(({ segment, contexts }, index) =>
    contexts.flatMap(({ directory, bindings, parameters }) =>
      expandSegmentBindings(
        withoutInterpreterSource(
          readProgramNamespaceStable[index] && parameters ? expandPositionalParameters(segment, parameters) : segment,
        ),
        bindings,
      ).map((variant) => ({ ...variant, directory, bindings, parameters })),
    ),
  );
  const candidates = expanded.flatMap((variants, index) =>
    variants.flatMap(({ text, argvPreserved, unresolvedBindings = [], directory, bindings, parameters }) => {
      const execution = shellSubstitutions(text, SUBSTITUTION);
      const nested = nestedSubstitutionDecisions(
        execution.inner,
        directory,
        source,
        depth,
        copyNamespaceStable[index],
        readProgramNamespaceStable[index],
        { bindings, parameters },
      );
      // The substitution executes in a child shell; only its output is an outer operand.
      // Pure data/lookup builtins without file redirections consume data without executing generated argv.
      const lookupSegment = isPureReadOnlyLookupConsumer(execution.text, readProgramNamespaceStable[index], bindings);
      const dataConsumer = lookupSegment !== null;
      const preserved = dataConsumer || (argvPreserved && !execution.inner.length);
      const candidateText = lookupSegment ?? execution.text;
      const targetEvidence = dataConsumer
        ? candidateText
        : [text, ...unresolvedBindings].join(' ').replace(/\r?\n/g, ' ');
      return [
        ...nested,
        {
          ...segmentCandidate(
            isShellBinding(candidateText) ? '' : candidateText,
            directory,
            previewDecisions[index]?.operation,
            source,
            preserved,
            targetEvidence,
            dataConsumer ? candidateText : units[index].segment,
            copyNamespaceStable[index],
            readProgramNamespaceStable[index],
          ),
          offendingClause: units[index].segment,
        },
      ];
    }),
  );
  if (executionBoundary) candidates.push(executionBoundary);
  if (mediaUncertainty) candidates.push(mediaUncertainty);
  if (pipelineBoundary) candidates.push(pipelineBoundary);
  // Child policy decisions may deny an otherwise ordinary target (for example
  // an unbounded managed-preview operation). Do not reinterpret them as candidates.
  const decisions = candidates.map((candidate) => {
    const decision = candidate.decision ? candidate : decideNativeEffect(candidate);
    return (decision.decision === 'deny' || decision.reasonCode === 'copy_target_unresolved') &&
      candidate.offendingClause
      ? { ...decision, offendingClause: candidate.offendingClause }
      : decision;
  });
  const rank = (candidate) => SHELL_EFFECT_PRIORITY.get(candidate.effect) ?? -1;
  const denials = decisions.filter((decision) => decision.decision === 'deny');
  if (denials.length) return denials.reduce((best, candidate) => (rank(candidate) > rank(best) ? candidate : best));
  if (!lexical.complete) {
    const candidate = { effect: 'unknown', target: classifyTarget(raw, cwd, 'unknown'), source };
    return candidate.target.kind === 'protected_branch'
      ? deny(candidate, 'protected_target_unparsed')
      : decideNativeEffect(candidate);
  }
  return (
    decisions.find((decision) => decision.reasonCode === 'copy_target_unresolved') ??
    decisions.reduce((best, candidate) => (rank(candidate) > rank(best) ? candidate : best))
  );
}
function dataDrivenPipelineDecision(raw, cwd, source) {
  const consumer = splitPipelineSegments(raw).slice(1).find(isDataDrivenPipelineConsumer);
  if (!consumer) return null;
  const effect = classifyShellSegment(consumer);
  return decideNativeEffect({ effect, target: classifyTarget(raw, cwd, effect), source });
}

function nestedSubstitutionDecisions(
  innerCommands,
  directory,
  source,
  depth,
  initialCopyNamespaceStable,
  programNamespaceStable,
  initialScope = {},
) {
  let stable = initialCopyNamespaceStable;
  return innerCommands.map((inner) => {
    const decision = decideShellHookPayload(
      hereDocumentView(inner),
      directory,
      source,
      depth + 1,
      stable,
      programNamespaceStable,
      initialScope,
    );
    stable &&= shellTextPreservesCopyNamespace(inner, programNamespaceStable);
    return decision;
  });
}

/** Original-source roles precede env/path expansion; evidence stays on its execution chain. */
function codeInputBoundary(raw, parts, contexts, cwd, source, builtinContexts, depth) {
  const rootContext = builtinContexts[0] ?? false;
  const root = executedInvocations(withoutInterpreterSource(raw), { cwd, builtinContext: rootContext });
  if (codexAuthenticationEffect(root.pipelines.flat()) === 'auth_mutation')
    return decideNativeEffect({ effect: 'auth_mutation', target: classifyTarget(raw, cwd, 'auth_mutation'), source });
  const original = protectedBranchBoundary(root, cwd, source, { deferDirectories: true, builtinContext: rootContext });
  if (original) return original;
  for (let index = 0; index < parts.length; index++) {
    const start = pipelineChainStart(parts, index);
    let end = index;
    while (['|', '|&'].includes(parts[end + 1]?.separator)) end++;
    const chain = raw.slice(parts[start].start, parts[end].end);
    for (const { directory, bindings } of contexts[start] ?? [{ directory: cwd }]) {
      const builtinContext = builtinContexts.slice(start, end + 1).every(Boolean);
      const reader = executionChainInvocations(withoutInterpreterSource(chain), {
        cwd: directory,
        bindings,
        builtinContext,
      });
      const branch = protectedBranchBoundary(reader, directory, source, { bindings, builtinContext });
      if (branch) return branch;
      for (const call of reader.pipelines.flat()) {
        const literal = generatedLiteralCommand(call);
        if (literal === undefined) continue;
        const decision = decideShellHookPayload(hereDocumentView(literal), call.cwd, source, depth + 1);
        if (decision.decision === 'deny') return decision;
      }
    }
    index = end;
  }
  return null;
}

/** Reuse the reader's literal stdout proof for a single generated code operand. */
function generatedLiteralCommand(call) {
  if (!call.generatedCode) return undefined;
  const template = call.script ?? call.program;
  const markers = template?.match(/\0catcafe_substitution:\d+\0/g);
  if (markers?.length !== 1) return undefined;
  const producers = new Set((call.codeEvidence ?? []).flatMap((text) => extractSubstitutions(text).inner));
  if (producers.size !== 1) return undefined;
  const reader = executedInvocations(producers.values().next().value, { cwd: call.cwd });
  if (!reader.complete || reader.directInvocations.length !== 1) return undefined;
  if (reader.directInvocations[0].redirections?.length || reader.directInvocations[0].wrappers?.length)
    return undefined;
  const stdout = reader.output?.source;
  if (stdout === undefined) return undefined;
  const value = template.replace(markers[0], () => stdout.replace(/\n+$/, ''));
  if (call.script !== undefined) return value;
  if (!/^[\w./-]+$/.test(value) || call.operands.some((word) => word.includes('\0'))) return undefined;
  return [value, ...call.operands].map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(' ');
}

function protectedBranchBoundary(
  reader,
  cwd,
  source,
  { deferDirectories = false, bindings, builtinContext = false } = {},
) {
  const evidence = [
    ...reader.pipelines.flat().flatMap((call) => {
      const directory = boundGitDirectoryView(call, bindings);
      if (deferDirectories && directory?.defer) return [];
      const calls = directory?.text
        ? executedInvocations(directory.text, { cwd: call.cwd ?? cwd, builtinContext }).pipelines.flat()
        : [call];
      return calls.flatMap((entry) => shellExecutionEvidence(entry, cwd));
    }),
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
  roleSource = segment,
  copyNamespaceStable = true,
  readProgramNamespaceStable = copyNamespaceStable,
) {
  // Pure shell structure (`fi`, `done`, `}`) runs nothing of its own.
  if (!segment.trim()) return { effect: 'read', target: { kind: 'ordinary', value: cwd ?? '' }, source };
  const removal = worktreeRemovalDecision(segment, cwd, source, argvPreserved, readProgramNamespaceStable);
  if (removal) return removal;
  // A benign prefix can prevent the whole command from being a pure Git chain.
  // Its mutation segment still needs the same checkout/ancestor protection.
  const contextual = argvPreserved ? contextualGitMutationCandidates(segment, cwd) : null;
  if (contextual?.length === 1) return { ...contextual[0], source };
  const { command, location, targetCwd, targetText, roles, unprovedReadProgram } = argvPreserved
    ? segmentView(segment, cwd, roleSource, readProgramNamespaceStable)
    : { command: segment, location: cwd, targetCwd: cwd };
  const observedEffect = bindingViewEffect(command, managedPreview, argvPreserved, readProgramNamespaceStable);
  const effect = observedEffect === 'read' && unprovedReadProgram ? 'unknown' : observedEffect;
  const remoteOperation =
    argvPreserved &&
    !unprovedReadProgram &&
    (constrainedGhApiOperation(command) ?? constrainedGhPullRequestOperation(command));
  const copy = explicitCopyRoles(command, location ?? cwd);
  const http = argvPreserved && copyNamespaceStable ? httpOutputTargets(command, location ?? cwd) : null;
  const explicitTarget = argvPreserved ? (explicitTemporaryWorktreeTarget(command) ?? copy?.destination) : undefined;
  const locatedSource = location ? { ...source, cwd: location } : source;
  if (copy?.destination && (!copy.complete || !copyNamespaceStable)) {
    return deny(
      { effect: 'unknown', target: { kind: 'ordinary', value: copy.destination }, source: locatedSource },
      'protected_target_unparsed',
    );
  }
  if (http && !http.complete)
    return deny(
      { effect: 'unknown', target: { kind: 'ordinary', value: http.targetText }, source: locatedSource },
      'protected_target_unparsed',
    );
  if (managedPreview)
    return { effect, target: { kind: 'ordinary', value: managedPreview.target }, source: locatedSource };
  if (remoteOperation)
    return { effect, target: { kind: 'remote_repository', value: remoteOperation.target }, source: locatedSource };
  const target = classifyTarget(
    withoutPathTargets(
      http?.targetText ??
        copy?.targetText ??
        explicitTarget ??
        observedSegmentTarget(segment, unresolvedText, targetText ?? command, roles, effect),
      location ?? cwd,
    ),
    explicitTarget || http ? undefined : targetCwd,
    effect,
    explicitTarget,
  );
  const candidate = { effect, target, source: locatedSource };
  if (copy?.unresolved && target.kind === 'ordinary')
    return { ...candidate, decision: 'allow', reasonCode: 'copy_target_unresolved' };
  if (target.kind === 'protected_branch') {
    const boundary = protectedBranchBoundary(
      executedInvocations(command, { cwd, builtinContext: readProgramNamespaceStable }),
      cwd,
      source,
      { builtinContext: readProgramNamespaceStable },
    );
    if (boundary) return boundary;
  }
  return candidate;
}

function bindingViewEffect(command, managedPreview, argvPreserved, builtinContext) {
  const observed = managedPreview?.effect ?? classifyShellSegment(command, { builtinContext });
  // A target-only view cannot prove a read, refresh or remote-only operation.
  // Keep recognised destructive effects so uncertain argv never downgrades a root denial.
  return !argvPreserved && ['read', 'repository_refresh', 'remote_mutation'].includes(observed) ? 'unknown' : observed;
}

/** Keep unresolved source and add observed write aliases; observation never removes a target. */
function observedSegmentTarget(original, unresolved, observed, hasRoles, effect) {
  if (hasRoles || unresolved === original) return observed;
  return effect === 'write' ? `${unresolved} ${observed}` : unresolved;
}
