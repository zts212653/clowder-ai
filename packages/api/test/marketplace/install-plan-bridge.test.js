// @ts-check
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('InstallPlanBridge', () => {
  let toMcpInstallRequest, validateInstallPlan;

  before(async () => {
    ({ toMcpInstallRequest, validateInstallPlan } = await import('../../dist/marketplace/install-plan-bridge.js'));
  });

  it('converts direct_mcp plan to McpInstallRequest', () => {
    const plan = {
      mode: 'direct_mcp',
      mcpEntry: { id: 'test-mcp', command: 'npx', args: ['-y', 'mcp-server'] },
      metadata: { versionRef: '1.2.3', publisherIdentity: 'anthropic' },
    };
    const req = toMcpInstallRequest(plan);
    assert.strictEqual(req.id, 'test-mcp');
    assert.strictEqual(req.command, 'npx');
    assert.deepStrictEqual(req.args, ['-y', 'mcp-server']);
  });

  it('preserves transport/url/env/headers in conversion', () => {
    const plan = {
      mode: 'direct_mcp',
      mcpEntry: {
        id: 'remote',
        url: 'https://x.com',
        transport: 'streamableHttp',
        env: { K: 'V' },
        headers: { Auth: 'tok' },
      },
    };
    const req = toMcpInstallRequest(plan);
    assert.strictEqual(req.url, 'https://x.com');
    assert.strictEqual(req.transport, 'streamableHttp');
    assert.deepStrictEqual(req.env, { K: 'V' });
    assert.deepStrictEqual(req.headers, { Auth: 'tok' });
  });

  it('throws for non-direct_mcp plans', () => {
    assert.throws(
      () =>
        toMcpInstallRequest({
          mode: 'delegated_cli',
          delegatedCommand: 'claude mcp add x',
        }),
      /only supports direct_mcp/,
    );
  });

  it('validates direct_mcp plan requires mcpEntry', () => {
    const errors = validateInstallPlan({ mode: 'direct_mcp' });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes('mcpEntry'));
  });

  it('validates delegated_cli plan requires delegatedCommand', () => {
    const errors = validateInstallPlan({ mode: 'delegated_cli' });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes('delegatedCommand'));
  });

  it('validates manual_ui plan requires manualSteps', () => {
    const errors = validateInstallPlan({ mode: 'manual_ui' });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes('manualSteps'));
  });

  it('validates manual_file plan requires manualSteps', () => {
    const errors = validateInstallPlan({ mode: 'manual_file' });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes('manualSteps'));
  });

  it('passes valid plans with no errors', () => {
    assert.deepStrictEqual(validateInstallPlan({ mode: 'direct_mcp', mcpEntry: { id: 'x' } }), []);
    assert.deepStrictEqual(validateInstallPlan({ mode: 'delegated_cli', delegatedCommand: 'cmd' }), []);
    assert.deepStrictEqual(validateInstallPlan({ mode: 'manual_ui', manualSteps: ['step 1'] }), []);
    assert.deepStrictEqual(validateInstallPlan({ mode: 'manual_file', manualSteps: ['step 1'] }), []);
  });
});
