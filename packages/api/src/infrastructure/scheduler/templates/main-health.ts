import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import type { ExecuteContext, TaskSpec_P1 } from '../types.js';
import { parseHealthCommand } from './main-health-command.js';
import type { DynamicTaskParams, TaskTemplate } from './types.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 4_000;

interface MainHealthReceiptProjection {
  availability: 'available' | 'unavailable';
  headSha: string | null;
  treeSha: string | null;
  receipt: { runId: string; terminalAt: number | null } | null;
  lastGreen: { headSha: string; runId: string } | null;
  bisectCandidates: string[];
  reason?: string;
}

interface HealthCheckResult {
  status: 'green' | 'red' | 'not_run';
  outputTail: string;
}

interface LocalTreeProjection {
  headSha: string;
  treeSha: string;
  clean: boolean;
}

interface MainHealthSignal {
  repo: string;
  branch: string;
  healthCommand: string;
  guardianCatId: string;
  quarantineFile: string;
}

export interface MainHealthTemplateOptions {
  inspectReceipt?: (repo: string, branch: string, signal?: AbortSignal) => Promise<MainHealthReceiptProjection>;
  inspectLocalTree?: (repo: string, signal?: AbortSignal) => Promise<LocalTreeProjection>;
  runHealthCheck?: (repo: string, command: string, signal?: AbortSignal) => Promise<HealthCheckResult>;
  readQuarantine?: (repo: string, relativePath: string, now: number) => Promise<string | null>;
  now?: () => number;
}

type MainHealthExecutionDeps = Required<
  Pick<MainHealthTemplateOptions, 'inspectReceipt' | 'inspectLocalTree' | 'runHealthCheck' | 'readQuarantine' | 'now'>
> & { triggerUserId: string };

function tail(value: string): string {
  return value.slice(-MAX_OUTPUT_CHARS);
}

async function defaultInspectReceipt(
  repo: string,
  branch: string,
  signal?: AbortSignal,
): Promise<MainHealthReceiptProjection> {
  await execFileAsync('git', ['fetch', 'origin', branch, '--quiet'], { cwd: repo, signal });
  const reader = path.join(repo, 'scripts', 'gate-terminal-receipt.mjs');
  const { stdout } = await execFileAsync(process.execPath, [reader, 'main-health', '--head-ref', `origin/${branch}`], {
    cwd: repo,
    signal,
    maxBuffer: 256_000,
  });
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as MainHealthReceiptProjection;
}

async function defaultRunHealthCheck(repo: string, command: string, signal?: AbortSignal): Promise<HealthCheckResult> {
  const parsed = parseHealthCommand(command);
  try {
    const result = await execFileAsync(parsed.executable, parsed.args, { cwd: repo, signal, maxBuffer: 4_000_000 });
    return { status: 'green', outputTail: tail(`${result.stdout}\n${result.stderr}`.trim()) };
  } catch (error) {
    const output = error as Error & { stdout?: string; stderr?: string };
    return { status: 'red', outputTail: tail(`${output.stdout ?? ''}\n${output.stderr ?? output.message}`.trim()) };
  }
}

async function defaultInspectLocalTree(repo: string, signal?: AbortSignal): Promise<LocalTreeProjection> {
  const [revision, worktree] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], { cwd: repo, signal, maxBuffer: 16_000 }),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repo,
      signal,
      maxBuffer: 256_000,
    }),
  ]);
  const [headSha, treeSha] = revision.stdout.trim().split(/\s+/);
  if (!headSha || !treeSha) throw new Error('local checkout HEAD/tree could not be resolved');
  return { headSha, treeSha, clean: worktree.stdout.trim().length === 0 };
}

async function defaultReadQuarantine(repo: string, relativePath: string, now: number): Promise<string | null> {
  const resolvedRepo = path.resolve(repo);
  const resolvedFile = path.resolve(resolvedRepo, relativePath);
  if (!resolvedFile.startsWith(`${resolvedRepo}${path.sep}`)) throw new Error('quarantine file must stay inside repo');
  const value = JSON.parse(await readFile(resolvedFile, 'utf8')) as { expiresAt?: number; reason?: string };
  if (!Number.isFinite(value.expiresAt) || (value.expiresAt ?? 0) <= now) return null;
  return `${value.reason ?? 'project quarantine'} (expires ${new Date(value.expiresAt ?? 0).toISOString()})`;
}

