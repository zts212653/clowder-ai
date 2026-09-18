import { readFile } from 'node:fs/promises';
import type {
  CycleGovernanceSubmission,
  HarnessGovernanceChangeDraft,
  HarnessGovernanceProposal,
  HarnessGovernanceProposalChange,
  HarnessUnitAddDraft,
  HookCondition,
} from '@cat-cafe/shared';
import type { HookOverrideStore } from '../../../domains/prompt-hooks/HookOverrideStore.js';
import type { HookRegistry } from '../../../domains/prompt-hooks/HookRegistry.js';
import type { CycleVersionRef } from '../evaluation/CycleTriggerChecker.js';
import type { EvaluationCatalog } from '../evaluation/evaluation-catalog.js';
import type { ObjectiveVersionState } from '../evaluation/ObjectiveVersionStore.js';
import type { HarnessUnitDirectoryWriter } from './HarnessUnitDirectoryWriter.js';

type AddChange = Extract<HarnessGovernanceProposalChange, { action: 'add' }>;
type EnablementChange = Extract<HarnessGovernanceProposalChange, { action: 'enable' | 'disable' }>;
type ContentChange = Extract<HarnessGovernanceProposalChange, { action: 'modify' | 'rollback' }>;
type RegisteredHook = NonNullable<ReturnType<HookRegistry['getHook']>>;
type UnitState = RegisteredHook & {
  enabled: boolean;
  version: number;
  content: string;
  condition: HookCondition | null;
};
type OverrideAudit = { source: 'operator'; reason: string };

export class HarnessGovernanceExecutor {
  constructor(
    private readonly deps: {
      catalog: EvaluationCatalog;
      overrideStore: HookOverrideStore;
      getRegistry: () => HookRegistry | null;
      reloadPipeline: () => Promise<void>;
      resolveObjectiveVersion: (objectiveId: string, state: ObjectiveVersionState) => Promise<CycleVersionRef>;
      unitWriter?: HarnessUnitDirectoryWriter;
    },
  ) {}

  async hydrate(objectiveId: string, input: CycleGovernanceSubmission): Promise<HarnessGovernanceProposalChange[]> {
    if (input.decision === 'keep') {
      return this.hydrateKeep(input);
    }
    if (input.decision === 'rollback') return [await this.hydrateRollback(objectiveId, input)];
    return this.hydrateEvolution(objectiveId, input);
  }

  private hydrateKeep(input: CycleGovernanceSubmission): HarnessGovernanceProposalChange[] {
    if (input.rollback || input.v2Draft) throw new Error('cycle_governance_keep_cannot_mutate');
    return [];
  }

  private async hydrateEvolution(
    objectiveId: string,
    input: CycleGovernanceSubmission,
  ): Promise<HarnessGovernanceProposalChange[]> {
    if (input.rollback || !input.v2Draft?.changes.length) {
      throw new Error('cycle_governance_evolve_requires_draft');
    }
    if (input.v2Draft.changes.length > 16) throw new Error('cycle_governance_change_limit');
    const seen = new Set<string>();
    const changes: HarnessGovernanceProposalChange[] = [];
    for (const draft of input.v2Draft.changes) {
      const coordinate = changeCoordinate(draft);
      if (seen.has(coordinate)) throw new Error(`cycle_governance_duplicate_change:${coordinate}`);
      seen.add(coordinate);
      if (draft.reason.trim().length === 0) throw new Error('cycle_governance_change_reason_required');
      changes.push(await this.hydrateDraftChange(objectiveId, draft));
    }
    return changes;
  }

  private async hydrateDraftChange(
    objectiveId: string,
    draft: HarnessGovernanceChangeDraft,
  ): Promise<HarnessGovernanceProposalChange> {
    if (draft.action === 'add') return this.hydrateAdd(objectiveId, draft);
    const state = await this.requireUnit(objectiveId, draft.unitId);
    if (draft.action === 'enable' || draft.action === 'disable') {
      return this.hydrateEnablement(objectiveId, draft, state);
    }
    return this.hydrateModification(draft, state);
  }

