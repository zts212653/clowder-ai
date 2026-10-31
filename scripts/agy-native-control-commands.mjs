import { executedInvocations, optionValue } from './lib/shell-invocation.mjs';
import { isShellStructure, segmentCommandText, segmentContexts } from './native-effect-segment-locations.mjs';
import { classifyShellSegment, splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { expandSegmentBindings } from './native-effect-shell-expansion.mjs';
import { shellInvocation } from './native-effect-shell-tokenizer.mjs';
import { fileProgramAnalysis } from './native-effect-write-effects.mjs';

function isReadOnlySecurityCall(call) {
  const [operation, ...args] = call.operands;
  if (operation === 'help' || operation === 'error') return true;
  if (operation === '-h') return args.length === 0;
  if (operation === 'show-keychain-info') return args.length === 0 || (args.length === 1 && !args[0].startsWith('-'));
  if (!['default-keychain', 'list-keychains', 'login-keychain'].includes(operation)) return false;
  // Only documented read forms are admitted. Unknown options or operations may
  // mutate an implicit keychain/trust/auth target without naming a protected file.
  return (
    args.length === 0 ||
    (args.length === 1 && /^(?:-h|-d(?:user|system|common|dynamic))$/.test(args[0])) ||
    (args.length === 2 && args[0] === '-d' && /^(?:user|system|common|dynamic)$/.test(args[1]))
  );
}

function fileTargets(call) {
  // dd's output operand is a key/value word; its input remains a read.
  if (['dd', 'gdd'].includes(call.name))
    return call.operands.filter((word) => word.startsWith('of=')).map((word) => word.slice(3));
  // A hard-link source remains protected: a new alias would let a later write
  // mutate the same control inode. Only plain copies have a read-only source.
  if (!['cp', 'install'].includes(call.name)) return call.operands;
  const separator = call.operands.indexOf('--');
  const options = separator < 0 ? call.operands : call.operands.slice(0, separator);
  const directory = optionValue(options, '--target-directory') ?? optionValue(options, '-t');
  if (directory !== undefined) return [directory];
  const targetFlag = options.find((word) => /^-[A-Za-z]*t/.test(word));
  if (targetFlag) {
    const attached = targetFlag.slice(targetFlag.indexOf('t') + 1);
    return [attached || options[options.indexOf(targetFlag) + 1] || ''];
  }
  // Unknown option arity cannot certify source-vs-destination roles.
  if (options.some((word) => word.startsWith('-')))
    return call.operands.flatMap((word) => [word, ...(word.includes('=') ? [word.slice(word.indexOf('=') + 1)] : [])]);
  return call.operands.slice(-1);
}

/** Carrier control files use the same shell coordinates and argv parser as the shared effect guard. */
export function commandTouchesAgyControl(command, cwd, profileHome, isControl, depth = 0, toolHome = profileHome) {
  if (depth > 8) return true;
  const env = { ...process.env, ...(toolHome ? { HOME: toolHome } : {}) };
  // Preserve shared stdin-to-code attribution before splitting the pipeline.
  // A quoted path printed as data becomes executable only at its shell consumer.
  const delegated = executedInvocations(command, { cwd }).directInvocations ?? [];
  if (
    delegated.some(
      (call) =>
        call.delegated &&
        call.script &&
        commandTouchesAgyControl(call.script, call.cwd ?? cwd, profileHome, isControl, depth + 1, toolHome),
    )
  )
    return true;
  const segments = splitShellExecutionSegmentsWithSeparators(command);
  const contexts = segmentContexts(segments, cwd, env);
  return segments.some((segment, index) => {
    if (isShellStructure(segment.text)) return false;
    return contexts[index].some(({ directory, bindings }) =>
      expandSegmentBindings(segmentCommandText(segment.text), bindings, env).some(({ text }) => {
        const target = (path) => {
          const expanded = path.startsWith('~/') && toolHome ? `${toolHome}/${path.slice(2)}` : path;
          return isControl(expanded, directory ?? cwd, profileHome);
        };
        const parsed = shellInvocation(text);
        if (parsed.redirections.some(({ operator, operand }) => operator.includes('>') && target(operand.value)))
          return true;
        if ((fileProgramAnalysis(text).writes ?? []).some(target)) return true;
        const calls = executedInvocations(text, { cwd: directory, bindings }).pipelines.flat();
        return calls.some((call) => {
          if (call.script && call.delegated)
            return commandTouchesAgyControl(
              call.script,
              call.cwd ?? directory ?? cwd,
              profileHome,
              isControl,
              depth + 1,
              toolHome,
            );
          if (profileHome && call.name.toLowerCase() === 'security') return !isReadOnlySecurityCall(call);
          // Printing a filename is data. Read-only calls do not mutate the carrier.
          if (
            ['echo', 'printf', 'cd', 'pushd'].includes(call.name) ||
            classifyShellSegment(call.text ?? text) === 'read'
          )
            return false;
          return fileTargets(call).some(target);
        });
      }),
    );
  });
}
