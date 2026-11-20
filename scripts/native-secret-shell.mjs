import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitInvocationArguments } from './lib/git-invocation.mjs';
import { kernelPath, unfoldedJoin } from './lib/shell-directory.mjs';
import { executedInvocations } from './lib/shell-invocation.mjs';
import { programNamespaceStability } from './native-effect-copy-namespace.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';
import { hasProgramLoader, proveProgramSelection, selectedExecutable } from './native-effect-program-selection.mjs';
import { segmentCommandText, segmentContexts } from './native-effect-segment-locations.mjs';
import { splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { commandName, isFileOutputRedirection } from './native-effect-shell-tokenizer.mjs';

export function secretShellDenial(command, cwd) {
  const parts = splitShellExecutionSegmentsWithSeparators(hereDocumentView(command).judged);
  // Builtin context distinguishes a lookup from execution. It does not
  // decide whether a normal environment or pipeline may run a managed sender.
  const builtins = programNamespaceStability(parts.map(({ text }) => ({ segment: text })));
  const contexts = segmentContexts(parts, cwd, process.env, builtins);
  const written = new Set();
  for (let index = 0; index < parts.length; index++) {
    let end = index;
    while (['|', '|&'].includes(parts[end + 1]?.separator)) end++;
    const pipeline = parts
      .slice(index, end + 1)
      .map((part, offset) =>
        offset ? `${part.separator} ${segmentCommandText(part.text)}` : segmentCommandText(part.text),
      )
      .join(' ');
    for (const { directory, bindings, parameters } of contexts[index]) {
      const calls = executedInvocations(pipeline, {
        cwd: directory,
        bindings,
        parameters,
        builtinContext: builtins[index],
      }).pipelines.flat();
      recordOutputPaths(calls, written);
      for (const call of calls) {
        const reason = invocationDenial(call, bindings, written);
        if (reason) return reason;
      }
    }
    index = end;
  }
  return null;
}

function recordOutputPaths(calls, written) {
  for (const call of calls)
    for (const { operand } of (call.redirections ?? []).filter(isFileOutputRedirection)) {
      const path = operand.literal && resolvedPath(operand.value, call.cwd);
      if (path) written.add(path);
    }
}

function invocationDenial(call, bindings, written) {
  const program = commandName(call.program ?? call.name);
  if (program === 'git' && skipsPushHook(call, bindings)) return 'secret_git_hook_bypass_blocked';
  if (['gh', 'curl'].includes(program) && selectsUnmanagedSender(call, program, bindings, written))
    return 'secret_send_requires_managed_command';
  return null;
}

function skipsPushHook(call, bindings) {
  const { args, directories, configuration, coordinateKnown } = gitInvocationArguments(
    call.programOperands ?? call.operands,
  );
  if (args?.[0] !== 'push') return false;
  const separator = args.indexOf('--');
  if (args.slice(1, separator < 0 ? undefined : separator).includes('--no-verify')) return true;
  const hooks = configuration.findLast(({ value }) => /^core\.hookspath(?:=|$)/i.test(value));
  if (!hooks) return false;
  const operand = hooks.value.slice('core.hooksPath='.length);
  const paths = hooks.fromEnv ? environmentValues(call, bindings, operand) : [operand];
  const directory = directories.reduce(
    (base, part) => (part && base ? kernelPath(unfoldedJoin(base, part)) : base),
    call.cwd,
  );
  const root = checkoutRoot(directory);
  if (!coordinateKnown || !call.coordinateKnown || !root || !paths?.length) return true;
  const canonicalHook = join(root, '.githooks', 'pre-push');
  return paths.some(
    (path) => !path || kernelPath(unfoldedJoin(unfoldedJoin(root, path), 'pre-push')) !== canonicalHook,
  );
}

function checkoutRoot(directory) {
  for (let current = directory && kernelPath(directory); current; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (current === dirname(current)) break;
  }
  return null;
}

function inlineEnvironmentValue(call, name) {
  return call.environment?.findLast((word) => word.startsWith(`${name}=`))?.slice(name.length + 1);
}

function environmentValues(call, bindings, name) {
  const assigned = inlineEnvironmentValue(call, name);
  if (assigned !== undefined) return [assigned];
  return bindings.has(name) ? bindings.get(name) : [process.env[name]];
}

function resolvedPath(value, cwd) {
  const path = isAbsolute(value) ? value : cwd && unfoldedJoin(cwd, value);
  return path && kernelPath(path);
}

function selectsUnmanagedSender(call, program, bindings, written) {
  const override = (name) => inlineEnvironmentValue(call, name) ?? bindings.get(name)?.at(-1);
  if (hasProgramLoader((name) => override(name) ?? process.env[name])) return true;
  const delegate = override('CAT_CAFE_REAL_GH_PATH');
  if (program === 'gh' && delegate && delegate !== process.env.CAT_CAFE_REAL_GH_PATH) return true;
  const command = call.program ?? call.name;
  if (command.includes('/')) {
    return !isManagedSender(resolvedPath(command, call.cwd), program, call, written);
  }
  const pathOverride = override('PATH');
  const selected = pathOverride && selectedExecutable(program, pathOverride, call.cwd);
  if (selected && !isManagedSender(selected.realpath, program, { ...call, program: selected.path }, written))
    return true;
  // Explicitly selecting the system path is distinct from inheriting PATH.
  return Boolean(
    call.wrappers?.some(
      ({ program: wrapper, options }) => commandName(wrapper) === 'command' && options.includes('-p'),
    ),
  );
}

function isManagedSender(executable, program, call, written) {
  if (!executable || written.has(executable)) return false;
  const packaged = kernelPath(fileURLToPath(new URL(`./guarded-bin/${program}`, import.meta.url)));
  const bin = process.env.CAT_CAFE_VERDICT_GH_GUARD_BIN;
  return (
    executable === packaged ||
    (bin && executable === kernelPath(join(bin, program))) ||
    (program === 'gh' && proveProgramSelection(call)?.kind === 'repository_gh_wrapper')
  );
}
