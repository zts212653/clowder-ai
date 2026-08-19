import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  bindMcpImplementation,
  compareToolRegistries,
  defineMcpTool,
  deriveProfileNames,
  type EvidenceRef,
  type McpActionBoundary,
  type McpOperationContract,
  type McpStandaloneReason,
  type McpToolDefinition,
  type ProtectedToolSnapshot,
  type ResolvedEvidenceCatalog,
  type ResolvedImplementationCatalog,
  validateToolGovernance,
} from '../src/tool-governance.js';
import { digestMcpInputSchema, normalizeMcpInputSchema } from '../src/tool-governance-snapshot.js';

const testRef = 'test:packages/mcp-server/test/tool-governance.test.ts' as const;
const architectureRef = 'architecture-cell:mcp-surface-governance' as const;

const readBoundary: McpActionBoundary = {
  authorizationPaths: [
    {
      principal: 'invocation-cat',
      credentialSource: 'invocation-record',
      scope: { kind: 'thread', threadRef: 'current-thread' },
      enforcementRef: testRef,
    },
  ],
  risk: { level: 'read', openWorld: false },
};

const writeBoundary: McpActionBoundary = {
  authorizationPaths: readBoundary.authorizationPaths,
  risk: { level: 'write', openWorld: false },
};

const run = async (_args: never): Promise<unknown> => ({ ok: true });

function operation(action = 'read', boundary: McpActionBoundary = readBoundary): McpOperationContract {
  return {
    kind: 'single',
    action,
    inputSchema: { subject: z.string() },
    boundary,
  };
}

function makeDefinition(
  options: {
    name?: string;
    resourceFamily?: string;
    standaloneReason?: McpStandaloneReason;
    operation?: McpOperationContract;
    activeState?: 'canonical' | 'migration-candidate';
    runtimeProfiles?: readonly ['full', ...Array<'full' | 'readonly' | 'agent-key'>];
  } = {},
): McpToolDefinition {
  const name = options.name ?? 'cat_cafe_subject_read';
  return defineMcpTool({
    name,
    description: `Operate ${name}`,
    operation: options.operation ?? operation(),
    implementation: bindMcpImplementation('module:./fixtures/mcp-governance.js#run', run),
    policy: {
      resourceFamily: options.resourceFamily ?? 'subject',
      exposureTier: { current: 'eager-core', evidenceRef: testRef },
      runtimeProfiles: options.runtimeProfiles ?? ['full', 'readonly'],
      owner: { domainCell: architectureRef, surface: 'mcp-surface-governance' },
      standaloneReason: options.standaloneReason ?? {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: testRef,
      },
      activeState: options.activeState ?? 'canonical',
      cognitiveEntryPoints: [{ kind: 'tool-description', ref: testRef }],
      verification: [{ kind: 'test', ref: testRef }],
    },
  });
}

function evidenceCatalog(
  claims: ResolvedEvidenceCatalog['admissionClaims'] = new Map(),
  extraRefs: readonly EvidenceRef[] = [],
): ResolvedEvidenceCatalog {
  return {
    existingRefs: new Set<EvidenceRef>([testRef, architectureRef, ...extraRefs]),
    admissionClaims: claims,
  };
}

const implementationCatalog: ResolvedImplementationCatalog = new Map([
  [
    'module:./fixtures/mcp-governance.js#run',
    { moduleDigest: 'sha256:fixture', exportName: 'run', compilerSymbolId: 'fixture#run' },
  ],
]);

function validate(
  definitions: readonly McpToolDefinition[],
  options: {
    evidence?: ResolvedEvidenceCatalog;
    protectedBase?: ReadonlyMap<string, ProtectedToolSnapshot>;
  } = {},
) {
  return validateToolGovernance(definitions, {
    evidenceCatalog: options.evidence ?? evidenceCatalog(),
    implementationCatalog,
    protectedBase: options.protectedBase ?? new Map(),
  });
}

function schemaDigest(definition: McpToolDefinition): string {
  return digestMcpInputSchema(definition.inputSchema);
}

function protectedSnapshot(definition: McpToolDefinition) {
  return {
    name: definition.name,
    resourceFamily: definition.policy.resourceFamily,
    actions: definition.actionInventory,
    risk: definition.effectiveRisk,
    inputSchemaDigest: schemaDigest(definition),
  };
}

