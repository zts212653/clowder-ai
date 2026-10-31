import { defineShellCopy } from '../components/shell/shell-copy';

export const apiClientCopy = defineShellCopy({
  zh: {
    connectionTitle: '后端连接异常',
    connectionMessage: '未能取得后端响应，请检查服务并刷新确认操作结果。',
    sessionTitle: '会话恢复失败',
    sessionMessage: '登录态没有自动恢复成功。请稍后重试；如果仍无响应，再刷新页面。',
  },
  en: {
    connectionTitle: 'Backend connection problem',
    connectionMessage:
      'No response was received. Check the service and refresh to confirm the result of your operation.',
    sessionTitle: 'Session recovery failed',
    sessionMessage:
      'Your session could not be restored. Try again shortly; if there is still no response, refresh the page.',
  },
});
