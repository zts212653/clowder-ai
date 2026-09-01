import { homedir } from 'node:os';
import { join } from 'node:path';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function expandHomePath(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return join(homeDir, value.slice(2));
  return value;
}

function resolveDataRoot(env: NodeJS.ProcessEnv, homeDir: string): string {
  return expandHomePath(nonEmpty(env.CAT_CAFE_DATA_DIR) ?? join(homeDir, '.cat-cafe'), homeDir);
}

/**
 * F279 owns its durable state path. This deliberately depends only on the
 * current-main data-root environment contract, not F289's paused migration
 * catalog. Generated WAV files are governed by DATA_DIR/CACHE_DIR via
 * `resolveTtsCacheDir()` in `config/data-dirs.js`.
 */
export function resolveDocumentListenStatePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string {
  const explicitPath = nonEmpty(env.LISTEN_MODE_DB);
  if (explicitPath) return expandHomePath(explicitPath, homeDir);

  return join(resolveDataRoot(env, homeDir), 'listen-mode.sqlite');
}
