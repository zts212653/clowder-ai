/**
 * OpenCode config file writers — separated from opencode-config-template.ts
 * to keep the core template generator under the 350-line module budget.
 *
 * Handles:
 * - writeOpenCodeRuntimeConfig: full runtime config (with async pencil resolution)
 * - writeOpenCodeInstructionsOnlyConfig: instructions-only config (F203 Phase I)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  expandManagedMcpNamesForUserMerge,
  resolvePencilCommand,
  resolveServersForCat,
} from '../../../../../config/capabilities/capability-orchestrator.js';
import { toOpenCodeMcpEntry } from '../../../../../config/capabilities/mcp-config-adapters.js';
import {
  buildExternalDirectoryPermissions,
  generateOpenCodeRuntimeConfig,
  type OpenCodeRuntimeConfigOptions,
} from './opencode-config-template.js';
import { resolveCapabilityMcpNamesSync } from './opencode-mcp-injection.js';

// ─── Config file writers ──────────────────────────────────────────

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/**
 * F203 Phase I: Write an instructions-only opencode config (no provider block).
 *
 * Used for OpenCode fallback paths (subscription/unresolved/known-model) where
 * a full runtime config is not generated. The config ONLY contains `instructions`
 * so OpenCode reads L0 + OPENCODE.md into system role. No provider/apiKey fields
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
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'opencode.json');
  const tempPath = `${configPath}.tmp-${process.pid}`;
  const config: {
    $schema: string;
    instructions: string[];
    permission?: { external_directory: Record<string, string> };
  } = {
    $schema: 'https://opencode.ai/config.json',
    instructions: [...instructions],
  };
  const externalDirectoryPermissions = buildExternalDirectoryPermissions(externalDirectories);
  if (externalDirectoryPermissions) {
    config.permission = { external_directory: externalDirectoryPermissions };
  }
  writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tempPath, configPath);
  return configPath;
}

/**
 * Writes a per-invocation opencode config file.
 * OpenCode's `OPENCODE_CONFIG` points to a config file path; `OPENCODE_CONFIG_DIR`
 * is reserved for the `.opencode/`-style config directory structure.
 * Returns the `opencode.json` file path (set it as `OPENCODE_CONFIG`).
 */
export async function writeOpenCodeRuntimeConfig(
  projectRoot: string,
  catId: string,
  invocationId: string,
  options: OpenCodeRuntimeConfigOptions,
  workingDirectory?: string,
): Promise<string> {
  const safeCatId = sanitizePathSegment(catId);
  const safeInvocationId = sanitizePathSegment(invocationId);
  const configDir = join(projectRoot, '.cat-cafe', `oc-config-${safeCatId}-${safeInvocationId}`);
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'opencode.json');
  const tempPath = `${configPath}.tmp-${process.pid}`;
  const capabilitiesProjectRoot =
    options.capabilitiesProjectRoot ??
    (options.mcpServerPath ? resolve(dirname(options.mcpServerPath), '../../..') : projectRoot);
  const config = generateOpenCodeRuntimeConfig({
    ...options,
    catId: options.catId ?? catId,
    capabilitiesProjectRoot,
    workingDirectory,
  });

  // Resolve pencil at invoke time (async) — only if enabled in capabilities.json
  if (options.mcpServerPath) {
    const effectiveCatId = options.catId ?? catId;
    let pencilEnabled = false;
    try {
      // F249: Project config is the single truth source for MCP resolution.
      let capConfig = null;
      if (workingDirectory && workingDirectory !== capabilitiesProjectRoot) {
        try {
          const projectRaw = readFileSync(join(workingDirectory, '.cat-cafe', 'capabilities.json'), 'utf-8');
          const parsed = JSON.parse(projectRaw);
          if (parsed?.version === 1 || parsed?.version === 2) capConfig = parsed;
        } catch {
          /* No project config — fall back to global */
        }
      }
      if (!capConfig) {
        const raw = readFileSync(join(capabilitiesProjectRoot, '.cat-cafe', 'capabilities.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed?.version === 1 || parsed?.version === 2) capConfig = parsed;
      }
      if (capConfig && effectiveCatId) {
        pencilEnabled = (
          resolveServersForCat(capConfig, effectiveCatId) as Array<{
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
        const pencil = await resolvePencilCommand({ projectRoot: capabilitiesProjectRoot });
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
        const userConfig = JSON.parse(readFileSync(userConfigPath, 'utf-8')) as { mcp?: Record<string, unknown> };
        if (userConfig.mcp && typeof userConfig.mcp === 'object') {
          const userMcp = { ...userConfig.mcp };
          const managedMcpNames = expandManagedMcpNamesForUserMerge([
            ...resolveCapabilityMcpNamesSync(capabilitiesProjectRoot, options.catId ?? catId),
            ...Object.keys(config.mcp ?? {}),
          ]);
          for (const name of managedMcpNames) delete userMcp[name];
          const merged = { ...userMcp, ...(config.mcp ?? {}) };
          if (Object.keys(merged).length > 0) config.mcp = merged;
          else delete config.mcp;
        }
      }
    } catch {
      // best-effort: if user config unreadable, proceed with our config only
    }
  }

  writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tempPath, configPath);
  return configPath;
}