  private hydrateEnablement(
    objectiveId: string,
    draft: Extract<HarnessGovernanceChangeDraft, { action: 'enable' | 'disable' }>,
    state: UnitState,
  ): EnablementChange {
    if (draft.action === 'disable' && !state.manifest.disableable) {
      throw new Error(`cycle_governance_disable_forbidden:${draft.unitId}`);
    }
    const remainingMemberCount = this.deps.catalog.manifest.units.filter(
      (unit) => unit.unitId !== draft.unitId && unit.objectives.some((item) => item.objectiveId === objectiveId),
    ).length;
    return {
      action: draft.action,
      unitId: draft.unitId,
      hookId: state.manifest.id,
      reason: draft.reason.trim(),
      beforeEnabled: state.enabled,
      beforeContent: state.content,
      objectiveImpact: { objectiveId, remainingMemberCount },
    };
  }

  private hydrateModification(
    draft: Extract<HarnessGovernanceChangeDraft, { action: 'modify' }>,
    state: UnitState,
  ): Extract<HarnessGovernanceProposalChange, { action: 'modify' }> {
    const contentChanged = draft.proposedContent !== undefined && draft.proposedContent.trim() !== state.content.trim();
    if (draft.proposedContent !== undefined && state.manifest.safetyTier === 'readonly') {
      throw new Error(`cycle_governance_modify_forbidden:${draft.unitId}`);
    }
    if (draft.proposedCondition !== undefined && state.manifest.governanceTier === 'immutable') {
      throw new Error(`cycle_governance_condition_forbidden:${draft.unitId}`);
    }
    const conditionChanged =
      draft.proposedCondition !== undefined && !sameCondition(draft.proposedCondition, state.condition);
    if (!contentChanged && !conditionChanged) throw new Error(`cycle_governance_change_unchanged:${draft.unitId}`);
    return {
      action: 'modify',
      unitId: draft.unitId,
      hookId: state.manifest.id,
      reason: draft.reason.trim(),
      sourceVersion: state.version,
      beforeContent: state.content,
      ...(contentChanged ? { proposedContent: draft.proposedContent } : {}),
      beforeCondition: state.condition,
      ...(conditionChanged ? { proposedCondition: draft.proposedCondition } : {}),
    };
  }

  private hydrateAdd(objectiveId: string, draft: Extract<HarnessGovernanceChangeDraft, { action: 'add' }>): AddChange {
    this.validateAdd(objectiveId, draft.unit);
    return {
      action: 'add',
      unitId: draft.unit.unitId,
      hookId: draft.unit.unitId,
      assetSlug: draft.unit.assetSlug,
      reason: draft.reason.trim(),
      manifest: structuredClone(draft.unit.manifest),
      content: draft.unit.content,
      objectives: draft.unit.objectives.map((attachment) => ({ ...attachment })),
    };
  }

  async apply(
    proposal: HarnessGovernanceProposal,
    actorId: string,
    reason: string,
    state: ObjectiveVersionState,
  ): Promise<CycleVersionRef> {
    await this.preflight(proposal);
    for (const change of proposal.changes) await this.applyChange(change, actorId, reason);
    await this.deps.reloadPipeline();
    return this.currentVersion(proposal.objectiveId, state);
  }

  /** Validate the complete card before the first mutation; operators approve the proposal as one action list. */
  private async preflight(proposal: HarnessGovernanceProposal): Promise<void> {
    const addedOrders = new Set<string>();
    for (const change of proposal.changes) {
      await this.preflightChange(proposal.objectiveId, change, addedOrders);
    }
  }

  private async preflightChange(
    objectiveId: string,
    change: HarnessGovernanceProposalChange,
    addedOrders: Set<string>,
  ): Promise<void> {
    if (change.action === 'add') return this.preflightAdd(objectiveId, change, addedOrders);
    const state = await this.requireUnit(objectiveId, change.unitId);
    if (change.action === 'enable' || change.action === 'disable') {
      const target = change.action === 'enable';
      if (state.enabled !== target && state.enabled !== change.beforeEnabled) {
        throw new Error('harness_governance_enablement_changed');
      }
      return;
    }
    if (
      !contentAlreadyApplied(change, state.content) &&
      (state.version !== change.sourceVersion || state.content !== change.beforeContent)
    ) {
      throw new Error('harness_governance_source_version_changed');
    }
    if (
      change.action === 'modify' &&
      !conditionAlreadyApplied(change, state.condition) &&
      !sameCondition(state.condition, change.beforeCondition)
    ) {
      throw new Error('harness_governance_condition_changed');
    }
  }

  private preflightAdd(objectiveId: string, change: AddChange, addedOrders: Set<string>): void {
    if (!this.deps.unitWriter) throw new Error('harness_governance_unit_writer_unavailable');
    this.validateAdd(objectiveId, change);
    const orderCoordinate = `${change.manifest.stage}:${change.manifest.order}`;
    if (addedOrders.has(orderCoordinate)) throw new Error('cycle_governance_add_registry_conflict');
    addedOrders.add(orderCoordinate);
  }

