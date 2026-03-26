/**
 * F070: Governance Bootstrap Service
 *
 * Core engine that writes governance pack to external projects.
 * Handles managed blocks, skills symlinks, methodology skeleton,
 * and bootstrap reporting.
 */

import { lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { BootstrapAction, BootstrapReport } from '@cat-cafe/shared';
import { pathsEqual } from '../../utils/project-path.js';
import type { Provider } from './governance-pack.js';
import {
  computePackChecksum,
  GOVERNANCE_PACK_VERSION,
  getGovernanceManagedBlock,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
} from './governance-pack.js';
import { GovernanceRegistry } from './governance-registry.js';
import { getMethodologyTemplates } from './methodology-templates.js';

const IS_WIN32 = process.platform === 'win32';

/** Provider instruction file mapping */
const PROVIDER_FILES: Record<Provider, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
};

/** Provider skills directory mapping */
const PROVIDER_SKILLS_DIRS: Record<Provider, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  gemini: '.gemini/skills',
};

/** Provider hooks directory mapping (F070 Phase 2) */
const PROVIDER_HOOKS_DIRS: Record<Provider, string> = {
  claude: '.claude/hooks',
  codex: '.codex/hooks',
  gemini: '.gemini/hooks',
};

export interface BootstrapOptions {
  dryRun: boolean;
}

export class GovernanceBootstrapService {
  private readonly registry: GovernanceRegistry;

  constructor(private readonly catCafeRoot: string) {
    this.registry = new GovernanceRegistry(catCafeRoot);
  }

  getRegistry(): GovernanceRegistry {
    return this.registry;
  }

  async bootstrap(targetProject: string, opts: BootstrapOptions): Promise<BootstrapReport> {
    const actions: BootstrapAction[] = [];
    const packVersion = GOVERNANCE_PACK_VERSION;
    const checksum = computePackChecksum();

    // 1. Managed blocks in provider instruction files
    for (const [provider, filename] of Object.entries(PROVIDER_FILES) as [Provider, string][]) {
      const action = await this.writeManagedBlock(targetProject, provider, filename, opts.dryRun);
      actions.push(action);
    }

    // 2. Skills symlinks for all 3 providers
    for (const [provider, skillsDir] of Object.entries(PROVIDER_SKILLS_DIRS) as [Provider, string][]) {
      const action = await this.symlinkSkills(targetProject, provider, skillsDir, opts.dryRun);
      actions.push(action);
    }

    // 2b. Hooks symlinks for providers that have source hooks
    for (const [provider, hooksDir] of Object.entries(PROVIDER_HOOKS_DIRS) as [Provider, string][]) {
      const action = await this.symlinkHooks(targetProject, provider, hooksDir, opts.dryRun);
      if (action) actions.push(action);
    }

    // 3. Methodology skeleton (only create missing files)
    const templates = getMethodologyTemplates();
    for (const template of templates) {
      const action = await this.writeTemplate(targetProject, template.relativePath, template.content, opts.dryRun);
      actions.push(action);
    }

    // 4. Save bootstrap report
    const report: BootstrapReport = {
      projectPath: targetProject,
      timestamp: Date.now(),
      packVersion,
      actions,
      dryRun: opts.dryRun,
    };

    if (!opts.dryRun) {
      await this.saveReport(targetProject, report);
      await this.registry.register(targetProject, {
        packVersion,
        checksum,
        syncedAt: Date.now(),
        confirmedByUser: true,
      });
    }

    return report;
  }

  private async writeManagedBlock(
    targetProject: string,
    provider: Provider,
    filename: string,
    dryRun: boolean,
  ): Promise<BootstrapAction> {
    const filePath = resolve(targetProject, filename);
    const block = getGovernanceManagedBlock(provider);
    let existingContent = '';

    try {
      existingContent = await readFile(filePath, 'utf-8');
    } catch {
      // File doesn't exist — will create
    }

    // Check if managed block already exists
    const startIdx = existingContent.indexOf(MANAGED_BLOCK_START);
    const endIdx = existingContent.indexOf(MANAGED_BLOCK_END);

    if (startIdx >= 0 && endIdx >= 0) {
      // Replace existing managed block
      const before = existingContent.slice(0, startIdx);
      const after = existingContent.slice(endIdx + MANAGED_BLOCK_END.length);
      const newContent = before + block + after;

      if (newContent === existingContent) {
        return { file: filename, action: 'skipped', reason: 'managed block already up to date' };
      }

      if (!dryRun) {
        await writeFile(filePath, newContent, 'utf-8');
      }
      return { file: filename, action: 'updated', reason: 'managed block replaced with new version' };
    }

    // Append managed block to existing file, or create new file
    const newContent = existingContent ? `${existingContent}\n\n${block}\n` : `${block}\n`;

    if (!dryRun) {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, newContent, 'utf-8');
    }

