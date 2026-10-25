import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isCredentialSource } from './lib/secret-credential-paths.mjs';
import { ghOperation } from './lib/secret-gh-options.mjs';
import { executedInvocations } from './lib/shell-invocation.mjs';
import { scanShellText } from './lib/shell-lexical.mjs';
import { programTokens } from './lib/shell-program-tokens.mjs';
import { constrainedGhApiOperation } from './native-effect-github-classifier.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';
import { observedReadProgram } from './native-effect-invocation-targets.mjs';
import { segmentCommandText, segmentContexts } from './native-effect-segment-locations.mjs';
import { splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { commandName, shellInvocation } from './native-effect-shell-tokenizer.mjs';

const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'sed', 'awk']);
const SECRET_ENV = /^\$(?:\{)?[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)[A-Za-z0-9_]*/i;
const ENV_NAME = /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH/i;
const VALUE_OPTIONS = new Set(['-m', '-A', '-B', '-C', '--max-count', '--glob', '-g', '--type', '-t']);

export function secretShellDenial(command, cwd, credentialSources) {
  const host = hereDocumentView(command).host;
  const parts = splitShellExecutionSegmentsWithSeparators(host);
  const contexts = segmentContexts(parts, cwd);
  for (const [index, part] of parts.entries()) {
    const source = segmentCommandText(part.text);
    for (const { directory } of contexts[index]) {
      const reason = credentialEnvironmentDenial(source, directory);
      if (reason) return reason;
    }
  }
  for (const invocation of contextualInvocations(parts, contexts)) {
    const reason = invocationDenial(invocation, cwd, credentialSources, host);
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

function invocationDenial(invocation, cwd, credentialSources, source) {
  const program = commandName(invocation.program ?? invocation.name);
  const operands = invocation.programOperands ?? invocation.operands;
  if (program === 'printenv' && readsPrintenv(operands)) return 'credential_environment_blocked_before_read';
  if (
    READERS.has(program) &&
    readOperands(program, operands).some((path) => isCredentialSource(path, invocation.cwd ?? cwd, credentialSources))
  )
    return 'credential_source_blocked_before_read';
  if (
    invocation.redirections?.some(
      (entry) =>
        /^\d*(?:<|<>|<&)$/.test(entry.operator) &&
        isCredentialSource(entry.operand?.value, invocation.cwd ?? cwd, credentialSources),
    )
  )
    return 'credential_source_blocked_before_read';
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

function credentialEnvironmentDenial(source, cwd) {
  // The literal argv reader deliberately omits expansions; lexical spans still
  // distinguish real reads from single-quoted or escaped variable spellings.
  if (scanShellText(source).parameters.some(({ start }) => SECRET_ENV.test(source.slice(start))))
    return 'credential_environment_blocked_before_read';
  const { words, syntaxComplete } = shellInvocation(source);
  const parsed = programTokens(
    words.map(({ value }) => value),
    cwd,
  );
  // `command -v` queries a name rather than running the queried program.
  if (
    parsed.wrappers.some(
      (wrapper) =>
        commandName(wrapper.program) === 'command' && wrapper.options.some((option) => ['-v', '-V'].includes(option)),
    )
  )
    return null;
  const hasEnv = parsed.wrappers.some((wrapper) => commandName(wrapper.program) === 'env');
  if (!parsed.complete || !syntaxComplete) return hasEnv ? 'credential_environment_uninspectable' : null;
  const envDump = parsed.rest.length === 0 && commandName(parsed.wrappers.at(-1)?.program) === 'env';
  if (envDump || (commandName(parsed.rest[0]) === 'printenv' && readsPrintenv(parsed.rest.slice(1))))
    return 'credential_environment_blocked_before_read';
  return null;
}

function readsPrintenv(operands) {
  const names = operands.filter((word) => !['-0', '--null', '--'].includes(word));
  return names.length === 0 || names.some((word) => ENV_NAME.test(word));
}

function readOperands(program, words) {
  const args = readerArguments(words, readerOptionRoles(program));
  // Explicit expressions can follow a filename. Decide positional roles only
  // after all options are known; pattern-file values are reads in their own right.
  let pattern =
    ['grep', 'rg', 'sed', 'awk'].includes(program) && !args.some(({ role }) => role === 'pattern' || role === 'file');
  return args
    .filter(({ role }) => {
      if (role === 'file') return true;
      if (role !== 'operand') return false;
      if (!pattern) return true;
      pattern = false;
      return false;
    })
    .map(({ value }) => value);
}

function readerArguments(words, roles) {
  let options = true;
  const args = [];
  for (let index = 0; index < words.length; index++) {
    const value = words[index];
    if (options && value === '--') {
      options = false;
      continue;
    }
    const option = options ? readerOption(value, roles) : null;
    if (option) {
      const argument = option.attached ?? words[++index];
      if (argument !== undefined) args.push({ role: option.role, value: argument });
      continue;
    }
    if (options && value.startsWith('-') && value !== '-') continue;
    args.push({ role: 'operand', value });
  }
  return args;
}

function readerOptionRoles(program) {
  const roles = new Map([...VALUE_OPTIONS].map((name) => [name, 'value']));
  if (['grep', 'rg', 'sed', 'awk'].includes(program)) {
    roles.set('-e', 'pattern');
    roles.set('-f', 'file');
    roles.set('--file', 'file');
  }
  if (['grep', 'rg'].includes(program)) roles.set('--regexp', 'pattern');
  if (program === 'sed') roles.set('--expression', 'pattern');
  if (program === 'awk') {
    roles.set('--source', 'pattern');
    for (const name of ['-F', '--field-separator', '-v', '--assign']) roles.set(name, 'value');
  }
  return roles;
}

function readerOption(value, roles) {
  if (value.startsWith('--')) {
    const equal = value.indexOf('=');
    const name = equal < 0 ? value : value.slice(0, equal);
    const role = roles.get(name);
    return role ? { role, attached: equal < 0 ? undefined : value.slice(equal + 1) } : null;
  }
  if (!value.startsWith('-')) return null;
  for (let cursor = 1; cursor < value.length; cursor++) {
    const role = roles.get(`-${value[cursor]}`);
    if (role) return { role, attached: value.slice(cursor + 1) || undefined };
  }
  return null;
}
