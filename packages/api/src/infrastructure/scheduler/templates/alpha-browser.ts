import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { InvocationQueue } from '../../../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../domains/cats/services/stores/ports/TaskStore.js';
import type { EngagementPolicyReader } from '../../../domains/routing-context/ScarceSeatNotificationPolicy.js';
import { reportAlphaFailures, resolveAlphaFailureTriageCat } from './alpha-browser-reporting.js';
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
    'alpha-browser-failure-signature.mjs',
    'gate-execution-api.mjs',
  ].every((name) => existsSync(join(repoRoot, 'scripts/lib', name)));
}
export interface FailureDraft {
  incidentKey?: string;
  failureSummary?: string;
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
export interface AlphaRuntime {
  runAlphaBrowserRevision(
    input: Record<string, unknown>,
  ): Promise<{ status: string; headSha?: string; reason?: string }>;
  alphaBrowserFailureTasks(input: Record<string, unknown>): Promise<FailureDraft[]>;
}
type MainProjection = {
  databasePath: string;
  legacyLockPath: string;
} & ({ targetSha: string; discoveryError?: never } | { targetSha?: never; discoveryError: string });
export interface AlphaBrowserOptions {
  repoRoot: string;
  ownerUserId: string;
  tasks: Pick<ITaskStore, 'getBySubject' | 'upsertBySubject'>;
  messages: Pick<IMessageStore, 'getByIdempotencyKey' | 'getById'>;
  queue: Pick<InvocationQueue, 'getDurableEntry'>;
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
  const common = await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal);
  const storage = {
    databasePath: join(common, 'cat-cafe-full-gate-resources.sqlite'),
    legacyLockPath: join(common, 'cat-cafe-full-gates.lock'),
  };
  try {
    const advertised = await git(repoRoot, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], signal);
    const [targetSha, remoteRef, extra] = advertised.split(/\s+/u);
    if (!targetSha || !EXACT_OID.test(targetSha) || remoteRef !== 'refs/heads/main' || extra !== undefined) {
      throw new Error('Alpha discovery requires one exact remote main commit');
    }
    // Worktrees share remote-tracking refs. Fetch only the advertised objects;
    // failure supplies no target, never stale main or a partially fetched ref.
    await git(
      repoRoot,
      ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--refmap=', 'origin', targetSha],
      signal,
    );
    if ((await git(repoRoot, ['rev-parse', '--verify', `${targetSha}^{commit}`], signal)) !== targetSha) {
      throw new Error('Alpha remote main commit identity mismatch');
    }
    return { ...storage, targetSha };
  } catch (error) {
    signal.throwIfAborted();
    // Already enrolled work has its own exact identity and settlement contract.
    // Preserve discovery failure for the scheduler after that work is consumed.
    return { ...storage, discoveryError: error instanceof Error ? error.message : String(error) };
  }
}

function describeAlphaExecutionFailure(message: string, discoveryError: string | undefined): string {
  if (discoveryError === undefined) return message;
  // The scheduler ledger keeps only the first 500 characters. Reserve space for
  // both causes there, while the full logger still receives both original texts.
  const oneLine = discoveryError.replace(/\s+/gu, ' ');
  const summary = oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 80)}…${oneLine.slice(-79)}`;
  return `Alpha discovery unavailable: ${summary}; ${message}\nDiscovery details: ${discoveryError}`;
}

function rethrowWithDiscoveryContext(error: unknown, discoveryError: string | undefined, signal: AbortSignal): never {
  if (signal.aborted || discoveryError === undefined) throw error;
  throw new Error(
    describeAlphaExecutionFailure(error instanceof Error ? error.message : String(error), discoveryError),
    {
      cause: error,
    },
  );
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
      failureTriageCatId: {
        type: 'string',
        required: false,
        description: '可选值守猫 stable ID；负责新修复任务的调查与推进，保留产品原归属和既有任务',
      },
      executionCarrier: {
        type: 'string',
        required: false,
        enum: ['fork', 'managed'],
        description: '执行载体：fork（默认）或 managed；在飞 revision 保持原载体',
      },
    },
    createSpec(id, params) {
      const baselineSha = typeof params.params.baselineSha === 'string' ? params.params.baselineSha : '';
      const guardian =
        typeof params.params.guardianCatId === 'string' ? options.resolveCat(params.params.guardianCatId) : null;
      const threadId = params.deliveryThreadId;
      const executionCarrier = params.params.executionCarrier ?? 'fork';
      const failureTriageCatId = params.params.failureTriageCatId;
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
            try {
              resolveAlphaFailureTriageCat(options, failureTriageCatId);
            } catch (error) {
              return { run: false, reason: error instanceof Error ? error.message : String(error) };
            }
            return { run: true, workItems: [{ signal: id, subjectKey: `repo:alpha-browser:${id}` }] };
          },
        },
        run: {
          overlap: 'skip',
          timeoutMs: 3 * 60 * 60_000 + 60_000,
          async execute(_signal, _subject, ctx) {
            if (!threadId || !guardian) throw new Error('Alpha subscription is not admitted');
            resolveAlphaFailureTriageCat(options, failureTriageCatId);
            const runtime = await (options.loadRuntime?.() ?? loadRuntime(options.repoRoot));
            const main = await (options.inspectMain?.(ctx.signal) ?? inspectMain(options.repoRoot, ctx.signal));
            const result = await runtime
              .runAlphaBrowserRevision({
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
                  reportAlphaFailures(options, runtime, id, threadId, guardian, ctx, failure, failureTriageCatId),
              })
              .catch((error: unknown) => rethrowWithDiscoveryContext(error, main.discoveryError, ctx.signal));
            if (!['idle', 'green', 'red'].includes(result.status)) {
              throw new Error(
                describeAlphaExecutionFailure(
                  `Alpha verification remains ${result.status} for ${result.headSha ?? 'unknown revision'}; ${result.reason ?? 'recover the existing execution before settlement'}`,
                  main.discoveryError,
                ),
              );
            }
            if (main.discoveryError !== undefined) {
              throw new Error(
                `Alpha discovery unavailable; enrolled revision ${result.headSha ?? 'none'}: ${result.status}. ${main.discoveryError}`,
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