function renderHealth(input: {
  repo: string;
  branch: string;
  healthCommand: string;
  status: 'green' | 'red' | 'unknown';
  check: HealthCheckResult;
  receipt: MainHealthReceiptProjection | null;
  degradedReason: string | null;
  quarantine: string | null;
}): string {
  const lines = [
    `${SCHEDULER_TRIGGER_PREFIX} Main-health guardian triage`,
    `repo: ${input.repo}`,
    `branch: ${input.branch}`,
    `status: ${input.status}`,
    `check: ${input.healthCommand} → ${input.check.status}`,
    `check output tail:\n${input.check.outputTail || '(empty)'}`,
  ];
  if (input.receipt?.receipt) lines.push(`exact-tree receipt: ${input.receipt.receipt.runId}`);
  else lines.push('exact-tree receipt: no exact-tree green receipt covers current branch HEAD');
  if (input.quarantine) lines.push(`active project quarantine: ${input.quarantine}`);
  if (input.degradedReason) lines.push(`degraded: ${input.degradedReason}`);
  if (input.status === 'red') {
    const candidates = input.receipt?.bisectCandidates ?? [];
    lines.push(`bisect candidates: ${candidates.length > 0 ? candidates.join(', ') : '(unavailable)'}`);
    lines.push('triage requested: identify the first bad candidate and route the smallest owner-scoped repair.');
  } else if (input.status === 'unknown') {
    lines.push('triage requested: restore receipt/check visibility; do not claim main green from partial evidence.');
  }
  return lines.join('\n');
}

async function readReceipt(
  input: MainHealthSignal,
  inspectReceipt: NonNullable<MainHealthTemplateOptions['inspectReceipt']>,
  signal: AbortSignal,
): Promise<{ receipt: MainHealthReceiptProjection | null; degradedReason: string | null }> {
  try {
    const receipt = await inspectReceipt(input.repo, input.branch, signal);
    return {
      receipt,
      degradedReason: receipt.availability === 'unavailable' ? (receipt.reason ?? 'receipt unavailable') : null,
    };
  } catch (error) {
    return { receipt: null, degradedReason: error instanceof Error ? error.message : String(error) };
  }
}

