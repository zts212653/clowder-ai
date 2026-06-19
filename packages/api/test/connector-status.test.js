import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { isValueField } from '@cat-cafe/shared';
import { configEventBus, createChangeSetId } from '../dist/config/config-event-bus.js';
import {
  clearExternalConnectorRegistry,
  registerExternalConnectorMeta,
} from '../dist/infrastructure/connectors/external-connector-registry.js';
import {
  clearConnectorConfigCache,
  loadAllConnectorConfigs,
  resolveConnectorEnv,
  writeConnectorConfig,
} from '../dist/infrastructure/connectors/im-connector-config-store.js';
import { scanConnectorManifests } from '../dist/infrastructure/connectors/plugins/im-connector-manifest.js';
import { buildConnectorStatus } from '../dist/routes/connector-hub.js';

const STORE_PROJECT_ROOT = '/tmp/cat-cafe-status-store-test';

function cleanupStore() {
  clearConnectorConfigCache();
  const storePath = `${STORE_PROJECT_ROOT}/.cat-cafe/im-connector-config`;
  for (const file of ['dingtalk.json', 'feishu.json']) {
    try {
      if (existsSync(`${storePath}/${file}`)) unlinkSync(`${storePath}/${file}`);
    } catch {
      /* ignore */
    }
  }
}

