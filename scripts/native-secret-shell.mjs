import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isCredentialSource } from './lib/secret-credential-paths.mjs';
import { ghOperation } from './lib/secret-gh-options.mjs';
import { executedInvocations } from './lib/shell-invocation.mjs';
import { programTokens } from './lib/shell-program-tokens.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';
import { splitShellExecutionSegments } from './native-effect-shell-classifier.mjs';
import { commandName, shellInvocation } from './native-effect-shell-tokenizer.mjs';

const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'sed', 'awk']);
const SECRET_ENV = /\$(?:\{)?[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)[A-Za-z0-9_]*/i;
const ENV_NAME = /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH/i;
const VALUE_OPTIONS = new Set(['-m', '-A', '-B', '-C', '--max-count', '--glob', '-g', '--type', '-t']);

export function secretShellDenial(command, cwd) {
  const host = hereDocumentView(command).host;
  for (const segment of splitShellExecutionSegments(host)) {
    const invocation = shellInvocation(segment);
    const program = commandName(invocation.words[0]?.value);
    if (readsCredentialEnvironment(program, invocation.words)) return 'credential_environment_blocked_before_read';
  }
  for (const invocation of executedInvocations(host, { cwd }).pipelines.flat()) {
    const reason = invocationDenial(invocation, cwd);
    if (reason) return reason;
  }
  return null;
}

function invocationDenial(invocation, cwd) {
  const program = commandName(invocation.program ?? invocation.name);
  const operands = invocation.programOperands ?? invocation.operands;
  if (
    READERS.has(program) &&
    readOperands(program, operands).some((path) => isCredentialSource(path, invocation.cwd ?? cwd))
  )
    return 'credential_source_blocked_before_read';
  if (
    invocation.redirections?.some(
      (entry) =>
        /^\d*(?:<|<>|<&)$/.test(entry.operator) && isCredentialSource(entry.operand?.value, invocation.cwd ?? cwd),
    )
  )
    return 'credential_source_blocked_before_read';
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
  if (invocation.environment?.some((item) => item.startsWith('PATH='))) return true;
  if (program === 'gh' && plainGhRead(invocation)) return false;
  if (!(invocation.program ?? '').includes('/'))
    return invocation.wrappers?.some(
      (wrapper) => commandName(wrapper.program) === 'command' && wrapper.options.includes('-p'),
    );
  try {
    return (
      realpathSync(invocation.program) !==
      realpathSync(fileURLToPath(new URL(`./guarded-bin/${program}`, import.meta.url)))
    );
  } catch {
    return true;
  }
}

function plainGhRead(invocation) {
  const operation = ghOperation(invocation.programOperands ?? invocation.operands);
  return (
    ['pr', 'issue', 'run', 'repo'].includes(operation.group) &&
    ['view', 'list', 'checks', 'status', 'diff'].includes(operation.action)
  );
}

function readsCredentialEnvironment(program, words) {
  if (words.some((word) => !word.literal && SECRET_ENV.test(word.value))) return true;
  if (program === 'env') return programTokens(words.map(({ value }) => value)).rest.length === 0;
  return program === 'printenv' && (words.length === 1 || words.slice(1).some((word) => ENV_NAME.test(word.value)));
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
