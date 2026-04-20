import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { revokeCapability } from '../dist/config/capabilities/capability-revoke.js';

describe('Capability Revoke', () => {
  const makeEntry = (overrides = {}) => ({
    id: 'test-mcp',
    type: 'mcp',
    enabled: true,
    source: 'external',
    ...overrides,
  });

  test('revoke disables capability entry', () => {
    const entry = makeEntry();
    const result = revokeCapability(entry, 'opus');
    assert.strictEqual(result.entry.enabled, false);
  });

  test('revoke records revoker and timestamp', () => {
    const result = revokeCapability(makeEntry(), 'you');
    assert.strictEqual(result.revokedBy, 'you');
    assert.ok(!Number.isNaN(Date.parse(result.revokedAt)));
  });

  test('revoke returns audit action = revoke', () => {
    const result = revokeCapability(makeEntry(), 'opus');
    assert.strictEqual(result.auditAction, 'revoke');
  });

  test('revoke already-disabled entry still succeeds', () => {
    const entry = makeEntry({ enabled: false });
    const result = revokeCapability(entry, 'opus');
    assert.strictEqual(result.entry.enabled, false);
  });

  test('revoke preserves other entry fields', () => {
    const entry = makeEntry({ mcpServer: { command: 'node', args: ['server.js'] } });
    const result = revokeCapability(entry, 'opus');
    assert.deepStrictEqual(result.entry.mcpServer, { command: 'node', args: ['server.js'] });
    assert.strictEqual(result.entry.id, 'test-mcp');
    assert.strictEqual(result.entry.source, 'external');
  });

  test('revoke cat-cafe source throws', () => {
    assert.throws(() => revokeCapability(makeEntry({ source: 'cat-cafe' }), 'opus'), /cannot revoke.*cat-cafe/i);
  });
});
