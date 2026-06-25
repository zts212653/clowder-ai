/**
 * F245 PR2 — N-day cadence eval domain task spec.
 *
 * Split from eval-domain-daily.ts (cloud R4 P1: file-size hard limit 350 lines).
 * Daily/Weekly specs remain in eval-domain-daily.ts.
 * Callers import `createEvalDomainNDaySpec` directly from this module (no re-export
 * in eval-domain-daily.ts — circular dependency was avoided by having index.ts import
 * both modules independently).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { TaskSpec_P1 } from '../../scheduler/types.js';
import { buildEvalCatInvocation } from '../eval-cat-invocation.js';
import { ensureEvalDomainThreads } from '../hub/eval-hub-thread-ensure.js';
import { inventoryLegacyTasks } from '../legacy-task-cleanup.js';
import {
  buildPublishPrereqSkippedMessage,
  type EvalDomainScheduleOpts,
  evaluatePublishPrereq,
} from './eval-domain-daily.js';
import { getEvalCatOverride } from './eval-domain-override.js';
import { type EvalDomainRegistryEntry, parseEvalDomainRegistryFile } from './eval-domain-registry.js';

// ---- N-day cadence helpers ----

/**
 * Parse N from `every-Nd` frequency string.
 * Returns null if the frequency is not N-day format.
 *
 * @example parseNDayFrequency('every-3d') === 3
 * @example parseNDayFrequency('weekly') === null
 */
export function parseNDayFrequency(frequency: string): number | null {
  const m = /^every-(\d+)d$/.exec(frequency);
  return m ? parseInt(m[1], 10) : null;
}

