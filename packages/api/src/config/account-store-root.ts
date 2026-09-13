/**
 * Single account-store root resolver (INV-1).
 *
 * All account metadata and credential reads/writes resolve their durable store
 * root through this one function. Precedence (INV-2 / INV-10):
 *   1. CAT_CAFE_GLOBAL_CONFIG_ROOT — explicit override always wins.
 *   2. A path inside CAT_CAFE_RUNTIME_ROOT — remapped to the same relative
 *      path under CAT_CAFE_WORKSPACE_ROOT (persistent workspace store).
 *   3. Explicit projectRoot — project-scoped store.
 *   4. Homedir — last-resort default.
 *
 * The resolver performs no filesystem writes and has no dependency on cat
 * catalog loading, so any config layer can call it synchronously.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { redirectRuntimePathLexical } from '../utils/persistent-project-path.js';

export interface AccountStoreRootOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveAccountStoreRoot(options: AccountStoreRootOptions = {}): string {
  const env = options.env ?? process.env;
  const envRoot = env.CAT_CAFE_GLOBAL_CONFIG_ROOT?.trim();
  if (envRoot) return resolve(envRoot);
  if (options.projectRoot) return redirectRuntimePathLexical(options.projectRoot, env);
  return resolve(homedir());
}
