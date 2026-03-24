import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildConnectorStatus } from '../dist/routes/connector-hub.js';

describe('buildConnectorStatus', () => {
  it('returns all platforms as not configured when env is empty', () => {
    const result = buildConnectorStatus({});
    assert.equal(result.length, 4);

    const feishu = result.find((p) => p.id === 'feishu');
    assert.ok(feishu);
    assert.equal(feishu.configured, false);
    assert.equal(feishu.fields.length, 3);
    for (const f of feishu.fields) {
      assert.equal(f.currentValue, null);
    }

    const telegram = result.find((p) => p.id === 'telegram');
    assert.ok(telegram);
    assert.equal(telegram.configured, false);

    const dingtalk = result.find((p) => p.id === 'dingtalk');
    assert.ok(dingtalk);
    assert.equal(dingtalk.configured, false);

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
    }
  });
});
