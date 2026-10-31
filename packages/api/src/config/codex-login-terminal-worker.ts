/** Thin terminal command adapter: native Codex owns all authentication and browser behavior. */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliTerminationController } from '../utils/CliTerminationController.js';
import { withoutUnreviewedCodexEnvironment } from './codex-env-namespace.js';

const requestPath = process.argv[2];
const request = JSON.parse(readFileSync(requestPath, 'utf8')) as {
  command: string;
  cwd: string;
  home: string;
  env: Record<string, string | null>;
  ownerPid: number;
};
const resultPath = join(request.home, '..', 'terminal-result.json');
const cancelPath = join(request.home, '..', 'terminal-cancel');
const env = { ...process.env };
// Terminal's own shell env is inherited here; keep its CODEX_*/OPENAI_* knobs out of the managed login.
for (const [key, value] of Object.entries(withoutUnreviewedCodexEnvironment(request.env, env))) {
  if (value === null) delete env[key];
  else env[key] = value;
}
function ownerGone(): boolean {
  try {
    process.kill(request.ownerPid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
let exitCode = 1;
if (!existsSync(cancelPath) && !ownerGone()) {
  const args = ['-c', 'cli_auth_credentials_store="file"', 'login'];
  const child = spawn(request.command, args, { cwd: request.cwd, env, stdio: 'inherit' });
  let exited = false;
  const termination = new CliTerminationController({
    child,
    isChildExited: () => exited,
    graces: { interruptMs: 300, terminateMs: 300 },
  });
  const cancel = () => termination.request('interrupt-first');
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  const monitor = setInterval(() => {
    if (existsSync(cancelPath) || ownerGone()) cancel();
  }, 100);
  const timeout = setTimeout(cancel, 15 * 60_000);
  try {
    exitCode = await new Promise<number>((resolve) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        console.error(`无法启动官方 Codex 命令（${error.code ?? 'unknown'}），请在账号条目重试。`);
        resolve(1);
      });
      child.once('exit', (code) => resolve(code ?? 1));
    });
    if (termination.getState() !== 'running' || existsSync(cancelPath)) exitCode = 1;
    if (exitCode === 0) {
      // A successful native login AND its official status are required; no raw output is persisted.
      try {
        execFileSync(request.command, [...args, 'status'], { cwd: request.cwd, env, timeout: 5000, stdio: 'ignore' });
      } catch {
        exitCode = 1;
      }
    }
  } finally {
    exited = true;
    termination.markExited();
    clearInterval(monitor);
    clearTimeout(timeout);
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
}
const temp = `${resultPath}.tmp`;
writeFileSync(temp, JSON.stringify({ exitCode }), { mode: 0o600, flag: 'wx' });
renameSync(temp, resultPath);
if (exitCode !== 0) console.error('官方 Codex 登录未完成。请查看上方输出，在原账号条目重试。');
process.exitCode = exitCode;
