import { defineShellCopy } from '@/components/shell/shell-copy';

export const textModificationCopy = defineShellCopy({
  zh: {
    selectionFailed: '选中文字暂时无法唯一定位，请选择更多上下文后重试。',
    preparing: '正在核对选区…',
    ask: '请猫修改',
    records: '修改记录',
    choose_places: '在文档里选一处或几处，放进聊天输入框，再说一句想怎么改。',
    no_thread: '先打开一段聊天，再把文档选区放进输入框。',
    recall_pending: '输入框正在恢复原消息，请稍后重试。',
    refused: '这处暂未放进输入框；选文和原草稿仍保留，请重新选择后重试。',
    added: '已放进聊天输入框，补充修改要求后发送。',
  },
  en: {
    selectionFailed: 'This passage cannot be located uniquely. Select more context and try again.',
    preparing: 'Checking the selection…',
    ask: 'Ask a cat to edit',
    records: 'Modification history',
    choose_places: 'Select one or more passages, add them to Chat, then describe what to change.',
    no_thread: 'Open a conversation before adding document passages to Chat.',
    recall_pending: 'Chat is restoring the original message. Please try again shortly.',
    refused: 'This passage was not added. Your selection and draft are preserved; select it again to retry.',
    added: 'Added to Chat. Describe the change, then send.',
  },
});
