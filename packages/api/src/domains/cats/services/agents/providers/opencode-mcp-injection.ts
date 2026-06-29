/**
 * OpenCode MCP injection — capabilities.json → OpenCode MCP config at invoke time.
 *
 * Separated from opencode-config-template.ts (#712) to keep the template
 * generator under the 350-line module budget (F161 Phase E).
 *
 * Two public functions:
 * - buildOpenCodeMcpSync: resolves MCP servers from capabilities.json + fallback
 * - resolveCapabilityMcpNamesSync: resolves managed MCP names for user-merge exclusion
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  resolveCatCafeNodeCommand,
  resolveServersForCat,
} from '../../../../../config/capabilities/capability-orchestrator.js';
import {
  toOpenCodeMcpEntry,
  toOpenCodeRemoteMcpEntry,
} from '../../../../../config/capabilities/mcp-config-adapters.js';

/** MCP entry type derived from toOpenCodeMcpEntry return type. */
type OpenCodeMcpEntry = ReturnType<typeof toOpenCodeMcpEntry> | ReturnType<typeof toOpenCodeRemoteMcpEntry>;

import { createModuleLogger } from '../../../../../infrastructure/logger.js';

const log = createModuleLogger('opencode-mcp-injection');

/**
 * Build OpenCode MCP config from capabilities.json at invoke time.
 *
 * Format conversion delegates to `toOpenCodeMcpEntry` from mcp-config-adapters
 * — same adapter used by the sync-time `writeOpenCodeMcpConfig` writer.
 * Capabilities resolution (split entrypoints, pencil, external servers) is
 * the same pattern as Kimi/Claude/Codex invoke-time injection.
 */
export function buildOpenCodeMcpSync(
  mcpServerPath: string,
  catId?: string,
  capabilitiesProjectRoot?: string,
  workingDirectory?: string,
): Record<string, OpenCodeMcpEntry> {
  const distDir = dirname(mcpServerPath);
  const binaryProjectRoot = resolve(distDir, '../../..');
  const capabilityRoot = resolve(capabilitiesProjectRoot || binaryProjectRoot);
  const mcp: Record<string, OpenCodeMcpEntry> = {};

  let resolved = false;
  try {
    // F249: Project config is the single truth source for MCP resolution.
    // Try project first; fall back to global for uninitialized projects.
    let capConfig = null;
    if (workingDirectory && workingDirectory !== capabilityRoot) {
      try {
        const projectRaw = readFileSync(join(workingDirectory, '.cat-cafe', 'capabilities.json'), 'utf-8');
        const parsed = JSON.parse(projectRaw);
        if (parsed?.version === 1 || parsed?.version === 2) capConfig = parsed;
      } catch {
        /* No project config — fall back to global */
      }
    }
    if (!capConfig) {
      const raw = readFileSync(join(capabilityRoot, '.cat-cafe', 'capabilities.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 || parsed?.version === 2) capConfig = parsed;
    }
    if (capConfig && catId) {
      for (const s of resolveServersForCat(capConfig, catId) as Array<{
        name: string;
        enabled: boolean;
        command: string;
        args?: string[];
        resolver?: string;
        transport?: string;
        url?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
        source: string;
      }>) {
        if (!s.enabled) continue;
        if (s.transport === 'streamableHttp') {
          if (s.url) mcp[s.name] = toOpenCodeRemoteMcpEntry({ url: s.url, headers: s.headers });
          continue;
        }
        if (s.source === 'cat-cafe' && CAT_CAFE_SPLIT_ENTRYPOINTS.has(s.name)) {
          const ep = CAT_CAFE_SPLIT_ENTRYPOINTS.get(s.name)!;
          const epPath = join(distDir, ep);
          if (existsSync(epPath)) {
            mcp[s.name] = toOpenCodeMcpEntry({ command: resolveCatCafeNodeCommand(), args: [epPath] });
          }
        } else if (s.resolver === 'pencil') {
          // Pencil needs async resolution — handled in writeOpenCodeRuntimeConfig
        } else if (s.command) {
          mcp[s.name] = toOpenCodeMcpEntry({ command: s.command, args: s.args, env: s.env });
        }
      }
      resolved = true;
    }
  } catch {
    // best-effort fallback below
  }

  if (!resolved) {
    for (const [name, entrypoint] of CAT_CAFE_SPLIT_ENTRYPOINTS) {
      mcp[name] = toOpenCodeMcpEntry({ command: resolveCatCafeNodeCommand(), args: [join(distDir, entrypoint)] });
    }
  }
  log.debug(
    {
      provider: 'opencode',
      catId,
      resolvedFrom: resolved ? 'capabilities.json' : 'fallback',
      serverCount: Object.keys(mcp).length,
      servers: Object.entries(mcp).map(([name, cfg]) => ({
        name,
        type: cfg.type,
        command: 'command' in cfg ? cfg.command : undefined,
        url: 'url' in cfg ? cfg.url : undefined,
      })),
    },
    '#712: MCP invoke-time injection',
  );
  return mcp;
}

export function resolveCapabilityMcpNamesSync(capabilitiesProjectRoot: string, catId?: string): Set<string> {
  const names = new Set<string>();
  if (!catId) return names;
  try {
    const raw = readFileSync(join(capabilitiesProjectRoot, '.cat-cafe', 'capabilities.json'), 'utf-8');
    const capConfig = JSON.parse(raw);
    if (capConfig?.version === 1 || capConfig?.version === 2) {
      for (const s of resolveServersForCat(capConfig, catId) as Array<{ name: string }>) {
        names.add(s.name);
      }
    }
  } catch {
    // best-effort: generated MCP entries still override same-name user entries below.
  }
  return names;
}
