import type { FamilyToolDefinition, McpServerFamily } from './tool-governance-snapshot.js';
import type { McpToolDefinition } from './tool-governance-types.js';

export type CanonicalToolSources = Readonly<Record<McpServerFamily, readonly McpToolDefinition[]>>;

export type CanonicalToolsetEnv = {
  readonly?: boolean;
  hasAgentKey?: boolean;
  desktopMode?: string;
};

const DESKTOP_PROFILES = {
  'fable-phase0': 'desktop:fable-phase0',
  'cloud-pro-phase0': 'desktop:cloud-pro-phase0',
} as const;

function assertGovernedDefinition(definition: McpToolDefinition): void {
  const candidate = definition as Partial<McpToolDefinition>;
  const annotations = candidate.annotations;
  if (
    !candidate.operation ||
    !candidate.implementation?.ref ||
    !candidate.policy?.resourceFamily?.trim() ||
    !candidate.policy.runtimeProfiles?.length ||
    !candidate.actionInventory?.length ||
    !candidate.effectiveRisk ||
    !annotations ||
    typeof annotations.readOnlyHint !== 'boolean' ||
    typeof annotations.destructiveHint !== 'boolean' ||
    typeof annotations.openWorldHint !== 'boolean'
  ) {
    throw new Error(`MCP tool ${candidate.name ?? '<unnamed>'} is missing its governance certificate`);
  }
}

export function buildCanonicalToolRegistry(sources: CanonicalToolSources): readonly FamilyToolDefinition[] {
  const registry = (Object.entries(sources) as [McpServerFamily, readonly McpToolDefinition[]][]).flatMap(
    ([serverFamily, definitions]) =>
      definitions.map((definition) => {
        assertGovernedDefinition(definition);
        return { ...definition, serverFamily };
      }),
  );
  const seen = new Set<string>();
  for (const definition of registry) {
    if (seen.has(definition.name)) throw new Error(`Duplicate canonical MCP tool: ${definition.name}`);
    seen.add(definition.name);
  }
  return registry.sort((left, right) => left.name.localeCompare(right.name));
}

export function projectCanonicalToolRegistry(
  registry: readonly FamilyToolDefinition[],
  env: CanonicalToolsetEnv,
): readonly FamilyToolDefinition[] {
  if (env.desktopMode) {
    const profile = DESKTOP_PROFILES[env.desktopMode as keyof typeof DESKTOP_PROFILES];
    if (!profile) {
      throw new Error(
        `Unknown CAT_CAFE_DESKTOP_MODE: "${env.desktopMode}". Valid modes: ${Object.keys(DESKTOP_PROFILES).join(', ')}`,
      );
    }
    return registry.filter((definition) => definition.policy.runtimeProfiles.includes(profile));
  }
  if (!env.readonly) {
    return registry.filter((definition) => definition.policy.runtimeProfiles.includes('full'));
  }
  return registry.filter(
    (definition) =>
      definition.policy.runtimeProfiles.includes('readonly') ||
      (!!env.hasAgentKey && definition.policy.runtimeProfiles.includes('agent-key')),
  );
}

export function projectServerFamily(
  registry: readonly FamilyToolDefinition[],
  serverFamily: McpServerFamily,
  env: CanonicalToolsetEnv,
): readonly FamilyToolDefinition[] {
  return projectCanonicalToolRegistry(
    registry.filter((definition) => definition.serverFamily === serverFamily),
    env,
  );
}

export function derivedProfileSet(
  registry: readonly FamilyToolDefinition[],
  profile: FamilyToolDefinition['policy']['runtimeProfiles'][number],
): ReadonlySet<string> {
  return new Set(
    registry
      .filter((definition) => definition.policy.runtimeProfiles.includes(profile))
      .map((definition) => definition.name),
  );
}
