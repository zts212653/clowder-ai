import { homedir } from 'node:os';
import { join } from 'node:path';
import { findMonorepoRoot } from '../../utils/monorepo-root.js';
import type { CliConfigPaths } from './capability-orchestrator.js';

export interface StartupCliConfigContext {
  projectRoot: string;
  paths: CliConfigPaths;
}

export function resolveStartupCliConfigContext(start = process.cwd()): StartupCliConfigContext {
  const projectRoot = findMonorepoRoot(start);
  return {
    projectRoot,
    paths: {
      anthropic: join(projectRoot, '.mcp.json'),
      openai: join(projectRoot, '.codex', 'config.toml'),
      google: join(projectRoot, '.gemini', 'settings.json'),
      kimi: join(projectRoot, '.kimi', 'mcp.json'),
      antigravity: join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
    },
  };
}
