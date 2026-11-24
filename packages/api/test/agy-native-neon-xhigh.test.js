import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  AGY_OAUTH_FILE,
  agyOAuthFile,
  assertAgyCredentialHome,
  inspectAgyLogin,
  prepareAgyAccount,
} from '../dist/config/agy-account.js';
import { hasOnlyControlledWin32Hardlinks, isWin32AclSnapshotPrivate } from '../dist/config/win32-fs-security.js';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { materializeAgyNativeEffectGuard } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-effect-guard.js';
import { prepareAgyNativeLaunch } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-launch.js';
import { acquireAgyNativeProfileTurn } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-profile-turn.js';
import { parseNativeTurnOwner } from '../dist/domains/cats/services/agents/providers/agy-native/profile-turn/store.js';
import { evaluateWin32NativeTurnRetirement } from '../dist/domains/cats/services/agents/providers/agy-native/profile-turn/win32-process-identity.js';
import { prepareAgyAccountDataView } from '../dist/domains/cats/services/agents/providers/agy-native/run/agy-account-data-view.js';
import { spawnCli } from '../dist/utils/cli-spawn.js';

function makeOAuthToken(accessToken) {
  return JSON.stringify({
    auth_method: 'consumer',
    token: {
      access_token: accessToken,
      refresh_token: `refresh-${accessToken}`,
      expiry: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
}

describe('Gemini 4 Neon + xhigh & Windows AGY Native compatibility', () => {
  it('enforces AGY Native effort precedence (thread override > explicit member > model suffix) including clear override and unsupported models', async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'neon-xhigh-launch-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, 'workspace');
    const homeRoot = join(root, 'profiles');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });

    const prepare = async (invocationId, model, opts = {}) => {
      const plan = await prepareAgyNativeLaunch({
        catId: 'gemini-neon',
        model,
        workspace,
        profileConfig: {
          enabled: true,
          carrier: 'native',
          autoApprove: true,
          model,
          profileId: 'gemini-neon',
          homeRoot,
          trustedWorkspaces: [workspace],
        },
        prompt: 'hi',
        body: '# L0',
        command: process.execPath,
        options: {
          invocationId,
          ...(opts.override ? { reasoningEffortOverride: opts.override } : {}),
          ...(opts.memberEffort || opts.effortSource
            ? {
                executionPreferences: {
                  configurationSource: 'managed_account',
                  model,
                  effort: opts.memberEffort ?? 'high',
                  effortSource: opts.effortSource ?? 'member',
                  nativeAuthentication: false,
                },
              }
            : {}),
          spawnCliOverride: async function* () {},
        },
      });
      try {
        const modelIdx = plan.cliOptions.args.indexOf('--model');
        const effortIdx = plan.cliOptions.args.indexOf('--effort');
        return {
          effectiveModel: plan.effectiveModel,
          bindingModel: plan.binding.model,
          cliModel: plan.cliOptions.args[modelIdx + 1],
          cliEffort: effortIdx >= 0 ? plan.cliOptions.args[effortIdx + 1] : undefined,
        };
      } finally {
        await plan.disposeCredentials?.();
      }
    };

    // 1. Member low + thread override xhigh -> override wins
    const memberLowOverrideXhigh = await prepare('inv-1', 'gemini-4-neon-high', {
      memberEffort: 'low',
      effortSource: 'member',
      override: 'xhigh',
    });
    assert.deepEqual(memberLowOverrideXhigh, {
      effectiveModel: 'gemini-4-neon-xhigh',
      bindingModel: 'gemini-4-neon-xhigh',
      cliModel: 'gemini-4-neon-xhigh',
      cliEffort: 'xhigh',
    });

    // 2. Clear thread override -> falls back to explicit member low
    const memberLowCleared = await prepare('inv-2', 'gemini-4-neon-high', {
      memberEffort: 'low',
      effortSource: 'member',
    });
    assert.deepEqual(memberLowCleared, {
      effectiveModel: 'gemini-4-neon-low',
      bindingModel: 'gemini-4-neon-low',
      cliModel: 'gemini-4-neon-low',
      cliEffort: 'low',
    });

    // 3. Explicit member xhigh rewrites gemini-4-neon-high -> gemini-4-neon-xhigh
    const memberXhigh = await prepare('inv-3', 'gemini-4-neon-high', {
      memberEffort: 'xhigh',
      effortSource: 'member',
    });
    assert.deepEqual(memberXhigh, {
      effectiveModel: 'gemini-4-neon-xhigh',
      bindingModel: 'gemini-4-neon-xhigh',
      cliModel: 'gemini-4-neon-xhigh',
      cliEffort: 'xhigh',
    });

    // 4. Platform default preserves model suffix gemini-4-neon-xhigh without downgrading
    const platformDefault = await prepare('inv-4', 'gemini-4-neon-xhigh', {
      memberEffort: 'xhigh',
      effortSource: 'platform_default',
    });
    assert.deepEqual(platformDefault, {
      effectiveModel: 'gemini-4-neon-xhigh',
      bindingModel: 'gemini-4-neon-xhigh',
      cliModel: 'gemini-4-neon-xhigh',
      cliEffort: undefined,
    });

    // 5. Downgrade override low rewrites gemini-4-neon-xhigh -> gemini-4-neon-low
    const overrideLow = await prepare('inv-5', 'gemini-4-neon-xhigh', { override: 'low' });
    assert.deepEqual(overrideLow, {
      effectiveModel: 'gemini-4-neon-low',
      bindingModel: 'gemini-4-neon-low',
      cliModel: 'gemini-4-neon-low',
      cliEffort: 'low',
    });

    // 6. Switch to model that does NOT support xhigh (gemini-4-argon-high):
    //    (a) incompatible thread override xhigh + valid member low -> falls back to member low
    const argonMemberLow = await prepare('inv-6a', 'gemini-4-argon-high', {
      memberEffort: 'low',
      effortSource: 'member',
      override: 'xhigh',
    });
    assert.deepEqual(argonMemberLow, {
      effectiveModel: 'gemini-4-argon-low',
      bindingModel: 'gemini-4-argon-low',
      cliModel: 'gemini-4-argon-low',
      cliEffort: 'low',
    });

    //    (b) incompatible thread override xhigh + no member effort -> keeps model suffix, omits --effort
    const argonOverrideXhigh = await prepare('inv-6b', 'gemini-4-argon-high', { override: 'xhigh' });
    assert.deepEqual(argonOverrideXhigh, {
      effectiveModel: 'gemini-4-argon-high',
      bindingModel: 'gemini-4-argon-high',
      cliModel: 'gemini-4-argon-high',
      cliEffort: undefined,
    });

    //    (c) incompatible explicit member effort xhigh on gemini-4-argon-high -> rejected, keeps suffix
    const argonMemberXhigh = await prepare('inv-6c', 'gemini-4-argon-high', {
      memberEffort: 'xhigh',
      effortSource: 'member',
    });
    assert.deepEqual(argonMemberXhigh, {
      effectiveModel: 'gemini-4-argon-high',
      bindingModel: 'gemini-4-argon-high',
      cliModel: 'gemini-4-argon-high',
      cliEffort: undefined,
    });

    //    (d) model with no effort tiers at all (gemini-2.5-pro) + override xhigh -> untouched, no --effort
    const legacyPro = await prepare('inv-6d', 'gemini-2.5-pro', { override: 'xhigh' });
    assert.deepEqual(legacyPro, {
      effectiveModel: 'gemini-2.5-pro',
      bindingModel: 'gemini-2.5-pro',
      cliModel: 'gemini-2.5-pro',
      cliEffort: undefined,
    });
  });

  it('fails closed on Windows turn retirement for birth-read errors, live children without --gemini_dir, missing kernel job, and PID reuse', () => {
    const home = join('C:', 'Users', 'tester', '.cat-cafe', 'agy-profile');
    const runHome = join(home, '.cat-cafe-native-runs', 'run-abc123');
    const ownerBase = {
      identity: { pid: 4000, ppid: 100, pgid: 0, startedAt: '2026-01-01T00:00:00.0000000Z' },
      dataRoot: join('C:', 'Users', 'tester', '.cat-cafe', 'data'),
      invocationId: 'inv-win-retire',
      runHome,
      windowsJob: { jobName: 'Local\\ClowderApiJob-11111111-1111-1111-1111-111111111111', sessionId: 1 },
    };
    const verifiedJob = { status: 'verified_absent', jobCount: 1 };

    // 1. Birth-time read failure on owner PID + no marker in snapshot -> MUST stay unverified (fail closed)
    const birthReadFailed = evaluateWin32NativeTurnRetirement(
      ownerBase,
      home,
      [{ pid: 4000, ppid: 100, startedAt: null, commandLine: null }],
      verifiedJob,
    );
    assert.equal(birthReadFailed.retired, false);
    assert.equal(birthReadFailed.reason, 'owner_birth_unreadable');

    // 2. CIM snapshot failure -> fail closed
    assert.equal(evaluateWin32NativeTurnRetirement(ownerBase, home, null, verifiedJob).retired, false);

    // 3. Owner exited, live child tool still running WITHOUT --gemini_dir (or even null CommandLine) -> fail closed
    const liveChildNoMarker = evaluateWin32NativeTurnRetirement(
      ownerBase,
      home,
      [{ pid: 4500, ppid: 4000, startedAt: '2026-01-01T00:00:05.0000000Z', commandLine: 'node.exe helper.js' }],
      verifiedJob,
    );
    assert.equal(liveChildNoMarker.retired, false);
    assert.equal(liveChildNoMarker.reason, 'owner_descendant_alive');

    const liveChildNullCmd = evaluateWin32NativeTurnRetirement(
      ownerBase,
      home,
      [{ pid: 4501, ppid: 4000, startedAt: '2026-01-01T00:00:05.0000000Z', commandLine: null }],
      verifiedJob,
    );
    assert.equal(liveChildNullCmd.retired, false);
    assert.equal(liveChildNullCmd.reason, 'owner_descendant_alive');

    // 4. Non-preparation turn with NO kernel job proof -> fail closed (protects against orphaned grandchildren)
    const noJobProof = evaluateWin32NativeTurnRetirement(ownerBase, home, [], { status: 'none' });
    assert.equal(noJobProof.retired, false);
    assert.equal(noJobProof.reason, 'windows_job_evidence_missing');

    // 5. Non-preparation turn with live/unknown kernel job -> fail closed
    const presentJob = evaluateWin32NativeTurnRetirement(ownerBase, home, [], {
      status: 'unverified',
      reason: 'job_present:job_still_owns_members',
    });
    assert.equal(presentJob.retired, false);

    // 6. PID reuse where dead owner STILL has a live descendant born before PID reuse -> fail closed
    const pidReuseWithOrphan = evaluateWin32NativeTurnRetirement(
      ownerBase,
      home,
      [
        { pid: 4000, ppid: 1, startedAt: '2026-01-01T00:05:00.0000000Z', commandLine: 'unrelated.exe' },
        { pid: 4600, ppid: 4000, startedAt: '2026-01-01T00:00:10.0000000Z', commandLine: 'tool.exe --no-marker' },
      ],
      verifiedJob,
    );
    assert.equal(pidReuseWithOrphan.retired, false);
    assert.equal(pidReuseWithOrphan.reason, 'owner_descendant_alive');

    // 7. PID reuse where ONLY the new process and its own post-reuse child exist + closed kernel job -> RETIRED
    const pidReuseVerifiedClean = evaluateWin32NativeTurnRetirement(
      ownerBase,
      home,
      [
        { pid: 4000, ppid: 1, startedAt: '2026-01-01T00:05:00.0000000Z', commandLine: 'unrelated.exe' },
        { pid: 4601, ppid: 4000, startedAt: '2026-01-01T00:05:00.0500000Z', commandLine: 'unrelated-child.exe' },
      ],
      verifiedJob,
    );
    assert.equal(pidReuseVerifiedClean.retired, true);
    assert.equal(pidReuseVerifiedClean.reason, 'retired_verified');

    // 8. Preparation turn with PID reuse and no pre-reuse children -> RETIRED (no job required for host prep)
    const prepPidReuse = evaluateWin32NativeTurnRetirement(
      { ...ownerBase, preparation: true, windowsJob: undefined },
      home,
      [{ pid: 4000, ppid: 1, startedAt: '2026-01-01T00:05:00.0000000Z', commandLine: 'unrelated.exe' }],
      { status: 'none' },
    );
    assert.equal(prepPidReuse.retired, true);

    // 9. parseNativeTurnOwner rejects malformed windowsJob evidence
    assert.throws(
      () =>
        parseNativeTurnOwner(
          JSON.stringify({ ...ownerBase, windowsJob: { jobName: 'Foreign\\Job', sessionId: 1 } }),
          home,
        ),
      /invalid Windows job ownership/,
    );
  });

  it(
    'refuses to preempt or delete orphan credentials on Windows when parent exits but child without --gemini_dir is still alive',
    { skip: process.platform !== 'win32' },
    async (t) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'neon-win-retire-live-')));
      const home = join(root, 'profile');
      const runHome = join(home, '.cat-cafe-native-runs', 'run-livechild1');
      const credDir = join(runHome, '.gemini', 'config', 'cat-cafe-credentials');
      mkdirSync(credDir, { recursive: true });
      const credFile = join(credDir, `${randomUUID()}.json`);
      writeFileSync(credFile, '{"callbackToken":"do-not-delete"}');

      const turnModuleUrl = new URL(
        '../dist/domains/cats/services/agents/providers/agy-native/agy-native-profile-turn.js',
        import.meta.url,
      ).href;

      let childPid;
      t.after(() => {
        if (childPid) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {}
        }
        rmSync(root, { recursive: true, force: true });
      });

      const parent = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
            import { spawn } from 'node:child_process';
            import { acquireAgyNativeProfileTurn } from ${JSON.stringify(turnModuleUrl)};
            acquireAgyNativeProfileTurn(${JSON.stringify(home)}, 'inv-orphan-child', {
              conversationId: 'conv-child-alive',
              runHome: ${JSON.stringify(runHome)},
            });
            // Spawn child WITHOUT --gemini_dir or HOME marker in argv.
            const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            });
            child.unref();
            process.stdout.write(JSON.stringify({ childPid: child.pid }) + '\\n');
            process.exit(0);
          `,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      const [chunk] = await once(parent.stdout, 'data');
      childPid = JSON.parse(chunk.toString().trim()).childPid;
      await once(parent, 'exit');

      assert.throws(
        () =>
          acquireAgyNativeProfileTurn(home, 'inv-successor', {
            conversationId: 'conv-child-alive',
          }),
        /Another native turn/,
      );
      assert.equal(existsSync(credFile), true, 'orphan credential must NOT be deleted when retirement is unverified');

      // Preparation lease left by an exited parent without live children CAN be cleanly reclaimed.
      const prepParent = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
            import { acquireAgyNativeProfileTurn } from ${JSON.stringify(turnModuleUrl)};
            acquireAgyNativeProfileTurn(${JSON.stringify(home)}, 'inv-prep-dead', { preparation: true });
            process.exit(0);
          `,
        ],
        { stdio: 'ignore', windowsHide: true },
      );
      await once(prepParent, 'exit');
      const releasePrep = acquireAgyNativeProfileTurn(home, 'inv-prep-next', { preparation: true });
      releasePrep();
    },
  );

  it('enforces Windows ACL and controlled hardlink invariants plus fail-closed EXDEV cross-volume handling', (t) => {
    // 1. Pure ACL evaluator checks
    assert.equal(
      isWin32AclSnapshotPrivate({
        currentUserSid: 'S-1-5-21-1000-2000-3000-1001',
        ownerSid: 'S-1-5-21-1000-2000-3000-1001',
        allowSids: ['S-1-5-18', 'S-1-5-32-544', 'S-1-5-21-1000-2000-3000-1001'],
      }),
      true,
    );
    for (const badSid of ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-21-1000-2000-3000-1002']) {
      assert.equal(
        isWin32AclSnapshotPrivate({
          currentUserSid: 'S-1-5-21-1000-2000-3000-1001',
          ownerSid: 'S-1-5-21-1000-2000-3000-1001',
          allowSids: ['S-1-5-18', 'S-1-5-21-1000-2000-3000-1001', badSid],
        }),
        false,
        `Allow ACE for ${badSid} must be rejected`,
      );
    }
    assert.equal(
      isWin32AclSnapshotPrivate({
        currentUserSid: 'S-1-5-21-1000-2000-3000-1001',
        ownerSid: 'S-1-5-21-1000-2000-3000-1002',
        allowSids: ['S-1-5-21-1000-2000-3000-1001'],
      }),
      false,
    );
    assert.equal(isWin32AclSnapshotPrivate(null), false);

    // 2. Deterministic cross-volume EXDEV check (runs on all platforms)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'neon-exdev-')));
    const prevGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    t.after(() => {
      if (prevGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevGlobalRoot;
      rmSync(root, { recursive: true, force: true });
    });
    const profileHome = join(root, 'profile');
    mkdirSync(join(profileHome, '.gemini', 'antigravity-cli'), { recursive: true });
    const prepared = prepareAgyAccount(root, `agy-${randomUUID()}`);
    writeFileSync(agyOAuthFile(prepared.credentialHome), makeOAuthToken('tok-cross-vol'), { mode: 0o600 });

    assert.throws(
      () =>
        prepareAgyAccountDataView(profileHome, prepared.credentialHome, {
          forceWin32HardlinkFallback: true,
          linkSyncFn: () => {
            throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
          },
        }),
      /agy_account_view_cross_volume_unsupported/,
    );
    // Never fall back to copying token bytes into the view!
    const expectedViewDir = join(
      profileHome,
      '.cat-cafe-account-views',
      createHash('sha256').update(realpathSync(prepared.credentialHome)).digest('hex'),
    );
    assert.equal(
      existsSync(join(expectedViewDir, AGY_OAUTH_FILE)),
      false,
      'EXDEV must fail closed without copying tokens',
    );

    // 3. Controlled hardlink validator rejects extra uncontrolled aliases (including 8.3 short-path canonicalization)
    if (process.platform === 'win32') {
      const oauthPath = agyOAuthFile(prepared.credentialHome);
      const canonicalRel = realpathSync.native(oauthPath).slice(2);
      assert.equal(
        hasOnlyControlledWin32Hardlinks(oauthPath, (p) => p.includes('\\.cat-cafe-account-views\\'), {
          expectedNlink: 2,
          listLinks: () => [canonicalRel, '\\outside\\leaked-token'],
        }),
        false,
      );
      assert.equal(
        hasOnlyControlledWin32Hardlinks(oauthPath, () => true, {
          expectedNlink: 2,
          listLinks: () => null,
        }),
        false,
      );
    }
  });

  it(
    'recovers Windows hardlink views for first DB creation and canonical OAuth inode replacement, and rejects permissive ACLs & extra hardlinks',
    { skip: process.platform !== 'win32' },
    (t) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'neon-acct-win-real-')));
      const prevGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      const prevPsModulePath = process.env.PSModulePath;
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
      // Emulate a PowerShell 7 (`pwsh`) parent shell (e.g. GitHub Actions windows-latest)
      // whose PSModulePath must never break Windows PowerShell 5.1 ACL inspection.
      process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules';
      t.after(() => {
        if (prevGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
        else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevGlobalRoot;
        if (prevPsModulePath === undefined) delete process.env.PSModulePath;
        else process.env.PSModulePath = prevPsModulePath;
        rmSync(root, { recursive: true, force: true });
      });
      const profileHome = join(root, 'profile');
      mkdirSync(join(profileHome, '.gemini', 'antigravity-cli'), { recursive: true });
      const accountA = prepareAgyAccount(root, `agy-${randomUUID()}`);
      const accountB = prepareAgyAccount(root, `agy-${randomUUID()}`);
      assert.equal(inspectAgyLogin(accountA.credentialHome), 'not_logged_in');

      const oauthA = agyOAuthFile(accountA.credentialHome);
      const oauthB = agyOAuthFile(accountB.credentialHome);
      writeFileSync(oauthA, makeOAuthToken('tok-v1'), { mode: 0o600 });
      writeFileSync(oauthB, makeOAuthToken('tok-b'), { mode: 0o600 });
      assert.equal(inspectAgyLogin(accountA.credentialHome), 'ready');

      // 1. First DB creation: canonical conversation_summaries.db does NOT exist yet on first prepare
      const viewA = prepareAgyAccountDataView(profileHome, accountA.credentialHome, {
        forceWin32HardlinkFallback: true,
      });
      const canonicalDb = join(profileHome, '.gemini', 'antigravity-cli', 'conversation_summaries.db');
      const viewADb = join(viewA, 'conversation_summaries.db');
      assert.equal(existsSync(canonicalDb), false);
      assert.equal(existsSync(viewADb), false);

      // Simulate AGY CLI creating conversation_summaries.db inside the view
      writeFileSync(viewADb, 'sqlite-first-db-v1');

      // Second prepare must promote viewADb -> canonicalDb and hardlink viewADb back (NO agy_account_view_link_changed!)
      const viewAAgain = prepareAgyAccountDataView(profileHome, accountA.credentialHome, {
        forceWin32HardlinkFallback: true,
      });
      assert.equal(viewAAgain, viewA);
      assert.equal(existsSync(canonicalDb), true);
      assert.equal(readFileSync(canonicalDb, 'utf8'), 'sqlite-first-db-v1');
      assert.equal(lstatSync(canonicalDb).ino, lstatSync(viewADb).ino);
      assert.equal(lstatSync(canonicalDb).nlink, 2);

      // Account B view links to the SAME promoted canonical DB (nlink === 3)
      const viewB = prepareAgyAccountDataView(profileHome, accountB.credentialHome, {
        forceWin32HardlinkFallback: true,
      });
      const viewBDb = join(viewB, 'conversation_summaries.db');
      assert.equal(lstatSync(viewBDb).ino, lstatSync(canonicalDb).ino);
      assert.equal(lstatSync(canonicalDb).nlink, 3);
      assert.equal(readFileSync(viewBDb, 'utf8'), 'sqlite-first-db-v1');

      // Controlled nlink === 2 on oauthA (canonical + viewA) MUST still inspect as 'ready'
      assert.equal(lstatSync(oauthA).nlink, 2);
      assert.equal(inspectAgyLogin(accountA.credentialHome), 'ready');

      // 2. Canonical OAuth inode replacement (re-login writes temp file + rename -> new inode)
      const viewAOAuth = join(viewA, AGY_OAUTH_FILE);
      const oldIno = lstatSync(oauthA).ino;
      assert.equal(lstatSync(viewAOAuth).ino, oldIno);
      const reloginTmp = `${oauthA}.relogin-${randomUUID()}`;
      writeFileSync(reloginTmp, makeOAuthToken('tok-v2-relogin'), { mode: 0o600 });
      renameSync(reloginTmp, oauthA);
      const newIno = lstatSync(oauthA).ino;
      assert.notEqual(newIno, oldIno, 'atomic rename must produce a new canonical inode');

      // Next prepare recovers by atomically re-linking viewA to the new canonical inode (zero token copy)
      prepareAgyAccountDataView(profileHome, accountA.credentialHome, {
        forceWin32HardlinkFallback: true,
      });
      assert.equal(lstatSync(viewAOAuth).ino, newIno);
      assert.match(readFileSync(viewAOAuth, 'utf8'), /tok-v2-relogin/);
      assert.equal(inspectAgyLogin(accountA.credentialHome), 'ready');

      // 3. Extra uncontrolled hardlink outside the controlled view -> rejected!
      const leakedOAuth = join(root, 'leaked-oauth-link');
      linkSync(oauthA, leakedOAuth);
      assert.equal(inspectAgyLogin(accountA.credentialHome), 'unreadable');
      assert.throws(
        () => prepareAgyAccountDataView(profileHome, accountA.credentialHome, { forceWin32HardlinkFallback: true }),
        /agy_shared_session_file_unsafe/,
      );
      rmSync(leakedOAuth, { force: true });
      assert.equal(inspectAgyLogin(accountA.credentialHome), 'ready');

      const leakedDb = join(root, 'leaked-db-link');
      linkSync(canonicalDb, leakedDb);
      assert.throws(
        () => prepareAgyAccountDataView(profileHome, accountA.credentialHome, { forceWin32HardlinkFallback: true }),
        /agy_shared_session_file_unsafe/,
      );
      rmSync(leakedDb, { force: true });

      // 4. Tampered directory replacing file slot in view still fails with agy_account_view_link_changed
      const strayDirView = join(viewB, 'installation_id');
      mkdirSync(strayDirView);
      assert.throws(
        () => prepareAgyAccountDataView(profileHome, accountB.credentialHome, { forceWin32HardlinkFallback: true }),
        /agy_account_view_link_changed/,
      );
      rmSync(strayDirView, { recursive: true, force: true });

      // 5. Permissive credential root ACL (grant Everyone:Read via S-1-1-0) -> rejected!
      const grant = spawnSync('icacls.exe', [accountA.credentialHome, '/grant', '*S-1-1-0:(OI)(CI)R'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(grant.status, 0, grant.stderr || grant.stdout);
      assert.throws(() => assertAgyCredentialHome(accountA.credentialHome), /agy_account_directory_unsafe/);
      assert.equal(inspectAgyLogin(accountA.credentialHome), 'unreadable');

      // 6. Real cross-volume check if a second drive (e.g. D: when temp is on C:) is writable
      const currentDrive = root.slice(0, 2).toUpperCase();
      const otherDrive = currentDrive === 'C:' ? 'D:' : 'C:';
      const otherBase = join(`${otherDrive}\\`, 'CatWorkSpace');
      if (existsSync(otherBase)) {
        const otherProfile = mkdtempSync(join(otherBase, 'neon-xvol-profile-'));
        t.after(() => rmSync(otherProfile, { recursive: true, force: true }));
        mkdirSync(join(otherProfile, '.gemini', 'antigravity-cli'), { recursive: true });
        assert.throws(
          () =>
            prepareAgyAccountDataView(otherProfile, accountB.credentialHome, {
              forceWin32HardlinkFallback: true,
            }),
          /agy_account_view_cross_volume_unsupported/,
        );
      }
    },
  );

  it('executes materialized effect guard hooks through real cmd.exe (including /v:on delayed expansion) with spaces, Chinese, &, %TEMP%, and !BANG!', (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'neon-hook-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    if (process.platform !== 'win32') {
      const profileHome = join(root, 'run-home');
      const workspaceRoot = join(root, 'workspace');
      mkdirSync(join(profileHome, '.gemini', 'config'), { recursive: true });
      mkdirSync(workspaceRoot, { recursive: true });
      const hooksPath = materializeAgyNativeEffectGuard({
        profileHome,
        runtimeRoot: process.cwd(),
        workspaceRoot,
        readOnly: false,
      });
      const command = JSON.parse(readFileSync(hooksPath, 'utf8'))['cat-cafe-native-effect'].PreToolUse[0].hooks[0]
        .command;
      assert.ok(command.startsWith("'"), `Expected POSIX single-quoted hook command, got: ${command}`);
      return;
    }

    // Real Windows NTFS directory names containing spaces, Chinese, &, literal %TEMP%, and !BANG!
    const trickyDir = join(root, 'dir 中文 & %TEMP% !BANG!');
    const profileHome = join(trickyDir, 'profile 中文 & !BANG!');
    const workspaceRoot = join(trickyDir, 'ws 中文 & %TEMP% !BANG!');
    const outsideDir = join(trickyDir, 'outside dir');
    mkdirSync(join(profileHome, '.gemini', 'config'), { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const sampleFile = join(workspaceRoot, 'hello 中文.txt');
    writeFileSync(sampleFile, 'hello');

    const runGuardViaCmd = (command, payload, delayedExpansion) => {
      const args = delayedExpansion ? ['/d', '/v:on', '/c', command] : ['/d', '/c', command];
      const result = spawnSync('cmd.exe', args, {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
        env: {
          ...process.env,
          BANG: 'EXPANDED_SHOULD_NOT_HAPPEN',
          TEMP: join(root, 'decoy-temp-expansion'),
        },
      });
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, 0, `cmd.exe (${args.slice(0, -1).join(' ')}) failed: ${result.stderr}`);
      return JSON.parse(result.stdout.trim());
    };

    // 1. Normal mode with requireApproval + allowWorkspaceWrites:
    //    proves workspaceRoot (argv[5]) & profileHome (argv[4]) arrive byte-for-byte intact
    //    through BOTH cmd /d /c AND cmd /d /v:on /c without expanding %TEMP% or !BANG!.
    const hooksPath = materializeAgyNativeEffectGuard({
      profileHome,
      runtimeRoot: process.cwd(),
      workspaceRoot,
      readOnly: false,
      requireApproval: true,
      allowWorkspaceWrites: true,
    });
    const normalCommand = JSON.parse(readFileSync(hooksPath, 'utf8'))['cat-cafe-native-effect'].PreToolUse[0].hooks[0]
      .command;
    assert.ok(
      normalCommand.startsWith('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '),
      `Expected EncodedCommand wrapper on Windows, got: ${normalCommand}`,
    );

    for (const delayed of [false, true]) {
      const allowRead = runGuardViaCmd(
        normalCommand,
        {
          hookEventName: 'PreToolUse',
          workspacePaths: [workspaceRoot],
          toolCall: { name: 'read_file', args: { Path: sampleFile } },
        },
        delayed,
      );
      assert.equal(allowRead.decision, 'allow', JSON.stringify(allowRead));

      // In-workspace write succeeds ONLY if argv[5] workspaceRoot matched the exact unexpanded path!
      const allowInWorkspaceWrite = runGuardViaCmd(
        normalCommand,
        {
          hookEventName: 'PreToolUse',
          workspacePaths: [workspaceRoot],
          toolCall: { name: 'write_to_file', args: { TargetFile: join(workspaceRoot, 'in-ws 中文.txt') } },
        },
        delayed,
      );
      assert.equal(allowInWorkspaceWrite.decision, 'allow', JSON.stringify(allowInWorkspaceWrite));

      // Out-of-workspace write MUST be denied
      const denyOutside = runGuardViaCmd(
        normalCommand,
        {
          hookEventName: 'PreToolUse',
          workspacePaths: [workspaceRoot],
          toolCall: { name: 'write_to_file', args: { TargetFile: join(outsideDir, 'escape.txt') } },
        },
        delayed,
      );
      assert.equal(denyOutside.decision, 'deny', JSON.stringify(denyOutside));

      // Control-plane write (.agents/hooks.json and profile hooks.json) MUST be denied
      const denyControlAgents = runGuardViaCmd(
        normalCommand,
        {
          hookEventName: 'PreToolUse',
          workspacePaths: [workspaceRoot],
          toolCall: { name: 'write_to_file', args: { TargetFile: join(workspaceRoot, '.agents', 'hooks.json') } },
        },
        delayed,
      );
      assert.equal(denyControlAgents.decision, 'deny', JSON.stringify(denyControlAgents));

      const denyControlProfile = runGuardViaCmd(
        normalCommand,
        {
          hookEventName: 'PreToolUse',
          workspacePaths: [workspaceRoot],
          toolCall: { name: 'write_to_file', args: { TargetFile: hooksPath } },
        },
        delayed,
      );
      assert.equal(denyControlProfile.decision, 'deny', JSON.stringify(denyControlProfile));
    }

    // 2. Toggle to read-only mode on the same profileHome (verifies mode-change check works with EncodedCommand)
    materializeAgyNativeEffectGuard({
      profileHome,
      runtimeRoot: process.cwd(),
      workspaceRoot,
      readOnly: true,
      requireApproval: true,
      allowWorkspaceWrites: true,
    });
    const readOnlyCommand = JSON.parse(readFileSync(hooksPath, 'utf8'))['cat-cafe-native-effect'].PreToolUse[0].hooks[0]
      .command;
    const denyReadOnlyWrite = runGuardViaCmd(
      readOnlyCommand,
      {
        hookEventName: 'PreToolUse',
        workspacePaths: [workspaceRoot],
        toolCall: { name: 'write_to_file', args: { TargetFile: join(workspaceRoot, 'mutated.txt') } },
      },
      true,
    );
    assert.equal(denyReadOnlyWrite.decision, 'deny', JSON.stringify(denyReadOnlyWrite));
    assert.match(denyReadOnlyWrite.reason ?? '', /read-only/i);
  });

  describe(
    'Windows post-EOF teardown & terminal preservation regressions',
    { skip: process.platform !== 'win32' },
    () => {
      function createWindowsFixtureService(t, profileId = 'gemini-neon', autoApprove = false) {
        const root = realpathSync(mkdtempSync(join(tmpdir(), `neon-win-eof-${profileId}-`)));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const workspace = join(root, 'workspace');
        mkdirSync(workspace, { recursive: true });
        const model = 'gemini-4-neon-xhigh';
        const config = {
          catId: 'gemini-neon',
          command: process.execPath,
          l0CompilerFn: async () => '# Identity\nNeon Windows EOF fixture.',
          profile: {
            enabled: true,
            carrier: 'native',
            autoApprove,
            model,
            profileId,
            homeRoot: join(root, 'profiles'),
            trustedWorkspaces: [workspace],
          },
        };
        return { root, workspace, model, config, service: new AgyNativeAgentService(config) };
      }

      function spawnNodeScript(launch, script, model, timeoutMs = 15_000) {
        return spawnCli({
          ...launch,
          command: process.execPath,
          args: ['-e', script, launch.args[launch.args.indexOf('--agent') + 1], launch.cwd, model],
          timeoutMs,
        });
      }

      it('terminates lingering Windows stream-json child cleanly after SUCCESS and records post-EOF shutdown diagnostics', async (t) => {
        const { workspace, model, service } = createWindowsFixtureService(t, 'linger-ok');
        const script = `
        const readline = require('node:readline');
        const [agent, cwd, model] = process.argv.slice(1);
        const send = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
        setInterval(() => {}, 1000);
        const input = readline.createInterface({ input: process.stdin });
        input.once('line', () => {
          send({ event: 'init', conversation_id: 'win-eof-session', init: { agent, cwd, model, permission_mode: 'request-review', tools: [] } });
          setTimeout(() => send({ event: 'result', result: { conversation_id: 'win-eof-session', status: 'SUCCESS', response: 'WIN_EOF_OK' } }), 50);
        });
      `;
        const startedAt = Date.now();
        const messages = [];
        for await (const msg of service.invoke('Hello', {
          workingDirectory: workspace,
          signal: AbortSignal.timeout(15_000),
          spawnCliOverride: (launch) => spawnNodeScript(launch, script, model),
        })) {
          messages.push(msg);
        }
        const elapsedMs = Date.now() - startedAt;
        const done = messages.at(-1);
        assert.equal(done?.type, 'done');
        assert.equal(done?.errorCode, undefined, JSON.stringify(messages.filter((m) => m.type === 'error')));
        assert.equal(messages.find((m) => m.type === 'text')?.content, 'WIN_EOF_OK');
        assert.equal(done?.metadata?.diagnostics?.agyNative?.outcome, 'ok');
        assert.equal(done?.metadata?.diagnostics?.agyNative?.upstreamStatus, 'SUCCESS');
        assert.deepEqual(done?.metadata?.diagnostics?.agyNative?.windowsPostEofShutdown, {
          triggered: true,
          graceMs: 2000,
        });
        assert.ok(elapsedMs >= 1_800 && elapsedMs < 8_000, `Expected ~2s bounded teardown, took ${elapsedMs}ms`);
      });

      it('preserves immediate exit 1 and ordinary exit 3 failures after result without swallowing them', async (t) => {
        for (const exitCode of [1, 3]) {
          const { workspace, model, service } = createWindowsFixtureService(t, `exit-${exitCode}`);
          const script = `
          const readline = require('node:readline');
          const [agent, cwd, model] = process.argv.slice(1);
          const send = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
          const input = readline.createInterface({ input: process.stdin });
          input.once('line', () => {
            send({ event: 'init', conversation_id: 'win-exit-${exitCode}', init: { agent, cwd, model, permission_mode: 'request-review', tools: [] } });
            send({ event: 'result', result: { conversation_id: 'win-exit-${exitCode}', status: ${exitCode === 1 ? "'SUCCESS'" : "'ERROR'"}, response: 'partial', num_turns: 2, ...( ${exitCode === 3 ? "{ error: 'ordinary error' }" : '{}'} ) } });
            process.exit(${exitCode});
          });
        `;
          const startedAt = Date.now();
          const messages = [];
          for await (const msg of service.invoke('Fail after result', {
            workingDirectory: workspace,
            signal: AbortSignal.timeout(10_000),
            spawnCliOverride: (launch) => spawnNodeScript(launch, script, model),
          })) {
            messages.push(msg);
          }
          const elapsedMs = Date.now() - startedAt;
          const done = messages.at(-1);
          assert.equal(done?.type, 'done');
          assert.equal(done?.errorCode, 'AGY_NATIVE_FAILED', `exit ${exitCode} must surface AGY_NATIVE_FAILED`);
          assert.equal(done?.metadata?.diagnostics?.agyNative?.windowsPostEofShutdown, undefined);
          assert.ok(elapsedMs < 3_000, `Immediate exit ${exitCode} should not stall, took ${elapsedMs}ms`);
        }
      });

      it('preserves /compact retained checkpoint exit 3 success under real Windows child process execution', async (t) => {
        const { workspace, model, config } = createWindowsFixtureService(t, 'compact-exit3', true);
        const script = `
        const readline = require('node:readline');
        const [agent, cwd, model] = process.argv.slice(1);
        const send = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
        const input = readline.createInterface({ input: process.stdin });
        input.once('line', (line) => {
          const compact = line.includes('/compact');
          send({ event: 'init', conversation_id: 'win-compact-3', init: { agent, cwd, model, permission_mode: 'always-proceed', tools: [] } });
          if (compact) {
            send({ event: 'step_update', step_update: { conversation_id: 'win-compact-3', step_index: 2, state: 'DONE', step_type: 'user_input' } });
            send({ event: 'step_update', step_update: { conversation_id: 'win-compact-3', step_index: 4, state: 'DONE', step_type: 'checkpoint' } });
            send({ event: 'result', result: { conversation_id: 'win-compact-3', status: 'ERROR', response: '', num_turns: 2, error: 'retained prior error' } });
            process.exit(3);
          }
          send({ event: 'result', result: { conversation_id: 'win-compact-3', status: 'SUCCESS', response: 'seeded', num_turns: 1 } });
          process.exit(0);
        });
      `;
        const service = new AgyNativeAgentService({
          ...config,
          spawnCliFn: (launch) => spawnNodeScript(launch, script, model),
        });
        const first = [];
        for await (const msg of service.invoke('seed', { workingDirectory: workspace })) first.push(msg);
        const binding = first.find((m) => m.type === 'session_init')?.nativeSessionBinding;
        assert.ok(binding);

        const compactEvent = await service.requestNativeCompaction({
          sessionId: binding.cliSessionId,
          nativeSessionBinding: binding,
          invocationId: 'inv-win-compact-3',
          timeoutMs: 10_000,
          userId: 'fixture-owner',
        });
        assert.equal(compactEvent.runtimeSessionId, 'win-compact-3');
        assert.match(compactEvent.evidenceRef, /checkpoint/);
      });

      it('cancels immediately on caller Stop before terminal and preserves streamed partial text', async (t) => {
        const { workspace, model, service } = createWindowsFixtureService(t, 'stop-cancel');
        const script = `
        const readline = require('node:readline');
        const [agent, cwd, model] = process.argv.slice(1);
        const send = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
        setInterval(() => {}, 1000);
        const input = readline.createInterface({ input: process.stdin });
        input.once('line', () => {
          send({ event: 'init', conversation_id: 'win-stop', init: { agent, cwd, model, permission_mode: 'request-review', tools: [] } });
          send({
            event: 'step_update',
            step_update: {
              conversation_id: 'win-stop',
              step_index: 2,
              state: 'ACTIVE',
              step_type: 'agent_response',
              text_delta: 'PARTIAL_BEFORE_STOP',
            },
          });
        });
      `;
        const abort = new AbortController();
        const startedAt = Date.now();
        const messages = [];
        for await (const msg of service.invoke('Stream then stop', {
          workingDirectory: workspace,
          signal: abort.signal,
          spawnCliOverride: (launch) => spawnNodeScript(launch, script, model),
        })) {
          messages.push(msg);
          if (msg.type === 'text' && msg.content.includes('PARTIAL_BEFORE_STOP')) {
            abort.abort();
          }
        }
        const elapsedMs = Date.now() - startedAt;
        const done = messages.at(-1);
        assert.equal(done?.type, 'done');
        assert.equal(done?.errorCode, 'AGY_CANCELLED');
        assert.ok(messages.some((m) => m.type === 'text' && m.content.includes('PARTIAL_BEFORE_STOP')));
        assert.equal(done?.metadata?.diagnostics?.agyNative?.windowsPostEofShutdown, undefined);
        assert.ok(elapsedMs < 5_000, `Stop should cancel without hanging, took ${elapsedMs}ms`);
      });

      it('does not close or kill multi-turn child early when a pending supplemental input is queued before Turn 1 result', async (t) => {
        const { workspace, model, service } = createWindowsFixtureService(t, 'multi-turn');
        const script = `
        const readline = require('node:readline');
        const [agent, cwd, model] = process.argv.slice(1);
        const send = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
        setInterval(() => {}, 1000);
        let stdinClosed = false;
        process.stdin.on('end', () => { stdinClosed = true; });
        const input = readline.createInterface({ input: process.stdin });
        let turn = 0;
        input.on('line', () => {
          turn += 1;
          if (turn === 1) {
            send({ event: 'init', conversation_id: 'win-multi', init: { agent, cwd, model, permission_mode: 'request-review', tools: [] } });
            send({ event: 'step_update', step_update: { conversation_id: 'win-multi', step_index: 1, state: 'DONE', step_type: 'user_input' } });
            // Wait 300ms so caller dispatches Turn 2 before Turn 1 emits result.
            setTimeout(() => {
              send({ event: 'result', result: { conversation_id: 'win-multi', status: 'SUCCESS', response: 'TURN1_OK', num_turns: 1 } });
            }, 300);
          } else if (turn === 2) {
            // Delay Turn 2 beyond the 2s post-EOF window to prove Turn 1's result did NOT arm teardown!
            setTimeout(() => {
              send({ event: 'step_update', step_update: { conversation_id: 'win-multi', step_index: 3, state: 'DONE', step_type: 'user_input' } });
              send({
                event: 'result',
                result: {
                  conversation_id: 'win-multi',
                  status: stdinClosed ? 'ERROR' : 'SUCCESS',
                  response: stdinClosed ? '' : 'TURN2_OK',
                  ...(stdinClosed ? { error: 'stdin closed before turn 2' } : {}),
                  num_turns: 2,
                },
              });
            }, 2_400);
          }
        });
      `;
        let dispatchFn;
        let turn2Completed = false;
        const messages = [];
        for await (const msg of service.invoke('Turn 1', {
          workingDirectory: workspace,
          invocationId: 'inv-win-multi',
          signal: AbortSignal.timeout(20_000),
          activeRunDispatch: {
            invocationId: 'inv-win-multi',
            register(reg) {
              dispatchFn = reg.dispatch;
              return () => {};
            },
          },
          spawnCliOverride: (launch) => spawnNodeScript(launch, script, model, 20_000),
        })) {
          messages.push(msg);
          if (msg.type === 'session_init' && dispatchFn) {
            const accepted = await dispatchFn(
              {
                deliveryId: 'turn-2-delivery',
                text: 'Turn 2',
                messageIds: ['m-2'],
                onInputCompleted: async (ok) => {
                  turn2Completed = ok;
                },
              },
              { expectedInvocationId: 'inv-win-multi' },
            );
            assert.equal(accepted.accepted, true);
          }
        }
        const done = messages.at(-1);
        assert.equal(done?.type, 'done');
        assert.equal(done?.errorCode, undefined, JSON.stringify(messages.filter((m) => m.type === 'error')));
        assert.equal(turn2Completed, true);
        assert.ok(messages.some((m) => m.type === 'text' && m.content.includes('TURN1_OK')));
        assert.ok(messages.some((m) => m.type === 'text' && m.content.includes('TURN2_OK')));
        assert.deepEqual(done?.metadata?.diagnostics?.agyNative?.windowsPostEofShutdown, {
          triggered: true,
          graceMs: 2000,
        });
      });

      it('keeps parallel session B undisturbed when session A triggers its Windows post-EOF timer', async (t) => {
        const a = createWindowsFixtureService(t, 'parallel-a');
        const b = createWindowsFixtureService(t, 'parallel-b');
        const makeScript = (sessionId, delayMs, reply) => `
        const readline = require('node:readline');
        const [agent, cwd, model] = process.argv.slice(1);
        const send = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
        setInterval(() => {}, 1000);
        const input = readline.createInterface({ input: process.stdin });
        input.once('line', () => {
          send({ event: 'init', conversation_id: ${JSON.stringify(sessionId)}, init: { agent, cwd, model, permission_mode: 'request-review', tools: [] } });
          setTimeout(() => {
            send({ event: 'result', result: { conversation_id: ${JSON.stringify(sessionId)}, status: 'SUCCESS', response: ${JSON.stringify(reply)} } });
          }, ${delayMs});
        });
      `;
        const collect = async (fixture, sessionId, delayMs, reply) => {
          const msgs = [];
          for await (const msg of fixture.service.invoke('Run parallel', {
            workingDirectory: fixture.workspace,
            signal: AbortSignal.timeout(15_000),
            spawnCliOverride: (launch) => spawnNodeScript(launch, makeScript(sessionId, delayMs, reply), fixture.model),
          })) {
            msgs.push(msg);
          }
          return msgs;
        };
        const [msgsA, msgsB] = await Promise.all([
          collect(a, 'win-par-a', 50, 'SESSION_A_OK'),
          collect(b, 'win-par-b', 3_200, 'SESSION_B_OK'),
        ]);
        assert.equal(msgsA.at(-1)?.errorCode, undefined);
        assert.equal(msgsA.find((m) => m.type === 'text')?.content, 'SESSION_A_OK');
        assert.deepEqual(msgsA.at(-1)?.metadata?.diagnostics?.agyNative?.windowsPostEofShutdown, {
          triggered: true,
          graceMs: 2000,
        });
        assert.equal(msgsB.at(-1)?.errorCode, undefined);
        assert.equal(msgsB.find((m) => m.type === 'text')?.content, 'SESSION_B_OK');
        assert.deepEqual(msgsB.at(-1)?.metadata?.diagnostics?.agyNative?.windowsPostEofShutdown, {
          triggered: true,
          graceMs: 2000,
        });
      });

      it('never turns a missing result into success on Windows', async (t) => {
        const { workspace, model, service } = createWindowsFixtureService(t, 'no-result');
        const script = `
        const readline = require('node:readline');
        const [agent, cwd, model] = process.argv.slice(1);
        const send = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
        const input = readline.createInterface({ input: process.stdin });
        input.once('line', () => {
          send({ event: 'init', conversation_id: 'win-no-result', init: { agent, cwd, model, permission_mode: 'request-review', tools: [] } });
          setTimeout(() => process.exit(0), 50);
        });
      `;
        const messages = [];
        for await (const msg of service.invoke('Exit without result', {
          workingDirectory: workspace,
          signal: AbortSignal.timeout(10_000),
          spawnCliOverride: (launch) => spawnNodeScript(launch, script, model),
        })) {
          messages.push(msg);
        }
        const done = messages.at(-1);
        assert.equal(done?.type, 'done');
        assert.equal(done?.errorCode, 'AGY_NATIVE_FAILED');
        assert.equal(done?.metadata?.diagnostics?.agyNative?.windowsPostEofShutdown, undefined);
      });
    },
  );
});
