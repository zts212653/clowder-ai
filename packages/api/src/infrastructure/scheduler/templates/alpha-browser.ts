import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createCatId } from '@cat-cafe/shared';
import { isCatAvailable } from '../../../config/cat-config-loader.js';
import type { ITaskStore } from '../../../domains/cats/services/stores/ports/TaskStore.js';
import {
  type EngagementPolicyReader,
  readEngagementPolicy,
} from '../../../domains/routing-context/ScarceSeatNotificationPolicy.js';
import type { ExecuteContext } from '../types.js';
import { createAlphaManagedControl } from './alpha-managed-control.js';
import type { TaskTemplate } from './types.js';

const exec = promisify(execFile);
const EXACT_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
// Public exports carry the API but not the private full-gate execution plane.
// Advertise this optional schedule only where its owned runtime is installed.
export function supportsAlphaBrowserVerification(repoRoot: string): boolean {
  return [
    'alpha-browser-runner.mjs',
    'alpha-browser-process.mjs',
    'alpha-browser-worker.mjs',
    'alpha-browser-checkout.mjs',
    'alpha-browser-failures.mjs',
    'gate-execution-api.mjs',
  ].every((name) => existsSync(join(repoRoot, 'scripts/lib', name)));
}
interface FailureDraft {
  subjectKey: string;
  kind: string;
  ownerCatId: string | null;
  ownership: string;
  ownerSourceRef: string | null;
  testedHeadSha: string;
  jobId: string;
  generation: number;
  unitIds: string[];
  reason?: string;
  managedJobId?: string;
}
interface AlphaRuntime {
  runAlphaBrowserRevision(
    input: Record<string, unknown>,
  ): Promise<{ status: string; headSha?: string; reason?: string }>;
  alphaBrowserFailureTasks(input: Record<string, unknown>): Promise<FailureDraft[]>;
}
interface MainProjection {
  targetSha: string;
  databasePath: string;
  legacyLockPath: string;
}
export interface AlphaBrowserOptions {
  repoRoot: string;
  ownerUserId: string;
  tasks: Pick<ITaskStore, 'getBySubject' | 'upsertBySubject'>;
  resolveCat(mention: string): string | null;
  isAvailable?: (catId: string) => boolean;
  getEngagementPolicy?: EngagementPolicyReader;
  loadRuntime?: () => Promise<AlphaRuntime>;
  inspectMain?: (signal: AbortSignal) => Promise<MainProjection>;
}