  async currentVersion(objectiveId: string, state: ObjectiveVersionState): Promise<CycleVersionRef> {
    return this.deps.resolveObjectiveVersion(objectiveId, state);
  }

  private async hydrateRollback(
    objectiveId: string,
    input: CycleGovernanceSubmission,
  ): Promise<HarnessGovernanceProposalChange> {
    if (!input.rollback || input.v2Draft) throw new Error('cycle_governance_rollback_target_required');
    const state = await this.requireUnit(objectiveId, input.rollback.unitId);
    const targetVersion = input.rollback.targetVersion;
    if (!Number.isSafeInteger(targetVersion) || targetVersion < 1 || targetVersion >= state.version) {
      throw new Error('cycle_governance_rollback_target_invalid');
    }
    const targetContent =
      targetVersion === state.manifest.version
        ? await readFile(state.templatePath, 'utf8')
        : await this.deps.overrideStore.getVersionContent(state.manifest.id, targetVersion);
    if (targetContent === null) throw new Error('cycle_governance_rollback_target_missing');
    return {
      action: 'rollback',
      unitId: input.rollback.unitId,
      hookId: state.manifest.id,
      reason: input.reason.trim(),
      sourceVersion: state.version,
      targetVersion,
      beforeContent: state.content,
      targetContent,
    };
  }

  private async applyChange(
    change: HarnessGovernanceProposalChange,
    actorId: string,
    proposalReason: string,
  ): Promise<void> {
    if (change.action === 'add') return this.applyAdd(change);
    const registry = this.requireRegistry();
    const hook = registry.getHook(change.hookId);
    if (!hook) throw new Error(`harness_governance_hook_missing:${change.hookId}`);
    const audit = { source: 'operator' as const, reason: `${proposalReason} — ${change.reason}` };
    if (change.action === 'enable' || change.action === 'disable') {
      return this.applyEnablement(change, hook, actorId, audit);
    }
    return this.applyContent(change, hook.manifest.version, actorId, audit);
  }

  private async applyAdd(change: AddChange): Promise<void> {
    if (!this.deps.unitWriter) throw new Error('harness_governance_unit_writer_unavailable');
    await this.deps.unitWriter.add({
      unitId: change.unitId,
      assetSlug: change.assetSlug,
      manifest: change.manifest,
      content: change.content,
      objectives: change.objectives,
    });
  }

  private async applyEnablement(
    change: EnablementChange,
    hook: RegisteredHook,
    actorId: string,
    audit: OverrideAudit,
  ): Promise<void> {
    const current = await this.deps.overrideStore.getOverride(change.hookId);
    const enabled = current?.enabled ?? hook.manifest.enabled;
    const target = change.action === 'enable';
    if (enabled === target) return;
    await this.deps.overrideStore[change.action](change.hookId, actorId, audit);
  }

  private async applyContent(
    change: ContentChange,
    manifestVersion: number,
    actorId: string,
    audit: OverrideAudit,
  ): Promise<void> {
    const version = await this.deps.overrideStore.getActiveVersion(change.hookId);
    const content = await this.effectiveContent(change.hookId);
    if (!contentAlreadyApplied(change, content) && version !== change.sourceVersion) {
      throw new Error('harness_governance_source_version_changed');
    }
    return change.action === 'modify'
      ? this.applyModify(change, content, actorId, audit)
      : this.applyRollback(change, version, content, manifestVersion, actorId, audit);
  }

  private async applyModify(
    change: Extract<ContentChange, { action: 'modify' }>,
    content: string,
    actorId: string,
    audit: OverrideAudit,
  ): Promise<void> {
    if (change.proposedContent !== undefined && content !== change.proposedContent) {
      await this.deps.overrideStore.setContentOverride(change.hookId, change.proposedContent, actorId, audit);
    }
    if (change.proposedCondition === undefined) return;
    if (change.proposedCondition === null) {
      await this.deps.overrideStore.clearConditionOverride(change.hookId, actorId, audit);
      return;
    }
    await this.deps.overrideStore.setConditionOverride(change.hookId, change.proposedCondition, actorId, audit);
  }

