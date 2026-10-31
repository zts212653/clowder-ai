import { defineShellCopy } from './shell-copy';

export const settingsReturnCopy = defineShellCopy({
  zh: {
    title: '返回对话',
    notSaved: '返回位置未能保存，刷新页面后可能无法恢复。当前页面仍可返回。',
    unavailable: '未能恢复来源对话的阅读位置。返回记录已保留，可从设置重试。',
    interrupted: '返回已中断，阅读位置未确认恢复。返回记录已保留。',
    clearFailed: '返回记录未能完整清理。请在设置重试。',
    saveFailed: '返回请求未能保存，尚未开始返回。请重试。',
  },
  en: {
    title: 'Return to conversation',
    notSaved: 'The return position could not be saved for a reload. You can still return on this page.',
    unavailable:
      'The reading position could not be restored. The return record is kept so you can retry from Settings.',
    interrupted:
      'The return was interrupted. The reading position is not confirmed restored, and the return record is kept.',
    clearFailed: 'The return record could not be fully cleared. Please retry from Settings.',
    saveFailed: 'The return request could not be saved and has not started. Please retry.',
  },
});
