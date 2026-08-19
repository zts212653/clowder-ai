import { digestMcpInputSchema, normalizeMcpInputSchema } from './tool-governance-snapshot.js';
import type {
  EvidenceRef,
  GovernanceFinding,
  McpToolDefinition,
  ProtectedToolSnapshot,
  ResolvedEvidenceCatalog,
  ResolvedImplementationCatalog,
} from './tool-governance-types.js';

type ValidationOptions = {
  evidenceCatalog: ResolvedEvidenceCatalog;
  implementationCatalog: ResolvedImplementationCatalog;
  protectedBase: ReadonlyMap<string, ProtectedToolSnapshot>;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function referencedEvidence(definition: McpToolDefinition): readonly EvidenceRef[] {
  const boundaries =
    definition.operation.kind === 'single'
      ? [definition.operation.boundary]
      : definition.operation.variants.map((variant) => variant.boundary);
  const reasonRef =
    definition.policy.standaloneReason.disposition === 'accepted-boundary'
      ? definition.policy.standaloneReason.admissionRef
      : definition.policy.standaloneReason.evidenceRef;
  return [
    ...boundaries.flatMap((boundary) => boundary.authorizationPaths.map((path) => path.enforcementRef)),
    definition.policy.exposureTier.evidenceRef,
    definition.policy.owner.domainCell,
    reasonRef,
    ...definition.policy.cognitiveEntryPoints.map((entry) => entry.ref),
    ...definition.policy.verification.map((entry) => entry.ref),
  ];
}

function matchesProtectedBase(definition: McpToolDefinition, snapshot: ProtectedToolSnapshot): boolean {
  return (
    definition.policy.resourceFamily === snapshot.resourceFamily &&
    stable(definition.actionInventory) === stable([...snapshot.actions].sort()) &&
    stable(definition.effectiveRisk) === stable(snapshot.risk) &&
    digestMcpInputSchema(definition.inputSchema) === snapshot.inputSchemaDigest
  );
}

const DEFAULT_OPERATION_DISCRIMINATORS = ['action', 'operation', 'decision', 'mode'] as const;

type StringDomain = { kind: 'finite'; literals: readonly string[] } | { kind: 'neutral' } | { kind: 'open' };

const NEUTRAL_STRING_DOMAIN = { kind: 'neutral' } as const;
const OPEN_STRING_DOMAIN = { kind: 'open' } as const;

function finiteStringDomain(literals: readonly string[]): StringDomain {
  return { kind: 'finite', literals: [...new Set(literals)].sort() };
}

function unionStringDomains(domains: readonly StringDomain[]): StringDomain {
  if (domains.some((domain) => domain.kind === 'open')) return OPEN_STRING_DOMAIN;
  const literals = domains.flatMap((domain) => (domain.kind === 'finite' ? domain.literals : []));
  return literals.length > 0 ? finiteStringDomain(literals) : NEUTRAL_STRING_DOMAIN;
}

function intersectStringDomains(domains: readonly StringDomain[]): StringDomain {
  const literals = domains.flatMap((domain) => (domain.kind === 'finite' ? domain.literals : []));
  if (literals.length > 0) return finiteStringDomain(literals);
  return domains.some((domain) => domain.kind === 'neutral') ? NEUTRAL_STRING_DOMAIN : OPEN_STRING_DOMAIN;
}

function isEmptySchema(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema) && Object.keys(schema).length === 0;
}

function directStringDomain(record: Readonly<Record<string, unknown>>): StringDomain {
  if (Object.hasOwn(record, 'const')) {
    return typeof record.const === 'string' ? finiteStringDomain([record.const]) : NEUTRAL_STRING_DOMAIN;
  }
  if (Array.isArray(record.enum)) {
    const literals = record.enum.filter((value): value is string => typeof value === 'string');
    return literals.length > 0 ? finiteStringDomain(literals) : NEUTRAL_STRING_DOMAIN;
  }
  if (isEmptySchema(record.not)) return NEUTRAL_STRING_DOMAIN;

  if (typeof record.type === 'string') {
    return record.type === 'string' ? OPEN_STRING_DOMAIN : NEUTRAL_STRING_DOMAIN;
  }
  if (Array.isArray(record.type) && record.type.every((value) => typeof value === 'string')) {
    return record.type.includes('string') ? OPEN_STRING_DOMAIN : NEUTRAL_STRING_DOMAIN;
  }
  return OPEN_STRING_DOMAIN;
}

