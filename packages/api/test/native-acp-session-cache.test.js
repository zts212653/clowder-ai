import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ActiveSessionCache,
  AcpSessionBindingError,
} from '../dist/domains/cats/services/agents/providers/acp/active-session-cache.js';

test('active session receipts follow complete setter and notification updates', () => {
  const cache = new ActiveSessionCache();
  cache.remember({ sessionId: 'history', configOptions: [] }, '/project', []);
  cache.update('history', { configOptions: [{ id: 'effort', currentValue: 'low' }] });
  assert.equal(cache.get('history', '/project', [], true).configOptions[0].currentValue, 'low');
  cache.notify({
    sessionId: 'history',
    update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'effort', currentValue: 'high' }] },
  });
  assert.equal(cache.get('history', '/project', [], true).configOptions[0].currentValue, 'high');
});
test('active session binding cannot silently change workspace, MCP or process health', () => {
  const cache = new ActiveSessionCache();
  cache.remember({ sessionId: 'history' }, '/project', []);
  assert.throws(() => cache.get('history', '/other', [], true), AcpSessionBindingError);
  assert.throws(
    () => cache.get('history', '/project', [{ name: 'new', command: 'node', args: [], env: [] }], true),
    AcpSessionBindingError,
  );
  assert.throws(() => cache.get('history', '/project', [], false), AcpSessionBindingError);
  assert.equal(new ActiveSessionCache().get('history', '/project', [], true), undefined);
  cache.forget('history');
  assert.equal(cache.get('history', '/project', [], true), undefined);
});
test('only credentials refreshed through the same session file can vary during reuse', () => {
  const servers = (token, file) => [
    {
      name: 'cat-cafe',
      command: 'node',
      args: [],
      env: [
        { name: 'CAT_CAFE_CALLBACK_TOKEN', value: token },
        ...(file ? [{ name: 'CAT_CAFE_CREDENTIAL_FILE', value: file }] : []),
      ],
    },
  ];
  const cache = new ActiveSessionCache();
  cache.remember({ sessionId: 'history' }, '/project', servers('a', '/creds/session'));
  assert.equal(cache.get('history', '/project', servers('b', '/creds/session'), true).sessionId, 'history');
  assert.throws(() => cache.get('history', '/project', servers('b', '/creds/other'), true), AcpSessionBindingError);
  cache.remember({ sessionId: 'unbridged' }, '/project', servers('a'));
  assert.throws(() => cache.get('unbridged', '/project', servers('b'), true), AcpSessionBindingError);
});
