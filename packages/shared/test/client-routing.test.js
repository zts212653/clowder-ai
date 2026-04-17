import assert from 'node:assert/strict';
import test from 'node:test';
import { builtinAccountFamilyForClient, builtinAccountIdForClient, protocolForClient } from '../dist/index.js';

test('catagent shares anthropic builtin account family', () => {
  assert.equal(builtinAccountFamilyForClient('catagent'), 'anthropic');
  assert.equal(builtinAccountIdForClient('catagent'), 'claude');
});

test('protocolForClient normalizes provider family routing', () => {
  assert.equal(protocolForClient('catagent'), 'anthropic');
  assert.equal(protocolForClient('opencode'), 'anthropic');
  assert.equal(protocolForClient('dare'), 'openai');
  assert.equal(protocolForClient('antigravity'), null);
});