function decodeJsonPointerSegment(segment: string): string | undefined {
  try {
    const decoded = decodeURIComponent(segment);
    if (/~(?:[^01]|$)/.test(decoded)) return undefined;
    return decoded.replaceAll('~1', '/').replaceAll('~0', '~');
  } catch {
    return undefined;
  }
}

function resolveLocalSchemaRef(root: unknown, ref: string): unknown | undefined {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;

  let cursor = root;
  for (const encodedSegment of ref.slice(2).split('/')) {
    const segment = decodeJsonPointerSegment(encodedSegment);
    if (segment === undefined || typeof cursor !== 'object' || cursor === null) return undefined;
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= cursor.length) return undefined;
      cursor = cursor[index];
    } else {
      if (!Object.hasOwn(cursor, segment)) return undefined;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  return cursor;
}

function classifyStringDomain(
  schema: unknown,
  root: unknown = schema,
  activeRefs: ReadonlySet<string> = new Set(),
): StringDomain {
  if (schema === false) return NEUTRAL_STRING_DOMAIN;
  if (schema === true) return OPEN_STRING_DOMAIN;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return OPEN_STRING_DOMAIN;
  const record = schema as Record<string, unknown>;
  const constraints: StringDomain[] = [directStringDomain(record)];

  if (typeof record.$ref === 'string') {
    const resolved = resolveLocalSchemaRef(root, record.$ref);
    if (resolved === undefined || activeRefs.has(record.$ref)) {
      constraints.push(OPEN_STRING_DOMAIN);
    } else {
      constraints.push(classifyStringDomain(resolved, root, new Set([...activeRefs, record.$ref])));
    }
  }

  for (const unionKey of ['oneOf', 'anyOf'] as const) {
    const branches = record[unionKey];
    if (Array.isArray(branches) && branches.length > 0) {
      constraints.push(unionStringDomains(branches.map((branch) => classifyStringDomain(branch, root, activeRefs))));
    }
  }

  const intersections = record.allOf;
  if (Array.isArray(intersections) && intersections.length > 0) {
    constraints.push(
      intersectStringDomains(intersections.map((branch) => classifyStringDomain(branch, root, activeRefs))),
    );
  }

  return intersectStringDomains(constraints);
}

function hiddenOperationDiscriminators(
  definition: McpToolDefinition,
): readonly { field: string; literals: readonly string[] }[] {
  if (definition.operation.kind !== 'single') return [];
  const normalized = normalizeMcpInputSchema(definition.inputSchema);
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) return [];
  const properties = (normalized as Record<string, unknown>).properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return [];
  const names = new Set([...DEFAULT_OPERATION_DISCRIMINATORS, ...(definition.operation.customDiscriminators ?? [])]);
  return [...names].sort().flatMap((field) => {
    const domain = classifyStringDomain((properties as Record<string, unknown>)[field], normalized);
    return domain.kind === 'finite' && domain.literals.length > 1 ? [{ field, literals: domain.literals }] : [];
  });
}

function baseFindings(definition: McpToolDefinition, options: ValidationOptions): GovernanceFinding[] {
  const findings: GovernanceFinding[] = [];
  if (
    !definition.name.trim() ||
    !definition.description.trim() ||
    !definition.policy.resourceFamily.trim() ||
    definition.policy.runtimeProfiles.length === 0 ||
    definition.policy.cognitiveEntryPoints.length === 0 ||
    definition.policy.verification.length === 0
  ) {
    findings.push({ code: 'invalid-policy', toolName: definition.name, message: 'Governance policy is incomplete' });
  }
  if (!options.implementationCatalog.has(definition.implementation.ref)) {
    findings.push({
      code: 'unresolved-implementation-binding',
      toolName: definition.name,
      message: `Unresolved implementation binding: ${definition.implementation.ref}`,
    });
  }
  for (const ref of referencedEvidence(definition)) {
    if (!options.evidenceCatalog.existingRefs.has(ref)) {
      findings.push({
        code: 'unresolved-evidence-ref',
        toolName: definition.name,
        message: `Unresolved evidence: ${ref}`,
      });
    }
  }
  return findings;
}

