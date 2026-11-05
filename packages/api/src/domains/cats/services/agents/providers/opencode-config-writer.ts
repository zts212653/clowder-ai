/**
 * OpenCode config file writers — separated from opencode-config-template.ts
 * to keep the core template generator under the 350-line module budget.
 *
 * Handles:
 * - captureOpenCodeMcpConfig: reads the existing MCP plan before admission waits
 * - writeOpenCodeRuntimeConfig: full runtime config (with async pencil resolution)
 * - writeOpenCodeInstructionsOnlyConfig: instructions-only config (F203 Phase I)
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  expandManagedMcpNamesForUserMerge,
  resolvePencilCommand,
  resolveServersForCat,
} from '../../../../../config/capabilities/capability-orchestrator.js';
import {
  isSameCapabilityRoot,
  resolveInvokeCapabilityRoot,
} from '../../../../../config/capabilities/invoke-capability-root.js';
import {
  observeInvocationMcpSource,
  readInvocationMcpFile,
} from '../../../../../config/capabilities/invoke-mcp-config.js';
import { toOpenCodeMcpEntry } from '../../../../../config/capabilities/mcp-config-adapters.js';
import { isRetiredGithubMcpConfigEntry } from '../../../../../config/capabilities/retired-github-mcp.js';
import {
  buildExternalDirectoryPermissions,
  generateOpenCodeRuntimeConfig,
  type OpenCodeRuntimeConfigOptions,
} from './opencode-config-template.js';
import { buildOpenCodeMcpSync, resolveCapabilityMcpNamesSync } from './opencode-mcp-injection.js';
import { withOpenCodeSecretGuard } from './opencode-secret-config.js';

// ─── Config file writers ──────────────────────────────────────────

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/**
 * F203 Phase I: Write an instructions-only opencode config (no provider block).
 *
 * Used for OpenCode fallback paths (subscription/unresolved/known-model) where
 * a full runtime config is not generated. Instructions plus the managed security
 * plugin let OpenCode read L0 + OPENCODE.md without replacing auth. No provider/apiKey fields
 * → `buildEnv` must NOT clear native auth when this config is set.
 *
 * Callers must also set `CAT_CAFE_OC_INSTRUCTIONS_ONLY=1` in callbackEnv so
 * `OpenCodeAgentService.buildEnv` knows to preserve native auth.
 */