describe('F286 MCP governance contract', () => {
  it('derives executable schema, action inventory, risk, and SDK annotations from one operation', () => {
    const schema = { subject: z.string(), depth: z.number().optional() };
    const definition = makeDefinition({
      operation: { kind: 'single', action: 'inspect', inputSchema: schema, boundary: readBoundary },
    });

    assert.equal(definition.inputSchema, schema);
    assert.deepEqual(definition.actionInventory, ['inspect']);
    assert.deepEqual(definition.effectiveRisk, { level: 'read', openWorld: false });
    assert.deepEqual(definition.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('rejects duplicate action literals in a discriminated lifecycle', () => {
    assert.throws(
      () =>
        makeDefinition({
          operation: {
            kind: 'discriminated',
            discriminator: 'action',
            variants: [
              { action: 'advance', inputSchema: { value: z.string() }, boundary: writeBoundary },
              { action: 'advance', inputSchema: { note: z.string() }, boundary: writeBoundary },
            ],
          },
        }),
      /duplicate action/i,
    );
  });

  it('rejects a canonical single operation that hides a closed action enum', () => {
    const definition = makeDefinition({
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: { action: z.enum(['next', 'skip', 'exit']) },
        boundary: writeBoundary,
      },
    });

    const result = validate([definition]);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => /closed.*action|action.*literal/i.test(finding.message)));
  });

  it('rejects a canonical single operation that hides action literals inside allOf', () => {
    const definition = makeDefinition({
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: {
          action: z.intersection(z.enum(['next', 'skip', 'exit']), z.string()),
        },
        boundary: writeBoundary,
      },
    });

    const result = validate([definition]);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => /closed.*action|action.*literal/i.test(finding.message)));
  });

  it('rejects a canonical single operation whose finite actions are nullable and optional', () => {
    const definition = makeDefinition({
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: {
          action: z.enum(['next', 'skip', 'exit']).nullable().optional(),
        },
        boundary: writeBoundary,
      },
    });

    const result = validate([definition]);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => /closed.*action|action.*literal/i.test(finding.message)));
  });

  it('rejects a canonical single operation whose finite actions include an undefined alternative', () => {
    const definition = makeDefinition({
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: {
          action: z.union([z.enum(['next', 'skip', 'exit']), z.undefined()]).optional(),
        },
        boundary: writeBoundary,
      },
    });

    const result = validate([definition]);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => /closed.*action|action.*literal/i.test(finding.message)));
  });

  it('rejects a canonical single operation whose reused finite action schema normalizes to a local ref', () => {
    const sharedAction = z.enum(['next', 'skip', 'exit']);
    const definition = makeDefinition({
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: {
          reason: sharedAction,
          action: sharedAction,
        },
        boundary: writeBoundary,
      },
    });

    const normalized = normalizeMcpInputSchema(definition.inputSchema) as {
      properties: Record<string, unknown>;
    };
    assert.deepEqual(normalized.properties.action, { $ref: '#/properties/reason' });
    const result = validate([definition]);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.code === 'hidden-operation-discriminator'));
  });

  it('rejects a reused finite action schema whose local ref target crosses an array path', () => {
    const sharedAction = z.enum(['next', 'skip', 'exit']);
    const definition = makeDefinition({
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: {
          source: z.union([z.string(), sharedAction]),
          action: sharedAction,
        },
        boundary: writeBoundary,
      },
    });

    const normalized = normalizeMcpInputSchema(definition.inputSchema) as {
      properties: Record<string, unknown>;
    };
    assert.deepEqual(normalized.properties.action, { $ref: '#/properties/source/anyOf/1' });
    const result = validate([definition]);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.code === 'hidden-operation-discriminator'));
  });

  it('does not treat a reused open string schema emitted as a local ref as closed', () => {
    const sharedAction = z.string();
    const definition = makeDefinition({
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: {
          reason: sharedAction,
          action: sharedAction,
        },
        boundary: writeBoundary,
      },
    });

    const result = validate([definition]);
    assert.equal(
      result.findings.some((finding) => finding.code === 'hidden-operation-discriminator'),
      false,
    );
  });

  it('does not treat a genuinely string-open action union as a closed discriminator', () => {
    const definition = makeDefinition({
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: {
          action: z.union([z.enum(['next', 'skip', 'exit']), z.string()]),
        },
        boundary: writeBoundary,
      },
    });

    const result = validate([definition]);
    assert.equal(
      result.findings.some((finding) => finding.code === 'hidden-operation-discriminator'),
      false,
    );
  });

  it('accepts an unchanged protected migration candidate whose legacy finite actions are nullable', () => {
    const definition = makeDefinition({
      activeState: 'migration-candidate',
      standaloneReason: {
        disposition: 'consolidation-candidate',
        kind: 'same-resource-lifecycle',
        evidenceRef: testRef,
      },
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: {
          action: z.enum(['next', 'skip', 'exit']).nullable().optional(),
        },
        boundary: writeBoundary,
      },
    });
    const protectedBase = new Map([[definition.name, protectedSnapshot(definition)]]);

    assert.deepEqual(validate([definition], { protectedBase }), { ok: true, findings: [] });
  });

  it('accepts an unchanged protected migration candidate whose reused finite action schema is a local ref', () => {
    const sharedAction = z.enum(['next', 'skip', 'exit']);
    const definition = makeDefinition({
      activeState: 'migration-candidate',
      standaloneReason: {
        disposition: 'consolidation-candidate',
        kind: 'same-resource-lifecycle',
        evidenceRef: testRef,
      },
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: {
          reason: sharedAction,
          action: sharedAction,
        },
        boundary: writeBoundary,
      },
    });
    const protectedBase = new Map([[definition.name, protectedSnapshot(definition)]]);

    assert.deepEqual(validate([definition], { protectedBase }), { ok: true, findings: [] });
  });

  it('accepts an unchanged protected migration candidate whose legacy action enum is inside allOf', () => {
    const definition = makeDefinition({
      activeState: 'migration-candidate',
      standaloneReason: {
        disposition: 'consolidation-candidate',
        kind: 'same-resource-lifecycle',
        evidenceRef: testRef,
      },
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: {
          action: z.intersection(z.enum(['next', 'skip', 'exit']), z.string()),
        },
        boundary: writeBoundary,
      },
    });
    const protectedBase = new Map([[definition.name, protectedSnapshot(definition)]]);

    assert.deepEqual(validate([definition], { protectedBase }), { ok: true, findings: [] });
  });

  it('accepts an unchanged protected migration candidate with a legacy action enum', () => {
    const definition = makeDefinition({
      activeState: 'migration-candidate',
      standaloneReason: {
        disposition: 'consolidation-candidate',
        kind: 'same-resource-lifecycle',
        evidenceRef: testRef,
      },
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: { action: z.enum(['next', 'skip', 'exit']) },
        boundary: writeBoundary,
      },
    });
    const protectedBase = new Map([[definition.name, protectedSnapshot(definition)]]);

    assert.deepEqual(validate([definition], { protectedBase }), { ok: true, findings: [] });
  });

  it('rejects adding one hidden action literal to a protected migration candidate', () => {
    const original = makeDefinition({
      activeState: 'migration-candidate',
      standaloneReason: {
        disposition: 'consolidation-candidate',
        kind: 'same-resource-lifecycle',
        evidenceRef: testRef,
      },
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: { action: z.enum(['next', 'skip', 'exit']) },
        boundary: writeBoundary,
      },
    });
    const changed = makeDefinition({
      activeState: 'migration-candidate',
      standaloneReason: original.policy.standaloneReason,
      operation: {
        kind: 'single',
        action: 'command',
        inputSchema: { action: z.enum(['next', 'skip', 'exit', 'restart']) },
        boundary: writeBoundary,
      },
    });
    const protectedBase = new Map([[original.name, protectedSnapshot(original)]]);

    const result = validate([changed], { protectedBase });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.code === 'protected-base-drift'));
    assert.ok(result.findings.some((finding) => /closed.*action|action.*literal/i.test(finding.message)));
  });

  it('audits explicitly declared custom discriminators on single operations', () => {
    const operationWithCustomDiscriminator = {
      kind: 'single',
      action: 'command',
      inputSchema: { transition: z.union([z.literal('start'), z.literal('stop')]) },
      boundary: writeBoundary,
      customDiscriminators: ['transition'],
    } satisfies McpOperationContract;
    const definition = makeDefinition({ operation: operationWithCustomDiscriminator });

    const result = validate([definition]);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.message.includes('transition')));
  });

  it('rejects a canonical lifecycle whose variants cross risk boundaries', () => {
    const definition = makeDefinition({
      operation: {
        kind: 'discriminated',
        discriminator: 'action',
        variants: [
          { action: 'read', inputSchema: { id: z.string() }, boundary: readBoundary },
          { action: 'update', inputSchema: { id: z.string(), value: z.string() }, boundary: writeBoundary },
        ],
      },
    });

    const result = validate([definition]);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.code === 'mixed-action-boundary'));
  });

  it('rejects duplicate semantic names before registration', () => {
    const first = makeDefinition();
    const second = makeDefinition();
    const result = validate([first, second]);

    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.code === 'duplicate-tool-name'));
  });

  it('rejects an added top-level name in an existing family when it is only a consolidation candidate', () => {
    const definition = makeDefinition({
      name: 'cat_cafe_subject_update',
      standaloneReason: {
        disposition: 'consolidation-candidate',
        kind: 'same-resource-lifecycle',
        evidenceRef: testRef,
      },
      operation: operation('update', writeBoundary),
    });
    const protectedBase = new Map([
      [
        'cat_cafe_subject_read',
        {
          name: 'cat_cafe_subject_read',
          resourceFamily: 'subject',
          actions: ['read'],
          risk: { level: 'read' as const, openWorld: false },
        },
      ],
    ]);

    const result = validate([definition], { protectedBase });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.code === 'unjustified-family-growth'));
  });

  it('admits an independent boundary only when evidence is bound to the exact subject', () => {
    const admissionRef = 'adr:44' as const;
    const definition = makeDefinition({
      name: 'cat_cafe_subject_update',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'authority-boundary',
        admissionRef,
      },
      operation: operation('update', writeBoundary),
    });
    const protectedBase = new Map([
      [
        'cat_cafe_subject_read',
        {
          name: 'cat_cafe_subject_read',
          resourceFamily: 'subject',
          actions: ['read'],
          risk: { level: 'read' as const, openWorld: false },
        },
      ],
    ]);
    const wrongClaims = new Map([
      [
        admissionRef,
        [
          {
            ref: admissionRef,
            subject: {
              toolName: 'cat_cafe_another_update',
              resourceFamily: 'subject',
              boundaryKind: 'authority-boundary' as const,
            },
            decision: 'accepted' as const,
            sourceDigest: 'sha256:wrong-subject',
          },
        ] as const,
      ],
    ]);

    const rejected = validate([definition], {
      protectedBase,
      evidence: evidenceCatalog(wrongClaims, [admissionRef]),
    });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.findings.some((finding) => finding.code === 'admission-subject-mismatch'));

    const exactClaims = new Map([
      [
        admissionRef,
        [
          {
            ref: admissionRef,
            subject: {
              toolName: definition.name,
              resourceFamily: definition.policy.resourceFamily,
              boundaryKind: 'authority-boundary' as const,
            },
            decision: 'accepted' as const,
            sourceDigest: 'sha256:exact-subject',
          },
        ] as const,
      ],
    ]);
    const accepted = validate([definition], {
      protectedBase,
      evidence: evidenceCatalog(exactClaims, [admissionRef]),
    });
    assert.deepEqual(accepted.findings, []);
    assert.equal(accepted.ok, true);
  });

  it('fails closed when a policy reference or implementation binding is unresolved', () => {
    const definition = makeDefinition();
    const result = validateToolGovernance([definition], {
      evidenceCatalog: { existingRefs: new Set(), admissionClaims: new Map() },
      implementationCatalog: new Map(),
      protectedBase: new Map(),
    });

    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.code === 'unresolved-evidence-ref'));
    assert.ok(result.findings.some((finding) => finding.code === 'unresolved-implementation-binding'));
  });

  it('derives stable profile membership and per-resource action deltas', () => {
    const before = makeDefinition({ runtimeProfiles: ['full'] });
    const after = makeDefinition({
      runtimeProfiles: ['full', 'agent-key'],
      operation: {
        kind: 'discriminated',
        discriminator: 'action',
        variants: [
          { action: 'read', inputSchema: { id: z.string() }, boundary: readBoundary },
          { action: 'inspect', inputSchema: { id: z.string() }, boundary: readBoundary },
        ],
      },
    });

    assert.deepEqual(deriveProfileNames([after], 'agent-key'), [after.name]);
    const delta = compareToolRegistries([before], [after]);
    assert.deepEqual(delta.profileChanges, [{ name: after.name, added: ['agent-key'], removed: [] }]);
    assert.deepEqual(delta.resourceActionChanges, [{ resourceFamily: 'subject', added: ['inspect'], removed: [] }]);
  });
});
