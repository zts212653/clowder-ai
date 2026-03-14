/**
 * CLI Parser Utilities
 * CLI 子进程解析工具导出
 */

export { formatCliExitError } from './cli-format.js';
export type { CliSpawnerDeps } from './cli-spawn.js';
export { isCliError, KILL_GRACE_MS, spawnCli } from './cli-spawn.js';
export type {
  ChildProcessLike,
  CliSpawnOptions,
  CliTransformer,
  SpawnFn,
} from './cli-types.js';
export { isParseError, parseNDJSON } from './ndjson-parser.js';
export { normalizeErrorMessage } from './normalize-error.js';
export { isUnderAllowedRoot, validateProjectPath } from './project-path.js';
