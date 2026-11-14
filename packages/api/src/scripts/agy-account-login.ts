import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertAgyCredentialHome } from '../config/agy-account.js';
import { isolatedOAuthEnv } from '../domains/cats/services/agents/providers/agy-native/launch/agy-native-launch-env.js';
import { resolveCliCommand } from '../utils/cli-resolve.js';

/** Same OAuth environment as Native: preserve host proxies, remove alternate billing/auth. */
export function prepareAgyAccountLogin(home: string, command = resolveCliCommand('agy')) {
  assertAgyCredentialHome(home);
  if (!command) throw new Error('Install the official agy CLI first');
  const env = Object.fromEntries(
    Object.entries(isolatedOAuthEnv(home)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  env.SSH_TTY = 'cat-cafe-file-auth';
  return { command, cwd: home, env };
}

/** Invoked by the human in their own terminal; the official CLI owns all OAuth interaction. */
export async function loginAgyAccount(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { home: { type: 'string' }, help: { type: 'boolean' } },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      'Usage: pnpm agy:account:login --home <account-directory>\nComplete personal Google OAuth in the official CLI.\n',
    );
    return 0;
  }
  if (!values.home) throw new Error('Supply the account directory shown in Accounts');
  const { command, ...options } = prepareAgyAccountLogin(values.home);
  const child = spawn(command, [], { ...options, stdio: 'inherit' });
  const [code] = await once(child, 'close');
  return typeof code === 'number' ? code : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loginAgyAccount(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('AGY login could not start. Check the official CLI and account directory.\n');
      process.exitCode = 1;
    });
}
