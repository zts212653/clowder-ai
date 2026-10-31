import { defineShellCopy } from '../shell/shell-copy';

export const chatApprovalReceiptCopy = defineShellCopy({
  zh: {
    loading: '正在读取审批结果…',
    unavailable: '审批结果暂不可确认',
    cachedFailure: '没更新成功，保留上次读到的结果',
    reread: '重新读取',
    approved: '你同意了',
    responded: '你处理了',
    rejected: '你拒绝了',
    thread: '提的新对话',
    proposed: '提的',
    reason: '理由：',
    origin: '回原提议',
    handoff: '会话接力',
    profile: '画像更新',
  },
  en: {
    loading: 'Reading the approval result…',
    unavailable: 'Approval result unavailable',
    cachedFailure: 'Could not update; showing the previous result',
    reread: 'Read again',
    approved: 'You approved',
    responded: 'You answered',
    rejected: 'You declined',
    thread: 'a new conversation from',
    proposed: 'a proposal from',
    reason: 'Reason: ',
    origin: 'Back to the proposal',
    handoff: 'Session handoff',
    profile: 'Profile update',
  },
});
