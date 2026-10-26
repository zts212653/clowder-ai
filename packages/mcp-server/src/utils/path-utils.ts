/**
 * Path Utilities
 * 路径处理的内部工具函数
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSharedInvocationContext } from '../tools/invocation-auth.js';

export function expandHomeDir(inputPath: string): string {
  if (inputPath === '~') {
    return os.homedir();
  }
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function resolveAbsolutePath(inputPath: string): string {
  const shared = resolveSharedInvocationContext();
  return shared ? path.resolve(shared.workspaceRoot, expandHomeDir(inputPath)) : path.resolve(expandHomeDir(inputPath));
}

export function tryRealpathSync(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function stripTrailingSeparators(targetPath: string): string {
  const root = path.parse(targetPath).root;
  let result = targetPath;
  while (result.length > root.length && result.endsWith(path.sep)) {
    result = result.slice(0, -1);
  }
  return result;
}

export function isWithinPath(targetPath: string, baseDir: string): boolean {
  const normalizedTarget = stripTrailingSeparators(targetPath);
  const normalizedBase = stripTrailingSeparators(baseDir);
  const baseRoot = path.parse(normalizedBase).root;

  if (normalizedBase === baseRoot) {
    return normalizedTarget.startsWith(normalizedBase);
  }

  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + path.sep);
}

export function findDeepestExistingPath(targetPath: string): string | null {
  let current = targetPath;

  while (true) {
    if (fs.existsSync(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}
