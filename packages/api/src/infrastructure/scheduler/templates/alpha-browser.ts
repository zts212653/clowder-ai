import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createCatId } from '@cat-cafe/shared';
import type { ITaskStore } from '../../../domains/cats/services/stores/ports/TaskStore.js';
import type { ExecuteContext } from '../types.js';
import type { TaskTemplate } from './types.js';

const exec = promisify(execFile);
const EXACT_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
// Public exports carry the API but not the private full-gate execution plane.
// Advertise this optional schedule only where its owned runtime is installed.
export function supportsAlphaBrowserVerification(repoRoot: string): boolean {
  return [
    'alpha-browser-runner.mjs',
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
}
interface AlphaRuntime {
  executionApi: { GATE_EXECUTION_API_VERSION: number };
  runAlphaBrowserRevision(input: Record<string, unknown>): Promise<{ status: string; headSha?: string }>;
  withAlphaBrowserCheckout(input: Record<string, unknown>, run: unknown): Promise<unknown>;
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
  loadRuntime?: () => Promise<AlphaRuntime>;
  inspectMain?: (signal: AbortSignal) => Promise<MainProjection>;
}

async function git(repoRoot: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (await exec('git', args, { cwd: repoRoot, signal, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}
async function loadRuntime(repoRoot: string): Promise<AlphaRuntime> {
  const load = (name: string) => import(pathToFileURL(join(repoRoot, 'scripts/lib', name)).href);
  const [runner, checkout, failures, executionApi] = await Promise.all([
    load('alpha-browser-runner.mjs'),
    load('alpha-browser-checkout.mjs'),
    load('alpha-browser-failures.mjs'),
    load('gate-execution-api.mjs'),
  ]);
  if (executionApi.GATE_EXECUTION_API_VERSION !== 1) throw new Error('Unsupported alpha gate execution API');
  return { ...runner, ...checkout, ...failures, executionApi } as AlphaRuntime;
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

async function notifyAlphaFailure(
  ctx: ExecuteContext,
  threadId: string,
  ownerUserId: string,
  targetCatId: string,
  content: string,
): Promise<void> {
  if (!ctx.deliver || !ctx.invokeTrigger) throw new Error('Alpha failure delivery and trigger are required');
  const source = await ctx.deliver({ threadId, content, userId: 'scheduler' });
  const outcome = await ctx.invokeTrigger.trigger(threadId, targetCatId, ownerUserId, content, source, undefined, {
    reason: 'scheduled_alpha_browser_triage',
    sourceCategory: 'scheduled',
    priority: 'urgent',
  });
  if (outcome !== 'dispatched' && outcome !== 'enqueued') throw new Error(`Alpha wake not accepted: ${outcome}`);
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
        why: `Alpha full verification requires triage.\nRevision: ${draft.testedHeadSha}\nExecution: ${draft.jobId}:${draft.generation}\nUnits: ${draft.unitIds.join(', ')}\nOwner source: ${draft.ownerSourceRef ?? 'unresolved'}\nOwnership: ${draft.ownership}. A failing journey is evidence to investigate, not proof that its feature code is the root cause.`,
      }));
    // Task identity and notification completion are different facts. Replays
    // retain the one Task but retry delivery/trigger until both have succeeded.
    // Duplicate notifications after a crash are preferable to silently losing
    // the owner/guardian wake and settling an unhandled revision.
    const content = `Alpha 浏览器验证未通过：${draft.testedHeadSha}\n内部 P1：${task.id}\n${task.why}`;
    await notifyAlphaFailure(ctx, threadId, options.ownerUserId, draft.ownerCatId ?? guardianCatId, content);
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
    },
    createSpec(id, params) {
      const baselineSha = typeof params.params.baselineSha === 'string' ? params.params.baselineSha : '';
      const guardian =
        typeof params.params.guardianCatId === 'string' ? options.resolveCat(params.params.guardianCatId) : null;
      const threadId = params.deliveryThreadId;
      return {
        id,
        profile: 'poller',
        trigger: params.trigger,
        admission: {
          async gate() {
            if (!EXACT_OID.test(baselineSha) || !threadId || !guardian)
              return { run: false, reason: 'exact baseline, delivery thread and verified guardian required' };
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
              executionApi: runtime.executionApi,
              withCheckout: (revision: unknown, run: unknown) =>
                runtime.withAlphaBrowserCheckout({ repoRoot: options.repoRoot, subscriptionId: id, revision }, run),
              reportFailure: (failure: Record<string, unknown>) =>
                reportFailures(options, runtime, id, threadId, guardian, ctx, failure),
            });
            if (!['idle', 'green', 'red'].includes(result.status)) {
              throw new Error(
                `Alpha verification remains ${result.status} for ${result.headSha ?? 'unknown revision'}; recover the existing execution before settlement`,
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
