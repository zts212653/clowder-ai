import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildConnectorStatus } from '../dist/routes/connector-hub.js';

describe('buildConnectorStatus', () => {
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
});
