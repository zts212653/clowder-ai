import { executedInvocations, optionValue } from './lib/shell-invocation.mjs';
import { scanShellText } from './lib/shell-lexical.mjs';
import { extractSubstitutions } from './lib/shell-text.mjs';
import { programNamespaceStability } from './native-effect-copy-namespace.mjs';
import { segmentCommandText, segmentContexts } from './native-effect-segment-locations.mjs';
import { classifyShellSegment, splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { hasConcurrentShellExecution } from './native-effect-shell-concurrency.mjs';
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
export function commandTouchesAgyControl(
  command,
  cwd,
  profileHome,
  isControl,
  depth = 0,
  toolHome = profileHome,
  builtinContext = true,
) {
  const env = { ...process.env, ...(toolHome ? { HOME: toolHome } : {}) };
  return inspectScript(command, { cwd, depth, builtinContext }, { profileHome, toolHome, isControl, env });
}

// A substitution inherits a fork of the caller's shell data. A new interpreter
// starts without a native-builtin certificate; neither path borrows outer text.
function inspectScript(command, scope, owner) {
  if (scope.depth > 8) return true;
  const parts = splitShellExecutionSegmentsWithSeparators(command);
  const namespaces = programNamespaceStability(
    parts.map(({ text }) => ({ segment: text })),
    scope.builtinContext && !hasConcurrentShellExecution(scanShellText(command), command, true),
  );
  for (let index = 1; index < parts.length; index++)
    if (['|', '|&'].includes(parts[index].separator)) {
      namespaces[index] = false;
      namespaces[index - 1] = false;
    }
  const contexts = segmentContexts(parts, scope.cwd, owner.env, namespaces, scope);
  // Keep every pipeline's producer and consumer in one reader invocation.
  return parts.some((part, index) => {
    if (['|', '|&'].includes(part.separator)) return false;
    let end = index;
    while (['|', '|&'].includes(parts[end + 1]?.separator)) end++;
    const chain = parts
      .slice(index, end + 1)
      .map((p, i) => `${i ? p.separator : ''} ${segmentCommandText(p.text)}`)
      .join(' ');
    return contexts[index].some(({ directory, bindings, parameters }) => {
      const active = {
        cwd: directory ?? scope.cwd,
        bindings,
        parameters,
        depth: scope.depth,
        builtinContext: namespaces[index] && index === end,
      };
      // Inspect child source before expanding the host's argv: host expansion
      // must not rewrite a child's later binding or confuse its nested quotes.
      const substitutions = extractSubstitutions(chain);
      if (substitutions.inner.some((inner) => inspectScript(inner, { ...active, depth: scope.depth + 1 }, owner)))
        return true;
      return expandSegmentBindings(substitutions.text, bindings, owner.env).some(({ text }) =>
        inspectChain(text, active, owner),
      );
    });
  });
}

function inspectChain(text, scope, owner) {
  const target = (path, cwd = scope.cwd) => {
    const expanded = path.startsWith('~/') && owner.toolHome ? `${owner.toolHome}/${path.slice(2)}` : path;
    return owner.isControl(expanded, cwd, owner.profileHome);
  };
  if (writesControl(shellInvocation(text).redirections, target)) return true;
  if ((fileProgramAnalysis(text).writes ?? []).some((path) => target(path))) return true;
  const calls = executedInvocations(text, scope).pipelines.flat();
  return calls.some((call) => {
    const cwd = call.cwd ?? scope.cwd;
    if (writesControl(call.redirections ?? [], (path) => target(path, cwd))) return true;
    if (
      call.script &&
      call.delegated &&
      inspectScript(call.script, { cwd, depth: scope.depth + 1, builtinContext: false }, owner)
    )
      return true;
    if (call.lookupOnly) return false;
    if (owner.profileHome && call.name?.toLowerCase() === 'security') return !isReadOnlySecurityCall(call);
    // An execution call that was not certified by its own reader must not be
    // recertified by parsing call.text with the parent namespace.
    if (
      ['echo', 'printf', 'cd', 'pushd'].includes(call.name) ||
      classifyShellSegment(call.text ?? text, { builtinContext: false }) === 'read'
    )
      return false;
    return fileTargets(call).some((path) => target(path, cwd));
  });
}

function writesControl(redirections, target) {
  return redirections.some(
    ({ operator, operand }) => operator.includes('>') && typeof operand?.value === 'string' && target(operand.value),
  );
}