function operationFindings(definition: McpToolDefinition, options: ValidationOptions): GovernanceFinding[] {
  const protectedSnapshot = options.protectedBase.get(definition.name);
  const grandfathered =
    definition.policy.activeState === 'migration-candidate' &&
    protectedSnapshot !== undefined &&
    matchesProtectedBase(definition, protectedSnapshot);
  const findings: GovernanceFinding[] = [];
  if (!grandfathered) {
    for (const discriminator of hiddenOperationDiscriminators(definition)) {
      findings.push({
        code: 'hidden-operation-discriminator',
        toolName: definition.name,
        message: `Closed operation discriminator "${discriminator.field}" exposes action literals [${discriminator.literals.join(', ')}] outside the declared single action`,
      });
    }
  }
  if (definition.operation.kind === 'discriminated') {
    const boundaries = definition.operation.variants.map((variant) => stable(variant.boundary));
    if (new Set(boundaries).size > 1 && !grandfathered) {
      findings.push({
        code: 'mixed-action-boundary',
        toolName: definition.name,
        message: 'Canonical lifecycle variants must share one authority and risk boundary',
      });
    }
  }
  if (definition.policy.activeState === 'migration-candidate' && !grandfathered) {
    findings.push({
      code: 'protected-base-drift',
      toolName: definition.name,
      message: 'Migration candidate must match the protected base schema/action/risk contract',
    });
  }
  return findings;
}

function admissionFindings(
  definition: McpToolDefinition,
  options: ValidationOptions,
  baseFamilies: ReadonlySet<string>,
): GovernanceFinding[] {
  const findings: GovernanceFinding[] = [];
  const reason = definition.policy.standaloneReason;
  const isAdded = !options.protectedBase.has(definition.name);
  const familyExisted = baseFamilies.has(definition.policy.resourceFamily);
  if (isAdded && familyExisted && reason.disposition !== 'accepted-boundary') {
    findings.push({
      code: 'unjustified-family-growth',
      toolName: definition.name,
      message: 'A new top-level name in an existing family requires an accepted independent boundary',
    });
  }
  if (isAdded && !familyExisted && (reason.disposition !== 'accepted-boundary' || reason.kind !== 'resource-entry')) {
    findings.push({
      code: 'new-family-requires-resource-entry',
      toolName: definition.name,
      message: 'A new resource family requires an accepted resource-entry decision',
    });
  }
  if (reason.disposition !== 'accepted-boundary') return findings;
  const claims = options.evidenceCatalog.admissionClaims.get(reason.admissionRef) ?? [];
  const exact = claims.some(
    (claim) =>
      claim.subject.toolName === definition.name &&
      claim.subject.resourceFamily === definition.policy.resourceFamily &&
      claim.subject.boundaryKind === reason.kind,
  );
  if (!exact) {
    findings.push({
      code: 'admission-subject-mismatch',
      toolName: definition.name,
      message: `Admission evidence is not bound to ${definition.name}/${definition.policy.resourceFamily}/${reason.kind}`,
    });
  }
  return findings;
}

export function validateToolGovernance(
  definitions: readonly McpToolDefinition[],
  options: ValidationOptions,
): { ok: boolean; findings: readonly GovernanceFinding[] } {
  const findings: GovernanceFinding[] = [];
  const seenNames = new Set<string>();
  const baseFamilies = new Set([...options.protectedBase.values()].map((snapshot) => snapshot.resourceFamily));
  for (const definition of definitions) {
    if (seenNames.has(definition.name)) {
      findings.push({
        code: 'duplicate-tool-name',
        toolName: definition.name,
        message: `Duplicate tool: ${definition.name}`,
      });
    }
    seenNames.add(definition.name);
    findings.push(...baseFindings(definition, options));
    findings.push(...operationFindings(definition, options));
    findings.push(...admissionFindings(definition, options, baseFamilies));
  }
  findings.sort((left, right) =>
    `${left.toolName ?? ''}:${left.code}`.localeCompare(`${right.toolName ?? ''}:${right.code}`),
  );
  return { ok: findings.length === 0, findings };
}
