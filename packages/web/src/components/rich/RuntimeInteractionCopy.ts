import type { RuntimeInteractionRecord } from '@cat-cafe/shared';

/** Host-supplied fixed words; classic keeps its existing Chinese wording. */
export interface RuntimeInteractionCopy {
  loading: string;
  preparing: string;
  readonly: string;
  syncFailed: string;
  submitFailed: string;
  kind: Record<Exclude<RuntimeInteractionRecord['request']['kind'], 'conversation_decision'> | 'unknown', string>;
  status: Record<RuntimeInteractionRecord['status'], string>;
  terminal: {
    answered: string;
    handled: string;
    rejected: string;
    cancelled: string;
    restarted: string;
    lost: string;
    unavailable: string;
    publicationFailed: string;
    invalid: string;
  };
  elicitation: { open: (host: string) => string; unavailable: string; choose: string; yes: string; no: string };
  form: { skip: string; submit: string; choose: string; other: string; otherLabel: (question: string) => string };
}
export const CLASSIC_RUNTIME_INTERACTION_COPY: RuntimeInteractionCopy = {
  loading: '正在同步请求…',
  preparing: '正在准备请求…',
  readonly: '只读副本：请回到原消息处理这个请求。',
  syncFailed: '交互状态同步失败',
  submitFailed: '提交失败',
  kind: { approval: '需要确认', question: '需要回答', elicitation: '需要补充', unknown: '运行时请求' },
  status: {
    staged: '同步中',
    pending: '等待你处理',
    answered: '已处理',
    declined: '已拒绝',
    cancelled: '已取消',
    invalidated: '已失效',
  },
  terminal: {
    answered: '回答已提交。',
    handled: '请求已处理。',
    rejected: '你已拒绝这次请求。',
    cancelled: '你已取消这次请求。',
    restarted: '服务重启后，这个旧请求已失效。',
    lost: '运行连接已中断，这个请求已失效。',
    unavailable: '此运行没有可用的确认界面。',
    publicationFailed: '请求界面发布失败，未执行任何操作。',
    invalid: '这个请求已失效，不能再提交。',
  },
  elicitation: {
    open: (host) => `打开 ${host}`,
    unavailable: '链接不可用；你仍可拒绝或取消这次请求。',
    choose: '请选择',
    yes: '是',
    no: '否',
  },
  form: {
    skip: '不回答',
    submit: '提交回答',
    choose: '请选择',
    other: '其他答案',
    otherLabel: (question) => `其他答案：${question}`,
  },
};
