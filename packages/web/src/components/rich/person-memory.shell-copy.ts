import { defineShellCopy } from '../shell/shell-copy';
export const personMemoryCopy = defineShellCopy(
  {
    zh: {
      kind: '记人的记忆',
      person: (name: string) => `关于 ${name}`,
      subject: (name: string, n: number) => `关于 ${name} · ${n} 条草稿`,
      unverified: '暂时无法核实这条原提议，请重新读取。',
      reopened: '提议已重新打开',
      reread: '重新读取',
      original: '原卡内容',
      checking: '正在核验原提议…',
      written: '已写入',
      partial: '部分已写入，可继续选择',
      rejected: '已拒绝',
      rejectedAfterWrite: (n: number | null) => (n === null ? '此前已写入 · 其余没写' : `已写入 ${n} 条 · 其余没写`),
      writesRemain: '此前写入仍保留',
      withdrawn: '已撤回',
      undone: '已撤销本次写入',
      deferred: '已留待稍后',
      undo: '撤销本次写入',
      undoing: '正在撤销…',
      undoFailed: '撤销失败，请重新读取后重试。',
      receipt: (facts: number, relationships: number, events: number) =>
        `${facts} 条事实 · ${relationships} 条关系 · ${events} 个事件`,
      reversible: '只写入勾选的内容；写入后可以撤销。',
    },
    en: {
      kind: 'Person memory',
      person: (name: string) => `About ${name}`,
      subject: (name: string, n: number) => `About ${name} · ${n} drafts`,
      unverified: 'The original proposal could not be verified. Read again.',
      reopened: 'Proposal reopened',
      reread: 'Read again',
      original: 'Original card content',
      checking: 'Checking the original proposal…',
      written: 'Written to memory',
      partial: 'Partly written; choose remaining drafts',
      rejected: 'Declined',
      rejectedAfterWrite: (n: number | null) =>
        n === null ? 'Earlier writes remain · rest declined' : `Wrote ${n} · rest declined`,
      writesRemain: 'Earlier writes remain',
      withdrawn: 'Withdrawn',
      undone: 'This write was undone',
      deferred: 'Saved for later',
      undo: 'Undo this write',
      undoing: 'Undoing…',
      undoFailed: 'Undo failed. Read again and retry.',
      receipt: (facts: number, relationships: number, events: number) =>
        `${facts} ${facts === 1 ? 'fact' : 'facts'} · ${relationships} ${relationships === 1 ? 'relationship' : 'relationships'} · ${events} ${events === 1 ? 'event' : 'events'}`,
      reversible: 'Only selected drafts are written. You can undo a write.',
    },
  },
  {
    samples: {
      rejectedAfterWrite: [[null], [2]],
      person: [['林'], ['Lin']],
      subject: [
        ['林', 0],
        ['Lin', 2],
      ],
      receipt: [
        [0, 0, 0],
        [1, 2, 3],
      ],
    },
  },
);
