import { createHash } from 'node:crypto';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { getEncoding } from 'js-tiktoken';
import { z } from 'zod';
import { jsonSchemaToZod } from './json-schema-to-zod.js';
import type {
  McpRuntimeProfile,
  McpToolDefinition,
  ResolvedImplementationCatalog,
  ToolRegistryDelta,
} from './tool-governance-types.js';

export type McpServerFamily = 'collab' | 'memory' | 'signals' | 'limb' | 'audio' | 'finance';

export type FamilyToolDefinition = McpToolDefinition & { serverFamily: McpServerFamily };

export type McpSurfaceSnapshotEntry = {
  name: string;
  serverFamily: McpServerFamily;
  resourceFamily: string;
  actions: readonly string[];
  activeState: McpToolDefinition['policy']['activeState'];
  description: string;
  descriptionDigest: string;
  descriptionCharacters: number;
  descriptionTokensCl100kBase: number;
  inputSchema: unknown;
  inputSchemaDigest: string;
  annotations: McpToolDefinition['annotations'];
  runtimeProfiles: readonly McpRuntimeProfile[];
  implementationRef: string;
  protectedImplementationDigest: string;
};

export type McpSurfaceSnapshot = {
  schemaVersion: 1;
  protectedBaseSha: string;
  comparisonEncoding: 'cl100k_base';
  tools: readonly McpSurfaceSnapshotEntry[];
};

export type ProtocolParityFinding = {
  name: string;
  field:
    | 'missing'
    | 'serverFamily'
    | 'description'
    | 'inputSchema'
    | 'annotations'
    | 'runtimeProfiles'
    | 'implementationRef';
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')}`;
}

export function normalizeMcpInputSchema(schema: Record<string, unknown>): unknown {
  const zodSchema =
    typeof schema.type === 'string' && typeof schema.properties === 'object' && schema.properties !== null
      ? jsonSchemaToZod(schema)
      : z.object(schema as z.ZodRawShape);
  return stable(toJsonSchemaCompat(zodSchema, { strictUnions: true, pipeStrategy: 'input' }));
}

export function digestMcpInputSchema(schema: Record<string, unknown>): string {
  return digest(normalizeMcpInputSchema(schema));
}

export function normalizeMcpAnnotations(
  annotations: McpToolDefinition['annotations'],
): McpToolDefinition['annotations'] {
  return stable(annotations) as McpToolDefinition['annotations'];
}

export function createMcpSurfaceSnapshot(
  definitions: readonly FamilyToolDefinition[],
  options: {
    protectedBaseSha: string;
    implementationCatalog: ResolvedImplementationCatalog;
  },
): McpSurfaceSnapshot {
  const encoding = getEncoding('cl100k_base');
  const tools = [...definitions]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((definition): McpSurfaceSnapshotEntry => {
      const implementation = options.implementationCatalog.get(definition.implementation.ref);
      if (!implementation) throw new Error(`Missing implementation evidence for ${definition.name}`);
      const inputSchema = normalizeMcpInputSchema(definition.inputSchema);
      return {
        name: definition.name,
        serverFamily: definition.serverFamily,
        resourceFamily: definition.policy.resourceFamily,
        actions: [...definition.actionInventory].sort(),
        activeState: definition.policy.activeState,
        description: definition.description,
        descriptionDigest: digest(definition.description),
        descriptionCharacters: definition.description.length,
        descriptionTokensCl100kBase: encoding.encode(definition.description).length,
        inputSchema,
        inputSchemaDigest: digestMcpInputSchema(definition.inputSchema),
        annotations: normalizeMcpAnnotations(definition.annotations),
        runtimeProfiles: [...definition.policy.runtimeProfiles].sort(),
        implementationRef: definition.implementation.ref,
        protectedImplementationDigest: implementation.moduleDigest,
      };
    });
  return {
    schemaVersion: 1,
    protectedBaseSha: options.protectedBaseSha,
    comparisonEncoding: 'cl100k_base',
    tools,
  };
}

