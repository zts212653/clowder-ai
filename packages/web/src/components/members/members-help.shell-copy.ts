import { defineShellCopy } from '../shell/shell-copy';

export const membersHelpCopy = defineShellCopy(
  {
    zh: {
      preferenceHelp: '偏好只对符合条件且仍能接活的成员排序，不覆盖不可用状态，也不自动改派。',
      recoveryHelp: '这条记录只证明最近一次接活顺利完成，不代表长期健康或剩余额度。当前状态仍以最新读取为准。',
      recoveryEvidence: '恢复依据',
      preferenceReason: '缘由与依据',
      currentRule: '当前规则',
      reviewDue: '待复核 · 暂不用于派活',
      observedTime: (time: number) => `记录时间：${new Date(time).toLocaleString('zh-CN')}`,
      evidence: (ref: string) => `证据：${ref}`,
      revision: (version: number) => `版本 ${version}`,
    },
    en: {
      preferenceHelp:
        'Preferences rank matching members who can still take work. They do not override unavailable status or automatically reassign work.',
      recoveryHelp:
        'This record only proves that the latest work dispatch finished successfully. It does not establish long-term health or remaining quota. Current status follows the latest read.',
      recoveryEvidence: 'Recovery evidence',
      preferenceReason: 'Reason and evidence',
      currentRule: 'Current rules',
      reviewDue: 'Review due · not used for work assignment',
      observedTime: (time: number) => `Recorded at: ${new Date(time).toLocaleString('en-US')}`,
      evidence: (ref: string) => `Evidence: ${ref}`,
      revision: (version: number) => `Version ${version}`,
    },
  },
  {
    samples: {
      observedTime: [[1791036658110], [1791136658110]],
      evidence: [['source-a'], ['source-b']],
      revision: [[1], [2]],
    },
  },
);
