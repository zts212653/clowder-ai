import type { ManagedWorkBinding, TaskItem } from '@cat-cafe/shared';
import {
  assertTypedWaitRegistrationInstallation,
  type TypedWaitRegistration,
} from '../../../../ball-custody/TypedWaitRegistration.js';
import { automationGeneration } from './TaskAutomationState.js';
import {
  buildTaskDeploymentWaitReplacement,
  deploymentWaitGeneration,
  deploymentWaitReplacementMatches,
} from './TaskDeploymentWaitState.js';
import type {
  ReplaceAutomationStateIfGenerationInput,
  ReplaceDeploymentWaitIfGenerationInput,
} from './TaskStoreContract.js';
import { assertEntrustedWorkStatusUpdateAllowed } from './TaskStoreContract.js';
import { buildTaskWaitReplacement } from './TaskWaitReplacement.js';

type ManagedWorkRegistration = {
  bind(taskId: string, binding: ManagedWorkBinding): ManagedWorkBinding | null;
  get(taskId: string): ManagedWorkBinding | null;
};

/** Focused in-memory CAS mutations for typed waits and their private registration receipts. */
export class TaskWaitMutationStore {
  constructor(
    private readonly tasks: Map<string, TaskItem>,
    private readonly waitRegistrations: Map<string, TypedWaitRegistration>,
    private readonly managedWorkRegistration: ManagedWorkRegistration,
  ) {}

  replaceAutomationStateIfGeneration(taskId: string, input: ReplaceAutomationStateIfGenerationInput): TaskItem | null {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    assertEntrustedWorkStatusUpdateAllowed(existing, input);
    if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) return null;
    if (automationGeneration(existing.automationState) !== input.expectedGeneration) return null;

    const updated = buildTaskWaitReplacement(existing, input, this.managedWorkRegistration.get(taskId));
    if (input.waitRegistration) assertTypedWaitRegistrationInstallation(updated, input.waitRegistration);
    const binding = input.trackingRegistration?.managedWorkBinding;
    if (binding) this.managedWorkRegistration.bind(taskId, binding);
    this.commitWaitRegistration(
      taskId,
      input.waitRegistration,
      automationGeneration(existing.automationState) !== automationGeneration(updated.automationState),
    );
    this.tasks.set(taskId, updated);
    return updated;
  }

  replaceDeploymentWaitIfGeneration(taskId: string, input: ReplaceDeploymentWaitIfGenerationInput): TaskItem | null {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    if (!deploymentWaitReplacementMatches(existing, input)) return null;

    const updated = buildTaskDeploymentWaitReplacement(existing, input);
    if (input.waitRegistration) assertTypedWaitRegistrationInstallation(updated, input.waitRegistration);
    this.commitWaitRegistration(
      taskId,
      input.waitRegistration,
      deploymentWaitGeneration(existing.deploymentWait) !== deploymentWaitGeneration(updated.deploymentWait),
    );
    this.tasks.set(taskId, updated);
    return updated;
  }

  private commitWaitRegistration(
    taskId: string,
    registration: TypedWaitRegistration | undefined,
    generationChanged: boolean,
  ): void {
    if (registration) {
      this.waitRegistrations.set(taskId, structuredClone(registration));
    } else if (generationChanged) {
      this.waitRegistrations.delete(taskId);
    }
  }
}
