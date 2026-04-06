/**
 * F136 Phase 2: Connector secrets allowlist tests
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONNECTOR_SECRETS_ALLOWLIST, isConnectorSecret } from '../dist/config/connector-secrets-allowlist.js';

describe('CONNECTOR_SECRETS_ALLOWLIST', () => {
  it('accepts all connector env vars used by loadConnectorGatewayConfig', () => {
    const expected = [
      'TELEGRAM_BOT_TOKEN',
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'FEISHU_VERIFICATION_TOKEN',
      'FEISHU_BOT_OPEN_ID',
      'FEISHU_ADMIN_OPEN_IDS',
      'FEISHU_CONNECTION_MODE',
      'DINGTALK_APP_KEY',
      'DINGTALK_APP_SECRET',
      'WEIXIN_BOT_TOKEN',
      'WECOM_BOT_ID',
      'WECOM_BOT_SECRET',
      'WECOM_CORP_ID',
      'WECOM_AGENT_ID',
      'WECOM_AGENT_SECRET',
      'WECOM_TOKEN',
      'WECOM_ENCODING_AES_KEY',
      'XIAOYI_AK',
      'XIAOYI_SK',
      'XIAOYI_AGENT_ID',
    ];
    for (const name of expected) {
      assert.ok(isConnectorSecret(name), `${name} should be in allowlist`);
    }
  });

  it('rejects non-connector env vars', () => {
    assert.equal(isConnectorSecret('OPENAI_API_KEY'), false);
    assert.equal(isConnectorSecret('REDIS_URL'), false);
    assert.equal(isConnectorSecret('API_SERVER_PORT'), false);
    assert.equal(isConnectorSecret(''), false);
    assert.equal(isConnectorSecret('RANDOM_KEY'), false);
    assert.equal(isConnectorSecret('TELEGRAM_BOT_TOKEN_EXTRA'), false);
  });

  it('allowlist has exactly 20 entries', () => {
    assert.equal(CONNECTOR_SECRETS_ALLOWLIST.size, 20);
  });
});
