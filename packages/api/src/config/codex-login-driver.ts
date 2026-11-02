import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { CodexAccountIdentity } from '@cat-cafe/shared';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import { finalizeCodexAccountEnvironment } from './codex-account-environment.js';
import { readCodexAccountIdentity } from './codex-account-identity.js';
import { assertCodexManagedPlatformSupport } from './codex-managed-support.js';

export interface CodexLoginDriver {
  run(input: { home: string; cwd: string; signal: AbortSignal; onReady: () => void }): Promise<CodexAccountIdentity>;
}
const execute = promisify(execFile);
const TERMINAL = `on run argv
  tell application "Terminal"
    do script item 1 of argv
    activate
  end tell
end run`;
/** The URL and browser never cross this adapter. Only an argv-quoted command is sent to Terminal. */
export async function openCodexLoginTerminal(shellCommand: string): Promise<void> {
  await execute('/usr/bin/osascript', ['-e', TERMINAL, shellCommand], { timeout: 5000, maxBuffer: 1024 });
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function createCodexTerminalLoginDriver(
  options: {
    command?: string;
    assertSupport?: (home: string) => void | Promise<void>;
    openTerminal?: typeof openCodexLoginTerminal;
  } = {},
): CodexLoginDriver {
  return {
    async run(input) {
      input.signal.throwIfAborted();
      const command = options.command ?? resolveCliCommand('codex');
      if (!command) throw new Error('codex_cli_unavailable');
      mkdirSync(input.home, { recursive: true, mode: 0o700 });
      await (options.assertSupport ?? assertCodexManagedPlatformSupport)(input.home);
      const args = ['-c', 'cli_auth_credentials_store="file"', 'login'];
      const env = finalizeCodexAccountEnvironment(
        {
          accountRef: 'login-attempt',
          accountRevision: 'login-attempt',
          accountOwnerRoot: input.cwd,
          authMode: 'oauth',
          credentialHome: input.home,
          stateRoot: input.home,
          sqliteHome: input.home,
        },
        { env: { HOME: dirname(input.home) }, args, cwd: input.cwd },
      );
      const request = join(dirname(input.home), 'terminal-request.json');
      const result = join(dirname(input.home), 'terminal-result.json');
      const cancel = join(dirname(input.home), 'terminal-cancel');
      writeFileSync(
        request,
        JSON.stringify({ command, cwd: input.cwd, home: input.home, env, ownerPid: process.pid }),
        { mode: 0o600, flag: 'wx' },
      );
      const source = import.meta.url.endsWith('.ts');
      const worker = fileURLToPath(new URL(`./codex-login-terminal-worker.${source ? 'ts' : 'js'}`, import.meta.url));
      const nodeArgs = source
        ? ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))]
        : [];
      const shellCommand = [process.execPath, ...nodeArgs, worker, request].map(quote).join(' ');
      let finished = false;
      try {
        // Keep Terminal's interactive shell: worker/CLI failure must leave its output visible.
        await (options.openTerminal ?? openCodexLoginTerminal)(shellCommand);
        input.signal.throwIfAborted();
        input.onReady();
        const deadline = Date.now() + 15 * 60_000;
        while (!existsSync(result)) {
          if (Date.now() >= deadline) throw new Error('codex_login_timeout');
          await delay(100, undefined, { signal: input.signal });
        }
        const completion: { exitCode: unknown } = JSON.parse(readFileSync(result, 'utf8'));
        input.signal.throwIfAborted();
        if (completion.exitCode !== 0) throw new Error('codex_login_failed');
        const identity = readCodexAccountIdentity(input.home);
        if (!identity) throw new Error('codex_login_identity_unavailable');
        finished = true;
        return identity;
      } finally {
        if (!finished) {
          writeFileSync(cancel, '', { mode: 0o600 });
          // Reuse the native child's existing termination controller; no terminal/window registry.
          for (let i = 0; i < 20 && !existsSync(result); i++) await delay(100);
        }
      }
    },
  };
}
export const nativeCodexLoginDriver = createCodexTerminalLoginDriver();
