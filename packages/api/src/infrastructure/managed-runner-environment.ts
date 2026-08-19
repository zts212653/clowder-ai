import { createRequire } from 'node:module';
import { delimiter, dirname } from 'node:path';

const require = createRequire(import.meta.url);

function resolveBundledRipgrepDirectory(): string | null {
  try {
    const module = require('@vscode/ripgrep') as { rgPath?: unknown };
    return typeof module.rgPath === 'string' && module.rgPath.length > 0 ? dirname(module.rgPath) : null;
  } catch {
    // Unsupported platforms retain the inherited PATH rather than failing API startup.
    return null;
  }
}

export function buildManagedRunnerEnvironment(inheritedEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bundledRipgrepDirectory = resolveBundledRipgrepDirectory();
  if (bundledRipgrepDirectory === null) {
    return { ...inheritedEnv };
  }

  const entries = [bundledRipgrepDirectory, ...(inheritedEnv.PATH?.split(delimiter) ?? [])].filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );

  return { ...inheritedEnv, PATH: [...new Set(entries)].join(delimiter) };
}