/** Load domains with N-day (`every-Nd`) frequency from the registry. */
function loadNDayDomains(harnessFeedbackRoot: string): EvalDomainRegistryEntry[] {
  const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
  if (!existsSync(domainsDir)) return [];
  return readdirSync(domainsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
    .map((e) => parseEvalDomainRegistryFile(parseYaml(readFileSync(join(domainsDir, e.name), 'utf8'))))
    .filter((d) => parseNDayFrequency(d.frequency) !== null)
    .filter((d) => d.enabled !== false);
}

// ---- N-day factory ----

/**
 * F245 PR2 — N-day cadence eval domain task spec.
 *
 * Runs on the **daily cron** (`0 3 * * *`) but applies a per-domain
 * last-run gate: domains with `frequency: every-Nd` are only included in
 * the work batch when `Date.now() - lastDispatchMs >= N * 86400000`.
 *
 * Last dispatch time is stored in Redis:
 *   key  = `eval-nday-last-dispatch:{domainId}`
 *   value = epoch ms as string (no TTL)
 *
 * **Fail-open** when Redis is unavailable: all N-day domains are treated as
 * due and invoked (better than silently dropping them).
 *
 * After a successful `ctx.deliver()` call, the Redis key is updated so the
 * next daily cron fire skips the domain for the remaining N-day window.
 */
export function createEvalDomainNDaySpec(opts: EvalDomainScheduleOpts): TaskSpec_P1<EvalDomainRegistryEntry> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Cloud R1 P2: absorb trigger-processing latency. Without this, a Redis write at 03:00:05
  // on day D would be ~5 s short of the N*DAY_MS window at the next 03:00:00 probe, causing
  // the domain to slip an extra day. 2-min grace comfortably covers cron processing jitter
  // while staying far below any meaningful cadence threshold (min cadence = every-1d = 1440 min).
  const CRON_JITTER_MS = 2 * 60 * 1000;

  return {
    id: 'eval-domain-nday',
    profile: 'awareness',
    trigger: { type: 'cron', expression: '0 3 * * *', timezone: 'UTC' },
    admission: {
      async gate() {
        const allNDay = loadNDayDomains(opts.harnessFeedbackRoot);
        if (allNDay.length === 0) return { run: false, reason: 'no registered eval domains' };

        // For each domain, check Redis last-dispatch. Fail-open when Redis missing.
        const dueDomains: EvalDomainRegistryEntry[] = [];
        for (const domain of allNDay) {
          const nDays = parseNDayFrequency(domain.frequency);
          if (nDays === null) continue; // shouldn't happen (loadNDayDomains filters), but be safe

          let isDue = true; // fail-open default
          if (opts.redis) {
            try {
              const raw = await opts.redis.get(`eval-nday-last-dispatch:${domain.domainId}`);
              if (raw !== null) {
                const lastMs = parseInt(raw, 10);
                if (Number.isFinite(lastMs)) {
                  // Cloud R1 P2: subtract CRON_JITTER_MS so the gate is "N days minus 2 min"
                  // rather than exact milliseconds — cron fires at 03:00 UTC, Redis write
                  // completes seconds later; without the grace, the probe at 03:00:00 (N days
                  // after dispatch at 03:00:05) is ~5 s short and skips the domain for a full
                  // extra day.
                  isDue = Date.now() - lastMs >= nDays * DAY_MS - CRON_JITTER_MS;
                }
                // Cloud R2 P2: malformed / non-numeric value → treat as missing key (fail-open).
                // isDue stays true so the domain is retried on the next probe rather than
                // being silently skipped until the corrupt key is manually removed.
              }
            } catch {
              // Redis error → fail-open (include domain)
              isDue = true;
            }
          }

          if (isDue) dueDomains.push(domain);
        }

        if (dueDomains.length === 0) {
          return { run: false, reason: 'all N-day domains skipped — cadence not due' };
        }

        // Cloud R1 P2: parity with daily/weekly gate — skip N-day domains whose legacy tasks
        // are still enabled to prevent double-trigger (N-day cron fires + legacy harness task
        // still running in parallel). Matches the filter in createEvalDomainSpec lines 157-161.
        const activeTasks = opts.listDynamicTasks?.() ?? [];
        const eligibleDomains = dueDomains.filter((d) => {
          const legacyActive = inventoryLegacyTasks(d, activeTasks).filter((t) => t.enabled);
          return legacyActive.length === 0;
        });
        if (eligibleDomains.length === 0) {
          return { run: false, reason: 'all N-day domains skipped — cadence not due or active legacy tasks' };
        }
        return {
          run: true,
          workItems: eligibleDomains.map((d) => ({ signal: d, subjectKey: d.domainId })),
        };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 60_000,
      async execute(domain, _subjectKey, ctx) {
        // Ensure system thread exists (same guard as daily/weekly spec)
        if (opts.threadStore) {
          await ensureEvalDomainThreads(
            opts.threadStore,
            [{ domainId: domain.domainId, systemThreadId: domain.systemThreadId, displayName: domain.displayName }],
            opts.defaultUserId,
          );
        }

        // Direction B publish-prereq gate (same as daily/weekly spec)
        if (opts.publishPrereqProbe) {
          const prereqOk = await evaluatePublishPrereq(opts.publishPrereqProbe, domain.domainId);
          if (!prereqOk) {
            if (ctx.deliver) {
              await ctx.deliver({
                threadId: domain.systemThreadId,
                content: buildPublishPrereqSkippedMessage(domain),
                userId: 'scheduler',
              });
            }
            return;
          }
        }

        // OQ-20: Apply Redis evalCat override
        let effectiveDomain = domain;
        if (opts.redis) {
          try {
            const override = await getEvalCatOverride(opts.redis, domain.domainId);
            if (override) {
              effectiveDomain = {
                ...domain,
                evalCat: { catId: override.catId, handle: override.handle, model: override.model },
              };
            }
          } catch {
            // Redis error → use static registry cat
          }
        }

        const activeTasks = opts.listDynamicTasks?.() ?? [];
        const enabledLegacy = inventoryLegacyTasks(domain, activeTasks).filter((t) => t.enabled);
        const legacyStatus = enabledLegacy.length > 0 ? 'dry_run_ready' : 'disabled';

        const invocation = buildEvalCatInvocation(
          { domain: effectiveDomain, trendRefs: [], verdictRefs: [], legacyCleanup: { status: legacyStatus } },
          { wiredPublishDomains: opts.wiredPublishDomains },
        );

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

          // F245 PR2 (gpt52 R1 P1 fix): await trigger BEFORE writing Redis.
          // If trigger fails, eval cat was never notified — do NOT trip the N-day
          // gate (original order wrote Redis before trigger, causing a silent N-day
          // skip on transient trigger failure even though no eval ran).
          //
          // No invokeTrigger = message is in thread, EYES-driven pickup = dispatched.
          let triggered = !ctx.invokeTrigger;
          if (ctx.invokeTrigger && messageId) {
            const triggerUserId = opts.defaultUserId ?? 'default-user';
            try {
              const outcome = await ctx.invokeTrigger.trigger(
                invocation.targetThreadId,
                invocation.evalCat.catId,
                triggerUserId,
                `N-day eval: ${invocation.domainId}`,
                messageId,
              );
              // Cloud R3 P1: treat 'full' (queue at capacity, invocation dropped) the same
              // as a throw — Redis NOT written so the domain retries on the next daily probe
              // rather than being silently suppressed for a full N-day window.
              triggered = outcome !== 'full';
            } catch {
              // Trigger failed — Redis NOT written, domain retried on next daily probe
            }
          }

          // Write last-dispatch only when trigger succeeded (or no trigger available)
          if (opts.redis && triggered) {
            try {
              await opts.redis.set(`eval-nday-last-dispatch:${domain.domainId}`, Date.now().toString());
            } catch {
              // Best-effort: Redis write failure should not fail the eval task
            }
          }
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    display: {
      label: 'N天周期 Harness Eval',
      category: 'system',
      description:
        'N-day cadence harness eval — reads domain registry, triggers eval cat for every-Nd frequency domains',
      subjectKind: 'none',
    },
  };
}
