import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AGY_NATIVE_READ_TOOLS } from '../agy-native-tools.js';

const LEGACY_READ_ONLY_TOOL_HASH = createHash('sha256')
  .update(AGY_NATIVE_READ_TOOLS.join('\n'))
  .digest('hex')
  .slice(0, 8);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsDirectoryPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function hostAgyNativeAgentName(
  catId: string,
  mode: 'normal' | 'readonly' | 'member' | 'watcher' = 'normal',
): string {
  if (!/^[a-z][a-z0-9-]*$/.test(catId)) throw new Error('Unsafe AGY native cat ID');
  if (mode === 'readonly') return `cat-cafe-host-${catId}-readonly`;
  if (mode === 'watcher') return `cat-cafe-host-${catId}-watcher`;
  if (mode === 'member') return `cat-cafe-host-${catId}-member`;
  return `cat-cafe-host-${catId}`;
}

export function matchesCatAgyAgentName(
  agentName: string,
  catId: string,
): { readonly matches: boolean; readonly bornReadOnly: boolean; readonly watcher?: boolean } {
  if (agentName === `cat-cafe-host-${catId}-watcher`) return { matches: true, bornReadOnly: false, watcher: true };
  if (agentName === `cat-cafe-host-${catId}` || agentName === `cat-cafe-${catId}`) {
    return { matches: true, bornReadOnly: false };
  }
  if (agentName === `cat-cafe-host-${catId}-readonly`) {
    return { matches: true, bornReadOnly: true };
  }
  const legacyPattern = new RegExp(`^cat-cafe-${escapeRegExp(catId)}-[a-f0-9]{16}(-auto)?(?:-([a-f0-9]{8}))?$`);
  const match = agentName.match(legacyPattern);
  if (!match) return { matches: false, bornReadOnly: false };
  const autoFlag = Boolean(match[1]);
  const toolHash = match[2];
  const bornReadOnly = !autoFlag && toolHash === LEGACY_READ_ONLY_TOOL_HASH;
  return { matches: true, bornReadOnly };
}

function resolveGitCommonDir(startDir: string): string | null {
  let current = startDir;
  for (;;) {
    const dotGit = join(current, '.git');
    try {
      const stat = lstatSync(dotGit);
      if (stat.isDirectory()) {
        const commondirFile = join(dotGit, 'commondir');
        if (existsSync(commondirFile)) {
          const relCommon = readFileSync(commondirFile, 'utf8').trim();
          if (relCommon) return realpathSync(resolve(dotGit, relCommon));
        }
        return realpathSync(dotGit);
      }
      if (stat.isFile()) {
        const raw = readFileSync(dotGit, 'utf8').trim();
        if (raw.startsWith('gitdir:')) {
          const gitDir = resolve(current, raw.slice('gitdir:'.length).trim());
          const commondirFile = join(gitDir, 'commondir');
          if (existsSync(commondirFile)) {
            const relCommon = readFileSync(commondirFile, 'utf8').trim();
            if (relCommon) return realpathSync(resolve(gitDir, relCommon));
          }
          return realpathSync(gitDir);
        }
      }
    } catch {
      /* continue walking upward */
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * AGY retains prior workspace directories inside the resumed conversation's active
 * workspace list. Allow continuing across the same workspace, subdirectories, or
 * sibling git worktrees of the same repository (provided prior workspace remains
 * valid and trusted when !autoApprove), while rotating to a fresh session when
 * switching to an unrelated repository.
 */
export function canResumeAgyWorkspaceScope(input: {
  readonly priorWorkspaceRoot: string;
  readonly nextWorkspaceRoot: string;
  readonly profileHome: string;
  readonly autoApprove: boolean;
  readonly trustedWorkspaces?: readonly string[];
}): boolean {
  let priorReal: string;
  try {
    priorReal = realpathSync(input.priorWorkspaceRoot);
    if (!lstatSync(priorReal).isDirectory()) return false;
  } catch {
    return false;
  }
  if (containsDirectoryPath(input.profileHome, priorReal) || containsDirectoryPath(priorReal, input.profileHome)) {
    return false;
  }
  if (!input.autoApprove) {
    const priorTrusted =
      input.trustedWorkspaces?.some((entry) => {
        if (!isAbsolute(entry)) return false;
        try {
          return realpathSync(entry) === priorReal;
        } catch {
          return false;
        }
      }) === true;
    if (!priorTrusted) return false;
  }
  if (priorReal === input.nextWorkspaceRoot) return true;
  if (
    containsDirectoryPath(priorReal, input.nextWorkspaceRoot) ||
    containsDirectoryPath(input.nextWorkspaceRoot, priorReal)
  ) {
    return true;
  }
  const priorGit = resolveGitCommonDir(priorReal);
  const nextGit = resolveGitCommonDir(input.nextWorkspaceRoot);
  return Boolean(priorGit && nextGit && priorGit === nextGit);
}
