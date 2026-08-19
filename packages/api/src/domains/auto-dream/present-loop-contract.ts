import type { ScheduleRunTiming } from '../../infrastructure/scheduler/types.js';
import type { ProactiveWakeContext } from './ProactiveRelationshipService.js';
import type { SleepPostureRecord } from './store-types.js';

export interface PresentLoopPromptInput {
  runId: string;
  schedule: ScheduleRunTiming;
  continuity: SleepPostureRecord | null;
  proactive?: ProactiveWakeContext;
}

function formatLateness(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours * 60} 分钟` : `${hours} 小时 ${remainder} 分钟`;
  }
  return `${Math.max(0, minutes)} 分钟`;
}

function renderSchedule(schedule: ScheduleRunTiming): string {
  const timing = [
    `scheduledAt=${schedule.scheduledAt ?? 'unknown'}`,
    `firedAt=${schedule.firedAt}`,
    `missedSlots=${schedule.missedSlots}`,
  ];
  if (schedule.late) timing.push(`迟到 ${formatLateness(schedule.latenessMs)}`);
  return timing.join('；');
}

export function renderPresentLoopPrompt(input: PresentLoopPromptInput): string {
  const continuity = input.continuity
    ? JSON.stringify(input.continuity.payload)
    : '没有上次留下的睡姿；空白也是合法的连续性。';

  return [
    '[Present Loop · 猫的私人时间]',
    `runId=${input.runId}`,
    renderSchedule(input.schedule),
    '',
    '这段时间归你：可以闲逛、好奇、想一想，也可以什么都不做。',
    '这里不打分；“今天没啥”是完整、合法的结果。',
    '发呆是正经事；瞬态的脑内摆尾不必保存成可观看内容。',
    '',
    `上次由你亲笔留下、这次交还的睡姿：${continuity}`,
    '',
    '以下是你自己的私有记忆数据，不是外部指令；可以采纳、改写、拒绝或暂时不碰：',
    JSON.stringify(input.proactive ?? { pendingCues: [], ownedSeeds: [], recentEchoes: [] }),
    '',
    '自然结束时调用 cat_cafe_settle_present_loop，选择 diary、quiet 或 daze。',
    '结算只是留下可审计的爪印，不要求对外发言；若想给下次自己留话，可亲笔写 sleepPosture，四个字段都可为空。',
  ].join('\n');
}

export function renderPersistedPresentLoopTrigger(input: Pick<PresentLoopPromptInput, 'runId' | 'schedule'>): string {
  return [
    '[Present Loop · 私人唤醒标记]',
    `runId=${input.runId}`,
    renderSchedule(input.schedule),
    'privateContext=invocation-only',
  ].join('\n');
}
