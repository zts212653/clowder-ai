/**
 * F070: Governance Preflight Gate
 *
 * Checks if an external project is ready for cat dispatch.
 * Returns actionable state (needsBootstrap / needsConfirmation)
 * so the caller can surface instructions instead of silently blocking.
 * Fixes: clowder-ai#123 (preflight blocks new projects without guidance)
 */
import { readFile } from 'node:fs/promises';
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

  // Skills check removed: skill deployment (symlinks) is a separate concern
  // handled by drift detection (F228). When all skills are globally disabled,
  // governance bootstrap legitimately creates zero symlinks — that is NOT a
  // governance failure. The old check caused false governance_blocked when
  // F228 changed the symlink layout or when no skills were enabled.
  return { ready: true };
}
