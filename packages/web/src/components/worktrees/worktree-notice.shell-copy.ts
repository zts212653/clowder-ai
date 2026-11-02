import { WORKTREE_NOTICE_COPY } from '@cat-cafe/shared';
import { defineShellCopy } from '../shell/shell-copy';

export const worktreeNoticeCopy = defineShellCopy({
  zh: {
    ...WORKTREE_NOTICE_COPY.zh,
    ownerAction: '已排入负责人待办',
    ownerUnavailable: '未排入负责人待办 · 待维护核对',
    owner: '负责人',
    until: '保留期限',
    details: '查看详情',
    path: '工位路径',
    source: '来源',
    archive: '恢复归档',
    restore: '恢复命令',
    reason: '核对原因',
  },
  en: {
    ...WORKTREE_NOTICE_COPY.en,
    ownerAction: 'Queued for original owner',
    ownerUnavailable: 'Not queued · needs maintenance review',
    owner: 'Owner',
    until: 'Retained until',
    details: 'View details',
    path: 'Worktree path',
    source: 'Source',
    archive: 'Recovery archive',
    restore: 'Restore command',
    reason: 'Reason',
  },
});
