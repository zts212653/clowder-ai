/**
 * mint-agent-key — types + constants shared across parse / mint modules.
 *
 * Split out of the original single-file mint-agent-key.ts after cloud codex
 * review 2026-06-13 P1 flagged AGENTS.md 350-line hard limit (file was 448).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentKeyRegistry } from '../../domains/cats/services/agents/agent-key/AgentKeyRegistry.js';

// ============ Constants ============

export const DEFAULT_USER_ID = 'default-user';
export const SANCTUARY_REDIS_PORT = '6399';
export const KEY_FILE_MODE = 0o600;
export const KEY_DIR_MODE = 0o700;

export function defaultKeyFile(catId: string): string {
  return join(homedir(), '.cat-cafe', 'agent-keys', `${catId}.secret`);
}

// ============ CLI args ============

export interface MintArgs {
  catId: string;
  redisUrl: string;
  execute: boolean;
  userId: string;
  keyFile: string;
  iUnderstandRuntimeRedis: boolean;
}

export interface ParseError {
  error: string;
}

export type ParseResult = MintArgs | ParseError;

// ============ Mint deps ============

export interface MintFsOps {
  mkdir: (path: string, options: { recursive: boolean; mode: number }) => Promise<void>;
  /**
   * Write file with mode and optional fs flag (e.g. 'wx' for exclusive create).
   * Cloud codex review 2026-06-13 P2: passing flag='wx' lets executeMint fail
   * on concurrent races where two processes both pass exists() preflight but
   * one then truncates the other's secret.
   */
  writeFile: (path: string, content: string, options: { mode: number; flag?: string }) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  stat: (path: string) => Promise<{ mode: number }>;
}

/**
 * Lazy registry provider — invoked only after preflight passes and only on
 * the execute path. Dry-run and preflight failures never trigger this, so
 * Redis (incl. 6399 sanctuary) is never touched until all guards pass.
 * (codex review §P1 #3: createRedisClient must not run before preflight.)
 */
export type RegistryProvider = () => Promise<{
  /**
   * cloud-review round 4 P2: registry must expose revoke() so executeMint can
   * roll back the Redis-side agent key when a post-issue local persistence
   * step (wx EEXIST race / chmod / stat mode verify) fails. Without revoke
   * the orphan Redis entry sits forever.
   */
  registry: Pick<AgentKeyRegistry, 'issue' | 'revoke'>;
  cleanup?: () => Promise<void>;
}>;

export interface MintDeps {
  registryProvider: RegistryProvider;
  allowlist: Set<string>;
  fsOps: MintFsOps;
  logger?: (msg: string) => void;
}

// ============ Outcome ============

export type MintErrorCode =
  | 'cat_not_in_allowlist'
  | 'sanctuary_not_acknowledged'
  | 'key_file_exists'
  | 'permission_verification_failed'
  | 'issue_failed';

export interface MintOutcome {
  ok: boolean;
  dryRun: boolean;
  agentKeyId?: string;
  errorCode?: MintErrorCode;
  message: string;
}
