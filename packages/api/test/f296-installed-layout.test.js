/**
 * F296 #1542 final acceptance: installed-layout evidence.
 *
 * Runs ONLY when CAT_CAFE_INSTALLED_LAYOUT_ROOT points at a staged install
 * tree (pnpm deploy artifact + the installer's .claude/hooks carrier asset —
 * the same layout contract as desktop/installer/cat-cafe.iss). The Windows
 * CI job stages that tree and runs this suite against it, so the assertions
 * exercise the PACKAGED artifact rather than the source checkout:
 *
 * 1. the launch plan resolves ready from the installed module, with the
 *    carrier coordinate inside the installed root;
 * 2. an Apps/apps case-variant spelling and a root-level directory link
 *    (junction on Windows) of the installed root both canonicalize by real
 *    identity;
 * 3. the managed launch is ready from an EXTERNAL project CWD;
 * 4. a Node/legacy seal overlap against the INSTALLED route code produces
 *    exactly one logical compression observation.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const INSTALL_ROOT = process.env.CAT_CAFE_INSTALLED_LAYOUT_ROOT?.trim();
const CARRIER_RELATIVE = join('.claude', 'hooks', 'f24-compaction.mjs');

if (!INSTALL_ROOT) {
  describe(
    'F296 #1542 installed-layout acceptance',
    { skip: 'CAT_CAFE_INSTALLED_LAYOUT_ROOT not set (staged-install CI job only)' },
    () => {
      test('placeholder', () => {});
    },
  );
} else {
  const installRoot = realpathSync(INSTALL_ROOT);
  const apiDist = join(installRoot, 'packages', 'api', 'dist');
  const moduleUrl = (rel) =>
    pathToFileURL(join(apiDist, 'domains', 'cats', 'services', 'agents', 'providers', rel)).href;

  const { buildClaudeCompactionLaunchPlan } = await import(moduleUrl('claude-compaction-launch-plan.js'));
  const { sessionHooksRoutes } = await import(pathToFileURL(join(apiDist, 'routes', 'session-hooks.js')).href);
  const { SessionChainStore } = await import(
    pathToFileURL(join(apiDist, 'domains', 'cats', 'services', 'stores', 'ports', 'SessionChainStore.js')).href
  );
  const { SessionSealer } = await import(
    pathToFileURL(join(apiDist, 'domains', 'cats', 'services', 'session', 'SessionSealer.js')).href
  );
  const { default: Fastify } = await import('fastify');

  describe('F296 #1542 installed-layout acceptance (packaged artifact)', () => {
    test('the launch plan resolves ready from the installed module with the carrier inside the install root', () => {
      const plan = buildClaudeCompactionLaunchPlan();
      assert.equal(plan.ready, true, 'installed artifact must yield a ready plan');
      assert.equal(
        plan.carrierScriptPath,
        join(installRoot, CARRIER_RELATIVE),
        'carrier coordinate is the packaged asset under the installed root',
      );
      assert.ok(plan.preCompactCommand.includes(`${plan.carrierScriptPath}" pre`));
    });

    test(
      'an Apps/apps case-variant spelling of the installed root canonicalizes',
      { skip: process.platform !== 'win32' },
      () => {
        const varied = installRoot
          .split(/[\\/]/)
          .map((segment, index) => (index % 2 === 1 ? segment.toUpperCase() : segment))
          .join('\\');
        const plan = buildClaudeCompactionLaunchPlan({ installRoot: varied });
        assert.equal(plan.ready, true);
        assert.equal(plan.carrierScriptPath, join(installRoot, CARRIER_RELATIVE));
      },
    );

    test('a root-level directory link (junction on Windows) resolves by real identity', () => {
      const aliasHome = mkdtempSync(join(tmpdir(), 'f296-install-alias-'));
      const alias = join(aliasHome, 'alias-to-install');
      symlinkSync(installRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        const plan = buildClaudeCompactionLaunchPlan({ installRoot: alias });
        assert.equal(plan.ready, true);
        assert.equal(plan.carrierScriptPath, join(installRoot, CARRIER_RELATIVE));
      } finally {
        rmSync(aliasHome, { recursive: true, force: true });
      }
    });

    test('the managed launch is ready from an EXTERNAL project CWD', async () => {
      const externalProject = mkdtempSync(join(tmpdir(), 'f296-external-cwd-'));
      const previousCwd = process.cwd();
      process.chdir(externalProject);
      try {
        const plan = buildClaudeCompactionLaunchPlan();
        assert.equal(plan.ready, true, 'plan must not depend on the process CWD');
        assert.equal(plan.carrierScriptPath, join(installRoot, CARRIER_RELATIVE));
      } finally {
        process.chdir(previousCwd);
        rmSync(externalProject, { recursive: true, force: true });
      }
    });

    test('a Node/legacy seal overlap against the INSTALLED route produces one logical observation', async () => {
      const sessionChainStore = new SessionChainStore();
      const app = Fastify();
      const callbackAuth = {
        invocationId: 'inv-installed-layout',
        callbackToken: 'tok-installed-layout',
      };
      await app.register(sessionHooksRoutes, {
        sessionChainStore,
        sessionSealer: new SessionSealer(sessionChainStore),
        transcriptReader: { read: async () => null },
        callbackRegistry: {
          isStartupRecoveryComplete: () => true,
          verify: async (invocationId, callbackToken) =>
            invocationId === callbackAuth.invocationId && callbackToken === callbackAuth.callbackToken
              ? {
                  ok: true,
                  record: {
                    ...callbackAuth,
                    userId: 'user-1',
                    catId: 'opus',
                    threadId: 'thread-1',
                    ownerAuthProvenance: 'strict',
                    clientMessageIds: new Set(),
                    expectedCompactionCarrier: 'f296-node-v1',
                    createdAt: 0,
                    expiresAt: null,
                    state: 'active',
                  },
                }
              : { ok: false, reason: 'invalid_token' },
        },
      });
      await app.ready();

      const record = sessionChainStore.create({
        cliSessionId: 'cli-installed-overlap',
        threadId: 'thread-1',
        catId: 'opus',
        userId: 'user-1',
        compressionCount: 0,
      });
      sessionChainStore.applyPolicySnapshot(record.id, {
        config: {
          strategy: 'handoff',
          thresholds: { warn: 0.75, action: 0.85 },
          turnBudget: 12_000,
          safetyMargin: 4_000,
        },
        source: 'runtime_override',
        revision: 'test:handoff:none',
        changedAt: 0,
        execution: { status: 'active', missingCapabilities: [] },
      });

      const seal = (headers) =>
        app.inject({
          method: 'POST',
          url: '/api/sessions/seal',
          headers,
          payload: { cliSessionId: 'cli-installed-overlap', reason: 'claude-code-compact-auto' },
        });
      const [nodeRes, legacyRes] = await Promise.all([
        seal({
          'x-invocation-id': callbackAuth.invocationId,
          'x-callback-token': callbackAuth.callbackToken,
          'x-clowder-compaction-carrier': 'f296-node-v1',
        }),
        seal({
          'x-invocation-id': callbackAuth.invocationId,
          'x-callback-token': callbackAuth.callbackToken,
        }),
      ]);
      assert.equal(nodeRes.statusCode, 200, 'the canonical Node carrier records');
      assert.equal(legacyRes.statusCode, 403, 'the legacy handler is fenced at the identity boundary');
      assert.equal(JSON.parse(legacyRes.payload).error, 'compaction_carrier_identity_mismatch');

      const after = sessionChainStore.get(record.id);
      assert.equal(after.compressionObservation?.sequence, 1, 'exactly one logical observation');
      assert.equal(after.compressionCount, 1, 'the lifetime counter advances exactly once');
      await app.close();
    });

    test('identifies the packaged artifact under test', () => {
      // The CI job records the exact commit SHA alongside this suite; the
      // packaged dist entry point must actually exist at the staged root.
      assert.ok(existsSync(join(apiDist, 'routes', 'session-hooks.js')), 'packaged dist entry point exists');
      assert.ok(existsSync(join(installRoot, CARRIER_RELATIVE)), 'packaged carrier asset exists');
      assert.ok(existsSync(join(installRoot, 'packages', 'api', 'package.json')), 'packaged package manifest exists');
      const recordedSha = process.env.GITHUB_SHA?.trim();
      if (recordedSha) {
        assert.match(recordedSha, /^[0-9a-f]{40}$/, 'CI records the exact commit SHA');
      }
    });
  });
}