  private async applyRollback(
    change: Extract<ContentChange, { action: 'rollback' }>,
    version: number,
    content: string,
    manifestVersion: number,
    actorId: string,
    audit: OverrideAudit,
  ): Promise<void> {
    if (version === change.targetVersion && content === change.targetContent) return;
    // hydrateRollback already chose which content this target names: the shipped
    // template when it equals the manifest version, otherwise a stored snapshot.
    // Say so explicitly, so a local epoch that collides with the shipped number
    // cannot silently redirect an approved rollback to the other content.
    const origin = change.targetVersion === manifestVersion ? 'manifest' : 'local';
    await this.deps.overrideStore.activateVersion(change.hookId, change.targetVersion, actorId, {
      ...audit,
      origin,
    });
  }

  private async requireUnit(objectiveId: string, unitId: string) {
    const unit = this.deps.catalog.manifest.units.find((candidate) => candidate.unitId === unitId);
    if (!unit || !unit.objectives.some((objective) => objective.objectiveId === objectiveId)) {
      throw new Error(`cycle_governance_unit_not_attached:${unitId}`);
    }
    const registry = this.requireRegistry();
    const hook = registry.getHook(unit.unitId);
    if (!hook) throw new Error(`harness_governance_hook_missing:${unit.unitId}`);
    return {
      ...hook,
      enabled: registry.isEnabled(unit.unitId),
      version: await this.deps.overrideStore.getActiveVersion(unit.unitId),
      content: await this.effectiveContent(unit.unitId),
      condition: registry.getConditionOverride(unit.unitId) ?? null,
    };
  }

  private validateAdd(objectiveId: string, unit: HarnessUnitAddDraft): void {
    if (!unit.objectives.some((attachment) => attachment.objectiveId === objectiveId)) {
      throw new Error('cycle_governance_add_must_attach_objective');
    }
    const existing = this.deps.catalog.manifest.units.find((candidate) => candidate.unitId === unit.unitId);
    if (existing) {
      // A previous attempt of this same proposal already materialised the unit.
      // Re-running is safe because the directory writer compares the manifest
      // and body byte-for-byte before reusing what is on disk; only a unit that
      // landed as something else is a genuine conflict.
      if (
        existing.hookId !== unit.assetSlug ||
        JSON.stringify(existing.objectives) !== JSON.stringify(unit.objectives)
      ) {
        throw new Error(`cycle_governance_add_unit_exists:${unit.unitId}`);
      }
      return;
    }
    const registry = this.requireRegistry();
    if (
      registry.getHook(unit.unitId) ||
      registry.getStageHooks(unit.manifest.stage).some((hook) => hook.manifest.order === unit.manifest.order)
    ) {
      throw new Error('cycle_governance_add_registry_conflict');
    }
  }

  private async effectiveContent(hookId: string): Promise<string> {
    const registry = this.requireRegistry();
    const hook = registry.getHook(hookId);
    if (!hook) throw new Error(`harness_governance_hook_missing:${hookId}`);
    return registry.getContentOverride(hookId) ?? readFile(hook.templatePath, 'utf8');
  }

  private requireRegistry(): HookRegistry {
    const registry = this.deps.getRegistry();
    if (!registry) throw new Error('harness_governance_registry_unavailable');
    return registry;
  }
}

/**
 * Apply is a sequence of individually durable writes, so a failure part-way
 * through leaves earlier ones in place while the coordinator leaves the proposal
 * pending. Every mutation here is already idempotent — enablement, content and
 * rollback all no-op when the unit is where the change wants it, and the unit
 * directory writer verifies existing files byte-for-byte before reusing them.
 * What blocked recovery was the guards reading our own partial progress as
 * foreign drift, which made the proposal permanently unapprovable while the
 * runtime carried part of it (Codex P1, PR #1462). These predicates let a
 * change count as satisfied when the live state already carries its target, so
 * a failed apply is resumable; anything that moved to a third value still fails
 * closed.
 */
function contentAlreadyApplied(change: ContentChange, content: string): boolean {
  return change.action === 'modify'
    ? change.proposedContent !== undefined && content === change.proposedContent
    : content === change.targetContent;
}

function conditionAlreadyApplied(change: ContentChange, condition: unknown): boolean {
  return (
    change.action === 'modify' &&
    change.proposedCondition !== undefined &&
    sameCondition(condition, change.proposedCondition)
  );
}

function sameCondition(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function changeCoordinate(draft: HarnessGovernanceChangeDraft): string {
  const unitId = draft.action === 'add' ? draft.unit.unitId : draft.unitId;
  const field = draft.action === 'enable' || draft.action === 'disable' ? 'enablement' : 'content';
  return `${unitId}:${field}`;
}