describe('buildConnectorStatus', () => {
  afterEach(() => {
    clearExternalConnectorRegistry();
    cleanupStore();
  });
  it('returns all platforms as not configured when env is empty', () => {
    const result = buildConnectorStatus({});
    assert.equal(result.length, 7);

    const xiaoyi = result.find((p) => p.id === 'xiaoyi');
    assert.ok(xiaoyi);
    assert.equal(xiaoyi.configured, false);
    assert.equal(xiaoyi.fields.length, 3);

    const feishu = result.find((p) => p.id === 'feishu');
    assert.ok(feishu);
    assert.equal(feishu.configured, false);
    assert.equal(feishu.fields.length, 4);
    for (const f of feishu.fields) {
      if (f.envName === 'FEISHU_CONNECTION_MODE') {
        assert.equal(f.currentValue, 'webhook', 'CONNECTION_MODE should default to webhook');
      } else {
        assert.equal(f.currentValue, null);
      }
    }

    const telegram = result.find((p) => p.id === 'telegram');
    assert.ok(telegram);
    assert.equal(telegram.configured, false);

    const dingtalk = result.find((p) => p.id === 'dingtalk');
    assert.ok(dingtalk);
    assert.equal(dingtalk.configured, false);

    const wecomBot = result.find((p) => p.id === 'wecom-bot');
    assert.ok(wecomBot);
    assert.equal(wecomBot.configured, false);
    assert.equal(wecomBot.fields.length, 2);

    const wecomAgent = result.find((p) => p.id === 'wecom-agent');
    assert.ok(wecomAgent);
    assert.equal(wecomAgent.configured, false);
    assert.equal(wecomAgent.fields.length, 5);

    const weixin = result.find((p) => p.id === 'weixin');
    assert.ok(weixin);
    assert.equal(weixin.configured, false);
    assert.equal(weixin.fields.length, 0);

    // F202-2B: GitHub moved to plugin framework — no longer in CONNECTOR_PLATFORMS
    const github = result.find((p) => p.id === 'github');
    assert.equal(github, undefined);
  });

  it('marks feishu as configured when all 3 fields are set', () => {
    const result = buildConnectorStatus({
      FEISHU_APP_ID: 'cli_abcdef123456',
      FEISHU_APP_SECRET: 'secretvalue123',
      FEISHU_VERIFICATION_TOKEN: 'tokenvalue789',
    });
    const feishu = result.find((p) => p.id === 'feishu');
    assert.ok(feishu);
    assert.equal(feishu.configured, true);

    const appId = feishu.fields.find((f) => f.envName === 'FEISHU_APP_ID');
    assert.ok(appId);
    assert.equal(appId.currentValue, 'cli_abcdef123456');
    assert.equal(appId.sensitive, false);

    const appSecret = feishu.fields.find((f) => f.envName === 'FEISHU_APP_SECRET');
    assert.ok(appSecret);
    assert.equal(appSecret.currentValue, '••••••••');
    assert.equal(appSecret.sensitive, true);
  });

  it('marks feishu as not configured when only partial fields are set', () => {
    const result = buildConnectorStatus({
      FEISHU_APP_ID: 'cli_abc',
    });
    const feishu = result.find((p) => p.id === 'feishu');
    assert.ok(feishu);
    assert.equal(feishu.configured, false);
  });

  it('marks telegram as configured when token is set', () => {
    const result = buildConnectorStatus({
      TELEGRAM_BOT_TOKEN: '123456:ABC-DEF-tokenfull',
    });
    const telegram = result.find((p) => p.id === 'telegram');
    assert.ok(telegram);
    assert.equal(telegram.configured, true);
    assert.equal(telegram.fields[0].currentValue, '••••••••');
  });

  it('does not mark telegram as configured for API keys stored in TELEGRAM_BOT_TOKEN', () => {
    const result = buildConnectorStatus({
      TELEGRAM_BOT_TOKEN: 'sk-community-openai-api-key',
    });
    const telegram = result.find((p) => p.id === 'telegram');
    assert.ok(telegram);
    assert.equal(telegram.configured, false);
    assert.equal(telegram.fields[0].currentValue, null);
  });

  it('treats placeholder default values as not configured', () => {
    const result = buildConnectorStatus({
      TELEGRAM_BOT_TOKEN: '(未设置 → 不启用)',
    });
    const telegram = result.find((p) => p.id === 'telegram');
    assert.ok(telegram);
    assert.equal(telegram.configured, false);
    assert.equal(telegram.fields[0].currentValue, null);
  });

  it('fully masks sensitive values without leaking suffix', () => {
    const result = buildConnectorStatus({
      DINGTALK_APP_KEY: 'mykey123',
      DINGTALK_APP_SECRET: 'mysecretvalue99',
    });
    const dingtalk = result.find((p) => p.id === 'dingtalk');
    assert.ok(dingtalk);
    assert.equal(dingtalk.configured, true);

    const key = dingtalk.fields.find((f) => f.envName === 'DINGTALK_APP_KEY');
    assert.ok(key);
    assert.equal(key.currentValue, 'mykey123');

    const secret = dingtalk.fields.find((f) => f.envName === 'DINGTALK_APP_SECRET');
    assert.ok(secret);
    assert.equal(secret.currentValue, '••••••••');
  });

  it('includes docsUrl and steps for each platform', () => {
    const result = buildConnectorStatus({});
    for (const platform of result) {
      assert.ok(platform.docsUrl.startsWith('https://'));
      assert.ok(platform.steps.length >= 3);
      for (const step of platform.steps) {
        assert.ok(typeof step.text === 'string' && step.text.length > 0, 'step must have non-empty text');
      }
    }
  });

  it('feishu steps are filtered by connection mode', () => {
    const result = buildConnectorStatus({});
    const feishu = result.find((p) => p.id === 'feishu');
    assert.ok(feishu);
    const webhookOnly = feishu.steps.filter((s) => s.mode === 'webhook');
    const wsOnly = feishu.steps.filter((s) => s.mode === 'websocket');
    const common = feishu.steps.filter((s) => !s.mode);
    assert.ok(webhookOnly.length >= 1, 'Should have webhook-only steps');
    assert.ok(wsOnly.length >= 1, 'Should have websocket-only steps');
    assert.ok(common.length >= 2, 'Should have common steps');
  });

  it('marks feishu as configured in websocket mode without verification token', () => {
    const result = buildConnectorStatus({
      FEISHU_APP_ID: 'cli_abcdef123456',
      FEISHU_APP_SECRET: 'secretvalue123',
      FEISHU_CONNECTION_MODE: 'websocket',
    });
    const feishu = result.find((p) => p.id === 'feishu');
    assert.ok(feishu);
    assert.equal(feishu.configured, true, 'Websocket mode should not require FEISHU_VERIFICATION_TOKEN');
  });

  it('normalizes invalid FEISHU_CONNECTION_MODE to webhook (requires token)', () => {
    // 'ws' is not a valid mode — runtime normalizes to 'webhook', status page must agree
    const result = buildConnectorStatus({
      FEISHU_APP_ID: 'cli_abcdef123456',
      FEISHU_APP_SECRET: 'secretvalue123',
      FEISHU_CONNECTION_MODE: 'ws',
    });
    const feishu = result.find((p) => p.id === 'feishu');
    assert.ok(feishu);
    assert.equal(feishu.configured, false, 'Invalid mode "ws" should normalize to webhook and require token');
  });

  it('marks feishu as not configured in webhook mode without verification token', () => {
    const result = buildConnectorStatus({
      FEISHU_APP_ID: 'cli_abcdef123456',
      FEISHU_APP_SECRET: 'secretvalue123',
      FEISHU_CONNECTION_MODE: 'webhook',
    });
    const feishu = result.find((p) => p.id === 'feishu');
    assert.ok(feishu);
    assert.equal(feishu.configured, false, 'Webhook mode requires FEISHU_VERIFICATION_TOKEN');
  });

  it('feishu fields include FEISHU_CONNECTION_MODE', () => {
    const result = buildConnectorStatus({});
    const feishu = result.find((p) => p.id === 'feishu');
    assert.ok(feishu);
    const modeField = feishu.fields.find((f) => f.envName === 'FEISHU_CONNECTION_MODE');
    assert.ok(modeField, 'FEISHU_CONNECTION_MODE should be in feishu fields');
    assert.equal(modeField.sensitive, false);
  });

  it('marks wecom-agent as configured when all 5 fields are set', () => {
    const result = buildConnectorStatus({
      WECOM_CORP_ID: 'ww_test_corp',
      WECOM_AGENT_ID: '1000002',
      WECOM_AGENT_SECRET: 'secret123',
      WECOM_TOKEN: 'callback_token',
      WECOM_ENCODING_AES_KEY: 'a'.repeat(43),
    });
    const wecomAgent = result.find((p) => p.id === 'wecom-agent');
    assert.ok(wecomAgent);
    assert.equal(wecomAgent.configured, true);

    const corpId = wecomAgent.fields.find((f) => f.envName === 'WECOM_CORP_ID');
    assert.ok(corpId);
    assert.equal(corpId.sensitive, false);

    const secret = wecomAgent.fields.find((f) => f.envName === 'WECOM_AGENT_SECRET');
    assert.ok(secret);
    assert.equal(secret.currentValue, '••••••••');
  });

  it('marks wecom-agent as not configured when partial fields set', () => {
    const result = buildConnectorStatus({
      WECOM_CORP_ID: 'ww_test_corp',
      WECOM_AGENT_ID: '1000002',
    });
    const wecomAgent = result.find((p) => p.id === 'wecom-agent');
    assert.ok(wecomAgent);
    assert.equal(wecomAgent.configured, false);
  });

  // F202-2B: "marks GitHub plugin as configured" test removed — GitHub config
  // moved to plugin framework (plugin-config-store), no longer in connector-hub.

  // ── F240 P1-2 regression: external connector plugins must appear in status ──

  it('F240 P1-2: includes external connector plugin in status when registered', () => {
    registerExternalConnectorMeta({
      id: 'welink',
      definition: {
        id: 'welink',
        displayName: 'WeLink',
        icon: { type: 'png', src: '/images/connectors/welink.png' },
        themeColor: '#FF6600',
        description: 'Huawei WeLink connector',
      },
      requiredEnvKeys: ['WELINK_APP_KEY', 'WELINK_APP_SECRET'],
      optionalEnvKeys: [],
      configured: true, // simulates bootstrap having called isConfigured()→true
    });

    const result = buildConnectorStatus({
      WELINK_APP_KEY: 'mykey123',
      WELINK_APP_SECRET: 'mysecret456',
    });

    // Built-in platforms still present
    assert.equal(result.filter((p) => p.id === 'feishu').length, 1);

    // External connector appears
    const welink = result.find((p) => p.id === 'welink');
    assert.ok(welink, 'External connector "welink" must appear in status');
    assert.equal(welink.name, 'WeLink');
    assert.equal(welink.configured, true);
    assert.equal(welink.fields.length, 2);

    // External fields are masked (sensitive: true by default)
    for (const field of welink.fields) {
      assert.equal(field.sensitive, true, `External field ${field.envName} must be sensitive`);
      assert.equal(field.currentValue, '••••••••', `External field ${field.envName} must be masked`);
    }
  });

  it('F240 P1-2: external connector shows not-configured when env vars missing', () => {
    registerExternalConnectorMeta({
      id: 'welink',
      definition: {
        id: 'welink',
        displayName: 'WeLink',
        icon: { type: 'png', src: '/images/connectors/welink.png' },
        themeColor: '#FF6600',
        description: 'Huawei WeLink connector',
      },
      requiredEnvKeys: ['WELINK_APP_KEY', 'WELINK_APP_SECRET'],
      optionalEnvKeys: [],
      configured: false, // simulates bootstrap having called isConfigured()→false
    });

    const result = buildConnectorStatus({});
    const welink = result.find((p) => p.id === 'welink');
    assert.ok(welink, 'External connector must appear even when not configured');
    assert.equal(welink.configured, false);
    assert.equal(welink.fields[0].currentValue, null);
  });

  it('F240 P1-2: external connector does not duplicate built-in platform', () => {
    // Register with a built-in ID — should be skipped
    registerExternalConnectorMeta({
      id: 'feishu',
      definition: {
        id: 'feishu',
        displayName: 'Fake Feishu',
        icon: { type: 'png', src: '/test.png' },
        themeColor: '#000',
        description: 'should not duplicate',
      },
      requiredEnvKeys: [],
      optionalEnvKeys: [],
      configured: false,
    });

    const result = buildConnectorStatus({});
    const feishuEntries = result.filter((p) => p.id === 'feishu');
    assert.equal(feishuEntries.length, 1, 'Must not duplicate built-in feishu');
  });

  it('F240 R10-P2: external manifest status uses plugin isConfigured metadata', () => {
    const pluginId = 'alt-auth-external';
    registerExternalConnectorMeta({
      id: pluginId,
      definition: {
        id: pluginId,
        displayName: 'Alt Auth External',
        icon: { type: 'png', src: '/test.png' },
        themeColor: '#336699',
        description: 'plugin predicate accepts alternate credentials',
      },
      requiredEnvKeys: ['ALT_AUTH_TOKEN'],
      optionalEnvKeys: [],
      configured: true,
    });

    const result = buildConnectorStatus({}, [
      {
        id: pluginId,
        name: 'Alt Auth External',
        nameEn: 'Alt Auth External',
        version: '1.0.0',
        icon: { type: 'png', src: '/test.png' },
        themeColor: '#336699',
        docsUrl: 'https://example.com',
        source: 'external',
        config: [
          {
            type: 'input',
            envName: 'ALT_AUTH_TOKEN',
            label: 'Token',
            sensitive: true,
            required: true,
          },
        ],
        steps: [{ text: 'test' }],
      },
    ]);

    const external = result.find((p) => p.id === pluginId);
    assert.ok(external, 'external manifest connector must appear in status');
    assert.equal(result.filter((p) => p.id === pluginId).length, 1, 'external manifest and meta must merge');
    assert.equal(
      external.configured,
      true,
      'external manifest status must honor plugin.isConfigured() metadata instead of YAML field heuristic',
    );
  });

  it('treats an external manifest without loaded plugin metadata as unconfigured', () => {
    const pluginId = 'unloaded-external';
    const result = buildConnectorStatus(
      {
        UNLOADED_EXTERNAL_TOKEN: 'stored-token',
      },
      [
        {
          id: pluginId,
          name: 'Unloaded External',
          nameEn: 'Unloaded External',
          version: '1.0.0',
          icon: { type: 'png', src: '/test.png' },
          themeColor: '#336699',
          docsUrl: 'https://example.com',
          source: 'external',
          config: [
            {
              type: 'input',
              envName: 'UNLOADED_EXTERNAL_TOKEN',
              label: 'Token',
              sensitive: true,
              required: true,
            },
          ],
          steps: [{ text: 'test' }],
        },
      ],
    );

    const external = result.find((p) => p.id === pluginId);
    assert.ok(external, 'external manifest connector must appear in status');
    assert.equal(
      external.configured,
      false,
      'external manifest without loaded plugin metadata must not fall back to field heuristics',
    );
  });

  it('evaluates external manifest requiredWhen values without mode-specific coercion', () => {
    const pluginId = 'oauth-required-when-external';
    const result = buildConnectorStatus(
      {
        AUTH_MODE: 'oauth',
        API_TOKEN: 'api-token',
      },
      [
        {
          id: pluginId,
          name: 'OAuth RequiredWhen External',
          nameEn: 'OAuth RequiredWhen External',
          version: '1.0.0',
          icon: { type: 'png', src: '/test.png' },
          themeColor: '#336699',
          docsUrl: 'https://example.com',
          source: 'external',
          config: [
            {
              type: 'select',
              envName: 'AUTH_MODE',
              label: 'Auth Mode',
              required: false,
              default: 'api_key',
              options: [
                { value: 'api_key', label: 'API Key' },
                { value: 'oauth', label: 'OAuth' },
              ],
            },
            {
              type: 'input',
              envName: 'API_TOKEN',
              label: 'API Token',
              sensitive: true,
              required: true,
            },
            {
              type: 'input',
              envName: 'OAUTH_CLIENT_SECRET',
              label: 'OAuth Client Secret',
              sensitive: true,
              required: false,
              requiredWhen: { envName: 'AUTH_MODE', value: 'oauth' },
            },
          ],
          steps: [{ text: 'test' }],
        },
      ],
    );

    const external = result.find((p) => p.id === pluginId);
    assert.ok(external, 'external manifest connector must appear in status');
    assert.equal(
      external.configured,
      false,
      'requiredWhen must compare against the manifest value, not Feishu websocket/webhook modes',
    );
  });

  // ── F240 A-4: stored config reflected in status (review P1 regression) ──

  it('F240 A-4: stored config values override empty env in status via resolveConnectorEnv', () => {
    // Simulates the exact chain used in the status route handler:
    // 1. Write config to .cat-cafe store
    // 2. Load all configs into cache
    // 3. Resolve per-connector env (stored > env > default)
    // 4. Build status with merged env

    // Get real manifests (same as the route does)
    const manifests = scanConnectorManifests(
      new URL('../src/infrastructure/connectors/im-connectors', import.meta.url).pathname,
    );

    // Step 1: Write DingTalk config to store
    const dingtalkManifest = Array.from(manifests.values()).find((m) => m.id === 'dingtalk');
    assert.ok(dingtalkManifest, 'dingtalk manifest must exist');
    writeConnectorConfig(STORE_PROJECT_ROOT, 'dingtalk', [
      { name: 'DINGTALK_APP_KEY', value: 'store-key-123' },
      { name: 'DINGTALK_APP_SECRET', value: 'store-secret-456' },
    ]);

    // Step 2: Load stored configs
    loadAllConnectorConfigs(STORE_PROJECT_ROOT, Array.from(manifests.values()));

    // Step 3: Resolve merged env (no process.env values for dingtalk)
    const mergedEnv = {};
    for (const m of manifests.values()) {
      const valueFields = m.config.filter(isValueField);
      Object.assign(mergedEnv, resolveConnectorEnv(m.id, valueFields));
    }

    // Step 4: Build status with merged env
    const status = buildConnectorStatus(mergedEnv, Array.from(manifests.values()));

    const dingtalk = status.find((p) => p.id === 'dingtalk');
    assert.ok(dingtalk);
    assert.equal(dingtalk.configured, true, 'DingTalk must be configured from stored values');

    const keyField = dingtalk.fields.find((f) => f.envName === 'DINGTALK_APP_KEY');
    assert.ok(keyField);
    assert.equal(keyField.currentValue, 'store-key-123', 'Non-sensitive stored value must appear');

    const secretField = dingtalk.fields.find((f) => f.envName === 'DINGTALK_APP_SECRET');
    assert.ok(secretField);
    assert.equal(secretField.currentValue, '••••••••', 'Sensitive stored value must be masked');
  });

  it('F240 A-4: stored tombstone (null) blocks env fallback in status', () => {
    // KD-19: stored null = tombstone — even if process.env has the key, it should be absent
    const manifests = scanConnectorManifests(
      new URL('../src/infrastructure/connectors/im-connectors', import.meta.url).pathname,
    );

    // Store a tombstone for one DingTalk field
    writeConnectorConfig(STORE_PROJECT_ROOT, 'dingtalk', [
      { name: 'DINGTALK_APP_KEY', value: null }, // tombstone: block env fallback
      { name: 'DINGTALK_APP_SECRET', value: 'stored-secret' },
    ]);

    loadAllConnectorConfigs(STORE_PROJECT_ROOT, Array.from(manifests.values()));

    // Build merged env with process.env that HAS the tombstoned key
    const mergedEnv = { DINGTALK_APP_KEY: 'env-key-should-be-blocked' };
    for (const m of manifests.values()) {
      const valueFields = m.config.filter(isValueField);
      Object.assign(mergedEnv, resolveConnectorEnv(m.id, valueFields));
    }

    const status = buildConnectorStatus(mergedEnv, Array.from(manifests.values()));
    const dingtalk = status.find((p) => p.id === 'dingtalk');
    assert.ok(dingtalk);
    assert.equal(dingtalk.configured, false, 'Tombstone blocks env fallback → not configured');

    const keyField = dingtalk.fields.find((f) => f.envName === 'DINGTALK_APP_KEY');
    assert.ok(keyField);
    assert.equal(keyField.currentValue, null, 'Tombstoned field must show null');
  });

  it('F240 AC-A25: permissionLabel from manifest drives HubPermissionsTab rendering', () => {
    const status = buildConnectorStatus();

    // Connectors with permissions declared in YAML should have permissionLabel
    const feishu = status.find((p) => p.id === 'feishu');
    assert.ok(feishu);
    assert.equal(feishu.permissionLabel, '飞书', 'feishu has permissions.label in manifest');

    const dingtalk = status.find((p) => p.id === 'dingtalk');
    assert.ok(dingtalk);
    assert.equal(dingtalk.permissionLabel, '钉钉', 'dingtalk has permissions.label in manifest');

    const wecomBot = status.find((p) => p.id === 'wecom-bot');
    assert.ok(wecomBot);
    assert.equal(wecomBot.permissionLabel, '企业微信', 'wecom-bot has permissions.label in manifest');

    // Connectors without permissions section should NOT have permissionLabel
    const telegram = status.find((p) => p.id === 'telegram');
    assert.ok(telegram);
    assert.equal(telegram.permissionLabel, undefined, 'telegram has no permissions in manifest');

    const weixin = status.find((p) => p.id === 'weixin');
    assert.ok(weixin);
    assert.equal(weixin.permissionLabel, undefined, 'weixin has no permissions in manifest');
  });

  it('F240 P1-1 regression: config store write fires configEventBus with changedKeys for gateway reload', () => {
    // Simulate the PUT route: writeConnectorConfig → emit configEventBus if changedKeys
    // No process.env sync — config store is the sole source, gateway reads it directly
    const captured = [];
    const unsub = configEventBus.onConfigChange((event) => captured.push(event));

    // Snapshot process.env before write — must be unchanged after
    const envKeyBefore = process.env.DINGTALK_APP_KEY;
    const envSecretBefore = process.env.DINGTALK_APP_SECRET;

    try {
      const { changedKeys } = writeConnectorConfig(STORE_PROJECT_ROOT, 'dingtalk', [
        { name: 'DINGTALK_APP_KEY', value: 'test-key' },
        { name: 'DINGTALK_APP_SECRET', value: 'test-secret' },
      ]);

      if (changedKeys.length > 0) {
        configEventBus.emitChange({
          source: 'config-store',
          scope: 'key',
          changedKeys,
          changeSetId: createChangeSetId(),
          timestamp: Date.now(),
        });
      }

      assert.equal(captured.length, 1, 'exactly one config change event fired');
      assert.equal(captured[0].source, 'config-store');
      assert.equal(captured[0].scope, 'key');
      assert.ok(captured[0].changedKeys.includes('DINGTALK_APP_KEY'));
      assert.ok(captured[0].changedKeys.includes('DINGTALK_APP_SECRET'));

      // Verify no process.env pollution — values unchanged from before write
      assert.equal(process.env.DINGTALK_APP_KEY, envKeyBefore, 'must NOT modify process.env');
      assert.equal(process.env.DINGTALK_APP_SECRET, envSecretBefore, 'must NOT modify process.env');
    } finally {
      unsub();
    }
  });

  it('F240 tombstone: clearing absent store key (undefined → null) reports changedKeys for reload', () => {
    // KD-19 three-state: store has no entry (undefined) → user sends null (tombstone).
    // writeConnectorConfig must detect this as a change (undefined !== null),
    // so the route fires configEventBus and gateway restarts.
    // Previous bug: `?? ''` collapsed undefined and null to '' → no change detected.
    clearConnectorConfigCache();

    // Snapshot process.env before write
    const envBefore = process.env.DINGTALK_APP_KEY;

    const { changedKeys } = writeConnectorConfig(STORE_PROJECT_ROOT, 'dingtalk', [
      { name: 'DINGTALK_APP_KEY', value: null },
    ]);

    assert.ok(changedKeys.includes('DINGTALK_APP_KEY'), 'tombstone (undefined → null) must be in changedKeys');

    // Verify no process.env pollution — value unchanged
    assert.equal(process.env.DINGTALK_APP_KEY, envBefore, 'must NOT modify process.env');
  });

  it('F240 idempotent: re-sending same tombstone (null → null) reports no changedKeys', () => {
    // After a tombstone is written, sending null again should not trigger reload
    writeConnectorConfig(STORE_PROJECT_ROOT, 'dingtalk', [{ name: 'DINGTALK_APP_KEY', value: null }]);

    const { changedKeys } = writeConnectorConfig(STORE_PROJECT_ROOT, 'dingtalk', [
      { name: 'DINGTALK_APP_KEY', value: null },
    ]);

    assert.deepEqual(changedKeys, [], 'null → null is idempotent, no reload');
  });
});
