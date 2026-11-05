import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSessionCookieName } from '../dist/infrastructure/session-auth.js';

test('isolated deployments can separate browser sessions without changing the default', () => {
  assert.equal(resolveSessionCookieName({}), 'cat_cafe_session');
  assert.equal(resolveSessionCookieName({ CAT_CAFE_SESSION_COOKIE_NAME: 'issue1466_preview' }), 'issue1466_preview');
  assert.throws(() => resolveSessionCookieName({ CAT_CAFE_SESSION_COOKIE_NAME: 'bad;cookie' }));
});
