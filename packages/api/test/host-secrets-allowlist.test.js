import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOST_SECRETS_ALLOWLIST, isHostSecret } from '../dist/config/host-secrets-allowlist.js';

test('Host settings expose web-push secrets and reject plugin credentials', () => {
  assert.deepEqual([...HOST_SECRETS_ALLOWLIST].sort(), ['VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT']);
  for (const name of ['TELEGRAM_BOT_TOKEN', 'FEISHU_APP_SECRET', 'GITHUB_TOKEN', 'REDIS_URL', '']) {
    assert.equal(isHostSecret(name), false);
  }
});
