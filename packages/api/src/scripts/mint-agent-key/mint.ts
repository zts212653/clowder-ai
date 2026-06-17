/**
 * mint-agent-key — core mint logic (preflightValidate + executeMint + mintAgentKey).
 *
 * All side-effects (Redis client, fs writes) gated behind preflight passing;
 * lazy registryProvider only invoked on the execute path (codex P1#3).
 * writeFile uses exclusive create flag 'wx' to close concurrent-race window
 * between exists() preflight and actual write (codex P2 round 3).
 */

import { dirname } from 'node:path';
import { createCatId } from '@cat-cafe/shared';
import { isSanctuaryRedisUrl } from './parse.js';
import {
  KEY_DIR_MODE,
  KEY_FILE_MODE,
  type MintArgs,
  type MintDeps,
  type MintOutcome,
  type RegistryProvider,
} from './types.js';

/**
 * Pre-flight validation (no Redis I/O; only the exists() fs check). Returns
 * a failure MintOutcome iff any guard rejects, else null to proceed.
 */
async function preflightValidate(args: MintArgs, deps: MintDeps): Promise<MintOutcome | null> {
  if (!deps.allowlist.has(args.catId)) {
    return {
      ok: false,
      dryRun: !args.execute,
      errorCode: 'cat_not_in_allowlist',
      message: `Cat "${args.catId}" not in cat-config.json roster (fail-closed). Available: ${[...deps.allowlist].sort().join(', ')}`,
    };
  }
  if (isSanctuaryRedisUrl(args.redisUrl) && !args.iUnderstandRuntimeRedis) {
    return {
      ok: false,
      dryRun: !args.execute,
      errorCode: 'sanctuary_not_acknowledged',
      message: `--redis-url targets sanctuary Redis (6399). Add --i-understand-runtime-redis to confirm.`,
    };
  }
  const exists = await deps.fsOps.exists(args.keyFile);
  if (exists) {
    return {
      ok: false,
      dryRun: !args.execute,
      errorCode: 'key_file_exists',
      message: `Key file already exists: ${args.keyFile}. Refusing to overwrite (rotate not supported in this CLI).`,
    };
  }
  return null;
}

function isEexistError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === 'EEXIST';
}

/**
 * Execute the actual mint (assumes preflight passed). All side-effects live
 * here, including the lazy registryProvider() call that creates the Redis
 * client. If invoked, the provider's cleanup() is always run before return.
 */
async function executeMint(args: MintArgs, deps: MintDeps): Promise<MintOutcome> {
  let provided: Awaited<ReturnType<RegistryProvider>>;
  try {
    provided = await deps.registryProvider();
  } catch (err) {
    return {
      ok: false,
      dryRun: false,
      errorCode: 'issue_failed',
      message: `registryProvider failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const { registry, cleanup } = provided;

  try {
    await deps.fsOps.mkdir(dirname(args.keyFile), { recursive: true, mode: KEY_DIR_MODE });

    let issued: { agentKeyId: string; secret: string };
    try {
      issued = await registry.issue(createCatId(args.catId), args.userId);
    } catch (err) {
      return {
        ok: false,
        dryRun: false,
        errorCode: 'issue_failed',
        message: `AgentKeyRegistry.issue failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // cloud-review round 4 P2: any failure AFTER registry.issue() must revoke
    // the orphan Redis key — otherwise concurrent race / chmod fail / stat
    // verify fail all leak agent keys into the Redis backend that no on-disk
    // secret file references.
    const revokeAndFail = async (outcome: MintOutcome): Promise<MintOutcome> => {
      try {
        await registry.revoke(issued.agentKeyId, `local persistence failed: ${outcome.errorCode}`);
      } catch (revokeErr) {
        deps.logger?.(
          `[mint-agent-key] WARN: revoke of orphan agentKeyId=${issued.agentKeyId} also failed: ${revokeErr instanceof Error ? revokeErr.message : revokeErr}`,
        );
      }
      return outcome;
    };

    // codex P2 (round 3): exclusive create — refuse to overwrite even on
    // concurrent races where both processes passed exists() preflight.
    try {
      await deps.fsOps.writeFile(args.keyFile, `${issued.secret}\n`, { mode: KEY_FILE_MODE, flag: 'wx' });
    } catch (err) {
      if (isEexistError(err)) {
        return revokeAndFail({
          ok: false,
          dryRun: false,
          errorCode: 'key_file_exists',
          message: `Key file appeared between preflight and write (concurrent race): ${args.keyFile}. Orphan Redis key revoked.`,
        });
      }
      throw err;
    }
    try {
      await deps.fsOps.chmod(args.keyFile, KEY_FILE_MODE);
    } catch (err) {
      return revokeAndFail({
        ok: false,
        dryRun: false,
        errorCode: 'permission_verification_failed',
        message: `chmod failed: ${err instanceof Error ? err.message : String(err)}. Secret file remains at ${args.keyFile}; orphan Redis key revoked.`,
      });
    }
    const stat = await deps.fsOps.stat(args.keyFile);
    const actualMode = stat.mode & 0o777;
    if (actualMode !== KEY_FILE_MODE) {
      return revokeAndFail({
        ok: false,
        dryRun: false,
        errorCode: 'permission_verification_failed',
        message: `Secret file mode is 0o${actualMode.toString(8)} but expected 0o600. Secret file remains at ${args.keyFile}; orphan Redis key revoked.`,
      });
    }

    return {
      ok: true,
      dryRun: false,
      agentKeyId: issued.agentKeyId,
      message: `Minted agentKeyId=${issued.agentKeyId} for catId=${args.catId} → ${args.keyFile}`,
    };
  } finally {
    if (cleanup) await cleanup().catch(() => {});
  }
}

/**
 * Validate args + (when --execute) actually mint the agent key.
 * Returns MintOutcome with explicit success/failure + dry-run flag.
 * Never throws on expected validation errors — caller maps to exit code.
 */
export async function mintAgentKey(args: MintArgs, deps: MintDeps): Promise<MintOutcome> {
  const log = deps.logger ?? (() => {});

  const preflightFailure = await preflightValidate(args, deps);
  if (preflightFailure) return preflightFailure;

  if (!args.execute) {
    log(
      `[dry-run] would mint key for catId=${args.catId} userId=${args.userId} → file=${args.keyFile} (mode=0o600). Add --execute to actually mint.`,
    );
    return {
      ok: true,
      dryRun: true,
      message: `Dry-run: catId=${args.catId} key-file=${args.keyFile} (add --execute to mint)`,
    };
  }

  const outcome = await executeMint(args, deps);
  if (outcome.ok && outcome.agentKeyId) {
    log(`[minted] catId=${args.catId} agentKeyId=${outcome.agentKeyId} → ${args.keyFile} (mode=0o600)`);
  }
  return outcome;
}
