import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { CANONICAL_TOOL_REGISTRY } from '../src/canonical-server-tools.js';
import { bindMcpImplementation, defineMcpTool, type McpToolDefinition } from '../src/tool-governance.js';
import { resolveMcpImplementationCatalog } from '../src/tool-governance-implementation.js';
import { readSubject, updateSubject } from './fixtures/mcp-governance-implementation.js';

const implementationRef = 'module:../test/fixtures/mcp-governance-implementation.js#readSubject' as const;

function definition(run = readSubject): McpToolDefinition {
  return defineMcpTool({
    name: 'cat_cafe_subject_read',
    description: 'Read one subject.',
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
            enforcementRef: 'test:packages/mcp-server/test/tool-governance-implementation.test.ts',
          },
        ],
        risk: { level: 'read', openWorld: false },
      },
    },
    implementation: bindMcpImplementation(implementationRef, run),
    policy: {
      resourceFamily: 'subject',
      exposureTier: {
        current: 'eager-core',
        evidenceRef: 'test:packages/mcp-server/test/tool-governance-implementation.test.ts',
      },
      runtimeProfiles: ['full'],
      owner: {
        domainCell: 'architecture-cell:mcp-surface-governance',
        surface: 'mcp-surface-governance',
      },
      standaloneReason: {
        disposition: 'consolidation-candidate',
        kind: 'same-resource-lifecycle',
        evidenceRef: 'test:packages/mcp-server/test/tool-governance-implementation.test.ts',
      },
      activeState: 'migration-candidate',
      cognitiveEntryPoints: [
        { kind: 'tool-description', ref: 'test:packages/mcp-server/test/tool-governance-implementation.test.ts' },
      ],
      verification: [{ kind: 'test', ref: 'test:packages/mcp-server/test/tool-governance-implementation.test.ts' }],
    },
  });
}

describe('F286 compiler and runtime implementation binding', () => {
  it('resolves a named compiler export and exact pre-registration function identity', async () => {
    const catalog = await resolveMcpImplementationCatalog({
      repoRoot: resolve(import.meta.dirname, '../../..'),
      definitions: [definition()],
      loadRuntimeModule: async () => ({ readSubject }),
    });

    const resolved = catalog.get(implementationRef);
    assert.equal(resolved?.exportName, 'readSubject');
    assert.match(resolved?.moduleDigest ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.match(resolved?.compilerSymbolId ?? '', /mcp-governance-implementation\.ts#readSubject@/);
  });

  it('rejects a same-schema handler swap even when the referenced export exists', async () => {
    await assert.rejects(
      resolveMcpImplementationCatalog({
        repoRoot: resolve(import.meta.dirname, '../../..'),
        definitions: [definition(updateSubject)],
        loadRuntimeModule: async () => ({ readSubject }),
      }),
      /implementation identity mismatch/i,
    );
  });

  it('resolves every canonical tool to its exact named implementation export', async () => {
    const catalog = await resolveMcpImplementationCatalog({
      repoRoot: resolve(import.meta.dirname, '../../..'),
      definitions: CANONICAL_TOOL_REGISTRY,
      loadRuntimeModule: async (ref) => {
        const moduleSpecifier = /^module:(.+)#[^#]+$/.exec(ref)?.[1];
        assert.ok(moduleSpecifier?.startsWith('./'), `invalid canonical implementation ref: ${ref}`);
        return import(new URL(`../src/${moduleSpecifier.slice(2)}`, import.meta.url)) as Promise<
          Readonly<Record<string, unknown>>
        >;
      },
    });

    assert.equal(
      catalog.size,
      new Set(CANONICAL_TOOL_REGISTRY.map((definition) => definition.implementation.ref)).size,
    );
  });
});
