import { scriptFileCall } from './lib/shell-code-inputs.mjs';
import { executedInvocations } from './lib/shell-invocation.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';
import { commandName, shellInvocation } from './native-effect-shell-tokenizer.mjs';

const SHELL_COMMAND_OPTIONS = new Map([
  ['powershell', /^-(?:command|c)$/i],
  ['pwsh', /^-(?:command|c)$/i],
  ['cmd', /^\/[ck]$/i],
]);
const VALUE_OPTIONS = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '-p',
  '--profile',
  '-C',
  '--cd',
  '-m',
  '--model',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  '--add-dir',
  '-i',
  '--image',
  '--local-provider',
  '--remote',
  '--remote-auth-token-env',
  '--experimental_issuer',
  '--experimental_client-id',
  '--api-key',
]);

export const NATIVE_AUTH_DENIAL =
  'native_auth_mutation: Codex login/logout can revoke existing credentials, cancel another login and open the browser. ' +
  'Use Settings > Accounts to start a user-owned login; if unavailable on this platform, report that limitation. ' +
  'For diagnosis use codex login status or codex login --help. A temporary CODEX_HOME does not isolate the callback port.';

/** Native shell carriers share command extraction and data-aware authentication admission. */
export function nativeAuthenticationDenial(input) {
  const command = typeof input === 'string' ? input : (input?.command ?? input?.cmd);
  return typeof command === 'string' &&
    codexAuthenticationEffect(executedInvocations(hereDocumentView(command).judged).pipelines.flat()) ===
      'auth_mutation'
    ? NATIVE_AUTH_DENIAL
    : null;
}

/** Classify resolved invocations, never command-looking text in data operands. */
export function codexAuthenticationEffect(invocations, depth = 0) {
  if (depth > 8) return undefined;
  const effects = invocations.map((invocation) => {
    const view = literalWindowsInvocation(invocation);
    const { program, operands, text } = view;
    const commandOption = SHELL_COMMAND_OPTIONS.get(program);
    if (commandOption) return shellAuthenticationEffect(view, commandOption, depth);
    if (program === 'node' && !operands.some((arg) => ['-e', '--eval', '-p', '--print'].includes(arg))) {
      const script = scriptFileCall(operands, text);
      return script ? codexAuthenticationEffect([script], depth + 1) : undefined;
    }
    if (program !== 'codex') return undefined;
    const { words, help } = codexArguments(operands);
    const [subcommand, action] = words;
    if (subcommand === 'help' || (help && words.length === 0)) return 'read';
    if (!['login', 'logout'].includes(subcommand)) return undefined;
    return help || (subcommand === 'login' && action === 'status') ? 'read' : 'auth_mutation';
  });
  if (effects.includes('auth_mutation')) return 'auth_mutation';
  return effects.length > 0 && effects.every((effect) => effect === 'read') ? 'read' : undefined;
}

/** Recover literal Windows spelling without changing the shared POSIX reader. */
function literalWindowsInvocation({ name, operands, text = '' }) {
  const rawWords = shellInvocation(text).words.map(({ value, start, end }) => ({
    value,
    raw: text.slice(start, end),
    end,
  }));
  const programWord = rawWords.find(({ value }) => commandName(value) === name);
  const windowsWords = rawWords.filter(({ raw }) =>
    /^(?:\\|[^\\\s"'`$;&|<>()*?{}]+\\)[^\s"'`$;&|<>()*?{}]+$/.test(raw),
  );
  let program = commandName(name ?? '').replace(/\.(?:exe|cmd|bat|ps1|[cm]?js)$/, '');
  // Preserve a known POSIX identity too: co\dex.exe still executes codex.exe in Bash.
  if (program !== 'codex' && !SHELL_COMMAND_OPTIONS.has(program) && windowsWords.includes(programWord))
    program = commandName(programWord.raw).replace(/\.(?:exe|cmd|bat|ps1|[cm]?js)$/, '');
  return {
    program,
    operands: operands.map((arg) => windowsWords.find(({ value }) => value === arg)?.raw ?? arg),
    rawWords,
    text,
  };
}

/** Whole-script quotes and executable-only quotes carry different word boundaries. */
function shellAuthenticationEffect({ operands, rawWords, text }, commandOption, depth) {
  const index = operands.findIndex((arg) => commandOption.test(arg));
  if (index < 0) return undefined;
  const sources = [operands.slice(index + 1).join(' ')];
  const codeStart = rawWords.find(({ value }) => value === operands[index])?.end;
  if (codeStart !== undefined) sources.push(text.slice(codeStart));
  const effects = sources.map((source) =>
    codexAuthenticationEffect(executedInvocations(source).pipelines.flat(), depth + 1),
  );
  if (effects.includes('auth_mutation')) return 'auth_mutation';
  return effects.includes('read') ? 'read' : undefined;
}

/** Codex's Clap options own their values, including values resembling subcommands/help. */
function codexArguments(operands) {
  const words = [];
  let help = false;
  for (let index = 0; index < operands.length; index++) {
    const arg = operands[index];
    if (arg === '--') {
      words.push(...operands.slice(index + 1));
      break;
    }
    if (VALUE_OPTIONS.has(arg.split('=', 1)[0])) {
      if (!arg.includes('=')) index++;
      continue;
    }
    if (/^-[cpmCisa].+/.test(arg)) continue;
    // Codex 0.161.0 derives Clap Parser; help exits before authentication handlers.
    if (['-h', '--help', '-V', '--version'].includes(arg)) help = true;
    if (!arg.startsWith('-')) words.push(arg);
  }
  return { words, help };
}
