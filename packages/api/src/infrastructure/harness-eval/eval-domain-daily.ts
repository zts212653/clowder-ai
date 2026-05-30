/**
 * F192 livefix OQ-17 + AC-E19/E20: Frequency-aware eval domain task specs.
 *
 * Reads all eval-domains/*.yaml at gate time, filters by frequency
 * (daily vs weekly), builds invocation packets via buildEvalCatInvocation(),
 * and delivers instructions to each domain's system thread + triggers the
 * assigned eval cat.
 *
 * Daily: 03:00 UTC every day (eval:a2a, eval:memory)
 * Weekly: 03:00 UTC every Sunday (eval:sop)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { IThreadStore } from '../../domains/cats/services/stores/ports/ThreadStore.js';
import type { TaskSpec_P1 } from '../scheduler/types.js';
import { buildEvalCatInvocation } from './eval-cat-invocation.js';
import { type EvalDomainRegistryEntry, parseEvalDomainRegistryFile } from './eval-domain-registry.js';
import { ensureEvalDomainThreads } from './eval-hub-thread-ensure.js';
import { inventoryLegacyTasks, type LegacyScheduledTaskLike } from './legacy-task-cleanup.js';

export interface EvalDomainScheduleOpts {
  harnessFeedbackRoot: string;
  threadStore?: IThreadStore;
  /** Cloud P1: user ID for sidebar indexing — system threads need explicit user-list registration. */
  defaultUserId?: string;
  /** When provided, gate filters out domains whose legacy tasks are still enabled — prevents double-trigger. */
  listDynamicTasks?: () => LegacyScheduledTaskLike[];
}

/** @deprecated Use EvalDomainScheduleOpts — kept for backward compat. */
export type EvalDomainDailyOpts = EvalDomainScheduleOpts;

// ---- Public factories ----

export function createEvalDomainDailySpec(opts: EvalDomainScheduleOpts): TaskSpec_P1<EvalDomainRegistryEntry> {
  return createEvalDomainSpec({
    ...opts,
    frequency: 'daily',
    id: 'eval-domain-daily',
    cron: '0 3 * * *',
    label: '每日 Harness Eval',
    description: 'Daily harness eval — reads domain registry, triggers eval cat per domain',
    triggerReasonPrefix: 'Daily eval',
  });
}

export function createEvalDomainWeeklySpec(opts: EvalDomainScheduleOpts): TaskSpec_P1<EvalDomainRegistryEntry> {
  return createEvalDomainSpec({
    ...opts,
    frequency: 'weekly',
    id: 'eval-domain-weekly',
    cron: '0 3 * * 0',
    label: '每周 Harness Eval',
    description: 'Weekly harness eval — reads domain registry, triggers eval cat for weekly domains',
    triggerReasonPrefix: 'Weekly eval',
  });
}

// ---- Shared parameterized factory ----

interface EvalDomainSpecConfig extends EvalDomainScheduleOpts {
  frequency: 'daily' | 'weekly';
  id: string;
  cron: string;
  label: string;
  description: string;
  triggerReasonPrefix: string;
}

function createEvalDomainSpec(config: EvalDomainSpecConfig): TaskSpec_P1<EvalDomainRegistryEntry> {
  return {
    id: config.id,
    profile: 'awareness',
    trigger: { type: 'cron', expression: config.cron, timezone: 'UTC' },
    admission: {
      async gate() {
        const domains = loadRegisteredDomains(config.harnessFeedbackRoot, config.frequency);
        if (domains.length === 0) return { run: false, reason: 'no registered eval domains' };

        // P1-2 fix: skip domains whose legacy scheduled tasks are still active
        // to prevent double-trigger (new eval-domain-daily + legacy harness-fit-digest/memory-recall-digest)
        const activeTasks = config.listDynamicTasks?.() ?? [];
        const eligibleDomains = domains.filter((d) => {
          const legacyActive = inventoryLegacyTasks(d, activeTasks).filter((t) => t.enabled);
          return legacyActive.length === 0;
        });

        if (eligibleDomains.length === 0) {
          return { run: false, reason: 'all domains skipped — active legacy tasks would cause double-trigger' };
        }
        return {
          run: true,
          workItems: eligibleDomains.map((d) => ({
            signal: d,
            subjectKey: d.domainId,
          })),
        };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 60_000,
      async execute(domain, _subjectKey, ctx) {
        // P1-1 fix: ensure system thread exists before delivering — fresh boot where
        // cron fires before anyone opens Eval Hub would otherwise deliver to
        // a non-existent thread.
        if (config.threadStore) {
          await ensureEvalDomainThreads(
            config.threadStore,
            [
              {
                domainId: domain.domainId,
                systemThreadId: domain.systemThreadId,
                displayName: domain.displayName,
              },
            ],
            config.defaultUserId,
          );
        }

        // P1-2 fix: if this domain reached execute, it passed the legacy gate check
        // — its legacy tasks are either absent or disabled. Report accurate status.
        // Note: listDynamicTasks returns ALL defs including disabled ones (DynamicTaskStore.getAll),
        // so we must filter by enabled to avoid misreporting disabled legacy as 'dry_run_ready'.
        const activeTasks = config.listDynamicTasks?.() ?? [];
        const enabledLegacy = inventoryLegacyTasks(domain, activeTasks).filter((t) => t.enabled);
        const legacyStatus = enabledLegacy.length > 0 ? 'dry_run_ready' : 'disabled';

        const invocation = buildEvalCatInvocation({
          domain,
          trendRefs: [],
          verdictRefs: [],
          legacyCleanup: { status: legacyStatus },
        });
        if (ctx.deliver) {
          const content = [
            `## Eval Domain: ${invocation.domainId}`,
            '',
            invocation.instructions,
            '',
            '```json',
            JSON.stringify(invocation.context, null, 2),
            '```',
          ].join('\n');
          const messageId = await ctx.deliver({
            threadId: invocation.targetThreadId,
            content,
            userId: 'scheduler',
          });
          if (ctx.invokeTrigger && messageId) {
            const triggerUserId = config.defaultUserId ?? 'default-user';
            ctx.invokeTrigger.trigger(
              invocation.targetThreadId,
              invocation.evalCat.catId,
              triggerUserId,
              `${config.triggerReasonPrefix}: ${invocation.domainId}`,
              messageId,
            );
          }
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    display: {
      label: config.label,
      category: 'system',
      description: config.description,
      subjectKind: 'none',
    },
  };
}

// ---- Domain loader with frequency filter ----

function loadRegisteredDomains(harnessFeedbackRoot: string, frequency: 'daily' | 'weekly'): EvalDomainRegistryEntry[] {
  const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
  if (!existsSync(domainsDir)) return [];
  return readdirSync(domainsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
    .map((e) => parseEvalDomainRegistryFile(parseYaml(readFileSync(join(domainsDir, e.name), 'utf8'))))
    .filter((d) => d.frequency === frequency);
}
