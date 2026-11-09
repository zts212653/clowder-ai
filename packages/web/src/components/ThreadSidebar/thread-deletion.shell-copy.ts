import { defineShellCopy } from '../shell/shell-copy';

export const threadDeletionCopy = defineShellCopy(
  {
    zh: {
      moveToTrash: '移入回收站',
      dialogTitle: '确认删除对话',
      systemTitle: '删除系统对话',
      unnamed: '未命名对话',
      deleting: (title: string) => `即将删除「${title}」`,
      trashNote: '对话将移入回收站，30 天后自动清理。你可以随时从回收站恢复。',
      cancel: '取消',
      confirm: '确认删除',
      systemWarning: '这是系统级对话。删除可能影响平台功能（连接器路由、定时评估或猫的私人空间）。',
      typeName: '请输入对话名称以确认删除：',
      deletedTitle: '已移入回收站',
      deletedMessage: (title: string) => `「${title}」已移入回收站，可从回收站恢复。`,
      failedTitle: '未能删除对话',
      failedMessage: '未能移入回收站，请稍后重试。',
      uncertainMessage: '未能确认删除结果，正在刷新列表。请检查回收站后再重试。',
      workingMessage: '猫猫正在工作中，请等待当前任务完成后再删除对话。',
    },
    en: {
      moveToTrash: 'Move to trash',
      dialogTitle: 'Delete conversation?',
      systemTitle: 'Delete system conversation',
      unnamed: 'Untitled conversation',
      deleting: (title: string) => `You are deleting “${title}”.`,
      trashNote: 'The conversation will move to trash and be cleared after 30 days. You can restore it from trash.',
      cancel: 'Cancel',
      confirm: 'Confirm deletion',
      systemWarning:
        'This is a system conversation. Deleting it may affect connector routing, scheduled evaluations or a cat’s private space.',
      typeName: 'Type the conversation name to confirm:',
      deletedTitle: 'Moved to trash',
      deletedMessage: (title: string) => `“${title}” was moved to trash. You can restore it from trash.`,
      failedTitle: 'Could not delete conversation',
      failedMessage: 'Could not move to trash. Please retry.',
      uncertainMessage: 'Could not confirm the deletion result. Refreshing the list; check trash before retrying.',
      workingMessage: 'A cat is working here. Wait for the current task to finish before deleting this conversation.',
    },
  },
  {
    samples: {
      deleting: [['示例'], ['另一段会话']],
      deletedMessage: [['示例'], ['另一段会话']],
    },
  },
);
