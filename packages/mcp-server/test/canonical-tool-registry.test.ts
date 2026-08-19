import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  buildCanonicalToolRegistry,
  derivedProfileSet,
  projectCanonicalToolRegistry,
  projectServerFamily,
} from '../src/canonical-tool-registry.js';
import { bindMcpImplementation, defineMcpTool, type McpRuntimeProfile } from '../src/tool-governance.js';

const run = async (_args: never): Promise<unknown> => ({ ok: true });
const testRef = 'test:packages/mcp-server/test/canonical-tool-registry.test.ts' as const;

function tool(name: string, runtimeProfiles: readonly [McpRuntimeProfile, ...McpRuntimeProfile[]]) {
  return defineMcpTool({
    name,
    description: `Operate ${name}`,
    operation: {
      kind: 'single',
      action: 'read',
      inputSchema: { id: z.string() },
      boundary: {
        authorizationPaths: [
          {
            principal: 'local-operator',
            credentialSource: 'local-process',
            scope: { kind: 'local-runtime' },
            enforcementRef: testRef,
          },
        ],
        risk: { level: 'read', openWorld: false },
      },
    },
    implementation: bindMcpImplementation(`module:./fixtures/tools.js#${name}`, run),
    policy: {
      resourceFamily: 'fixture',
      exposureTier: { current: 'eager-core', evidenceRef: testRef },
      runtimeProfiles,
      owner: {
        domainCell: 'architecture-cell:mcp-surface-governance',
        surface: 'mcp-surface-governance',
      },
      standaloneReason: {
        disposition: 'consolidation-candidate',
        kind: 'same-resource-lifecycle',
        evidenceRef: testRef,
      },
      activeState: 'migration-candidate',
      cognitiveEntryPoints: [{ kind: 'tool-description', ref: testRef }],
      verification: [{ kind: 'test', ref: testRef }],
    },
  });
}

function registry() {
  return buildCanonicalToolRegistry({
    collab: [tool('cat_cafe_full', ['full']), tool('cat_cafe_agent', ['full', 'agent-key'])],
    memory: [tool('cat_cafe_read', ['full', 'readonly'])],
    signals: [],
    limb: [tool('limb_control', ['full', 'readonly'])],
    audio: [],
    finance: [tool('cat_cafe_desktop', ['full', 'desktop:fable-phase0', 'desktop:cloud-pro-phase0'])],
  });
}

describe('F286 canonical MCP registry projections', () => {
  it('rejects duplicate semantic names at composition time', () => {
    const duplicate = tool('cat_cafe_duplicate', ['full']);
    assert.throws(
      () =>
        buildCanonicalToolRegistry({
          collab: [duplicate],
          memory: [duplicate],
          signals: [],
          limb: [],
          audio: [],
          finance: [],
        }),
      /duplicate canonical/i,
    );
  });

  it('rejects a legacy array insertion that has no governance certificate', () => {
    const legacy = {
      name: 'cat_cafe_legacy_insertion',
      description: 'Legacy shape without lifecycle governance.',
      inputSchema: {},
      handler: run,
    };
    assert.throws(
      () =>
        buildCanonicalToolRegistry({
          collab: [legacy] as never,
          memory: [],
          signals: [],
          limb: [],
          audio: [],
          finance: [],
        }),
      /governance certificate/i,
    );
  });

  it('derives full, readonly, agent-key, desktop, and family views from certificates', () => {
    const canonical = registry();
    assert.deepEqual(
      projectCanonicalToolRegistry(canonical, { readonly: true }).map((definition) => definition.name),
      ['cat_cafe_read', 'limb_control'],
    );
    assert.deepEqual(
      projectCanonicalToolRegistry(canonical, { readonly: true, hasAgentKey: true }).map(
        (definition) => definition.name,
      ),
      ['cat_cafe_agent', 'cat_cafe_read', 'limb_control'],
    );
    assert.deepEqual(
      projectCanonicalToolRegistry(canonical, { desktopMode: 'fable-phase0' }).map((definition) => definition.name),
      ['cat_cafe_desktop'],
    );
    assert.deepEqual(
      projectServerFamily(canonical, 'limb', { readonly: true }).map((definition) => definition.name),
      ['limb_control'],
    );
    assert.deepEqual([...derivedProfileSet(canonical, 'agent-key')], ['cat_cafe_agent']);
  });

  it('fails fast on an unknown desktop profile', () => {
    assert.throws(() => projectCanonicalToolRegistry(registry(), { desktopMode: 'typo' }), /unknown/i);
  });
});
