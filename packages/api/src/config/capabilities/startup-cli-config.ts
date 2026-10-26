import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findMonorepoRoot } from '../../utils/monorepo-root.js';
import {
  type CliConfigPaths,
  healCatCafeMcpTopology,
  readCapabilitiesConfig,
  reconcileMcpRuntimeConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from './capability-orchestrator.js';
import { isSameCapabilityRoot, resolveDeclaredCapabilityRoot } from './invoke-capability-root.js';

export interface StartupCliConfigContext {
  projectRoot: string;
  paths: CliConfigPaths;
}

export interface StartupCliConfigRegenerationResult {
  projectRoot: string;
  generated: boolean;
  healed: boolean;
}

export function resolveStartupCliConfigContext(
  start = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): StartupCliConfigContext {
  const explicitWorkspace = env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  const projectRoot = resolveDeclaredCapabilityRoot(env) ?? findMonorepoRoot(explicitWorkspace || start);
  return {
    projectRoot,
    paths: {
      google: join(projectRoot, '.gemini', 'settings.json'),
      antigravity: join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
    },
  };
}

/** A preview can read shared configuration, but only its persistent owner may publish. */
export function allowsImplicitCapabilityWrites(env: NodeJS.ProcessEnv, binaryRoot: string): boolean {
  const deployment = env.CAT_CAFE_DEPLOYMENT_ID?.trim();
  if (deployment === 'runtime') {
    const runtimeRoot = env.CAT_CAFE_RUNTIME_ROOT?.trim();
    if (runtimeRoot) return isSameCapabilityRoot(binaryRoot, runtimeRoot);
  } else if (deployment) {
    return false;
  }
  try {
    // Linked checkouts inherit the runtime environment, not publication ownership.
    // A standalone/public installation has no .git file and retains first-run setup.
    return !statSync(join(binaryRoot, '.git')).isFile();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export async function regenerateStartupCliConfigs(
  start = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartupCliConfigRegenerationResult> {
  const { projectRoot, paths } = resolveStartupCliConfigContext(start, env);
  // A preview verifies an isolated build; it has no authority to repoint shared
  // workspace/HOME configurations to its transient MCP binaries.
  if (!allowsImplicitCapabilityWrites(env, findMonorepoRoot(start))) {
    return { projectRoot, generated: false, healed: false };
  }
  return withCapabilityLock(projectRoot, async () => {
    let config = await readCapabilitiesConfig(projectRoot);
    // An explicitly empty registry is a user choice. Only the first-run owner
    // may initialize an absent file; startup regeneration cannot turn an empty
    // one into a newly enabled collaboration surface.
    if (!config || config.capabilities.length === 0) return { projectRoot, generated: false, healed: false };

    const runtimeRoot = env.CAT_CAFE_RUNTIME_ROOT?.trim();
    const healed = healCatCafeMcpTopology(
      config,
      runtimeRoot ? { projectRoot, catCafeRepoRoot: runtimeRoot } : { projectRoot },
    );
    config = healed.config;
    if (healed.migrated) {
      await writeCapabilitiesConfig(projectRoot, config);
    }

    await reconcileMcpRuntimeConfig(config, paths, projectRoot);
    return { projectRoot, generated: true, healed: healed.migrated };
  });
}
