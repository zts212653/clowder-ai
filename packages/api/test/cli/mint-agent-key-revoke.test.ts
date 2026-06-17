/**
 * mint-agent-key — orphan-key revoke tests (cloud-review round 4 P2).
 *
 * Split out of mint-agent-key-core.test.ts after AGENTS.md 350-line hard
 * limit. Helpers (makeFsStub/makeArgs/makeProvider/makeDeps) are duplicated
 * intentionally to keep each test file self-contained without crossing a
 * sub-directory glob boundary that node --test does not recurse into.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  type MintArgs,
  type MintDeps,
  type MintFsOps,
  mintAgentKey,
  type RegistryProvider,
} from '../../src/scripts/mint-agent-key.js';

interface FsCallLog {
  mkdir: Array<{ path: string; options: { recursive: boolean; mode: number } }>;
  writeFile: Array<{ path: string; content: string; options: { mode: number; flag?: string } }>;
  chmod: Array<{ path: string; mode: number }>;
}

interface FsStubOpts {
  exists?: boolean;
  statMode?: number;
  writeFileThrowsEexist?: boolean;
}

function makeFsStub(opts: FsStubOpts): { fsOps: MintFsOps; log: FsCallLog } {
  const log: FsCallLog = { mkdir: [], writeFile: [], chmod: [] };
  return {
    log,
    fsOps: {
      mkdir: async (path, options) => {
        log.mkdir.push({ path, options });
      },
      writeFile: async (path, content, options) => {
        if (opts.writeFileThrowsEexist) {
          const err = new Error(`EEXIST: file already exists, open '${path}'`) as Error & { code?: string };
          err.code = 'EEXIST';
          throw err;
        }
        log.writeFile.push({ path, content, options });
      },
      chmod: async (path, mode) => {
        log.chmod.push({ path, mode });
      },
      exists: async () => opts.exists ?? false,
      stat: async () => ({ mode: opts.statMode ?? 0o600 }),
    },
  };
}

function makeArgs(overrides: Partial<MintArgs> = {}): MintArgs {
  return {
    catId: 'fable-5',
    redisUrl: 'redis://127.0.0.1:6398',
    execute: true,
    userId: 'default-user',
    keyFile: '/tmp/cat-cafe-test/fable-5.secret',
    iUnderstandRuntimeRedis: false,
    ...overrides,
  };
}

const STUB_ALLOWLIST = new Set(['fable-5', 'opus', 'codex', 'antigravity']);

interface RevokeCall {
  agentKeyId: string;
  reason: string;
}

function makeProvider(
  opts: {
    issueImpl?: (catId: unknown, userId: unknown) => Promise<{ agentKeyId: string; secret: string }>;
    revokeImpl?: (agentKeyId: string, reason: string) => Promise<boolean>;
    revokeCalls?: RevokeCall[];
  } = {},
): RegistryProvider {
  return async () => {
    return {
      registry: {
        issue: opts.issueImpl ?? (async () => ({ agentKeyId: 'ak_fixture', secret: '0123456789abcdef'.repeat(4) })),
        revoke: async (agentKeyId: string, reason: string) => {
          opts.revokeCalls?.push({ agentKeyId, reason });
          return opts.revokeImpl ? await opts.revokeImpl(agentKeyId, reason) : true;
        },
      },
    };
  };
}

function makeDeps(overrides: Partial<MintDeps> = {}): MintDeps {
  return {
    registryProvider: makeProvider(),
    allowlist: STUB_ALLOWLIST,
    fsOps: makeFsStub({}).fsOps,
    logger: () => {},
    ...overrides,
  };
}

describe('mintAgentKey — orphan-key revoke on post-issue failure (cloud-review round 4 P2)', () => {
  it('wx EEXIST race → revoke issued Redis key (no orphan)', async () => {
    const stub = makeFsStub({ writeFileThrowsEexist: true });
    const revokeCalls: RevokeCall[] = [];
    const outcome = await mintAgentKey(
      makeArgs(),
      makeDeps({
        fsOps: stub.fsOps,
        registryProvider: makeProvider({
          revokeCalls,
          issueImpl: async () => ({ agentKeyId: 'ak_race_orphan', secret: 'race-secret' }),
        }),
      }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'key_file_exists');
    assert.equal(revokeCalls.length, 1, 'must revoke the orphan agent key on race');
    assert.equal(revokeCalls[0].agentKeyId, 'ak_race_orphan');
    assert.match(revokeCalls[0].reason, /key_file_exists/);
    assert.match(outcome.message, /Orphan Redis key revoked/);
  });

  it('stat returns wrong mode → revoke issued Redis key', async () => {
    const stub = makeFsStub({ statMode: 0o644 });
    const revokeCalls: RevokeCall[] = [];
    const outcome = await mintAgentKey(
      makeArgs(),
      makeDeps({
        fsOps: stub.fsOps,
        registryProvider: makeProvider({
          revokeCalls,
          issueImpl: async () => ({ agentKeyId: 'ak_bad_mode', secret: 'mode-secret' }),
        }),
      }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'permission_verification_failed');
    assert.equal(revokeCalls.length, 1, 'must revoke after stat-mode mismatch');
    assert.equal(revokeCalls[0].agentKeyId, 'ak_bad_mode');
  });

  it('successful mint → revoke NOT called', async () => {
    const stub = makeFsStub({ statMode: 0o600 });
    const revokeCalls: RevokeCall[] = [];
    const outcome = await mintAgentKey(
      makeArgs(),
      makeDeps({ fsOps: stub.fsOps, registryProvider: makeProvider({ revokeCalls }) }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(revokeCalls.length, 0, 'success path must NOT invoke revoke');
  });

  it('revoke itself throws → original failure outcome preserved (logger warn)', async () => {
    const stub = makeFsStub({ writeFileThrowsEexist: true });
    const warnings: string[] = [];
    const outcome = await mintAgentKey(
      makeArgs(),
      makeDeps({
        fsOps: stub.fsOps,
        registryProvider: makeProvider({
          issueImpl: async () => ({ agentKeyId: 'ak_with_double_failure', secret: 's' }),
          revokeImpl: async () => {
            throw new Error('redis revoke endpoint down');
          },
        }),
        logger: (msg) => warnings.push(msg),
      }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'key_file_exists');
    assert.ok(
      warnings.some((w) => /revoke.*also failed/i.test(w) && /ak_with_double_failure/.test(w)),
      'logger must capture revoke failure warning',
    );
  });
});
