import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import {
  type RunProfileMigrationOptions,
  rollbackProfileMigration,
  runProfileMigration,
} from '../domains/cats/services/profile/profile-migration.js';

const CLI_USAGE = `Usage:
  pnpm --filter @cat-cafe/api migrate:f231-profile -- --legacy-root <dir> [--legacy-root <dir> ...] [options]

Default mode is a zero-write JSON dry-run.

Options:
  --data-dir <dir>                 Canonical data root (default: CAT_CAFE_DATA_DIR or ~/.cat-cafe)
  --user-id <id>                   Profile owner (default: CAT_CAFE_USER_ID or default-user)
  --relationship-key <cat=persona> Explicit mapping for legacy catIds absent from the current catalog
  --resolution-file <json>         Hash-guarded merged content for every divergent target
  --apply                          Backup, write canonical files, then write legacy markers
  --rollback <backup-dir>          Restore canonical-before bytes if applied hashes still match
  --help                           Show this message
`;

interface CliOptions extends RunProfileMigrationOptions {
  rollbackDir?: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> & { legacyRoots: string[] } = { legacyRoots: [] };
  const relationshipKeyOverrides: Record<string, string> = {};
  const valueHandlers: Record<string, (value: string) => void> = {
    '--legacy-root': (value) => options.legacyRoots.push(value),
    '--data-dir': (value) => {
      options.dataDir = value;
    },
    '--user-id': (value) => {
      options.userId = value;
    },
    '--resolution-file': (value) => {
      options.resolutionFile = value;
    },
    '--relationship-key': (value) => addRelationshipKey(value, relationshipKeyOverrides),
    '--rollback': (value) => {
      options.rollbackDir = value;
    },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    const handler = valueHandlers[arg];
    const value = argv[index + 1];
    if (!handler || !value) throw new Error(`Unknown or incomplete argument: ${arg}`);
    handler(value);
    index += 1;
  }
  const configs = toAllCatConfigs(loadCatConfig());
  return {
    legacyRoots: options.legacyRoots,
    dataDir: resolve(options.dataDir ?? process.env.CAT_CAFE_DATA_DIR ?? join(homedir(), '.cat-cafe')),
    userId: options.userId ?? process.env.CAT_CAFE_USER_ID ?? 'default-user',
    relationshipKeys: {
      ...Object.fromEntries(
        Object.entries(configs).flatMap(([catId, config]) =>
          config.relationshipKey ? [[catId, config.relationshipKey]] : [],
        ),
      ),
      ...relationshipKeyOverrides,
    },
    apply: options.apply,
    resolutionFile: options.resolutionFile,
    rollbackDir: options.rollbackDir,
  };
}

function addRelationshipKey(value: string, overrides: Record<string, string>): void {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid --relationship-key "${value}"; expected legacyCatId=relationshipKey`);
  }
  overrides[value.slice(0, separator)] = value.slice(separator + 1);
}

function main(): void {
  try {
    if (process.argv.slice(2).includes('--help')) {
      process.stdout.write(CLI_USAGE);
      return;
    }
    const options = parseCliArgs(process.argv.slice(2));
    const result = options.rollbackDir ? rollbackProfileMigration(options.rollbackDir) : runProfileMigration(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`[f231-profile-migration] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export {
  hashContent,
  rollbackProfileMigration,
  runProfileMigration,
} from '../domains/cats/services/profile/profile-migration.js';
