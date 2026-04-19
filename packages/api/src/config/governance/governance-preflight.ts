/**
 * F070: Governance Preflight Gate
 *
 * Checks if an external project is ready for cat dispatch.
 * Returns actionable state (needsBootstrap / needsConfirmation)
 * so the caller can surface instructions instead of silently blocking.
 * Fixes: clowder-ai#123 (preflight blocks new projects without guidance)
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSameProject } from '../../utils/monorepo-root.js';
import type { Provider } from './governance-pack.js';
import { MANAGED_BLOCK_START } from './governance-pack.js';
import { GovernanceRegistry } from './governance-registry.js';

export interface PreflightResult {
  ready: boolean;
  reason?: string;
  needsBootstrap?: boolean;
  needsConfirmation?: boolean;
  bootstrapCommand?: string;
}

const CAT_PROVIDER_MAP: Record<string, Provider> = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  kimi: 'kimi',
};

const PROVIDER_CONFIG_FILE: Record<Provider, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  kimi: 'KIMI.md',
};

const PROVIDER_SKILLS_DIR: Record<Provider, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  gemini: '.gemini/skills',
  kimi: '.kimi/skills',
};

export async function checkGovernancePreflight(
  projectPath: string,
  catCafeRoot: string,
  catProvider?: string,
): Promise<PreflightResult> {
  if (isSameProject(projectPath, catCafeRoot)) {
    return { ready: true };
  }

  const registry = new GovernanceRegistry(catCafeRoot);
  const entry = await registry.get(projectPath);

  if (!entry) {
    return {
      ready: false,
      needsBootstrap: true,
      reason: `Governance not bootstrapped for ${projectPath}. Use POST /api/governance/confirm to bootstrap.`,
      bootstrapCommand: `POST /api/governance/confirm { "projectPath": "${projectPath}" }`,
    };
  }

  if (!entry.confirmedByUser) {
    return {
      ready: false,
      needsConfirmation: true,
      reason: `Governance bootstrap pending confirmation for ${projectPath}.`,
      bootstrapCommand: `POST /api/governance/confirm { "projectPath": "${projectPath}" }`,
    };
  }

  const govProvider = catProvider ? CAT_PROVIDER_MAP[catProvider] : undefined;
  const configFile = govProvider ? PROVIDER_CONFIG_FILE[govProvider] : 'CLAUDE.md';
  const skillsDirs = govProvider
    ? [PROVIDER_SKILLS_DIR[govProvider]]
    : ['.claude/skills', '.codex/skills', '.gemini/skills', '.kimi/skills'];

  try {
    const content = await readFile(join(projectPath, configFile), 'utf-8');
    if (!content.includes(MANAGED_BLOCK_START)) {
      return {
        ready: false,
        needsBootstrap: true,
        reason: `${configFile} missing governance managed block in ${projectPath}.`,
        bootstrapCommand: `POST /api/governance/confirm { "projectPath": "${projectPath}" }`,
      };
    }
  } catch {
    return {
      ready: false,
      needsBootstrap: true,
      reason: `${configFile} not found in ${projectPath}. Governance bootstrap may have failed.`,
      bootstrapCommand: `POST /api/governance/confirm { "projectPath": "${projectPath}" }`,
    };
  }

  // ADR-025: Skills may be directory-level symlinks (legacy) or real directories
  // containing per-skill symlinks. Check both patterns.
  let hasSkillsSetup = false;
  for (const dir of skillsDirs) {
    const dirPath = join(projectPath, dir);
    try {
      const dirStat = await lstat(dirPath);
      if (dirStat.isSymbolicLink()) {
        // Legacy directory-level symlink
        hasSkillsSetup = true;
        break;
      }
      if (dirStat.isDirectory()) {
        // ADR-025: real directory — check for per-skill symlinks inside
        const entries = await readdir(dirPath);
        for (const entry of entries) {
          try {
            const entryStat = await lstat(join(dirPath, entry));
            if (entryStat.isSymbolicLink()) {
              hasSkillsSetup = true;
              break;
            }
          } catch {
            /* skip unreadable entries */
          }
        }
        if (hasSkillsSetup) break;
      }
    } catch {
      // directory doesn't exist — continue
    }
  }
  if (!hasSkillsSetup) {
    const dirLabel = govProvider ? PROVIDER_SKILLS_DIR[govProvider] : 'skills';
    return {
      ready: false,
      needsBootstrap: true,
      reason: `No ${dirLabel} symlinks in ${projectPath}. Governance bootstrap may have failed.`,
      bootstrapCommand: `POST /api/governance/confirm { "projectPath": "${projectPath}" }`,
    };
  }

  return { ready: true };
}
