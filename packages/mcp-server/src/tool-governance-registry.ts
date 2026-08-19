import type { McpRuntimeProfile, McpToolDefinition, ToolRegistryDelta } from './tool-governance-types.js';

export function deriveProfileNames(
  definitions: readonly McpToolDefinition[],
  profile: McpRuntimeProfile,
): readonly string[] {
  return definitions
    .filter((definition) => definition.policy.runtimeProfiles.includes(profile))
    .map((definition) => definition.name)
    .sort();
}

function setDelta(left: ReadonlySet<string>, right: ReadonlySet<string>): readonly string[] {
  return [...right].filter((value) => !left.has(value)).sort();
}

export function compareToolRegistries(
  before: readonly McpToolDefinition[],
  after: readonly McpToolDefinition[],
): ToolRegistryDelta {
  const beforeByName = new Map(before.map((definition) => [definition.name, definition]));
  const afterByName = new Map(after.map((definition) => [definition.name, definition]));
  const beforeNames = new Set(beforeByName.keys());
  const afterNames = new Set(afterByName.keys());
  const families = new Set([
    ...before.map((definition) => definition.policy.resourceFamily),
    ...after.map((definition) => definition.policy.resourceFamily),
  ]);
  const resourceActionChanges = [...families].sort().flatMap((resourceFamily) => {
    const beforeActions = new Set(
      before
        .filter((definition) => definition.policy.resourceFamily === resourceFamily)
        .flatMap((definition) => definition.actionInventory),
    );
    const afterActions = new Set(
      after
        .filter((definition) => definition.policy.resourceFamily === resourceFamily)
        .flatMap((definition) => definition.actionInventory),
    );
    const added = setDelta(beforeActions, afterActions);
    const removed = setDelta(afterActions, beforeActions);
    return added.length || removed.length ? [{ resourceFamily, added, removed }] : [];
  });
  const profileChanges = [...new Set([...beforeNames, ...afterNames])].sort().flatMap((name) => {
    const oldProfiles = new Set(beforeByName.get(name)?.policy.runtimeProfiles ?? []);
    const newProfiles = new Set(afterByName.get(name)?.policy.runtimeProfiles ?? []);
    const added = setDelta(oldProfiles, newProfiles);
    const removed = setDelta(newProfiles, oldProfiles);
    return added.length || removed.length ? [{ name, added, removed }] : [];
  });
  return {
    addedNames: setDelta(beforeNames, afterNames),
    removedNames: setDelta(afterNames, beforeNames),
    resourceActionChanges,
    profileChanges,
  };
}
