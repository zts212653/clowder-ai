import type { HarnessUnitDescription } from '@cat-cafe/shared';
import type { HookOverrideStore } from '../../../domains/prompt-hooks/HookOverrideStore.js';
import type { HookRegistry } from '../../../domains/prompt-hooks/HookRegistry.js';
import type { EvaluationCatalog } from './evaluation-catalog.js';

/** Read-only action and version view used by an eval cat before drafting governance. */
export class HarnessUnitDescriber {
  constructor(
    private readonly deps: {
      catalog: EvaluationCatalog;
      overrideStore: HookOverrideStore;
      getRegistry: () => HookRegistry | null;
    },
  ) {}

  async describe(unitId: string): Promise<HarnessUnitDescription> {
    const unit = this.deps.catalog.manifest.units.find((candidate) => candidate.unitId === unitId);
    if (!unit) throw new Error(`harness_unit_not_found:${unitId}`);
    const registry = this.deps.getRegistry();
    const hook = registry?.getHook(unit.unitId);
    if (!registry || !hook) throw new Error(`harness_hook_not_available:${unit.unitId}`);

    const activeVersion = await this.deps.overrideStore.getActiveVersion(unit.unitId);
    const snapshots = await this.deps.overrideStore.listVersions(unit.unitId);
    const versions = new Set(
      [hook.manifest.version, activeVersion, ...snapshots.map((snapshot) => snapshot.version)].filter(
        (version) => Number.isSafeInteger(version) && version >= 0,
      ),
    );
    const contentRef = (version: number) => `hook-content:${unit.unitId}@${version}`;
    return {
      unitId: unit.unitId,
      hookId: unit.unitId,
      objectives: unit.objectives.map((objective) => ({ ...objective })),
      allowedActions: {
        enable: true,
        disable: hook.manifest.disableable,
        modify: hook.manifest.safetyTier !== 'readonly',
        // A new sibling segment can only be drafted from a unit whose manifest
        // explicitly participates in auto-evolution; S3 still human-gates apply.
        add: hook.manifest.governanceTier === 'auto-evolve',
      },
      current: {
        enabled: registry.isEnabled(unit.unitId),
        version: activeVersion,
        contentRef: contentRef(activeVersion),
      },
      versionChain: [...versions]
        .sort((left, right) => left - right)
        .map((version) => ({ version, contentRef: contentRef(version), current: version === activeVersion })),
    };
  }
}
