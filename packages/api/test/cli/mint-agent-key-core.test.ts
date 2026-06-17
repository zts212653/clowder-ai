import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  type MintArgs,
  type MintDeps,
  type MintFsOps,
  mintAgentKey,
  type RegistryProvider,
} from '../../src/scripts/mint-agent-key.js';

// ============ Shared stubs ============

interface FsCallLog {
  mkdir: Array<{ path: string; options: { recursive: boolean; mode: number } }>;
  writeFile: Array<{ path: string; content: string; options: { mode: number; flag?: string } }>;
  chmod: Array<{ path: string; mode: number }>;
}

interface FsStubOpts {
  exists?: boolean;
  statMode?: number;
  /** When set, fsOps.writeFile throws an EEXIST-shaped Error. (cloud P2 round 3 wx race) */
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
    execute: false,
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
    invocations?: { count: number };
    revokeImpl?: (agentKeyId: string, reason: string) => Promise<boolean>;
    revokeCalls?: RevokeCall[];
  } = {},
): RegistryProvider {
  return async () => {
    if (opts.invocations) opts.invocations.count += 1;
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

// ============ Preflight ============

describe('mintAgentKey — catId allowlist', () => {
  it('rejects unknown catId fail-closed', async () => {
    const outcome = await mintAgentKey(
      makeArgs({ catId: 'bogus-cat' }),
      makeDeps({ allowlist: new Set(['fable-5', 'opus']) }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'cat_not_in_allowlist');
    assert.match(outcome.message, /not in cat-config\.json roster/);
    assert.match(outcome.message, /Available: fable-5, opus/);
  });

  it('accepts catId present in allowlist', async () => {
    const outcome = await mintAgentKey(makeArgs(), makeDeps());
    assert.equal(outcome.ok, true);
  });
});

describe('mintAgentKey — sanctuary Redis triple-confirm', () => {
  it('rejects 6399 without --i-understand-runtime-redis', async () => {
    const outcome = await mintAgentKey(
      makeArgs({ redisUrl: 'redis://127.0.0.1:6399', iUnderstandRuntimeRedis: false }),
      makeDeps(),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'sanctuary_not_acknowledged');
    assert.match(outcome.message, /6399.*--i-understand-runtime-redis/);
  });

  it('accepts 6399 with --i-understand-runtime-redis', async () => {
    const outcome = await mintAgentKey(
      makeArgs({ redisUrl: 'redis://127.0.0.1:6399', iUnderstandRuntimeRedis: true }),
      makeDeps(),
    );
    assert.equal(outcome.ok, true);
  });

  it('accepts 6398 (worktree) without --i-understand-runtime-redis', async () => {
    const outcome = await mintAgentKey(
      makeArgs({ redisUrl: 'redis://127.0.0.1:6398', iUnderstandRuntimeRedis: false }),
      makeDeps(),
    );
    assert.equal(outcome.ok, true);
  });
});

describe('mintAgentKey — pre-existing key file refusal', () => {
  it('rejects when key-file already exists', async () => {
    const stub = makeFsStub({ exists: true });
    const outcome = await mintAgentKey(makeArgs(), makeDeps({ fsOps: stub.fsOps }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'key_file_exists');
    assert.match(outcome.message, /Refusing to overwrite/);
  });
});

// ============ Dry-run discipline ============

describe('mintAgentKey — dry-run discipline', () => {
  it('dry-run: ok=true, dryRun=true, registryProvider NOT invoked, no fs writes', async () => {
    const stub = makeFsStub({});
    const invocations = { count: 0 };
    let issueCalled = false;
    const outcome = await mintAgentKey(
      makeArgs({ execute: false }),
      makeDeps({
        fsOps: stub.fsOps,
        registryProvider: makeProvider({
          invocations,
          issueImpl: async () => {
            issueCalled = true;
            return { agentKeyId: 'ak_should_not_be_invoked', secret: 'nope' };
          },
        }),
      }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.dryRun, true);
    assert.equal(invocations.count, 0, 'registryProvider must NOT be invoked in dry-run (codex §P1#3)');
    assert.equal(issueCalled, false, 'registry.issue should NOT be called in dry-run');
    assert.equal(stub.log.mkdir.length, 0, 'no mkdir in dry-run');
    assert.equal(stub.log.writeFile.length, 0, 'no writeFile in dry-run');
    assert.equal(stub.log.chmod.length, 0, 'no chmod in dry-run');
    assert.match(outcome.message, /add --execute/);
  });
});

// ============ Lazy registryProvider (codex §P1#3) ============

describe('mintAgentKey — lazy registryProvider (codex §P1#3)', () => {
  it('preflight rejects (unknown catId) → registryProvider NOT invoked even on execute=true', async () => {
    const invocations = { count: 0 };
    const outcome = await mintAgentKey(
      makeArgs({ catId: 'bogus-cat', execute: true }),
      makeDeps({ registryProvider: makeProvider({ invocations }), allowlist: new Set(['fable-5']) }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'cat_not_in_allowlist');
    assert.equal(invocations.count, 0, 'allowlist rejection must short-circuit before Redis');
  });

  it('preflight rejects (6399 without ack) → registryProvider NOT invoked even on execute=true', async () => {
    const invocations = { count: 0 };
    const outcome = await mintAgentKey(
      makeArgs({ redisUrl: 'redis://127.0.0.1:6399', iUnderstandRuntimeRedis: false, execute: true }),
      makeDeps({ registryProvider: makeProvider({ invocations }) }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'sanctuary_not_acknowledged');
    assert.equal(invocations.count, 0, '6399 rejection must short-circuit before Redis (this IS the whole point)');
  });

  it('preflight rejects (key-file exists) → registryProvider NOT invoked even on execute=true', async () => {
    const stub = makeFsStub({ exists: true });
    const invocations = { count: 0 };
    const outcome = await mintAgentKey(
      makeArgs({ execute: true }),
      makeDeps({ fsOps: stub.fsOps, registryProvider: makeProvider({ invocations }) }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'key_file_exists');
    assert.equal(invocations.count, 0, 'file-exists rejection must short-circuit before Redis');
  });

  it('execute=true + preflight pass: registryProvider invoked exactly once', async () => {
    const stub = makeFsStub({ statMode: 0o600 });
    const invocations = { count: 0 };
    const outcome = await mintAgentKey(
      makeArgs({ execute: true }),
      makeDeps({ fsOps: stub.fsOps, registryProvider: makeProvider({ invocations }) }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(invocations.count, 1, 'registryProvider must be invoked exactly once on the success path');
  });
});

// ============ Execute path ============

describe('mintAgentKey — execute path', () => {
  it('execute=true: writes secret with mode 0o600 + flag wx + chmod verify', async () => {
    const stub = makeFsStub({ statMode: 0o600 });
    let issuedFor: { catId: unknown; userId: unknown } | null = null;
    const outcome = await mintAgentKey(
      makeArgs({ execute: true }),
      makeDeps({
        fsOps: stub.fsOps,
        registryProvider: makeProvider({
          issueImpl: async (catId: unknown, userId: unknown) => {
            issuedFor = { catId, userId };
            return { agentKeyId: 'ak_test_minted', secret: 'deadbeef'.repeat(8) };
          },
        }),
      }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.dryRun, false);
    assert.equal(outcome.agentKeyId, 'ak_test_minted');
    assert.ok(issuedFor, 'registry.issue called');
    assert.equal((issuedFor as { catId: unknown; userId: unknown }).userId, 'default-user');
    assert.equal(stub.log.mkdir.length, 1);
    assert.equal(stub.log.mkdir[0].options.mode, 0o700);
    assert.equal(stub.log.mkdir[0].options.recursive, true);
    assert.equal(stub.log.writeFile.length, 1);
    assert.equal(stub.log.writeFile[0].options.mode, 0o600);
    // cloud P2 round 3: writeFile must use wx (exclusive create) to win the
    // race when two concurrent mint commands both pass exists() preflight.
    assert.equal(stub.log.writeFile[0].options.flag, 'wx', 'writeFile must use exclusive-create flag');
    assert.match(stub.log.writeFile[0].content, /deadbeef/);
    assert.match(stub.log.writeFile[0].content, /\n$/);
    assert.equal(stub.log.chmod.length, 1);
    assert.equal(stub.log.chmod[0].mode, 0o600);
    assert.equal(outcome.message.includes('deadbeef'), false, 'outcome message must NOT leak secret');
  });

  it('execute=true: registry.issue throws → issue_failed (file not written)', async () => {
    const stub = makeFsStub({});
    const outcome = await mintAgentKey(
      makeArgs({ execute: true }),
      makeDeps({
        fsOps: stub.fsOps,
        registryProvider: makeProvider({
          issueImpl: async () => {
            throw new Error('redis down');
          },
        }),
      }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'issue_failed');
    assert.match(outcome.message, /redis down/);
    assert.equal(stub.log.writeFile.length, 0, 'writeFile must not run after issue throws');
  });

  it('execute=true: registryProvider throws → issue_failed (no fs writes)', async () => {
    const stub = makeFsStub({});
    const outcome = await mintAgentKey(
      makeArgs({ execute: true }),
      makeDeps({
        fsOps: stub.fsOps,
        registryProvider: async () => {
          throw new Error('cannot connect to redis');
        },
      }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'issue_failed');
    assert.match(outcome.message, /registryProvider failed.*cannot connect/);
    assert.equal(stub.log.writeFile.length, 0);
  });

  it('execute=true: stat returns wrong mode → permission_verification_failed', async () => {
    const stub = makeFsStub({ statMode: 0o644 });
    const outcome = await mintAgentKey(makeArgs({ execute: true }), makeDeps({ fsOps: stub.fsOps }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'permission_verification_failed');
    assert.match(outcome.message, /0o644.*0o600/);
  });

  it('execute=true: writeFile throws EEXIST → key_file_exists (cloud P2 round 3 wx race)', async () => {
    // Race window between preflight exists() returning false and the actual
    // exclusive-create writeFile. Must surface key_file_exists, not silently
    // succeed and overwrite the other process's key.
    const stub = makeFsStub({ writeFileThrowsEexist: true });
    const outcome = await mintAgentKey(makeArgs({ execute: true }), makeDeps({ fsOps: stub.fsOps }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'key_file_exists');
    assert.match(outcome.message, /concurrent race/);
  });
});

// orphan-key revoke tests live in mint-agent-key-revoke.test.ts (file-size split).