function setDelta(before: ReadonlySet<string>, after: ReadonlySet<string>): readonly string[] {
  return [...after].filter((value) => !before.has(value)).sort();
}

export function compareMcpSurfaceRegistry(before: McpSurfaceSnapshot, after: McpSurfaceSnapshot): ToolRegistryDelta {
  const beforeByName = new Map(before.tools.map((tool) => [tool.name, tool]));
  const afterByName = new Map(after.tools.map((tool) => [tool.name, tool]));
  const beforeNames = new Set(beforeByName.keys());
  const afterNames = new Set(afterByName.keys());
  const families = new Set([
    ...before.tools.map((tool) => tool.resourceFamily),
    ...after.tools.map((tool) => tool.resourceFamily),
  ]);
  const resourceActionChanges = [...families].sort().flatMap((resourceFamily) => {
    const beforeActions = new Set(
      before.tools.filter((tool) => tool.resourceFamily === resourceFamily).flatMap((tool) => tool.actions),
    );
    const afterActions = new Set(
      after.tools.filter((tool) => tool.resourceFamily === resourceFamily).flatMap((tool) => tool.actions),
    );
    const added = setDelta(beforeActions, afterActions);
    const removed = setDelta(afterActions, beforeActions);
    return added.length || removed.length ? [{ resourceFamily, added, removed }] : [];
  });
  const profileChanges = [...new Set([...beforeNames, ...afterNames])].sort().flatMap((name) => {
    const beforeProfiles = new Set(beforeByName.get(name)?.runtimeProfiles ?? []);
    const afterProfiles = new Set(afterByName.get(name)?.runtimeProfiles ?? []);
    const added = setDelta(beforeProfiles, afterProfiles);
    const removed = setDelta(afterProfiles, beforeProfiles);
    return added.length || removed.length ? [{ name, added, removed }] : [];
  });
  return {
    addedNames: setDelta(beforeNames, afterNames),
    removedNames: setDelta(afterNames, beforeNames),
    resourceActionChanges,
    profileChanges,
  };
}

function parityFields(
  expected: McpSurfaceSnapshotEntry,
  actual: McpSurfaceSnapshotEntry,
): ProtocolParityFinding['field'][] {
  const fields: ProtocolParityFinding['field'][] = [];
  if (expected.serverFamily !== actual.serverFamily) fields.push('serverFamily');
  if (expected.description !== actual.description) fields.push('description');
  if (JSON.stringify(expected.inputSchema) !== JSON.stringify(actual.inputSchema)) fields.push('inputSchema');
  if (JSON.stringify(expected.annotations) !== JSON.stringify(actual.annotations)) fields.push('annotations');
  if (JSON.stringify(expected.runtimeProfiles) !== JSON.stringify(actual.runtimeProfiles))
    fields.push('runtimeProfiles');
  if (expected.implementationRef !== actual.implementationRef) fields.push('implementationRef');
  return fields;
}

export function compareMcpSurfaceProtocol(
  expected: McpSurfaceSnapshot,
  actual: McpSurfaceSnapshot,
): readonly ProtocolParityFinding[] {
  const expectedByName = new Map(expected.tools.map((tool) => [tool.name, tool]));
  const actualByName = new Map(actual.tools.map((tool) => [tool.name, tool]));
  const findings: ProtocolParityFinding[] = [];
  for (const name of [...new Set([...expectedByName.keys(), ...actualByName.keys()])].sort()) {
    const before = expectedByName.get(name);
    const after = actualByName.get(name);
    if (!before || !after) findings.push({ name, field: 'missing' });
    else findings.push(...parityFields(before, after).map((field) => ({ name, field })));
  }
  return findings;
}

export function serializeMcpSurfaceSnapshot(snapshot: McpSurfaceSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
