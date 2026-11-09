import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCatId, type TaskItem } from '@cat-cafe/shared';
import { isCatAvailable } from '../../../config/cat-config-loader.js';
import { isTaskSubjectSnapshotConflictError } from '../../../domains/cats/services/stores/ports/TaskStoreContract.js';
import { readEngagementPolicy } from '../../../domains/routing-context/ScarceSeatNotificationPolicy.js';
import type { ExecuteContext } from '../types.js';
import type { AlphaBrowserOptions, AlphaRuntime, FailureDraft } from './alpha-browser.js';
import { notifyAlphaRepair } from './alpha-repair-notification.js';

const exec = promisify(execFile);
const EXACT_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

function notificationTarget(options: AlphaBrowserOptions, owner: string | null, guardian: string): string {
  const available = options.isAvailable ?? isCatAvailable;
  const policy = options.getEngagementPolicy ?? readEngagementPolicy;
  // Historical ownership is evidence, not consent to routine automated work.
  if (
    owner &&
    options.resolveCat(owner) === owner &&
    available(owner) &&
    policy(owner)?.quota !== 'weekly_subscription_scarce'
  )
    return owner;
  if (options.resolveCat(guardian) !== guardian || !available(guardian)) {
    throw new Error(`Alpha guardian unavailable: ${guardian}`);
  }
  return guardian;
}

function assertTaskScope(task: TaskItem, options: AlphaBrowserOptions, threadId: string): void {
  if (task.userId !== options.ownerUserId || task.threadId !== threadId) {
    throw new Error('Alpha failure task owner conflict');
  }
}

function repairDescription(draft: FailureDraft, guardian: string, previous: TaskItem | null): string {
  return [
    '修复责任：查明并修复根因，提交修复与复验证据；仅完成分诊不能关闭本任务。',
    `Revision: ${draft.testedHeadSha}`,
    `Execution: ${draft.jobId}:${draft.generation}`,
    `Units: ${draft.unitIds.join(', ')}`,
    `Owner source: ${draft.ownerSourceRef ?? 'unresolved'}`,
    `Ownership: ${draft.ownership}. A failing journey is evidence to investigate, not proof that its feature code is the root cause.`,
    ...(!draft.ownerCatId ? [`归属待核：由订阅 guardian ${guardian} 负责查明修复去向。`] : []),
    ...(draft.incidentKey
      ? [
          `Incident: ${draft.incidentKey}`,
          `Failure: ${draft.failureSummary ?? ''}`,
          '同症状的后续执行在原 Alpha ledger 中保留 RED 并引用本任务；不另建任务、不覆盖修复进度。',
        ]
      : []),
    ...(previous
      ? [`Previous repair: task:${previous.id}; closed work is not proof this new failure is repaired.`]
      : []),
    ...(draft.reason ? [`Managed execution: ${draft.managedJobId}`, `Reason: ${draft.reason}`] : []),
  ].join('\n');
}

async function repairTask(
  options: AlphaBrowserOptions,
  draft: FailureDraft,
  threadId: string,
  guardian: string,
): Promise<TaskItem> {
  let subjectKey = draft.incidentKey ?? draft.subjectKey;
  let previous: TaskItem | null = null;
  // A closed repair remains immutable. A recurrence gets a successor, while
  // still-open work keeps its owner, status and human-authored repair evidence.
  for (;;) {
    const existing = await options.tasks.getBySubject(subjectKey);
    if (existing) {
      assertTaskScope(existing, options, threadId);
      if (!draft.incidentKey || existing.status !== 'done') return existing;
      previous = existing;
      subjectKey = `${draft.incidentKey}:after:${existing.id}`;
      continue;
    }
    try {
      return await options.tasks.upsertBySubject(
        {
          kind: 'work',
          subjectKey,
          threadId,
          userId: options.ownerUserId,
          createdBy: 'system',
          ownerCatId: createCatId(draft.ownerCatId ?? guardian),
          title: `[P1] Alpha repair ${draft.kind}: ${draft.testedHeadSha.slice(0, 10)}`,
          why: repairDescription(draft, guardian, previous),
        },
        { expected: null },
      );
    } catch (error) {
      // A competing creator may have won after the lookup. The store fences
      // that race, so retry the read without overwriting its owner/progress.
      if (!isTaskSubjectSnapshotConflictError(error)) throw error;
    }
  }
}

export async function reportAlphaFailures(
  options: AlphaBrowserOptions,
  runtime: AlphaRuntime,
  subscriptionId: string,
  threadId: string,
  guardian: string,
  ctx: ExecuteContext,
  failure: Record<string, unknown>,
): Promise<string[]> {
  const source = async (path: string, headSha: string, blob: boolean): Promise<string> => {
    const validPath = blob
      ? /^packages\/web\/test\/browser\/[a-zA-Z0-9._/-]+\.mjs$/u
      : /^docs\/(?:features|plans)\/[a-zA-Z0-9._/-]+\.md$/u;
    if (!EXACT_OID.test(headSha) || !validPath.test(path) || path.includes('..')) {
      throw new Error('Invalid alpha owner source');
    }
    const args = blob ? ['rev-parse', '--verify', `${headSha}:${path}`] : ['show', `${headSha}:${path}`];
    return (
      await exec('git', args, { cwd: options.repoRoot, signal: ctx.signal, maxBuffer: 2 * 1024 * 1024 })
    ).stdout.trim();
  };
  const drafts = await runtime.alphaBrowserFailureTasks({
    ...failure,
    subscriptionId,
    resolveCat: options.resolveCat,
    readOwnerDocument: (path: string, headSha: string) => source(path, headSha, false),
    readTestBlob: (path: string, headSha: string) => source(path, headSha, true),
  });
  const refs: string[] = [];
  for (const draft of drafts) {
    const task = await repairTask(options, draft, threadId, guardian);
    const targetCatId = notificationTarget(options, task.ownerCatId, guardian);
    if (draft.incidentKey) {
      await notifyAlphaRepair(options, ctx, task, targetCatId);
      refs.push(`task:${task.id}`);
      continue;
    }
    let content = `Alpha 浏览器验证未通过：${draft.testedHeadSha}\n内部 P1：${task.id}\n${task.why}`;
    if (task.ownerCatId && targetCatId !== task.ownerCatId) {
      content += `\n自动核验交给订阅守护者 ${targetCatId}；历史负责人 ${task.ownerCatId} 当前不接自动核验，原归属记录保留。`;
    }
    if (!ctx.deliver) throw new Error('Alpha failure delivery is required');
    await ctx.deliver({
      threadId,
      content,
      userId: options.ownerUserId,
      targetCatId,
      idempotencyKey: `alpha-triage:${draft.jobId}:${draft.generation}:${task.id}`,
      deliveryStatus: 'queued',
      sourceCategory: 'scheduled',
      priority: 'urgent',
    });
    refs.push(`task:${task.id}`);
  }
  return refs;
}
