import { isAbsolute, resolve } from 'node:path';
import {
  type AgyNativeCodingGrantConfig,
  type CatId,
  developmentPlanRefSchema,
  developmentRevisionSchema,
  type TaskItem,
} from '@cat-cafe/shared';
import { buildAgyNativePolicy } from './agy-native-policy.js';

export interface NativeCodingGrantLookup {
  readonly grant?: AgyNativeCodingGrantConfig;
  readonly threadId: string;
  readonly catId: CatId;
  readonly userId: string;
  readonly taskStore?: { get(taskId: string): TaskItem | null | Promise<TaskItem | null> };
}

export interface ResolvedAgyNativeCodingGrant {
  readonly workspaceRoot: string;
  readonly writableFiles: readonly string[];
  readonly testFile: string;
  readonly taskId: string;
}

/** Only an operator catalog grant attached to the same live entrusted Task may unlock native writes. */
export async function resolveAgyNativeCodingGrant(
  input: NativeCodingGrantLookup,
): Promise<ResolvedAgyNativeCodingGrant | null> {
  const { grant } = input;
  if (!grant || grant.threadId !== input.threadId) return null;
  if (!input.taskStore) throw new Error('AGY native coding grant requires the durable Task store');
  if (
    !developmentPlanRefSchema.safeParse(grant.workUnitRef).success ||
    !developmentRevisionSchema.safeParse(grant.acceptedRevision).success ||
    !isAbsolute(grant.workspaceRoot) ||
    grant.writableFiles.length === 0 ||
    grant.writableFiles.length > 8 ||
    !grant.writableFiles.includes(grant.testFile) ||
    !/\.test\.[cm]?js$/.test(grant.testFile)
  ) {
    throw new Error('AGY native coding grant has an invalid source or test file');
  }
  const task = await input.taskStore.get(grant.taskId);
  if (!task) return null;
  const scope = task.entrustedWork?.developmentScope;
  if (
    task.kind !== 'work' ||
    task.threadId !== input.threadId ||
    task.ownerCatId !== input.catId ||
    task.userId !== input.userId ||
    scope?.featureRef !== 'feature:F325' ||
    scope.workUnitRef !== grant.workUnitRef ||
    scope.acceptedSourceRef !== grant.workUnitRef ||
    scope.acceptedRevision !== grant.acceptedRevision
  ) {
    throw new Error('AGY native coding grant does not match the live entrusted Task');
  }
  if (!['todo', 'doing'].includes(task.status) || task.entrustedWork?.closure.state !== 'open') return null;
  const policy = buildAgyNativePolicy({
    workspaceRoot: grant.workspaceRoot,
    writableFiles: grant.writableFiles,
    mcpTools: [],
  });
  if (!policy.settings.permissions.allow.includes(`write_file(${resolve(policy.workspaceRoot, grant.testFile)})`)) {
    throw new Error('AGY native coding grant test file is outside the writable scope');
  }
  return {
    workspaceRoot: policy.workspaceRoot,
    writableFiles: [...grant.writableFiles],
    testFile: grant.testFile,
    taskId: grant.taskId,
  };
}
