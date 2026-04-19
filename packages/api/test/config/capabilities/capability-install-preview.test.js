import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildInstallPreview } from '../../../dist/config/capabilities/capability-install.js';

describe('buildInstallPreview', () => {
  test('stdio MCP returns correct entry structure', () => {
    const preview = buildInstallPreview({
      id: 'test-mcp',
      command: 'npx',
      args: ['test-mcp-server'],
    });
    assert.equal(preview.entry.id, 'test-mcp');
    assert.equal(preview.entry.type, 'mcp');
    assert.equal(preview.entry.enabled, true);
    assert.equal(preview.entry.source, 'external');
    assert.equal(preview.entry.mcpServer?.command, 'npx');
    assert.deepEqual(preview.entry.mcpServer?.args, ['test-mcp-server']);
    assert.equal(preview.willProbe, true);
    assert.equal(preview.cliConfigsAffected.length, 4);
    assert.equal(preview.risks.length, 0);
  });

  test('streamableHttp MCP returns url-based entry', () => {
    const preview = buildInstallPreview({
      id: 'remote-mcp',
      transport: 'streamableHttp',
      url: 'https://mcp.example.com/api',
    });
    assert.equal(preview.entry.mcpServer?.transport, 'streamableHttp');
    assert.equal(preview.entry.mcpServer?.url, 'https://mcp.example.com/api');
    assert.equal(preview.willProbe, false);
  });

  test('resolver-backed MCP entry', () => {
    const preview = buildInstallPreview({
      id: 'chrome-ext',
      resolver: 'chrome-extension',
    });
    assert.equal(preview.entry.mcpServer?.resolver, 'chrome-extension');
    assert.equal(preview.entry.mcpServer?.command, '');
    assert.equal(preview.willProbe, false);
  });

  test('duplicate ID flagged as risk', () => {
    const preview = buildInstallPreview({ id: 'existing-mcp', command: 'node', args: ['server.js'] }, [
      { id: 'existing-mcp', type: 'mcp', enabled: true, source: 'external' },
    ]);
    assert.ok(preview.risks.some((r) => r.includes('already exists')));
  });

  test('no command/resolver/url flagged as risk', () => {
    const preview = buildInstallPreview({ id: 'empty-mcp' });
    assert.ok(preview.risks.some((r) => r.includes('unresolvable')));
  });

  test('env variables passed through', () => {
    const preview = buildInstallPreview({
      id: 'env-mcp',
      command: 'npx',
      args: ['server'],
      env: { API_KEY: 'secret' },
    });
    assert.deepEqual(preview.entry.mcpServer?.env, { API_KEY: 'secret' });
  });
});
