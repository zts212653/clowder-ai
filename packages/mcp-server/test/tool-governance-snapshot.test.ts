import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { bindMcpImplementation, defineMcpTool } from '../src/tool-governance.js';
import {
  compareMcpSurfaceProtocol,
  compareMcpSurfaceRegistry,
  createMcpSurfaceSnapshot,
  serializeMcpSurfaceSnapshot,
} from '../src/tool-governance-snapshot.js';

const run = async (_args: never): Promise<unknown> => ({ ok: true });
const testRef = 'test:packages/mcp-server/test/tool-governance-snapshot.test.ts' as const;
const implementationRef = 'module:./fixtures/snapshot.js#run' as const;

function definition(description = 'Read one governed subject.') {
  return {
    ...defineMcpTool({
      name: 'cat_cafe_subject_read',
      description,
      operation: {
        kind: 'single',
        action: 'read',
        inputSchema: { id: z.string().min(1).describe('Subject id') },
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
      implementation: bindMcpImplementation(implementationRef, run),
      policy: {
        resourceFamily: 'subject',
        exposureTier: { current: 'eager-core', evidenceRef: testRef },
        runtimeProfiles: ['full', 'readonly'],
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
    }),
    serverFamily: 'memory' as const,
  };
}

const implementationCatalog = new Map([
  [implementationRef, { moduleDigest: 'sha256:fixture', exportName: 'run', compilerSymbolId: 'fixture#run' }],
]);

describe('F286 deterministic MCP surface snapshot', () => {
  it('normalizes protocol fields and emits deterministic comparison metrics', () => {
    const snapshot = createMcpSurfaceSnapshot([definition()], {
      protectedBaseSha: 'a'.repeat(40),
      implementationCatalog,
    });
    const tool = snapshot.tools[0];

    assert.equal(tool?.descriptionCharacters, 26);
    assert.equal(tool?.activeState, 'migration-candidate');
    assert.match(tool?.descriptionDigest ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.match(tool?.inputSchemaDigest ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.ok((tool?.descriptionTokensCl100kBase ?? 0) > 0);
    assert.deepEqual(tool?.annotations, {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    });
    assert.match(serializeMcpSurfaceSnapshot(snapshot), /"comparisonEncoding": "cl100k_base"/);
  });

  it('reports resource action and profile deltas from generated snapshots', () => {
    const before = createMcpSurfaceSnapshot([definition()], {
      protectedBaseSha: 'a'.repeat(40),
      implementationCatalog,
    });
    const changed = definition();
    const after = createMcpSurfaceSnapshot(
      [
        {
          ...changed,
          actionInventory: ['inspect'],
          policy: { ...changed.policy, runtimeProfiles: ['full'] },
        },
      ],
      { protectedBaseSha: 'a'.repeat(40), implementationCatalog },
    );

    assert.deepEqual(compareMcpSurfaceRegistry(before, after), {
      addedNames: [],
      removedNames: [],
      resourceActionChanges: [{ resourceFamily: 'subject', added: ['inspect'], removed: ['read'] }],
      profileChanges: [{ name: 'cat_cafe_subject_read', added: [], removed: ['readonly'] }],
    });
  });

  it('reports exact protocol drift but ignores comparison-only token and digest fields', () => {
    const before = createMcpSurfaceSnapshot([definition()], {
      protectedBaseSha: 'a'.repeat(40),
      implementationCatalog,
    });
    const after = createMcpSurfaceSnapshot([definition('Changed description.')], {
      protectedBaseSha: 'a'.repeat(40),
      implementationCatalog,
    });

    assert.deepEqual(compareMcpSurfaceProtocol(before, after), [
      { name: 'cat_cafe_subject_read', field: 'description' },
    ]);
  });
});
