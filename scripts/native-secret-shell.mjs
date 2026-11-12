import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ghOperation } from './lib/secret-gh-options.mjs';
import { executedInvocations } from './lib/shell-invocation.mjs';
import { leadingShellControl, nativeBuiltinContext } from './lib/shell-program-tokens.mjs';
import { constrainedGhApiOperation, managedGhOperation } from './native-effect-github-classifier.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';
import { provedManagedGhInvocation } from './native-effect-program-selection.mjs';
import { segmentCommandText, segmentContexts } from './native-effect-segment-locations.mjs';
import { classifyShellSegment, splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { isLocalProgramBinding } from './native-effect-shell-expansion.mjs';
import { commandName } from './native-effect-shell-tokenizer.mjs';

export function secretShellDenial(command, cwd) {
  // Non-shell interpreter input is source, not another shell command stream.
  const host = hereDocumentView(command).judged;
  const parts = splitShellExecutionSegmentsWithSeparators(host);
  const builtinContexts = namespaceContexts(parts);
  const contexts = segmentContexts(parts, cwd, process.env, builtinContexts);
  for (const invocation of contextualInvocations(parts, contexts, builtinContexts)) {
    const reason = invocationDenial(invocation);
    if (reason) return reason;
  }
  return null;
}

function namespaceContexts(parts) {
  let stable = nativeBuiltinContext(
    !parts.some(
      (part) =>
        part.separator === '&' || ['for', 'while', 'until', 'function'].includes(leadingShellControl(part.text)),
    ),
  );
  return parts.map((part) => {
    const before = stable;
    stable &&=
      classifyShellSegment(part.text, { builtinContext: stable }) === 'read' || isLocalProgramBinding(part.text);
    return before;
  });
}

function contextualInvocations(parts, contexts, builtinContexts) {
  return parts.flatMap((part, index) => {
    if (['|', '|&'].includes(part.separator)) return [];
    let end = index;
    while (['|', '|&'].includes(parts[end + 1]?.separator)) end++;
    // Keep producer/consumer code evidence together within each pipeline.
    const pipeline = parts
      .slice(index, end + 1)
      .map((item, offset) => `${offset ? item.separator : ''} ${segmentCommandText(item.text)}`)
      .join(' ');
    const calls = contexts[index]
      .flatMap(({ directory, bindings, parameters }) =>
        executedInvocations(pipeline, {
          cwd: directory,
          bindings,
          parameters,
          builtinContext: builtinContexts[index] && index === end,
        }).pipelines.flat(),
      )
      .map((call) => ({ ...call, namespaceStable: builtinContexts[index] && index === end }));
    return calls;
  });
}

function invocationDenial(invocation) {
  const program = commandName(invocation.program ?? invocation.name);
  const operands = invocation.programOperands ?? invocation.operands;
  if (
    program === 'git' &&
    operands.includes('push') &&
    operands.some((arg) => arg === '--no-verify' || /core\.hooksPath/i.test(arg))
  )
    return 'secret_git_hook_bypass_blocked';
  if (['gh', 'curl'].includes(program) && unguardedSender(invocation, program))
    return 'secret_send_requires_managed_command';
  return null;
}

function unguardedSender(invocation, program) {
  if (program === 'gh' && plainGhRead(invocation)) return false;
  if (program === 'gh') {
    if (
      !invocation.namespaceStable ||
      invocation.delegated ||
      invocation.environment?.length ||
      invocation.wrappers?.length
    )
      return true;
    // Bare gh retains the launcher-owned carrier contract, not a new program
    // certificate. No inline environment or delegated carrier inherits it.
    if (!(invocation.program ?? '').includes('/')) return false;
    return !(
      managedGhOperation(invocation.programOperands ?? invocation.operands) && provedManagedGhInvocation(invocation)
    );
  }
  if (invocation.environment?.some((item) => item.startsWith('PATH='))) return true;
  if (!(invocation.program ?? '').includes('/'))
    return invocation.wrappers?.some(
      (wrapper) => commandName(wrapper.program) === 'command' && wrapper.options.includes('-p'),
    );
  try {
    if (
      realpathSync(invocation.program) ===
      realpathSync(fileURLToPath(new URL(`./guarded-bin/${program}`, import.meta.url)))
    )
      return false;
  } catch {
    // A copied wrapper can still prove its identity through the shared reader.
  }
  return true;
}

function plainGhRead(invocation) {
  // Bare, payload-free API observations share the launcher's existing read
  // carrier (including readonly loops). This never certifies an explicit path.
  if (
    !(invocation.program ?? '').includes('/') &&
    invocation.argvComplete &&
    !invocation.environment?.length &&
    !invocation.delegated &&
    !invocation.wrappers?.length
  ) {
    const query = ['gh', ...(invocation.programOperands ?? invocation.operands)]
      .map((word) => `'${word.replaceAll("'", "'\\''")}'`)
      .join(' ');
    if (constrainedGhApiOperation(query, { payloadFree: true })) return true;
  }
  const operation = ghOperation(invocation.programOperands ?? invocation.operands);
  return (
    ['pr', 'issue', 'run', 'repo'].includes(operation.group) &&
    ['view', 'list', 'checks', 'status', 'diff'].includes(operation.action)
  );
}
