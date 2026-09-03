import { createRequire } from 'node:module';
import { delimiter, dirname } from 'node:path';
import { CLI_PROCESS_CONTEXT_ENV, CLI_PROCESS_OWNER_ENV } from '../utils/cli-process-environment.js';

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
  const environment = { ...inheritedEnv };
  // wakeWhen is owned by the API-side managed runner, not by the requesting cat CLI.
  delete environment[CLI_PROCESS_OWNER_ENV];
  delete environment[CLI_PROCESS_CONTEXT_ENV];

  const bundledRipgrepDirectory = resolveBundledRipgrepDirectory();
  if (bundledRipgrepDirectory === null) {
    return environment;
  }

  const entries = [bundledRipgrepDirectory, ...(environment.PATH?.split(delimiter) ?? [])].filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );

  return { ...environment, PATH: [...new Set(entries)].join(delimiter) };
}
