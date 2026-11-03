import { executedInvocations } from './lib/shell-invocation.mjs';
import { commandName } from './native-effect-shell-tokenizer.mjs';

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
]);

export const NATIVE_AUTH_DENIAL =
  'native_auth_mutation: Codex login/logout can revoke existing credentials, cancel another login and open the browser. ' +
  'Use Settings > Accounts to start a user-owned login; if unavailable on this platform, report that limitation. ' +
  'For diagnosis use codex login status or codex login --help. A temporary CODEX_HOME does not isolate the callback port.';

/** Classify resolved invocations, never command-looking text in data operands. */
export function codexAuthenticationEffect(invocations, depth = 0) {
  if (depth > 8) return undefined;
  const effects = invocations.map(({ name, operands }) => {
    const program = commandName(name ?? '').replace(/\.(?:exe|cmd|bat|ps1|[cm]?js)$/, '');
    const commandOption = SHELL_COMMAND_OPTIONS.get(program);
    if (commandOption) {
      const index = operands.findIndex((arg) => commandOption.test(arg));
      return index < 0
        ? undefined
        : codexAuthenticationEffect(
            executedInvocations(operands.slice(index + 1).join(' ')).pipelines.flat(),
            depth + 1,
          );
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
