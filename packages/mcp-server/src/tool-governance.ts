import { type ZodTypeAny, z } from 'zod';
import {
  implementationBindingBrand,
  type McpImplementationBinding,
  type McpMigrationCandidateInput,
  type McpOperationContract,
  type McpRisk,
  type McpToolDefinition,
  type McpToolDefinitionInput,
} from './tool-governance-types.js';

export { compareToolRegistries, deriveProfileNames } from './tool-governance-registry.js';
export type {
  EvidenceRef,
  GovernanceFinding,
  McpActionBoundary,
  McpAuthorizationPath,
  McpImplementationBinding,
  McpMigrationCandidateInput,
  McpOperationContract,
  McpRisk,
  McpRuntimeProfile,
  McpStandaloneReason,
  McpToolDefinition,
  McpToolDefinitionInput,
  McpToolPolicy,
  NonEmptyReadonlyArray,
  ProtectedToolSnapshot,
  ResolvedAdmissionClaim,
  ResolvedEvidenceCatalog,
  ResolvedImplementationCatalog,
  ToolRegistryDelta,
} from './tool-governance-types.js';
export { validateToolGovernance } from './tool-governance-validation.js';

export function bindMcpImplementation(
  ref: McpImplementationBinding['ref'],
  run: McpImplementationBinding['run'],
): McpImplementationBinding {
  const match = /^module:(.+)#([^#]+)$/.exec(ref);
  if (!match) throw new Error(`Invalid MCP implementation binding: ${ref}`);
  return { ref, run, [implementationBindingBrand]: true };
}

function operationActions(operation: McpOperationContract): readonly string[] {
  const actions =
    operation.kind === 'single' ? [operation.action] : operation.variants.map((variant) => variant.action);
  for (const action of actions) {
    if (!action.trim()) throw new Error('MCP operation action cannot be empty');
  }
  if (new Set(actions).size !== actions.length) {
    throw new Error(`Duplicate action in MCP operation contract: ${actions.join(', ')}`);
  }
  return [...actions].sort();
}

function isZodType(value: unknown): value is ZodTypeAny {
  return typeof value === 'object' && value !== null && '_def' in value && 'safeParseAsync' in value;
}

function deriveInputSchema(operation: McpOperationContract): Record<string, unknown> {
  if (operation.kind === 'single') return operation.inputSchema;
  const actions = operationActions(operation);
  const shape: Record<string, unknown> = {
    [operation.discriminator]: z.enum(actions as [string, ...string[]]),
  };
  const keys = new Set(operation.variants.flatMap((variant) => Object.keys(variant.inputSchema)));
  keys.delete(operation.discriminator);
  for (const key of [...keys].sort()) {
    const values = operation.variants.flatMap((variant) =>
      key in variant.inputSchema ? [variant.inputSchema[key]] : [],
    );
    const unique = [...new Set(values)];
    let value: unknown = unique[0];
    if (unique.length > 1) {
      if (!unique.every(isZodType)) {
        throw new Error(`Discriminated operation field "${key}" must use compatible Zod schemas`);
      }
      value = z.union(unique as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    }
    if (values.length !== operation.variants.length && isZodType(value)) value = value.optional();
    shape[key] = value;
  }
  return shape;
}

function riskRank(level: McpRisk['level']): number {
  return { read: 0, write: 1, destructive: 2 }[level];
}

function deriveEffectiveRisk(operation: McpOperationContract): McpRisk {
  const boundaries = operation.kind === 'single' ? [operation.boundary] : operation.variants.map((v) => v.boundary);
  const level = boundaries.reduce<McpRisk['level']>(
    (current, boundary) => (riskRank(boundary.risk.level) > riskRank(current) ? boundary.risk.level : current),
    'read',
  );
  return { level, openWorld: boundaries.some((boundary) => boundary.risk.openWorld) };
}

export function deriveSdkAnnotations(operation: McpOperationContract): McpToolDefinition['annotations'] {
  const risk = deriveEffectiveRisk(operation);
  return {
    readOnlyHint: risk.level === 'read',
    destructiveHint: risk.level === 'destructive',
    openWorldHint: risk.openWorld,
  };
}

export function defineMcpTool(input: McpToolDefinitionInput): McpToolDefinition {
  const actionInventory = operationActions(input.operation);
  return Object.freeze({
    ...input,
    inputSchema: deriveInputSchema(input.operation),
    handler: input.implementation.run,
    actionInventory,
    effectiveRisk: deriveEffectiveRisk(input.operation),
    annotations: deriveSdkAnnotations(input.operation),
  });
}

export function defineMigrationCandidateMcpTool(input: McpMigrationCandidateInput): McpToolDefinition {
  const { governance } = input;
  return defineMcpTool({
    name: input.name,
    description: input.description,
    operation: {
      kind: 'single',
      action: governance.action,
      inputSchema: input.inputSchema,
      boundary: governance.boundary,
      ...(governance.customDiscriminators ? { customDiscriminators: governance.customDiscriminators } : {}),
    },
    implementation: bindMcpImplementation(governance.implementationRef, input.handler),
    policy: {
      resourceFamily: governance.resourceFamily,
      exposureTier: {
        current: 'eager-core',
        ...(governance.targetExposure ? { target: governance.targetExposure } : {}),
        evidenceRef: governance.sourceRef,
      },
      runtimeProfiles: governance.runtimeProfiles,
      owner: {
        domainCell: 'architecture-cell:mcp-surface-governance',
        surface: 'mcp-surface-governance',
      },
      standaloneReason: {
        disposition: 'consolidation-candidate',
        kind: 'same-resource-lifecycle',
        evidenceRef: governance.sourceRef,
      },
      activeState: 'migration-candidate',
      cognitiveEntryPoints: [{ kind: 'tool-description', ref: governance.sourceRef }],
      verification: [{ kind: 'test', ref: governance.verificationRef }],
    },
  });
}
