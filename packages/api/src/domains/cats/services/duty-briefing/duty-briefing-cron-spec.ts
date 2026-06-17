/**
 * F233 Phase A — 值班简报 daily cron builtin spec（照 createEvalDomainDailySpec 模式）
 *
 * builtin spec（非 scheduler template）：闭包捕获 stores + adapter，execute 调 generateAndDeliverBriefing。
 * 不走 template 的 ctx（ctx 只有 deliver/fetchContent，无 stores；F233 需 6 个 store + configStore）。
 * cron daily 07:00 America/Los_Angeles（operator 时区）。
 * INV-4 幂等：taskRunnerV2.register 同 id 重复抛错，注册方 catch 静默（process restart 安全）。
 * INV-2 不静默：cron 无 fallback，degraded → error log（不吞简报）。
 */

import type { TaskSpec_P1 } from '../../../../infrastructure/scheduler/types.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import type { IBriefingConfigStore } from './BriefingConfigStore.js';
import { deliverBriefingCard, hasBriefingToday } from './briefing-delivery.js';
import type { CollectDutyBriefingDeps } from './collectDutyBriefingInput.js';
import { BRIEFING_TIMEZONE } from './constants.js';
import { generateAndDeliverBriefing } from './generateAndDeliverBriefing.js';

export const DUTY_BRIEFING_CRON_ID = 'f233-duty-briefing-daily';

export interface DutyBriefingScheduleDeps {
  collectDeps: Omit<CollectDutyBriefingDeps, 'bindingStatus' | 'now'>;
  configStore: IBriefingConfigStore;
  threadStore: Pick<IThreadStore, 'get'>;
  messageStore: Pick<IMessageStore, 'append' | 'getByThread' | 'getByThreadBefore'>;
  /** 注入 now（测试可控；生产默认 Date.now） */
  now?: () => number;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

export function createDutyBriefingDailySpec(deps: DutyBriefingScheduleDeps): TaskSpec_P1 {
  const nowFn = deps.now ?? (() => Date.now());
  return {
    id: DUTY_BRIEFING_CRON_ID,
    profile: 'awareness',
    trigger: { type: 'cron', expression: '0 7 * * *', timezone: BRIEFING_TIMEZONE },
    admission: {
      async gate() {
        return { run: true, workItems: [{ signal: null, subjectKey: 'duty-briefing' }] };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 30_000,
      async execute(_signal, _subjectKey, _ctx) {
        const nowMs = nowFn();
        const result = await generateAndDeliverBriefing({
          collectDeps: deps.collectDeps,
          configStore: deps.configStore,
          threadExists: async (tid) => (await deps.threadStore.get(tid)) != null,
          hasBriefingToday: (tid, n) => hasBriefingToday(deps.messageStore, tid, n),
          deliverCard: (tid, card) => deliverBriefingCard(deps.messageStore, tid, card, nowMs),
          // cron 无 fallbackThreadId：degraded → degraded-no-fallback（下方记 error，INV-2 不静默）
          now: nowMs,
        });
        if (result.outcome === 'degraded-no-fallback') {
          deps.log?.warn(
            { threadId: result.threadId },
            '[duty-briefing] 简报 thread 绑定失效且 cron 无 fallback — 简报未投递（需重绑）',
          );
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    display: {
      label: '值班简报',
      category: 'system',
      description: '每日 07:00（PT）值班简报',
      subjectKind: 'thread',
    },
  };
}
