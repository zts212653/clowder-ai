/**
 * F136 Phase 2: Connector secrets allowlist
 *
 * Defines which env vars can be written via POST /api/config/secrets.
 * Aligned with loadConnectorGatewayConfig() in connector-gateway-bootstrap.ts.
 */

export const CONNECTOR_SECRETS_ALLOWLIST: ReadonlySet<string> = new Set([
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
]);

export function isConnectorSecret(name: string): boolean {
  return CONNECTOR_SECRETS_ALLOWLIST.has(name);
}
