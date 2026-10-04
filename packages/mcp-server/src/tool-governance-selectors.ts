import { classifyStringDomain } from './tool-governance-string-domain.js';
import type {
  DerivedMcpClosedSelector,
  GovernanceFinding,
  McpClosedSelector,
  McpToolDefinition,
  ResolvedEvidenceCatalog,
  ToolRegistryDelta,
} from './tool-governance-types.js';

const RESERVED_ACTION_FIELDS = new Set(['action', 'operation', 'decision']);

function isCanonicalRead(definition: McpToolDefinition): boolean {
  return (
    definition.policy.activeState === 'canonical' &&
    definition.operation.kind === 'single' &&
    definition.operation.action === 'read' &&
    definition.operation.boundary.risk.level === 'read'
  );
}

function properties(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null) return {};
  const value = (schema as Record<string, unknown>).properties;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Literal inventories are always projected from the normalized executable schema. */
export function deriveClosedSelectors(
  definition: McpToolDefinition,
  schema: unknown,
): readonly DerivedMcpClosedSelector[] {
  if (definition.operation.kind !== 'single') return [];
  const fields = properties(schema);
  return (definition.operation.closedSelectors ?? [])
    .map((selector) => {
      const domain = classifyStringDomain(fields[selector.field], schema);
      return { ...selector, literals: domain.kind === 'finite' ? domain.literals : [] };
    })
    .sort((a, b) => `${a.field}:${a.role}`.localeCompare(`${b.field}:${b.role}`));
}

export function validateClosedSelectors(
  definition: McpToolDefinition,
  schema: unknown,
  evidence: ResolvedEvidenceCatalog,
): { fields: ReadonlySet<string>; findings: readonly GovernanceFinding[] } {
  // Runtime validation also rejects malformed declarations supplied outside TypeScript.
  const declarations =
    (definition.operation as { closedSelectors?: readonly McpClosedSelector[] }).closedSelectors ?? [];
  const fields = new Set<string>();
  const findings: GovernanceFinding[] = [];
  const seen = new Set<string>();
  for (const selector of declarations) {
    const validShape =
      selector !== null &&
      typeof selector === 'object' &&
      typeof selector.field === 'string' &&
      Object.keys(selector).every((key) => ['field', 'role', 'evidenceRef'].includes(key));
    const domain = validShape ? classifyStringDomain(properties(schema)[selector.field], schema) : undefined;
    const claims = validShape ? (evidence.selectorClaims?.get(selector.evidenceRef) ?? []) : [];
    const bound = claims.some(
      (claim) =>
        claim.decision === 'accepted' &&
        /^sha256:[a-f0-9]{64}$/.test(claim.sourceDigest) &&
        claim.ref === selector.evidenceRef &&
        claim.subject.toolName === definition.name &&
        claim.subject.resourceFamily === definition.policy.resourceFamily &&
        claim.subject.field === selector.field &&
        claim.subject.role === selector.role,
    );
    const valid =
      validShape &&
      isCanonicalRead(definition) &&
      selector.role === 'read-strategy' &&
      !RESERVED_ACTION_FIELDS.has(selector.field) &&
      !seen.has(selector.field) &&
      Object.hasOwn(properties(schema), selector.field) &&
      domain?.kind === 'finite' &&
      domain.literals.length > 0 &&
      evidence.existingRefs.has(selector.evidenceRef) &&
      bound;
    if (validShape) seen.add(selector.field);
    if (!valid) {
      findings.push({
        code: 'invalid-closed-selector',
        toolName: definition.name,
        message: `Invalid or unbound canonical read-strategy selector: ${validShape ? selector.field : '<malformed>'}`,
      });
      continue;
    }
    fields.add(selector.field);
  }
  // Any invalid declaration denies the entire selector exemption, including duplicates.
  return { fields: findings.length > 0 ? new Set() : fields, findings };
}

export function compareClosedSelectors(
  before: readonly { name: string; closedSelectors?: readonly DerivedMcpClosedSelector[] }[],
  after: readonly { name: string; closedSelectors?: readonly DerivedMcpClosedSelector[] }[],
): ToolRegistryDelta['closedSelectorChanges'] {
  const inventory = (tools: typeof before) =>
    new Map(
      tools.flatMap((tool) =>
        (tool.closedSelectors ?? []).map(
          (selector) => [`${tool.name}:${selector.field}:${selector.role}`, { name: tool.name, ...selector }] as const,
        ),
      ),
    );
  const previous = inventory(before),
    next = inventory(after);
  return [...new Set([...previous.keys(), ...next.keys()])].sort().flatMap((key) => {
    const oldValue = previous.get(key),
      newValue = next.get(key);
    const added = (newValue?.literals ?? []).filter((value) => !oldValue?.literals.includes(value));
    const removed = (oldValue?.literals ?? []).filter((value) => !newValue?.literals.includes(value));
    const subject = newValue ?? oldValue;
    return subject && (added.length || removed.length)
      ? [{ name: subject.name, field: subject.field, role: subject.role, added, removed }]
      : [];
  });
}
