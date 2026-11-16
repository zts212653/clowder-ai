import { defineShellCopy } from '../shell/shell-copy';

export const claudeQuotaCopy = defineShellCopy(
  {
    zh: {
      check: '读取余量',
      reading: '正在读取…',
      unknown: '尚无可确认的读数',
      hint: '通过官方 Claude 发送两条最小请求（Haiku、Fable）读取此号余量',
      unavailable: '这次未能读到余量，请重试',
      changed: '此号的登录已变化，请刷新账号列表后重试',
      ownerUnknown: '无法确认此号的登录，请先核对登录状态',
      resetElapsed: '已过重置时间',
      resetUnknown: '重置时间未知',
      stale: '上次读数',
      fiveHour: '5 小时',
      weekly: '本周（全部模型）',
      fable: '本周（Fable）',
      left: (value: string) => `剩 ${value}%`,
      observed: (time: string) => `采集于 ${time}`,
      resets: (time: string) => `${time} 重置`,
    },
    en: {
      check: 'Read quota',
      reading: 'Reading…',
      unknown: 'No verified reading yet',
      hint: 'Send two minimal requests through official Claude (Haiku and Fable) to read this account',
      unavailable: 'Could not read quota this time. Try again.',
      changed: 'This account sign-in changed. Refresh the account list and try again.',
      ownerUnknown: 'Cannot verify this account sign-in. Check its login first.',
      resetElapsed: 'Reset time has passed',
      resetUnknown: 'Reset time unknown',
      stale: 'Last reading',
      fiveHour: '5 hours',
      weekly: 'Week (all models)',
      fable: 'Week (Fable)',
      left: (value: string) => `${value}% left`,
      observed: (time: string) => `Observed ${time}`,
      resets: (time: string) => `Resets ${time}`,
    },
  },
  {
    samples: {
      left: [['0'], ['12'], ['100']],
      observed: [['11/16 14:00'], ['11/17 08:30']],
      resets: [['11/16 15:00'], ['11/23 20:00']],
    },
  },
);
