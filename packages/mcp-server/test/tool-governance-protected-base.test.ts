import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { bindMcpImplementation, defineMcpTool } from '../src/tool-governance.js';
import { createProtectedBaseSnapshot } from '../src/tool-governance-protected-base.js';
import { createMcpSurfaceSnapshot } from '../src/tool-governance-snapshot.js';

const run = async (_args: never): Promise<unknown> => ({ ok: true });
const swapped = async (_args: never): Promise<unknown> => ({ ok: false });
const ref = 'module:./tools/fixture.js#run' as const;

function fixture() {
  return defineMcpTool({
    name: 'cat_cafe_fixture_read',
    description: 'Read one fixture.',
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
            enforcementRef: 'test:packages/mcp-server/test/tool-governance-protected-base.test.ts',
          },
        ],
        risk: { level: 'read', openWorld: false },
      },
    },
    implementation: bindMcpImplementation(ref, run),
    policy: {
      resourceFamily: 'fixture',
      exposureTier: {
        current: 'eager-core',
        evidenceRef: 'test:packages/mcp-server/test/tool-governance-protected-base.test.ts',
      },
      runtimeProfiles: ['full', 'readonly'],
      owner: { domainCell: 'architecture-cell:mcp-surface-governance', surface: 'mcp-surface-governance' },
      standaloneReason: {
        disposition: 'consolidation-candidate',
        kind: 'same-resource-lifecycle',
        evidenceRef: 'test:packages/mcp-server/test/tool-governance-protected-base.test.ts',
      },
      activeState: 'migration-candidate',
      cognitiveEntryPoints: [
        { kind: 'tool-description', ref: 'test:packages/mcp-server/test/tool-governance-protected-base.test.ts' },
      ],
      verification: [{ kind: 'test', ref: 'test:packages/mcp-server/test/tool-governance-protected-base.test.ts' }],
    },
  });
}

describe('F286 protected-base witness', () => {
  it('proves legacy protocol and pre-registration handler identity', async () => {
    const definition = fixture();
    const current = createMcpSurfaceSnapshot([{ ...definition, serverFamily: 'memory' }], {
      protectedBaseSha: 'a'.repeat(40),
      implementationCatalog: new Map([
        [ref, { moduleDigest: 'sha256:current', exportName: 'run', compilerSymbolId: 'x' }],
      ]),
    });
    const legacyTool = {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      handler: run,
    };
    const legacy = legacyModule(legacyTool);

    const snapshot = await createProtectedBaseSnapshot(current, [definition], legacy, {
      protectedBaseSha: 'a'.repeat(40),
      verifyImplementationBinding: async (_toolName, handler) => {
        if (handler !== run) throw new Error('Protected-base handler identity mismatch');
      },
      implementationDigest: async () => 'sha256:protected',
    });
    assert.equal(snapshot.tools[0]?.protectedImplementationDigest, 'sha256:protected');

    await assert.rejects(
      createProtectedBaseSnapshot(current, [definition], legacyModule({ ...legacyTool, handler: swapped }), {
        protectedBaseSha: 'a'.repeat(40),
        verifyImplementationBinding: async (_toolName, handler) => {
          if (handler !== run) throw new Error('Protected-base handler identity mismatch');
        },
        implementationDigest: async () => 'sha256:protected',
      }),
      /handler identity mismatch/i,
    );
  });
});

function legacyModule(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: typeof run;
}) {
  const empty = () => [];
  return {
    buildCollabTools: empty,
    buildMemoryTools: () => [tool],
    buildSignalTools: empty,
    buildLimbTools: empty,
    buildAudioTools: empty,
    buildFinanceTools: empty,
    AGENT_KEY_TOOLS: new Set<string>(),
    EXPLICIT_TOOL_ANNOTATIONS: { [tool.name]: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  };
}
