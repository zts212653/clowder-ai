import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { accountToRuntimeProfile } from '../src/config/account-resolver.js';
import { applyClaudeTokenAccountEnv, claudeExecutionAccountSnapshot } from '../src/config/claude-token-account.js';
import { ClaudeAgentService } from '../src/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { ClaudeBgCarrierService } from '../src/domains/cats/services/agents/providers/ClaudeBgCarrierService.js';
import { prepareClaudeSdkLaunch } from '../src/domains/cats/services/agents/providers/claude-sdk-launch.js';
import { startTmuxSession } from '../src/domains/cats/services/agents/providers/pty/pty-session-launch.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const tokenA = 'sk-ant-oat01-fixture-account-A';
const tokenB = 'sk-ant-oat01-fixture-account-B';
const callbackEnv = { CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription' };
const options = {
  callbackEnv,
  accountEnv: { CLAUDE_CODE_OAUTH_TOKEN: tokenA },
  claudeTokenAccount: true,
  sessionId: '11111111-1111-4111-8111-111111111111',
};
test('SDK launch preserves host/session and freezes the selected token over alternate auth', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  const host = process.env.HOME;
  for (const k of [
    'ANTHROPIC_UNIX_SOCKET',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_USE_BEDROCK',
  ])
    process.env[k] = 'ambient-account';
  const prepare = () =>
    prepareClaudeSdkLaunch({
      catId: createCatId('opus'),
      model: 'claude-opus-4-6',
      prompt: 'fixture',
      l0CompilerFn: fakeL0Compiler,
      abortController: new AbortController(),
      options,
    });
  const a = await prepare();
  options.accountEnv.CLAUDE_CODE_OAUTH_TOKEN = tokenB;
  const b = await prepare();
  assert.equal(a.sdkOptions.env?.CLAUDE_CODE_OAUTH_TOKEN, tokenA);
  assert.equal(b.sdkOptions.env?.CLAUDE_CODE_OAUTH_TOKEN, tokenB);
  assert.equal(a.sdkOptions.env?.HOME, host);
  assert.equal(a.sdkOptions.resume, b.sdkOptions.resume);
  for (const k of [
    'ANTHROPIC_UNIX_SOCKET',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_USE_BEDROCK',
  ])
    assert.equal(a.sdkOptions.env?.[k], undefined);
  const env: Record<string, string | null> = {
    CLAUDE_CODE_OAUTH_TOKEN: tokenA,
    ANTHROPIC_BASE_URL: 'http://foreign',
    CLAUDE_CONFIG_DIR: '/shared',
  };
  applyClaudeTokenAccountEnv(env, true);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/shared');
  assert.equal(env.ANTHROPIC_BASE_URL, null);
  const profile = accountToRuntimeProfile(
    'a',
    { authType: 'oauth', clientId: 'anthropic', claude: { kind: 'long_lived_token' } },
    { accessToken: tokenA },
  );
  const snapshot = claudeExecutionAccountSnapshot(profile);
  assert.equal(snapshot.accountRef, 'a');
  assert.ok(!JSON.stringify(snapshot).includes(tokenA));
  assert.throws(
    () =>
      accountToRuntimeProfile('missing', {
        authType: 'oauth',
        clientId: 'anthropic',
        claude: { kind: 'long_lived_token' },
      }),
    /missing_or_expired/,
  );
});
test('print carrier launches A then B with the same resume and preserves callback routing', async () => {
  const launches: Array<{ env: Record<string, string | null>; args: string[] }> = [];
  const service = new ClaudeAgentService({ model: 'claude-opus-4-6', l0CompilerFn: fakeL0Compiler });
  for (const token of [tokenA, tokenB]) {
    for await (const _ of service.invoke('fixture', {
      ...options,
      accountEnv: { CLAUDE_CODE_OAUTH_TOKEN: token },
      spawnCliOverride: async function* (launch) {
        launches.push({ env: { ...launch.env }, args: [...launch.args] });
        yield { type: 'result', subtype: 'success', session_id: options.sessionId, result: 'ok' };
      },
    })) {
      /* consume producer */
    }
  }
  assert.equal(launches[0].env.CLAUDE_CODE_OAUTH_TOKEN, tokenA);
  assert.equal(launches[1].env.CLAUDE_CODE_OAUTH_TOKEN, tokenB);
  for (const launch of launches) {
    assert.equal(launch.args[launch.args.indexOf('--resume') + 1], options.sessionId);
    assert.ok(!JSON.stringify(launch.args).includes(tokenA));
  }
});
test('bg daemon rejects token accounts before compiling or spawning', async () => {
  let spawns = 0;
  let compiles = 0;
  const service = new ClaudeBgCarrierService({
    model: 'claude-opus-4-6',
    l0CompilerFn: async () => {
      compiles++;
      return '';
    },
    spawnFn: (() => {
      spawns++;
      throw new Error('unexpected dispatch');
    }) as typeof import('node:child_process').spawn,
    enableJobOwnership: false,
  });
  for (const readOnly of [false, true]) {
    await assert.rejects(
      service.startJob('fixture', {
        ...options,
        ...(readOnly ? { toolExecutionPolicy: { mode: 'read_only' as const } } : {}),
      }),
      /claude_token_carrier_unsupported/,
    );
  }
  assert.equal(compiles, 0);
  assert.equal(spawns, 0);
});
test(
  'native tmux delivers fake secrets through stdin and reports only sanitized failures',
  { skip: process.platform === 'win32' || spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'f320-tmux-'));
    const prefix = ['-f', '/dev/null', '-S', join(root, 'socket')];
    try {
      await startTmuxSession(
        ['new-session', '-d', '-s', 'fixture', '-e', `CLAUDE_CODE_OAUTH_TOKEN=${tokenA}`, 'sleep 10'],
        prefix,
      );
      const result = execFileSync('tmux', [...prefix, 'show-environment', '-t', 'fixture', 'CLAUDE_CODE_OAUTH_TOKEN'], {
        encoding: 'utf8',
      });
      assert.equal(result.trim(), `CLAUDE_CODE_OAUTH_TOKEN=${tokenA}`);
      await assert.rejects(
        startTmuxSession(
          ['new-session', '--invalid-option', '-s', 'invalid', '-e', `CLAUDE_CODE_OAUTH_TOKEN=${tokenA}`, 'sleep 10'],
          prefix,
        ),
        { message: 'pty_session_launch_failed' },
      );
    } finally {
      try {
        execFileSync('tmux', [...prefix, 'kill-server'], { stdio: 'ignore' });
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('provider diagnostics and raw event archives never persist the selected token', async () => {
  const archives: unknown[] = [];
  const events: unknown[] = [];
  const service = new ClaudeAgentService({
    model: 'claude-opus-4-6',
    l0CompilerFn: fakeL0Compiler,
    rawArchive: {
      append: async (_id, event) => {
        archives.push(event);
      },
    },
  });
  for await (const event of service.invoke('fixture', {
    ...options,
    invocationId: 'private-fixture',
    accountEnv: { CLAUDE_CODE_OAUTH_TOKEN: tokenA },
    spawnCliOverride: async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        errors: [`Authentication rejected ${tokenA}`],
        is_error: true,
      };
    },
  }))
    events.push(event);
  assert.ok(!JSON.stringify(archives).includes(tokenA), 'private token must be removed before archiving raw errors');
  assert.ok(!JSON.stringify(events).includes(tokenA), 'private token must be removed before public errors');
});