async function git(repoRoot: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (await exec('git', args, { cwd: repoRoot, signal, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}
async function loadRuntime(repoRoot: string): Promise<AlphaRuntime> {
  const load = (name: string) => import(pathToFileURL(join(repoRoot, 'scripts/lib', name)).href);
  const [worker, failures] = await Promise.all([load('alpha-browser-process.mjs'), load('alpha-browser-failures.mjs')]);
  return { runAlphaBrowserRevision: worker.runAlphaBrowserProcess, ...failures } as AlphaRuntime;
}
async function inspectMain(repoRoot: string, signal: AbortSignal): Promise<MainProjection> {
  await git(repoRoot, ['fetch', 'origin', 'main', '--quiet'], signal);
  const targetSha = await git(repoRoot, ['rev-parse', '--verify', 'origin/main^{commit}'], signal);
  const common = await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal);
  return {
    targetSha,
    databasePath: join(common, 'cat-cafe-full-gate-resources.sqlite'),
    legacyLockPath: join(common, 'cat-cafe-full-gates.lock'),
  };
}

function alphaTriageTarget(options: AlphaBrowserOptions, ownerCatId: string | null, guardianCatId: string): string {
  const available = options.isAvailable ?? isCatAvailable;
  const policy = options.getEngagementPolicy ?? readEngagementPolicy;
  // Historical ownership is evidence, not consent to routine automated work.
  if (
    ownerCatId &&
    options.resolveCat(ownerCatId) === ownerCatId &&
    available(ownerCatId) &&
    policy(ownerCatId)?.quota !== 'weekly_subscription_scarce'
  ) {
    return ownerCatId;
  }
  // The guardian is the explicit selection in the owner-approved subscription.
  if (options.resolveCat(guardianCatId) !== guardianCatId || !available(guardianCatId)) {
    throw new Error(`Alpha guardian unavailable: ${guardianCatId}`);
  }
  return guardianCatId;
}

async function notifyAlphaFailure(
  options: AlphaBrowserOptions,
  ctx: ExecuteContext,
  threadId: string,
  ownerCatId: string | null,
  guardianCatId: string,
  content: string,
  idempotencyKey: string,
): Promise<void> {
  const targetCatId = alphaTriageTarget(options, ownerCatId, guardianCatId);
  if (ownerCatId && targetCatId !== ownerCatId) {
    content += `\n自动核验交给订阅守护者 ${targetCatId}；历史负责人 ${ownerCatId} 当前不接自动核验，原归属记录保留。`;
  }
  if (!ctx.deliver) throw new Error('Alpha failure delivery is required');
  await ctx.deliver({
    threadId,
    content,
    userId: options.ownerUserId,
    targetCatId,
    idempotencyKey,
    deliveryStatus: 'queued',
    sourceCategory: 'scheduled',
    priority: 'urgent',
  });
}

async function reportFailures(
  options: AlphaBrowserOptions,
  runtime: AlphaRuntime,
  subscriptionId: string,
  threadId: string,
  guardianCatId: string,
  ctx: ExecuteContext,
  failure: Record<string, unknown>,
): Promise<string[]> {
  const drafts = await runtime.alphaBrowserFailureTasks({
    ...failure,
    subscriptionId,
    resolveCat: options.resolveCat,
    readOwnerDocument: async (path: string, headSha: string) => {
      if (
        !EXACT_OID.test(headSha) ||
        !/^docs\/(?:features|plans)\/[a-zA-Z0-9._/-]+\.md$/u.test(path) ||
        path.includes('..')
      ) {
        throw new Error('Invalid alpha owner source');
      }
      return git(options.repoRoot, ['show', `${headSha}:${path}`]);
    },
  });
  const refs = [];
  for (const draft of drafts) {
    const existing = await options.tasks.getBySubject(draft.subjectKey);
    if (existing) {
      if (existing.userId !== options.ownerUserId || existing.threadId !== threadId)
        throw new Error('Alpha failure task owner conflict');
    }
    const task =
      existing ??
      (await options.tasks.upsertBySubject({
        kind: 'work',
        subjectKey: draft.subjectKey,
        threadId,
        userId: options.ownerUserId,
        createdBy: 'system',
        ownerCatId: draft.ownerCatId ? createCatId(draft.ownerCatId) : null,
        title: `[P1] Alpha ${draft.kind}: ${draft.testedHeadSha.slice(0, 10)}`,
        why: `Alpha full verification requires triage.\nRevision: ${draft.testedHeadSha}\nExecution: ${draft.jobId}:${draft.generation}\nUnits: ${draft.unitIds.join(', ')}\nOwner source: ${draft.ownerSourceRef ?? 'unresolved'}\nOwnership: ${draft.ownership}. A failing journey is evidence to investigate, not proof that its feature code is the root cause.${draft.reason ? `\nManaged execution: ${draft.managedJobId}\nReason: ${draft.reason}` : ''}`,
      }));
    // Retry the same atomic admission: one source and target, never a second trigger.
    const content = `Alpha 浏览器验证未通过：${draft.testedHeadSha}\n内部 P1：${task.id}\n${task.why}`;
    await notifyAlphaFailure(
      options,
      ctx,
      threadId,
      draft.ownerCatId,
      guardianCatId,
      content,
      `alpha-triage:${draft.jobId}:${draft.generation}:${task.id}`,
    );
    refs.push(`task:${task.id}`);
  }
  return refs;
}

// Registration goes through the existing owner-approved schedule mutation
// surface. This template does not auto-enable itself or alter main-health.
export function createAlphaBrowserTemplate(options: AlphaBrowserOptions): TaskTemplate {
  return {
    templateId: 'alpha-browser',
    label: 'Alpha 浏览器回归',
    category: 'repo',
    subjectKind: 'repo',
    description: '逐个 main revision 验证完整旅程，失败生成具名内部 P1',
    defaultTrigger: { type: 'cron', expression: '*/5 * * * *' },
    paramSchema: {
      baselineSha: {
        type: 'string',
        required: true,
        description: '订阅起点的精确 commit；其后每个 main revision 均须处置',
      },
      guardianCatId: { type: 'string', required: true, description: '归属不明或执行环境异常时负责核验的现有猫' },
      executionCarrier: {
        type: 'string',
        required: false,
        description: '执行载体：fork（默认）或 managed；在飞 revision 保持原载体',
      },
    },
    createSpec(id, params) {
      const baselineSha = typeof params.params.baselineSha === 'string' ? params.params.baselineSha : '';
      const guardian =
        typeof params.params.guardianCatId === 'string' ? options.resolveCat(params.params.guardianCatId) : null;
      const threadId = params.deliveryThreadId;
      const executionCarrier = params.params.executionCarrier ?? 'fork';
      return {
        id,
        profile: 'poller',
        trigger: params.trigger,
        admission: {
          async gate() {
            if (!EXACT_OID.test(baselineSha) || !threadId || !guardian)
              return { run: false, reason: 'exact baseline, delivery thread and verified guardian required' };
            if (!['fork', 'managed'].includes(String(executionCarrier)))
              return { run: false, reason: 'Alpha executionCarrier must be fork or managed' };
            return { run: true, workItems: [{ signal: id, subjectKey: `repo:alpha-browser:${id}` }] };
          },
        },
        run: {
          overlap: 'skip',
          timeoutMs: 3 * 60 * 60_000 + 60_000,
          async execute(_signal, _subject, ctx) {
            if (!threadId || !guardian) throw new Error('Alpha subscription is not admitted');
            const runtime = await (options.loadRuntime?.() ?? loadRuntime(options.repoRoot));
            const main = await (options.inspectMain?.(ctx.signal) ?? inspectMain(options.repoRoot, ctx.signal));
            const result = await runtime.runAlphaBrowserRevision({
              repoRoot: options.repoRoot,
              ...main,
              baselineSha,
              subscriptionId: id,
              ownerPrincipal: `schedule:${options.ownerUserId}:${id}`,
              originTaskId: id,
              signal: ctx.signal,
              executionCarrier,
              managedControl: createAlphaManagedControl({
                repoRoot: options.repoRoot,
                subscriptionId: id,
                principal: { userId: options.ownerUserId, threadId, catId: guardian },
              }),
              reportFailure: (failure: Record<string, unknown>) =>
                reportFailures(options, runtime, id, threadId, guardian, ctx, failure),
            });
            if (!['idle', 'green', 'red'].includes(result.status)) {
              throw new Error(
                `Alpha verification remains ${result.status} for ${result.headSha ?? 'unknown revision'}; ${result.reason ?? 'recover the existing execution before settlement'}`,
              );
            }
          },
        },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
        display: { label: 'Alpha 浏览器回归', category: 'repo', subjectKind: 'repo' },
      };
    },
  };
}