async function readProjectQuarantine(
  input: MainHealthSignal,
  readQuarantine: NonNullable<MainHealthTemplateOptions['readQuarantine']>,
  now: () => number,
): Promise<{ quarantine: string | null; degradedReason: string | null }> {
  if (!input.quarantineFile) return { quarantine: null, degradedReason: null };
  try {
    return { quarantine: await readQuarantine(input.repo, input.quarantineFile, now()), degradedReason: null };
  } catch (error) {
    return {
      quarantine: null,
      degradedReason: `quarantine unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function runCheckOnReceiptTree(
  input: MainHealthSignal,
  receipt: MainHealthReceiptProjection | null,
  deps: Pick<MainHealthExecutionDeps, 'inspectLocalTree' | 'runHealthCheck'>,
  signal: AbortSignal,
): Promise<{ check: HealthCheckResult; degradedReason: string | null }> {
  if (!receipt?.receipt) {
    return {
      check: { status: 'not_run', outputTail: 'skipped: current exact-tree receipt required' },
      degradedReason: null,
    };
  }
  try {
    const localTree = await deps.inspectLocalTree(input.repo, signal);
    if (!localTree.clean) {
      return {
        check: { status: 'not_run', outputTail: 'skipped: clean exact checkout required' },
        degradedReason: 'local checkout is dirty; exact receipt-covered contents are required',
      };
    }
    if (localTree.headSha !== receipt.headSha || localTree.treeSha !== receipt.treeSha) {
      return {
        check: { status: 'not_run', outputTail: 'skipped: exact checkout required' },
        degradedReason: 'local checkout HEAD/tree does not match the receipt-covered branch HEAD/tree',
      };
    }
    return { check: await deps.runHealthCheck(input.repo, input.healthCommand, signal), degradedReason: null };
  } catch (error) {
    return {
      check: { status: 'not_run', outputTail: 'skipped: exact checkout could not be verified' },
      degradedReason: `local checkout unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function executeMainHealth(
  input: MainHealthSignal,
  subjectKey: string,
  ctx: ExecuteContext,
  deps: MainHealthExecutionDeps,
): Promise<void> {
  if (!ctx.deliver) throw new Error('deliver not available');
  if (!ctx.invokeTrigger) throw new Error('invokeTrigger not available');
  const observed = await readReceipt(input, deps.inspectReceipt, ctx.signal);
  const verified = await runCheckOnReceiptTree(input, observed.receipt, deps, ctx.signal);
  const project = await readProjectQuarantine(input, deps.readQuarantine, deps.now);
  const degradedReason =
    [observed.degradedReason, verified.degradedReason, project.degradedReason]
      .filter((reason): reason is string => Boolean(reason))
      .join('; ') || null;
  const check = verified.check;
  const status = check.status === 'red' ? 'red' : observed.receipt?.receipt && !degradedReason ? 'green' : 'unknown';
  const content = renderHealth({
    repo: input.repo,
    branch: input.branch,
    healthCommand: input.healthCommand,
    status,
    check,
    receipt: observed.receipt,
    degradedReason,
    quarantine: project.quarantine,
  });
  const threadId = subjectKey.slice('thread-'.length);
  const messageId = await ctx.deliver({ threadId, content, userId: 'scheduler' });
  await ctx.invokeTrigger.trigger(threadId, input.guardianCatId, deps.triggerUserId, content, messageId, undefined, {
    reason: 'scheduled_main_health_triage',
    sourceCategory: 'scheduled',
    priority: status === 'red' ? 'urgent' : 'normal',
  });
}

export function createMainHealthTemplate(options: MainHealthTemplateOptions = {}): TaskTemplate {
  const inspectReceipt = options.inspectReceipt ?? defaultInspectReceipt;
  const inspectLocalTree = options.inspectLocalTree ?? defaultInspectLocalTree;
  const runHealthCheck = options.runHealthCheck ?? defaultRunHealthCheck;
  const readQuarantine = options.readQuarantine ?? defaultReadQuarantine;
  const now = options.now ?? Date.now;
  return {
    templateId: 'main-health',
    label: 'Main 健康守夜',
    category: 'repo',
    description: '项目显式订阅：用 exact-tree gate receipt + 便宜检查守望主分支',
    subjectKind: 'repo',
    defaultTrigger: { type: 'cron', expression: '0 * * * *' },
    paramSchema: {
      repo: { type: 'string', required: true, description: '本地项目绝对路径' },
      branch: { type: 'string', required: true, description: '远端主分支名' },
      healthCommand: { type: 'string', required: true, description: '无 shell 的便宜检查命令；禁止 gate' },
      guardianCatId: { type: 'string', required: true, description: '当前值日守门猫 stable id' },
      quarantineFile: { type: 'string', required: false, description: '项目内带 expiresAt 的 JSON quarantine 文件' },
    },
    createSpec(instanceId: string, p: DynamicTaskParams): TaskSpec_P1 {
      const repo = typeof p.params.repo === 'string' ? p.params.repo.trim() : '';
      const branch = typeof p.params.branch === 'string' ? p.params.branch.trim() : '';
      const healthCommand = typeof p.params.healthCommand === 'string' ? p.params.healthCommand.trim() : '';
      const guardianCatId = typeof p.params.guardianCatId === 'string' ? p.params.guardianCatId.trim() : '';
      const triggerUserId = typeof p.params.triggerUserId === 'string' ? p.params.triggerUserId : 'default-user';
      const quarantineFile = typeof p.params.quarantineFile === 'string' ? p.params.quarantineFile.trim() : '';
      const threadId = p.deliveryThreadId;
      return {
        id: instanceId,
        profile: 'poller',
        trigger: p.trigger,
        actor: { role: 'health-monitor', costTier: 'cheap' },
        admission: {
          async gate() {
            if (!repo || !branch || !healthCommand || !guardianCatId) {
              return { run: false, reason: 'repo, branch, healthCommand, and guardianCatId are required' };
            }
            try {
              parseHealthCommand(healthCommand);
            } catch (error) {
              return { run: false, reason: error instanceof Error ? error.message : String(error) };
            }
            if (!threadId) return { run: false, reason: 'no deliveryThreadId' };
            return {
              run: true,
              workItems: [
                {
                  signal: { repo, branch, healthCommand, guardianCatId, quarantineFile },
                  subjectKey: `thread-${threadId}`,
                },
              ],
            };
          },
        },
        run: {
          overlap: 'skip',
          timeoutMs: 10 * 60_000,
          async execute(signal, subjectKey, ctx) {
            await executeMainHealth(signal as MainHealthSignal, subjectKey, ctx, {
              inspectReceipt,
              inspectLocalTree,
              runHealthCheck,
              readQuarantine,
              now,
              triggerUserId,
            });
          },
        },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
        display: {
          label: repo ? `${path.basename(repo)} ${branch} 健康` : 'Main 健康守夜',
          category: 'repo',
          description: `${healthCommand || 'pnpm check'} + exact-tree receipt`,
          subjectKind: 'repo',
        },
      };
    },
  };
}

export const mainHealthTemplate = createMainHealthTemplate();
