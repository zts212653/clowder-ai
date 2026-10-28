import { defineShellCopy } from './shell/shell-copy';

export const codexStartupCopy = defineShellCopy(
  {
    zh: {
      checking: '正在确认 Codex 账号…',
      recovering: '暂时无法完成 Codex 账号确认，正在自动重试。本次任务尚未开始，无需重新发送。',
      retry: (attempt: number, seconds: number) => `第 ${attempt} 次尝试将在 ${seconds} 秒后开始`,
      attempt: (attempt: number) => `正在恢复连接 · 第 ${attempt} 次账号确认`,
      recovered: (attempt: number) => `账号确认已恢复，尝试 ${attempt} 次`,
      stopped: '已停止本次启动',
      interrupted: '本次启动已中断，可在原线程重新唤醒该猫。',
      details: '查看详细错误',
      step: '失败步骤：账号确认',
      causeMissing: 'Codex 未提供更具体的原因',
      evidenceAttempt: (attempt: number) => `错误来自第 ${attempt} 次尝试`,
      attempts: (attempt: number, seconds: number) => `已尝试 ${attempt} 次 · 耗时 ${seconds} 秒`,
    },
    en: {
      checking: 'Confirming the Codex account…',
      recovering:
        'Unable to confirm the Codex account yet. Retrying automatically. This task has not started; there is no need to resend it.',
      retry: (attempt: number, seconds: number) => `Attempt ${attempt} starts in ${seconds} seconds`,
      attempt: (attempt: number) => `Reconnecting · Account check ${attempt}`,
      recovered: (attempt: number) => `Account confirmation recovered after ${attempt} attempts`,
      stopped: 'Startup stopped',
      interrupted: 'Startup was interrupted. You can wake this member again in the original conversation.',
      details: 'View error details',
      step: 'Failed step: account confirmation',
      causeMissing: 'Codex did not provide a more specific cause',
      evidenceAttempt: (attempt: number) => `Error returned by attempt ${attempt}`,
      attempts: (attempt: number, seconds: number) => `${attempt} attempts · ${seconds} seconds elapsed`,
    },
  },
  {
    samples: {
      retry: [
        [2, 5],
        [6, 30],
      ],
      attempt: [[1], [6]],
      recovered: [[2], [6]],
      evidenceAttempt: [[1], [6]],
      attempts: [
        [1, 2],
        [6, 120],
      ],
    },
  },
);
