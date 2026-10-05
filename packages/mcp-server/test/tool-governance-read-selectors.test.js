import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  bindMcpImplementation,
  compareToolRegistries,
  defineMcpTool,
  validateToolGovernance,
} from '../dist/tool-governance.js';
import {
  compareMcpSurfaceRegistry,
  createMcpSurfaceSnapshot,
  digestMcpInputSchema,
} from '../dist/tool-governance-snapshot.js';

const evidenceRef = 'architecture-cell:mcp-surface-governance';
const implementationRef = 'module:./fixtures/read-selector.js#run';
const modes = ['lexical', 'semantic', 'hybrid'];
const claim = {
  ref: evidenceRef,
  subject: {
    toolName: 'cat_cafe_search_evidence',
    resourceFamily: 'evidence-navigation',
    field: 'mode',
    role: 'read-strategy',
  },
  decision: 'accepted',
  sourceDigest: `sha256:${'a'.repeat(64)}`,
};
const implementationCatalog = new Map([
  [implementationRef, { moduleDigest: 'sha256:fixture', exportName: 'run', compilerSymbolId: 'fixture#run' }],
]);

function definition({
  field = 'mode',
  literals = modes,
  level = 'read',
  declared = true,
  activeState = 'canonical',
  role = 'read-strategy',
} = {}) {
  return defineMcpTool({
    name: 'cat_cafe_search_evidence',
    description: 'Read evidence with a declared retrieval strategy.',
    operation: {
      kind: 'single',
      action: 'read',
      inputSchema: { query: z.string(), [field]: z.enum(literals).optional() },
      boundary: {
        authorizationPaths: [
          {
            principal: 'local-operator',
            credentialSource: 'local-process',
            scope: { kind: 'local-runtime' },
            enforcementRef: evidenceRef,
          },
        ],
        risk: { level, openWorld: true },
      },
      ...(declared ? { closedSelectors: [{ field, role, evidenceRef }] } : {}),
    },
    implementation: bindMcpImplementation(implementationRef, async () => ({ ok: true })),
    policy: {
      resourceFamily: 'evidence-navigation',
      activeState,
      schemaDelivery: { policy: 'host-default', evidenceRef },
      runtimeProfiles: ['full', 'readonly'],
      owner: { domainCell: evidenceRef, surface: 'mcp-surface-governance' },
      standaloneReason: { disposition: 'consolidation-candidate', kind: 'same-resource-lifecycle', evidenceRef },
      cognitiveEntryPoints: [{ kind: 'tool-description', ref: evidenceRef }],
      verification: [{ kind: 'test', ref: evidenceRef }],
    },
  });
}
function validate(tool, claims = [claim], existing = true, protectedDefinition = tool) {
  return validateToolGovernance([tool], {
    implementationCatalog,
    evidenceCatalog: {
      existingRefs: new Set(existing ? [evidenceRef] : []),
      admissionClaims: new Map(),
      selectorClaims: new Map([[evidenceRef, claims]]),
    },
    protectedBase: new Map([
      [
        tool.name,
        {
          name: tool.name,
          resourceFamily: 'evidence-navigation',
          actions: ['read'],
          risk: { level: 'read', openWorld: true },
          inputSchemaDigest: digestMcpInputSchema(protectedDefinition.inputSchema),
        },
      ],
    ]),
  });
}
function invalid(result) {
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((f) => f.code === 'invalid-closed-selector'),
    JSON.stringify(result.findings),
  );
}

describe('canonical read strategy admission', () => {
  it('accepts an exact-subject canonical read selector without changing schema or action inventory', () => {
    const tool = definition();
    assert.deepEqual(validate(tool), { ok: true, findings: [] });
    assert.deepEqual(tool.actionInventory, ['read']);
    assert.deepEqual(tool.inputSchema.mode.safeParse(undefined), { success: true, data: undefined });
    assert.equal(tool.inputSchema.mode.safeParse('delete').success, false);
  });
  it('still rejects the identical undeclared finite mode', () => {
    const result = validate(definition({ declared: false }));
    assert.ok(result.findings.some((f) => f.code === 'hidden-operation-discriminator'));
  });
  for (const field of ['action', 'operation', 'decision']) {
    it(`cannot exempt the reserved ${field} discriminator`, () =>
      invalid(validate(definition({ field }), [{ ...claim, subject: { ...claim.subject, field } }])));
  }
  for (const level of ['write', 'destructive']) {
    it(`cannot exempt a ${level} mode`, () => invalid(validate(definition({ level }))));
  }
  it('rejects an unknown role and an unbound or unresolved claim', () => {
    invalid(validate(definition({ role: 'write-strategy' })));
    invalid(validate(definition(), []));
    invalid(validate(definition(), [{ ...claim, subject: { ...claim.subject, toolName: 'other-tool' } }]));
    invalid(validate(definition(), [{ ...claim, sourceDigest: '' }]));
    invalid(validate(definition(), [claim], false));
  });
  it('rejects missing, open, duplicated and multi-action selector declarations', () => {
    const original = definition();
    const withOperation = (operation) => ({
      ...original,
      operation,
      inputSchema: operation.inputSchema ?? original.inputSchema,
    });
    invalid(
      validate(
        withOperation({
          ...original.operation,
          closedSelectors: [...original.operation.closedSelectors, ...original.operation.closedSelectors],
        }),
      ),
    );
    invalid(validate(withOperation({ ...original.operation, inputSchema: { query: z.string() } })));
    invalid(validate(withOperation({ ...original.operation, inputSchema: { query: z.string(), mode: z.string() } })));
    invalid(
      validate(
        withOperation({
          kind: 'discriminated',
          discriminator: 'mode',
          variants: [],
          closedSelectors: original.operation.closedSelectors,
        }),
      ),
    );
    invalid(
      validate(
        withOperation({
          ...original.operation,
          closedSelectors: [{ ...original.operation.closedSelectors[0], literals: ['delete'] }],
        }),
      ),
    );
  });
  it('never renews changed protected migration candidates through a selector', () => {
    const prior = definition({
      activeState: 'migration-candidate',
      declared: false,
      literals: ['lexical', 'semantic'],
    });
    const result = validate(definition({ activeState: 'migration-candidate' }), [claim], true, prior);
    invalid(result);
    assert.ok(result.findings.some((f) => f.code === 'protected-base-drift'));
    assert.ok(result.findings.some((f) => f.code === 'hidden-operation-discriminator'));
  });
  it('derives addition/removal reports from schema literals independently of actions', () => {
    const before = definition(),
      after = definition({ literals: [...modes, 'reranked'] });
    const expected = [{ name: before.name, field: 'mode', role: 'read-strategy', added: ['reranked'], removed: [] }];
    assert.deepEqual(compareToolRegistries([before], [after]).closedSelectorChanges, expected);
    assert.deepEqual(compareToolRegistries([before], [after]).resourceActionChanges, []);
    const snapshot = (tool) =>
      createMcpSurfaceSnapshot([{ ...tool, serverFamily: 'memory' }], {
        protectedBaseSha: 'a'.repeat(40),
        implementationCatalog,
      });
    assert.deepEqual(compareMcpSurfaceRegistry(snapshot(before), snapshot(after)).closedSelectorChanges, expected);
    assert.deepEqual(compareMcpSurfaceRegistry(snapshot(after), snapshot(before)).closedSelectorChanges, [
      { ...expected[0], added: [], removed: ['reranked'] },
    ]);
  });
});
