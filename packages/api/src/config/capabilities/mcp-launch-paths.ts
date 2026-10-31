import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function isAbsoluteMcpPath(value: string): boolean {
  return isAbsolute(value) || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value);
}

export function resolveMcpWorkingDir(workingDir: string | undefined, projectRoot: string): string | undefined {
  const trimmed = workingDir?.trim();
  if (!trimmed) return undefined;
  if (isAbsolute(trimmed)) return resolve(trimmed);
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) return trimmed;
  return resolve(projectRoot, trimmed);
}

/** Resolve file arguments without rewriting flags or literal non-file arguments. */
export function resolveMcpArgs(
  args: readonly string[] | undefined,
  workingDir: string | undefined,
  projectRoot: string,
): string[] {
  return (args ?? []).map((arg) => {
    if (isAbsoluteMcpPath(arg) || arg.startsWith('-')) return arg;
    if (workingDir) {
      const fromWorkDir = resolve(workingDir, arg);
      if (existsSync(fromWorkDir)) return fromWorkDir;
    }
    const fromRoot = resolve(projectRoot, arg);
    if (existsSync(fromRoot)) return fromRoot;
    return arg;
  });
}

export function resolveMcpCommand(command: string, workingDir: string | undefined, projectRoot: string): string {
  const pathLike =
    isAbsoluteMcpPath(command) || command.startsWith('.') || command.includes('/') || command.includes('\\');
  if (!pathLike || isAbsoluteMcpPath(command)) return command;
  if (workingDir) {
    const fromWorkDir = resolve(workingDir, command);
    if (existsSync(fromWorkDir)) return fromWorkDir;
  }
  const fromRoot = resolve(projectRoot, command);
  if (existsSync(fromRoot)) return fromRoot;
  return command;
}
