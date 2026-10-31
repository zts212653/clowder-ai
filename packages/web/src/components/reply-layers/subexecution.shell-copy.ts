import { defineShellCopy } from '../shell/shell-copy';
import type { ReplySubexecutionRecord } from './reply-subexecution';

export const subexecutionCopy = defineShellCopy(
  {
    zh: {
      title: '子代理',
      total: (n: number) => `子代理 ${n}`,
      runningCount: (n: number) => `${n} 个运行中`,
      failedCount: (n: number) => `${n} 个失败`,
      interruptedCount: (n: number) => `${n} 个已中断`,
      allFinished: '都完成了',
      running: '运行中',
      completed: '完成',
      failed: '失败',
      interrupted: '已中断',
      latest: '最新进展',
      progress: '进展',
      final: '最终回报',
      unknown: '消息阶段未确认',
      noMessage: '尚无子代理消息',
      taskId: '任务标识',
      zeroDuration: '0 秒',
      earlier: (n: number) => `之前的 ${n} 条进展`,
      ownTools: (n: number) => `这只猫自己的 ${n} 次工具调用`,
    },
    en: {
      title: 'Subagents',
      total: (n: number) => `Subagents ${n}`,
      runningCount: (n: number) => `${n} running`,
      failedCount: (n: number) => `${n} failed`,
      interruptedCount: (n: number) => `${n} interrupted`,
      allFinished: 'All finished',
      running: 'Running',
      completed: 'Finished',
      failed: 'Failed',
      interrupted: 'Interrupted',
      latest: 'Latest progress',
      progress: 'Progress',
      final: 'Final report',
      unknown: 'Message phase unconfirmed',
      noMessage: 'No subagent message recorded',
      taskId: 'Task ID',
      zeroDuration: '0s',
      earlier: (n: number) => `Earlier ${n} updates`,
      ownTools: (n: number) => `This cat’s ${n} tool calls`,
    },
  },
  {
    samples: {
      total: [[1], [8]],
      runningCount: [[1], [2]],
      failedCount: [[1], [2]],
      interruptedCount: [[1], [2]],
      earlier: [[1], [12]],
      ownTools: [[1], [12]],
    },
  },
);

export function subexecutionSummaryParts(t: typeof subexecutionCopy.zh, record: ReplySubexecutionRecord): string[] {
  const parts = [t.total(record.total)];
  if (record.completed === record.total) parts.push(t.allFinished);
  else {
    if (record.running) parts.push(t.runningCount(record.running));
    if (record.failed) parts.push(t.failedCount(record.failed));
    if (record.interrupted) parts.push(t.interruptedCount(record.interrupted));
  }
  return parts;
}

export function subexecutionSummary(t: typeof subexecutionCopy.zh, record: ReplySubexecutionRecord): string {
  return subexecutionSummaryParts(t, record).join(' · ');
}
