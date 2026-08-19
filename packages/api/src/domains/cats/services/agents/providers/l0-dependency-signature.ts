import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SHARED_RULES_RELPATH } from '../../context/governance-l0.js';

const GOVERNANCE_RULES_RELPATHS = [
  SHARED_RULES_RELPATH,
  'cat-cafe-skills/refs/shared-rules.local.md',
  'cat-cafe-skills/refs/shared-rules.local-override.md',
] as const;

function findWorkspaceRoot(start: string): string {
  let dir = resolve(start);
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return resolve(start);
}

function addStatFingerprint(filePath: string, label: string, entries: string[]): boolean {
  try {
    const stat = statSync(filePath);
    entries.push(
      `${label}\t${stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other'}\t${stat.size}\t${stat.mtimeMs}`,
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      entries.push(`${label}\tmissing`);
      return true;
    }
    return false;
  }
}

function collectDirectoryFingerprints(dirPath: string, label: string, entries: string[]): boolean {
  if (!addStatFingerprint(dirPath, label, entries)) return false;
  if (!existsSync(dirPath)) return true;

  let dirents: Array<{ name: string; isDirectory(): boolean }>;
  try {
    dirents = readdirSync(dirPath, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }

  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    const childPath = resolve(dirPath, dirent.name);
    const childLabel = `${label}/${dirent.name}`;
    if (dirent.isDirectory()) {
      if (!collectDirectoryFingerprints(childPath, childLabel, entries)) return false;
    } else if (!addStatFingerprint(childPath, childLabel, entries)) return false;
  }
  return true;
}

function computeSignature(cwd: string, scriptPath: string): string | null {
  const repoRoot = resolve(dirname(scriptPath), '..');
  const workspaceRoot = findWorkspaceRoot(cwd);
  const entries: string[] = [];
  if (
    !addStatFingerprint(
      resolve(repoRoot, 'assets/system-prompts/system-prompt-l0.md'),
      'assets/system-prompts/system-prompt-l0.md',
      entries,
    ) ||
    !collectDirectoryFingerprints(resolve(repoRoot, 'assets/prompt-templates'), 'assets/prompt-templates', entries)
  ) {
    return null;
  }
  for (const relPath of GOVERNANCE_RULES_RELPATHS) {
    if (!addStatFingerprint(resolve(repoRoot, relPath), relPath, entries)) return null;
  }
  if (
    !collectDirectoryFingerprints(
      resolve(workspaceRoot, '.cat-cafe', 'prompt-overlays'),
      '.cat-cafe/prompt-overlays',
      entries,
    )
  ) {
    return null;
  }
  entries.sort();
  return entries.join('\n');
}

export class L0DependencySignatureTracker {
  private currentSignature: string | null = null;

  refresh(cwd: string, scriptPath: string, invalidate: () => void): string | null {
    const nextSignature = computeSignature(cwd, scriptPath);
    if (nextSignature === null) {
      invalidate();
      this.currentSignature = null;
      return null;
    }
    if (this.currentSignature !== null && this.currentSignature !== nextSignature) invalidate();
    this.currentSignature = nextSignature;
    return nextSignature;
  }

  isCurrent(signature: string): boolean {
    return this.currentSignature === signature;
  }
}
