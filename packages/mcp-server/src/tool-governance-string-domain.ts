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

export function classifyStringDomain(
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
