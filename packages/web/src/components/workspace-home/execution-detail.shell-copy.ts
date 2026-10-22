import { defineShellCopy } from '../shell/shell-copy';

export const executionDetailCopy = defineShellCopy({
  zh: {
    title: '执行详情',
    loading: '正在读取这次执行…',
    unavailable: '读不到这次执行的位置',
    started: '开始时间',
    source: '来源对话',
    close: '收起',
    stop: '停止',
    cancel: '取消',
    stopFailed: '停止失败',
    stopRetry: '请刷新后重试',
    blocked: {
      control_plane_unavailable: '控制面暂不可用，无法安全停止',
      cancellation_pending: '正在停止',
      terminalizing: '正在收尾，已不可停止',
      foreign_principal: '由排程发起，占用中；你不是发起方',
    },
    retry: '重试',
  },
  en: {
    title: 'Execution details',
    loading: 'Reading this execution…',
    unavailable: 'Cannot read the location of this execution',
    started: 'Started',
    source: 'Source conversation',
    close: 'Collapse',
    stop: 'Stop',
    cancel: 'Cancel',
    stopFailed: 'Could not stop execution',
    stopRetry: 'Refresh and try again',
    blocked: {
      control_plane_unavailable: 'Control plane unavailable; cannot stop safely',
      cancellation_pending: 'Stopping',
      terminalizing: 'Finishing; can no longer stop',
      foreign_principal: 'Started by a schedule; you are not the initiator',
    },
    retry: 'Retry',
  },
});
