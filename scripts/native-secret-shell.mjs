import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ghOperation } from './lib/secret-gh-options.mjs';
import { executedInvocations } from './lib/shell-invocation.mjs';
import { constrainedGhApiOperation } from './native-effect-github-classifier.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';
import { observedReadProgram } from './native-effect-invocation-targets.mjs';
import { segmentCommandText, segmentContexts } from './native-effect-segment-locations.mjs';
import { splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { commandName } from './native-effect-shell-tokenizer.mjs';

export function secretShellDenial(command, cwd) {
  // Non-shell interpreter input is source, not another shell command stream.
  const host = hereDocumentView(command).judged;
  const parts = splitShellExecutionSegmentsWithSeparators(host);
  const contexts = segmentContexts(parts, cwd);
  for (const invocation of contextualInvocations(parts, contexts)) {
    const reason = invocationDenial(invocation, cwd, host);
    if (reason) return reason;
  }
  return null;
}

function contextualInvocations(parts, contexts) {
  return parts.flatMap((part, index) => {
    if (['|', '|&'].includes(part.separator)) return [];
    let end = index;
    while (['|', '|&'].includes(parts[end + 1]?.separator)) end++;
    // Keep producer/consumer code evidence together within each pipeline.
    const pipeline = parts
      .slice(index, end + 1)
      .map((item, offset) => `${offset ? item.separator : ''} ${segmentCommandText(item.text)}`)
      .join(' ');
    return contexts[index].flatMap(({ directory, bindings, parameters }) =>
      executedInvocations(pipeline, { cwd: directory, bindings, parameters }).pipelines.flat(),
    );
  });
}

function invocationDenial(invocation, cwd, source) {
  const program = commandName(invocation.program ?? invocation.name);
  const operands = invocation.programOperands ?? invocation.operands;
  if (
    program === 'git' &&
    operands.includes('push') &&
    operands.some((arg) => arg === '--no-verify' || /core\.hooksPath/i.test(arg))
  )
    return 'secret_git_hook_bypass_blocked';
  if (['gh', 'curl'].includes(program) && unguardedSender(invocation, program, source, cwd))
    return 'secret_send_requires_managed_command';
  return null;
}

function unguardedSender(invocation, program, source, cwd) {
  if (program === 'gh' && plainGhRead(invocation)) return false;
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
  if (program !== 'gh' || splitShellExecutionSegmentsWithSeparators(source).length !== 1) return true;
  // Reuse the existing pinned-wrapper/loader/interpreter/delegate proof. Do not
  // erase earlier namespace changes or treat an arbitrary GET as a managed send.
  const read = observedReadProgram(source, cwd, true);
  return !read.command || !constrainedGhApiOperation(read.command, { payloadFree: true });
}

function plainGhRead(invocation) {
  const operation = ghOperation(invocation.programOperands ?? invocation.operands);
  return (
    ['pr', 'issue', 'run', 'repo'].includes(operation.group) &&
    ['view', 'list', 'checks', 'status', 'diff'].includes(operation.action)
  );
}