    return {
      file: filename,
      action: existingContent ? 'updated' : 'created',
      reason: existingContent ? 'managed block appended to existing file' : 'file created with managed block',
    };
  }

  private async symlinkSkills(
    targetProject: string,
    _provider: Provider,
    skillsDir: string,
    dryRun: boolean,
  ): Promise<BootstrapAction> {
    const targetPath = resolve(targetProject, skillsDir);
    const sourcePath = resolve(this.catCafeRoot, 'cat-cafe-skills');

    // Check if symlink already exists and points to the right place
    try {
      const stat = await lstat(targetPath);
      if (stat.isSymbolicLink()) {
        const currentTarget = await readlink(targetPath);
        const resolvedCurrent = resolve(dirname(targetPath), currentTarget);
        if (pathsEqual(resolvedCurrent, sourcePath)) {
          return { file: skillsDir, action: 'skipped', reason: 'symlink already correct' };
        }
      }
      // Exists but not a symlink or wrong target — skip to avoid damage
      return { file: skillsDir, action: 'skipped', reason: 'path exists but is not a symlink to cat-cafe-skills' };
    } catch {
      // Doesn't exist — create
    }

    if (!dryRun) {
      await mkdir(dirname(targetPath), { recursive: true });
      // Windows: use junction (no admin privileges needed, requires absolute path)
      // Unix: use relative symlink for portability
      if (IS_WIN32) {
        await symlink(sourcePath, targetPath, 'junction');
      } else {
        const relPath = relative(dirname(targetPath), sourcePath);
        await symlink(relPath, targetPath);
      }
    }

    return { file: skillsDir, action: 'symlinked', reason: `linked to ${sourcePath}` };
  }

  private async symlinkHooks(
    targetProject: string,
    _provider: Provider,
    hooksDir: string,
    dryRun: boolean,
  ): Promise<BootstrapAction | null> {
    // Source hooks dir must exist in catCafeRoot
    const sourceHooksPath = resolve(this.catCafeRoot, hooksDir);
    try {
      const stat = await lstat(sourceHooksPath);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) return null;
    } catch {
      // Source hooks dir doesn't exist — silently skip
      return null;
    }

    const targetPath = resolve(targetProject, hooksDir);

    // Check if symlink already exists and points to the right place
    try {
      const stat = await lstat(targetPath);
      if (stat.isSymbolicLink()) {
        const currentTarget = await readlink(targetPath);
        const resolvedCurrent = resolve(dirname(targetPath), currentTarget);
        if (pathsEqual(resolvedCurrent, sourceHooksPath)) {
          return { file: hooksDir, action: 'skipped', reason: 'hooks symlink already correct' };
        }
      }
      return { file: hooksDir, action: 'skipped', reason: 'hooks path exists but is not a symlink to cat-cafe hooks' };
    } catch {
      // Doesn't exist — create
    }

    if (!dryRun) {
      await mkdir(dirname(targetPath), { recursive: true });
      if (IS_WIN32) {
        await symlink(sourceHooksPath, targetPath, 'junction');
      } else {
        const relPath = relative(dirname(targetPath), sourceHooksPath);
        await symlink(relPath, targetPath);
      }
    }

    return { file: hooksDir, action: 'symlinked', reason: `hooks linked to ${sourceHooksPath}` };
  }

  private async writeTemplate(
    targetProject: string,
    relativePath: string,
    content: string,
    dryRun: boolean,
  ): Promise<BootstrapAction> {
    const filePath = resolve(targetProject, relativePath);

    // Check path doesn't escape target project
    const rel = relative(targetProject, filePath);
    if (rel.startsWith(`..${sep}`) || rel === '..') {
      return { file: relativePath, action: 'skipped', reason: 'path escapes project root' };
    }

    // Never overwrite existing files
    try {
      await lstat(filePath);
      return { file: relativePath, action: 'skipped', reason: 'file already exists' };
    } catch {
      // Doesn't exist — create
    }

    if (!dryRun) {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf-8');
    }

    return { file: relativePath, action: 'created', reason: 'template generated' };
  }

  private async saveReport(targetProject: string, report: BootstrapReport): Promise<void> {
    const dir = resolve(targetProject, '.cat-cafe');
    await mkdir(dir, { recursive: true });
    const filePath = resolve(dir, 'governance-bootstrap-report.json');
    await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  }
}