test('token settings retain normal settings, override helper/key auth, and reject competing token sources', async () => {
  const { composeClaudeTokenSettingsDocument } = await import('../src/config/claude-token-settings.js');
  const root = mkdtempSync(join(tmpdir(), 'f320-settings-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'other' }, apiKeyHelper: 'echo other' }),
    );
    const before = JSON.parse(
      await import('node:fs').then((fs) => fs.readFileSync(join(root, 'settings.json'), 'utf8')),
    );
    const overlay = JSON.parse(
      await composeClaudeTokenSettingsDocument(
        JSON.stringify({
          model: 'kept',
          hooks: { Stop: [] },
          env: { MY_SETTING: 'kept', ANTHROPIC_API_KEY: 'operator-other' },
        }),
        root,
      ),
    );
    assert.equal(overlay.env.ANTHROPIC_API_KEY, '');
    assert.equal(overlay.apiKeyHelper, '');
    assert.equal(overlay.env.MY_SETTING, 'kept');
    assert.equal(overlay.model, 'kept');
    assert.deepEqual(overlay.hooks, { Stop: [] });
    assert.deepEqual(
      JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(root, 'settings.json'), 'utf8'))),
      before,
    );
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: tokenB } }));
    await assert.rejects(composeClaudeTokenSettingsDocument(undefined, root), /claude_token_settings_conflict/);
    await assert.doesNotReject(composeClaudeTokenSettingsDocument(undefined, root, []));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
