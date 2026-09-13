import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AGENT_KEY_TOOLS,
  buildLimbTools,
  READONLY_ALLOWED_TOOLS,
  registerFullToolset,
  type ToolsetEnv,
} from '../src/server-toolsets.js';

/**
 * F317 P1 regression: the legacy all-in-one entry (dist/index.js →
 * registerFullToolset) must keep CAT_CAFE_READONLY=true strict even when
 * CAT_CAFE_AGENT_KEY_* vars leak in from the parent environment.
 *
 * Evidence: the L1 gate probe observed exactly READONLY ∪ AGENT_KEY (66 tools)
 * under CAT_CAFE_READONLY=true because the probe env carried agent-key vars —
 * the union is by design, but only for explicit opt-in (antigravity), never
 * for incidental env inheritance (third-party MCP mounts like qodercn).
 */
function registeredNames(env?: ToolsetEnv): Set<string> {
  const server = new McpServer({ name: 'readonly-legacy-entry-test', version: '0.0.1' });
  registerFullToolset(server, env);
  const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return new Set(Object.keys(registry));
}

// limb family is deliberately unfiltered by readonly (F061 antigravity
// contract); include it in the expected sets so the assertions stay exact.
function limbNames(env?: ToolsetEnv): string[] {
  return buildLimbTools(env).map((tool) => tool.name);
}

describe('registerFullToolset — F317 P1 strict readonly (legacy dist/index.js entry)', () => {
  it('default env: full surface registered', () => {
    const names = registeredNames({});
    assert.ok(names.size > 100, `expected full registry, got ${names.size}`);
    assert.equal(names.has('cat_cafe_cross_post_message'), true);
  });

  it('readonly + leaked agent-key env WITHOUT opt-in → exactly READONLY ∪ limb', () => {
    const env: ToolsetEnv = { readonly: true, hasAgentKey: true };
    const names = registeredNames(env);
    const expected = new Set([...READONLY_ALLOWED_TOOLS, ...limbNames(env)]);
    assert.deepEqual([...names].sort(), [...expected].sort());
    assert.equal(names.has('cat_cafe_cross_post_message'), false, 'write tool must not leak without opt-in');
    assert.equal(names.has('cat_cafe_register_scheduled_task'), false);
    assert.equal(names.has('cat_cafe_remove_scheduled_task'), false);
    assert.equal(names.has('cat_cafe_teleport'), false);
  });

  it('readonly + agent-key + explicit opt-in → READONLY ∪ AGENT_KEY ∪ limb', () => {
    const env: ToolsetEnv = { readonly: true, hasAgentKey: true, agentKeyUnion: true };
    const names = registeredNames(env);
    const expected = new Set([...READONLY_ALLOWED_TOOLS, ...AGENT_KEY_TOOLS, ...limbNames(env)]);
    assert.deepEqual([...names].sort(), [...expected].sort());
    assert.equal(names.has('cat_cafe_cross_post_message'), true, 'antigravity opt-in keeps the union');
  });
});
