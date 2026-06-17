/**
 * mint-agent-key — F178 Phase D (V3) admin CLI: mint an agent-key for a
 * named cat (e.g. fable-5) into the user's local sidecar secret directory.
 *
 * Triple-explicit safety (codex APPROVE V2 §A):
 *   --execute                    : without it = forced dry-run (no Redis I/O, no fs writes)
 *   --redis-url <url>            : required; NO default (avoid silent 6399 hit)
 *   --i-understand-runtime-redis : required iff --redis-url targets production Redis (sacred) (any host)
 *
 * catId allowlist is read from runtime cat-config.json (fail-closed); not
 * found → reject. Existing secret file → reject (rotate is separate).
 * Secret file written exclusively (wx) at mode 0o600 + chmod-verified.
 *
 * Design doc: docs/discussions/2026-06-13-fable-cowork-adapter-phase0.md
 *
 * Usage:
 *   pnpm --filter @cat-cafe/api build
 *   # dry-run (safe; no side-effects)
 *   node packages/api/dist/scripts/mint-agent-key.js \
 *     --cat-id fable-5 \
 *     --redis-url redis://127.0.0.1:6399 \
 *     --i-understand-runtime-redis
 *
 *   # mint
 *   node packages/api/dist/scripts/mint-agent-key.js \
 *     --cat-id fable-5 \
 *     --redis-url redis://127.0.0.1:6399 \
 *     --i-understand-runtime-redis \
 *     --execute
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintAgentKey } from './mint-agent-key/mint.js';
import { loadCatIdAllowlistFromConfig, parseMintArgs } from './mint-agent-key/parse.js';
import { DEFAULT_USER_ID, type MintDeps, type MintFsOps, type RegistryProvider } from './mint-agent-key/types.js';

export { mintAgentKey } from './mint-agent-key/mint.js';
// Re-exports so external consumers (and the existing test suite) keep their
// import paths stable while implementation moved into mint-agent-key/*.ts.
export {
  isSanctuaryRedisUrl,
  loadCatIdAllowlistFromConfig,
  parseMintArgs,
} from './mint-agent-key/parse.js';
export type {
  MintArgs,
  MintDeps,
  MintErrorCode,
  MintFsOps,
  MintOutcome,
  ParseError,
  ParseResult,
  RegistryProvider,
} from './mint-agent-key/types.js';

// ============ CLI bootstrap ============

const USAGE = `Usage: node packages/api/dist/scripts/mint-agent-key.js [options]

Required:
  --cat-id <id>                 Cat id (must exist in cat-config.json roster)
  --redis-url <url>             Redis connection URL (NO default; explicit)

Triple-explicit safety:
  --execute                     Without this flag = forced dry-run (default)
  --i-understand-runtime-redis  Required iff --redis-url targets port 6399 (any host)

Optional:
  --user-id <id>                Defaults to "${DEFAULT_USER_ID}"
  --key-file <path>             Defaults to ~/.cat-cafe/agent-keys/<catId>.secret

Examples:
  # Dry-run (safe; no Redis I/O, no fs writes)
  node packages/api/dist/scripts/mint-agent-key.js \\
    --cat-id fable-5 \\
    --redis-url redis://127.0.0.1:6399 \\
    --i-understand-runtime-redis

  # Mint
  node packages/api/dist/scripts/mint-agent-key.js \\
    --cat-id fable-5 \\
    --redis-url redis://127.0.0.1:6399 \\
    --i-understand-runtime-redis \\
    --execute
`;

async function buildFsOps(): Promise<MintFsOps> {
  const { mkdir, writeFile, chmod, stat, access } = await import('node:fs/promises');
  return {
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    writeFile: async (path, content, options) => {
      await writeFile(path, content, options);
    },
    chmod,
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    stat: async (path) => {
      const s = await stat(path);
      return { mode: s.mode };
    },
  };
}

async function main(): Promise<void> {
  const parsed = parseMintArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    console.error('');
    console.error(USAGE);
    process.exit(2);
  }

  // dist/scripts/mint-agent-key.js → repo root (../../../../cat-config.json)
  const distDir = dirname(fileURLToPath(import.meta.url));
  const configPath = resolve(distDir, '../../../../cat-config.json');

  let allowlist: Set<string>;
  try {
    allowlist = await loadCatIdAllowlistFromConfig(configPath);
  } catch (err) {
    console.error(`Failed to load cat-config.json from ${configPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(3);
  }

  const fsOps = await buildFsOps();

  // Lazy registryProvider — only invoked inside executeMint AFTER preflight
  // passes (codex review P1 #3).
  const registryProvider: RegistryProvider = async () => {
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const redis = createRedisClient({ url: parsed.redisUrl });
    const { AgentKeyRegistry } = await import('../domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { RedisAgentKeyBackend } = await import('../domains/cats/services/agents/agent-key/RedisAgentKeyBackend.js');
    return {
      registry: new AgentKeyRegistry({ backend: new RedisAgentKeyBackend(redis) }),
      cleanup: async () => {
        await redis.quit().catch(() => {});
      },
    };
  };

  const deps: MintDeps = {
    registryProvider,
    allowlist,
    fsOps,
    logger: (msg) => console.log(msg),
  };

  const outcome = await mintAgentKey(parsed, deps);
  console.log(outcome.message);
  if (!outcome.ok) {
    console.error(`[mint-agent-key] failed: ${outcome.errorCode}`);
    process.exit(4);
  }
}

const isEntryPoint = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error(`[mint-agent-key] fatal:`, err);
    process.exit(1);
  });
}
