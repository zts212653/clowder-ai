import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareDshMemberLaunch } from '../dist/domains/cats/services/agents/providers/acp/dsh/dsh-member-launch.js';
import { prepareKimiMemberLaunch } from '../dist/domains/cats/services/agents/providers/acp/kimi/kimi-member-launch.js';
import { materializeAgyLaunchMcp } from '../dist/domains/cats/services/agents/providers/agy-native/launch/agy-native-launch-mcp.js';
import { prepareKimiMemberProfile } from '../dist/domains/cats/services/agents/providers/kimi-scoped-native.js';

// These tests exercise the Native config consumers. No CLI, account, provider,
// HTTP server or model is started; the real game transport has a separate probe.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'member-mcp-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const member = Object.freeze({
    server: Object.freeze({
      name: 'plugin__fixture__player',
      transport: 'stdio',
      command: process.execPath,
      args: Object.freeze(['not-executed.mjs']),
      workingDirectory: root,
      env: Object.freeze({
        CLOWDER_PLUGIN_ACTION_TOKEN: 'activation',
        CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action',
        GAME_SETTING: 'preserved',
        CAT_CAFE_API_URL: '',
        CAT_CAFE_INVOCATION_ID: 'stale-invocation',
        CAT_CAFE_CALLBACK_TOKEN: 'stale-token',
        CAT_CAFE_CREDENTIAL_FILE: '/stale-credential',
        CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE: '/stale-native-credential',
        CAT_CAFE_NATIVE_CONNECTION_ID: 'stale-native-connection',
      }),
    }),
    sandbox: Object.freeze({ kind: 'scoped-member', workspaceRoot: root }),
    assertCurrent() {},
  });
  return { root, member };
}

const materializers = {
  async 'Kimi ACP'(t, { member }, callbackEnv) {
    const launch = await prepareKimiMemberLaunch({
      native: { command: 'not-executed-kimi', args: ['acp'] },
      account: { env: {}, foreignServers: [] },
      identity: '# Own identity',
      member,
      callbackEnv,
    });
    t.after(launch.dispose);
    return join(launch.cwd, '.kimi-code/mcp.json');
  },
  async 'DSH ACP'(t, { root, member }, callbackEnv) {
    // Resolution metadata only; the package and provider program are never run.
    const module = join(root, 'node_modules/@deepseek-ai/dsh-mcp-client');
    await mkdir(module, { recursive: true });
    await writeFile(join(module, 'package.json'), JSON.stringify({ main: 'index.js' }));
    await writeFile(join(module, 'index.js'), 'throw new Error("not executed");');
    const launch = await prepareDshMemberLaunch({
      native: {
        command: 'not-executed-dsh',
        args: ['--profile', 'acp'],
        env: {},
        packagePath: join(root, 'package.json'),
      },
      account: {
        credentialPath: '/original-credential',
        providerConfig: {},
        credentialRef: 'original',
        keyDigest: 'digest',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
      },
      identity: '# Own identity',
      member,
      callbackEnv,
    });
    t.after(launch.dispose);
    return launch.args.at(-1);
  },
  async AGY(_t, { root, member }, callbackEnv) {
    await mkdir(join(root, '.gemini/config'), { recursive: true });
    await materializeAgyLaunchMcp(root, { options: { pluginNativeLaunch: member } }, callbackEnv);
    return join(root, '.gemini/config/mcp_config.json');
  },
  async 'Kimi CLI'(t, { root, member }, callbackEnv) {
    const profile = await prepareKimiMemberProfile({
      options: { pluginNativeLaunch: member, callbackEnv },
      catId: 'kimi31-pro',
      l0: '# Own identity',
      parentDirectory: root,
    });
    t.after(profile.dispose);
    return join(profile.env.KIMI_CODE_HOME, 'mcp.json');
  },
};

function readServer(config) {
  return Array.isArray(config)
    ? config.find((entry) => entry.insert)?.insert[0].config.server
    : Object.values(config.mcpServers)[0];
}

for (const [name, materialize] of Object.entries(materializers)) {
  test(`${name}: issued plugin MCP gets current transport binding without account or owner authority`, async (t) => {
    const f = await fixture(t);
    const callbackEnv = Object.freeze({
      CAT_CAFE_API_URL: 'http://127.0.0.1:43123',
      CAT_CAFE_INVOCATION_ID: 'current-invocation',
      CAT_CAFE_CALLBACK_TOKEN: 'current-token',
      CAT_CAFE_USER_ID: 'owner-must-not-transfer',
      CAT_CAFE_ANTHROPIC_API_KEY: 'EXAMPLE',
      OBSERVER_TOKEN: 'observer-must-not-transfer',
    });
    const path = await materialize(t, f, callbackEnv);
    const server = readServer(JSON.parse(await readFile(path, 'utf8')));
    assert.deepEqual(server.env, {
      CLOWDER_PLUGIN_ACTION_TOKEN: 'activation',
      CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action',
      GAME_SETTING: 'preserved',
      CAT_CAFE_API_URL: callbackEnv.CAT_CAFE_API_URL,
      CAT_CAFE_INVOCATION_ID: callbackEnv.CAT_CAFE_INVOCATION_ID,
      CAT_CAFE_CALLBACK_TOKEN: callbackEnv.CAT_CAFE_CALLBACK_TOKEN,
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(f.member.server.env.CAT_CAFE_CALLBACK_TOKEN, 'stale-token', 'issued descriptor stays frozen');
  });

  test(`${name}: a fresh credential-file binding removes stale inline and native credentials`, async (t) => {
    const f = await fixture(t);
    const path = await materialize(t, f, {
      CAT_CAFE_API_URL: 'http://127.0.0.1:43124',
      CAT_CAFE_CREDENTIAL_FILE: '/current-owned-turn/credential.json',
    });
    assert.deepEqual(readServer(JSON.parse(await readFile(path, 'utf8'))).env, {
      CLOWDER_PLUGIN_ACTION_TOKEN: 'activation',
      CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action',
      GAME_SETTING: 'preserved',
      CAT_CAFE_API_URL: 'http://127.0.0.1:43124',
      CAT_CAFE_CREDENTIAL_FILE: '/current-owned-turn/credential.json',
    });
  });
}
