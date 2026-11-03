import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  agyNativeMemberSettingsSchema,
  resolveAgyNativeMemberPatch,
} from '../../dist/config/agy-native-member-settings.js';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';

test('official AGY ACP settings persist the isolated profile and require matching carrier', () => {
  const profile = {
    carrier: 'acp',
    enabled: true,
    profileId: 'argon',
    model: 'gemini-4-argon-high',
    autoApprove: true,
    trustedWorkspaces: [],
  };
  assert.equal(agyNativeMemberSettingsSchema.safeParse(profile).success, true);
  const root = mkdtempSync(join(tmpdir(), 'agy-acp-settings-'));
  try {
    const input = {
      projectRoot: root,
      requested: profile,
      clientId: 'google',
      acp: { command: 'agy_acp_server.par' },
      carrier: 'acp',
      model: profile.model,
    };
    assert.deepEqual(resolveAgyNativeMemberPatch(input), profile);
    assert.throws(() => resolveAgyNativeMemberPatch({ ...input, acp: undefined, carrier: 'cli' }), /ACP|carrier/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry reuses the ACP pool with personal OAuth isolation and native identity policy', async (t) => {
  const previousMode = process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
  // Account/pool behavior does not attest inherited runner Temp ancestor ACLs.
  if (process.platform === 'win32') process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
  t.after(() => {
    if (previousMode === undefined) delete process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
    else process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = previousMode;
  });
  const root = mkdtempSync(join(tmpdir(), 'agy-acp-factory-'));
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const poolRegistry = new Map();
  try {
    const input = {
      projectRoot: workspace,
      bootstrapRoot: join(root, 'bootstrap'),
      profileId: 'argon',
      effectiveModel: 'gemini-4-argon-high',
      config: {
        id: 'gemini-argon',
        clientId: 'google',
        carrier: 'acp',
        defaultModel: 'gemini-4-argon-high',
        mcpSupport: false,
        agyProfile: {
          carrier: 'acp',
          enabled: true,
          profileId: 'argon',
          homeRoot: join(root, 'profiles'),
          model: 'gemini-4-argon-high',
          autoApprove: true,
          trustedWorkspaces: [],
        },
      },
      acpConfig: { command: 'agy_acp_server.par', startupArgs: [] },
      poolRegistry,
      log: { info() {}, warn() {} },
    };
    const service = await createAcpServiceForConfig(input);
    assert.ok(service);
    assert.equal(service.injectsL0Natively(), true);
    const client = poolRegistry.get('argon').clientFactory();
    assert.equal(client.config.inheritParentEnv, false);
    assert.equal(client.config.env.HOME, realpathSync(join(root, 'profiles', 'argon', 'acp')));
    assert.equal(client.config.env.AGY_ACP_DEFAULT_MODEL, 'gemini-4-argon-high');
    assert.equal(client.config.env.GEMINI_API_KEY, undefined);
    let response;
    await client.config.permissionHandler(
      { params: { sessionId: 'unknown', options: [{ kind: 'allow_once', optionId: 'yes' }] } },
      (value) => {
        response = value;
      },
    );
    assert.deepEqual(response, { cancelled: true });
    writeFileSync(
      join(client.config.env.HOME, '.gemini/antigravity-acp/settings.json'),
      JSON.stringify({ auth: { type: 'gemini-api-key' }, apiKey: 'must-not-leak' }),
    );
    let unavailable;
    assert.equal(
      await createAcpServiceForConfig({
        ...input,
        onUnavailable: (value) => {
          unavailable = value;
        },
      }),
      null,
    );
    assert.equal(poolRegistry.size, 0);
    assert.equal(unavailable.code, 'invalid-spawn-env');
    assert.ok(!JSON.stringify(unavailable).includes('must-not-leak'));
  } finally {
    await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll()));
    rmSync(root, { recursive: true, force: true });
  }
});