export function writeOpenCodeInstructionsOnlyConfig(
  projectRoot: string,
  catId: string,
  invocationId: string,
  instructions: readonly string[],
  externalDirectories?: readonly string[],
): string {
  const safeCatId = sanitizePathSegment(catId);
  const safeInvocationId = sanitizePathSegment(invocationId);
  const configDir = join(projectRoot, '.cat-cafe', `oc-config-${safeCatId}-${safeInvocationId}`);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configPath = join(configDir, 'opencode.json');
  const tempPath = `${configPath}.tmp-${process.pid}`;
  const config: {
    $schema: string;
    instructions: string[];
    plugin?: string[];
    permission?: { external_directory: Record<string, string> };
  } = {
    $schema: 'https://opencode.ai/config.json',
    instructions: [...instructions],
  };
  const externalDirectoryPermissions = buildExternalDirectoryPermissions(externalDirectories);
  if (externalDirectoryPermissions) {
    config.permission = { external_directory: externalDirectoryPermissions };
  }
  writeFileSync(tempPath, JSON.stringify(withOpenCodeSecretGuard(config), null, 2), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(tempPath, configPath);
  return configPath;
}

export interface OpenCodeMcpConfigPlan {
  readonly mcp: Readonly<Record<string, unknown>>;
  readonly mcpServerPath?: string;
}

/** Read native OpenCode MCP settings without writing an invocation config or credentials. */
export async function captureOpenCodeMcpConfig(
  projectRoot: string,
  catId: string,
  options: Pick<
    OpenCodeRuntimeConfigOptions,
    'mcpServerPath' | 'allowedWorkspaceDirs' | 'catId' | 'capabilitiesProjectRoot'
  >,
  workingDirectory?: string,
): Promise<OpenCodeMcpConfigPlan> {
  const capabilitiesProjectRoot = await resolveInvokeCapabilityRoot(
    options.capabilitiesProjectRoot ??
      (options.mcpServerPath ? resolve(dirname(options.mcpServerPath), '../../..') : projectRoot),
  );
  const config: { mcp?: Record<string, unknown> } = {};
  if (options.mcpServerPath)
    config.mcp = buildOpenCodeMcpSync(
      options.mcpServerPath,
      options.catId ?? catId,
      capabilitiesProjectRoot,
      workingDirectory,
      options.allowedWorkspaceDirs,
    );

  // Resolve pencil at invoke time (async) — only if enabled in capabilities.json
  if (options.mcpServerPath) {
    const effectiveCatId = options.catId ?? catId;
    let pencilEnabled = false;
    let configSourceRoot = capabilitiesProjectRoot;
    try {
      // F249: Project config is the single truth source for MCP resolution.
      let capConfig = null;
      let accessScope: 'global' | 'project' = 'global';
      if (workingDirectory && !isSameCapabilityRoot(workingDirectory, capabilitiesProjectRoot)) {
        try {
          const projectRaw = readInvocationMcpFile(join(workingDirectory, '.cat-cafe', 'capabilities.json'));
          const parsed = JSON.parse(projectRaw);
          if (parsed?.version === 1 || parsed?.version === 2) {
            capConfig = parsed;
            configSourceRoot = workingDirectory;
            accessScope = 'project';
          }
        } catch {
          /* No project config — fall back to global */
        }
      }
      if (!capConfig) {
        const raw = readInvocationMcpFile(join(capabilitiesProjectRoot, '.cat-cafe', 'capabilities.json'));
        const parsed = JSON.parse(raw);
        if (parsed?.version === 1 || parsed?.version === 2) capConfig = parsed;
      }
      if (capConfig && effectiveCatId) {
        pencilEnabled = (
          resolveServersForCat(capConfig, effectiveCatId, { accessScope }) as Array<{
            name: string;
            enabled: boolean;
            resolver?: string;
          }>
        ).some((s) => s.resolver === 'pencil' && s.enabled);
      }
    } catch {
      /* best-effort */
    }
    if (pencilEnabled) {
      try {
        const pencil = await resolvePencilCommand({ projectRoot: configSourceRoot });
        if (pencil) {
          if (!config.mcp) config.mcp = {};
          config.mcp.pencil = toOpenCodeMcpEntry({ command: pencil.command, args: pencil.args });
        }
      } catch {
        /* best-effort */
      }
    }
  }

  if (workingDirectory) {
    const userConfigPath = join(workingDirectory, 'opencode.json');
    try {
      if (existsSync(userConfigPath)) {
        const userConfig = JSON.parse(readInvocationMcpFile(userConfigPath)) as { mcp?: Record<string, unknown> };
        if (userConfig.mcp && typeof userConfig.mcp === 'object') {
          const userMcp = { ...userConfig.mcp };
          for (const [name, entry] of Object.entries(userMcp)) {
            if (isRetiredGithubMcpConfigEntry(name, entry)) delete userMcp[name];
          }
          const managedMcpNames = expandManagedMcpNamesForUserMerge([
            ...resolveCapabilityMcpNamesSync(capabilitiesProjectRoot, options.catId ?? catId),
            ...Object.keys(config.mcp ?? {}),
          ]);
          for (const name of managedMcpNames) delete userMcp[name];
          const merged = { ...userMcp, ...(config.mcp ?? {}) };
          if (Object.keys(merged).length > 0) config.mcp = merged;
          else delete config.mcp;
        }
      } else observeInvocationMcpSource(userConfigPath, null);
    } catch {
      // best-effort: if user config unreadable, proceed with our config only
    }
  }

  return structuredClone({ mcp: config.mcp ?? {}, mcpServerPath: options.mcpServerPath });
}

/** Write the native runtime config, consuming an admitted MCP plan when the Host provides one. */
export async function writeOpenCodeRuntimeConfig(
  projectRoot: string,
  catId: string,
  invocationId: string,
  options: OpenCodeRuntimeConfigOptions,
  workingDirectory?: string,
  frozenMcpConfig?: OpenCodeMcpConfigPlan,
): Promise<string> {
  const plan = frozenMcpConfig ?? (await captureOpenCodeMcpConfig(projectRoot, catId, options, workingDirectory));
  const config = generateOpenCodeRuntimeConfig({
    ...options,
    catId: options.catId ?? catId,
    workingDirectory,
    mcpServerPath: undefined,
  });
  if (Object.keys(plan.mcp).length > 0) config.mcp = structuredClone(plan.mcp);
  const safeCatId = sanitizePathSegment(catId);
  const safeInvocationId = sanitizePathSegment(invocationId);
  const configDir = join(projectRoot, '.cat-cafe', `oc-config-${safeCatId}-${safeInvocationId}`);
  const configPath = join(configDir, 'opencode.json');
  const tempPath = `${configPath}.tmp-${process.pid}`;
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(tempPath, JSON.stringify(withOpenCodeSecretGuard(config), null, 2), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(tempPath, configPath);
  return configPath;
}
