import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AGY_OAUTH_FILE, agyOAuthFile, inspectAgyLogin, prepareAgyAccount } from '../dist/config/agy-account.js';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { materializeAgyNativeEffectGuard } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-effect-guard.js';
import { prepareAgyNativeLaunch } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-launch.js';
import { prepareAgyAccountDataView } from '../dist/domains/cats/services/agents/providers/agy-native/run/agy-account-data-view.js';
import { spawnCli } from '../dist/utils/cli-spawn.js';

describe('Gemini 4 Neon + xhigh & Windows AGY Native compatibility', () => {
  it('rewrites Neon model tier suffix for thread override and explicit member effort, while preserving gemini-4-neon-xhigh default', async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'neon-xhigh-launch-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, 'workspace');
    const homeRoot = join(root, 'profiles');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });

    // 1. Thread override xhigh rewrites gemini-4-neon-high -> gemini-4-neon-xhigh + --effort xhigh
    const overridePlan = await prepareAgyNativeLaunch({
      catId: 'gemini-neon',
      model: 'gemini-4-neon-high',
      workspace,
      profileConfig: {
        enabled: true,
        carrier: 'native',
        autoApprove: true,
        model: 'gemini-4-neon-high',
        profileId: 'gemini-neon',
        homeRoot,
        trustedWorkspaces: [workspace],
      },
      prompt: 'hi',
      body: '# L0',
      command: process.execPath,
      options: {
        invocationId: 'inv-neon-override',
        reasoningEffortOverride: 'xhigh',
        spawnCliOverride: async function* () {},
      },
    });
    try {
      assert.equal(overridePlan.effectiveModel, 'gemini-4-neon-xhigh');
      const modelIdx = overridePlan.cliOptions.args.indexOf('--model');
      const effortIdx = overridePlan.cliOptions.args.indexOf('--effort');
      assert.equal(overridePlan.cliOptions.args[modelIdx + 1], 'gemini-4-neon-xhigh');
      assert.equal(overridePlan.cliOptions.args[effortIdx + 1], 'xhigh');
      assert.equal(overridePlan.binding.model, 'gemini-4-neon-xhigh');
    } finally {
      await overridePlan.disposeCredentials?.();
    }

    // 2. Explicit member effort xhigh rewrites gemini-4-neon-high -> gemini-4-neon-xhigh
    const memberPlan = await prepareAgyNativeLaunch({
      catId: 'gemini-neon',
      model: 'gemini-4-neon-high',
      workspace,
      profileConfig: {
        enabled: true,
        carrier: 'native',
        autoApprove: true,
        model: 'gemini-4-neon-high',
        profileId: 'gemini-neon',
        homeRoot,
        trustedWorkspaces: [workspace],
      },
      prompt: 'hi',
      body: '# L0',
      command: process.execPath,
      options: {
        invocationId: 'inv-neon-member',
        executionPreferences: {
          configurationSource: 'managed_account',
          model: 'gemini-4-neon-high',
          effort: 'xhigh',
          effortSource: 'member',
          nativeAuthentication: false,
        },
        spawnCliOverride: async function* () {},
      },
    });
    try {
      assert.equal(memberPlan.effectiveModel, 'gemini-4-neon-xhigh');
      const modelIdx = memberPlan.cliOptions.args.indexOf('--model');
      const effortIdx = memberPlan.cliOptions.args.indexOf('--effort');
      assert.equal(memberPlan.cliOptions.args[modelIdx + 1], 'gemini-4-neon-xhigh');
      assert.equal(memberPlan.cliOptions.args[effortIdx + 1], 'xhigh');
    } finally {
      await memberPlan.disposeCredentials?.();
    }

    // 3. Platform default must NOT downgrade gemini-4-neon-xhigh
    const defaultPlan = await prepareAgyNativeLaunch({
      catId: 'gemini-neon',
      model: 'gemini-4-neon-xhigh',
      workspace,
      profileConfig: {
        enabled: true,
        carrier: 'native',
        autoApprove: true,
        model: 'gemini-4-neon-xhigh',
        profileId: 'gemini-neon',
        homeRoot,
        trustedWorkspaces: [workspace],
      },
      prompt: 'hi',
      body: '# L0',
      command: process.execPath,
      options: {
        invocationId: 'inv-neon-default',
        executionPreferences: {
          configurationSource: 'managed_account',
          model: 'gemini-4-neon-xhigh',
          effort: 'xhigh',
          effortSource: 'platform_default',
          nativeAuthentication: false,
        },
        spawnCliOverride: async function* () {},
      },
    });
    try {
      assert.equal(defaultPlan.effectiveModel, 'gemini-4-neon-xhigh');
      const modelIdx = defaultPlan.cliOptions.args.indexOf('--model');
      assert.equal(defaultPlan.cliOptions.args[modelIdx + 1], 'gemini-4-neon-xhigh');
    } finally {
      await defaultPlan.disposeCredentials?.();
    }

    // 4. Downgrade override low rewrites gemini-4-neon-xhigh -> gemini-4-neon-low
    const lowPlan = await prepareAgyNativeLaunch({
      catId: 'gemini-neon',
      model: 'gemini-4-neon-xhigh',
      workspace,
      profileConfig: {
        enabled: true,
        carrier: 'native',
        autoApprove: true,
        model: 'gemini-4-neon-xhigh',
        profileId: 'gemini-neon',
        homeRoot,
        trustedWorkspaces: [workspace],
      },
      prompt: 'hi',
      body: '# L0',
      command: process.execPath,
      options: {
        invocationId: 'inv-neon-low',
        reasoningEffortOverride: 'low',
        spawnCliOverride: async function* () {},
      },
    });
    try {
      assert.equal(lowPlan.effectiveModel, 'gemini-4-neon-low');
      const modelIdx = lowPlan.cliOptions.args.indexOf('--model');
      const effortIdx = lowPlan.cliOptions.args.indexOf('--effort');
      assert.equal(lowPlan.cliOptions.args[modelIdx + 1], 'gemini-4-neon-low');
      assert.equal(lowPlan.cliOptions.args[effortIdx + 1], 'low');
    } finally {
      await lowPlan.disposeCredentials?.();
    }
  });

  it('materializes effect guard hooks with cmd-compatible double quotes on win32', (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'neon-hook-win-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
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
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8'));
    const command = parsed['cat-cafe-native-effect'].PreToolUse[0].hooks[0].command;
    if (process.platform === 'win32') {
      assert.ok(command.startsWith('"'), `Expected Windows double-quoted hook command, got: ${command}`);
      assert.ok(!command.startsWith("'"), `Windows cmd.exe hook must not use single quotes: ${command}`);
    } else {
      assert.ok(command.startsWith("'"), `Expected POSIX single-quoted hook command, got: ${command}`);
    }
  });

  it('prepares AGY account credential home, inspects login, and projects data view on current platform', (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'neon-acct-win-')));
    const prevGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    t.after(() => {
      if (prevGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevGlobalRoot;
      rmSync(root, { recursive: true, force: true });
    });
    const profileHome = join(root, 'profile');
    mkdirSync(profileHome, { recursive: true });

    const prepared = prepareAgyAccount(root, `agy-${randomUUID()}`);
    assert.equal(inspectAgyLogin(prepared.credentialHome), 'not_logged_in');

    const oauthPath = agyOAuthFile(prepared.credentialHome);
    writeFileSync(
      oauthPath,
      JSON.stringify({
        auth_method: 'consumer',
        token: {
          access_token: 'tok-access',
          refresh_token: 'tok-refresh',
          expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
      { mode: 0o600 },
    );
    assert.equal(inspectAgyLogin(prepared.credentialHome), 'ready');

    const dataView = prepareAgyAccountDataView(profileHome, prepared.credentialHome);
    assert.ok(existsSync(join(dataView, AGY_OAUTH_FILE)));
    assert.ok(existsSync(join(dataView, 'brain')));
  });

  it(
    'terminates lingering Windows stream-json child cleanly after terminal result instead of hanging until timeout',
    { skip: process.platform !== 'win32' },
    async (t) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'neon-win-eof-')));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const workspace = join(root, 'workspace');
      mkdirSync(workspace, { recursive: true });
      const model = 'gemini-4-neon-xhigh';
      const service = new AgyNativeAgentService({
        catId: 'gemini-neon',
        command: process.execPath,
        l0CompilerFn: async () => '# Identity\nNeon Windows EOF fixture.',
        profile: {
          enabled: true,
          carrier: 'native',
          model,
          profileId: 'gemini-neon',
          homeRoot: join(root, 'profiles'),
          trustedWorkspaces: [workspace],
        },
      });
      // Emulates Windows agy.exe: emits init + result, then ignores stdin EOF indefinitely.
      const script = `
        const readline = require('node:readline');
        const [agent, cwd, model] = process.argv.slice(1);
        const send = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
        const keepAlive = setInterval(() => {}, 1000);
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
        spawnCliOverride: (launch) =>
          spawnCli({
            ...launch,
            command: process.execPath,
            args: ['-e', script, launch.args[launch.args.indexOf('--agent') + 1], launch.cwd, model],
            timeoutMs: 15_000,
          }),
      })) {
        messages.push(msg);
      }
      const elapsedMs = Date.now() - startedAt;
      assert.equal(messages.at(-1)?.type, 'done');
      assert.equal(messages.at(-1)?.errorCode, undefined, JSON.stringify(messages.filter((m) => m.type === 'error')));
      assert.equal(messages.find((m) => m.type === 'text')?.content, 'WIN_EOF_OK');
      assert.ok(elapsedMs < 8_000, `Expected bounded Windows post-EOF teardown (<8s), took ${elapsedMs}ms`);
    },
  );
});
