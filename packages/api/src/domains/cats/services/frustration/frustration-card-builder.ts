/**
 * F222: Rich block builders for frustration auto-issue cards.
 *
 * Produces a card (context display) + interactive block (confirm/skip actions)
 * following the F128 propose-thread pattern.
 */

import type { FrustrationIssue, RichCardBlock, RichInteractiveBlock } from '@cat-cafe/shared';

// ── Field builders (extracted to reduce main function complexity) ──

const SIGNAL_LABELS: Record<string, string> = {
  cli_error: 'CLI 错误',
  cancel_burst: '操作频繁中断',
  text_frustration: '用户反馈异常',
  a2a_timeout: '猫猫响应超时',
  retry_burst: '重复操作',
  user_report: '用户主动反馈',
};

function buildSignalFields(issue: FrustrationIssue): Array<{ label: string; value: string }> {
  const signalLabel = SIGNAL_LABELS[issue.signalType] ?? issue.signalType;
  const fields: Array<{ label: string; value: string }> = [{ label: '触发类型', value: signalLabel }];

  if (issue.signalType === 'cli_error') {
    if (issue.signalDetail.reasonCode) {
      fields.push({ label: '错误类型', value: String(issue.signalDetail.reasonCode) });
    }
    if (issue.signalDetail.publicHint) {
      fields.push({ label: '建议', value: String(issue.signalDetail.publicHint) });
    }
  } else if (issue.signalType === 'cancel_burst') {
    const count = issue.signalDetail.cancelCount ?? '?';
    const windowSec = Math.round(Number(issue.signalDetail.windowMs ?? 60000) / 1000);
    fields.push({ label: '中断次数', value: `${count} 次（${windowSec}s 内）` });
  } else if (issue.signalType === 'text_frustration') {
    const keywords = issue.signalDetail.matchedKeywords;
    if (Array.isArray(keywords) && keywords.length > 0) {
      fields.push({ label: '检测关键词', value: keywords.map(String).join('、') });
    }
    if (issue.signalDetail.matchCount) {
      fields.push({ label: '匹配消息数', value: `${issue.signalDetail.matchCount} 条` });
    }
  } else if (issue.signalType === 'a2a_timeout') {
    if (issue.signalDetail.targetCatId) {
      fields.push({ label: '目标猫', value: String(issue.signalDetail.targetCatId) });
    }
    if (issue.signalDetail.elapsedMs) {
      fields.push({ label: '等待时间', value: `${Math.round(Number(issue.signalDetail.elapsedMs) / 1000)}s` });
    }
  } else if (issue.signalType === 'retry_burst') {
    if (issue.signalDetail.matchCount) {
      fields.push({ label: '重复次数', value: `${issue.signalDetail.matchCount} 次` });
    }
  } else if (issue.signalType === 'user_report') {
    if (issue.signalDetail.toolName) {
      fields.push({ label: '被拒绝的操作', value: String(issue.signalDetail.toolName) });
    }
  }

  return fields;
}

const ROLE_EMOJI: Record<string, string> = { user: '👤', cat: '🐱', system: '⚙️' };

function buildBodyMarkdown(issue: FrustrationIssue): string {
  const parts: string[] = [];

  if (issue.signalType === 'cli_error' && issue.signalDetail.publicSummary) {
    parts.push(`**问题**: ${issue.signalDetail.publicSummary}`);
  } else if (issue.signalType === 'text_frustration') {
    parts.push('**检测到重复的负面反馈**，你可能遇到了问题。');
  } else if (issue.signalType === 'a2a_timeout') {
    parts.push('**猫猫没有及时响应**，可能遇到了问题。');
  } else if (issue.signalType === 'retry_burst') {
    parts.push('**检测到重复发送相同消息**，之前的请求可能没有被正确处理。');
  } else if (issue.signalType === 'user_report') {
    parts.push('**你主动发起了问题反馈**，已采集当前上下文。请补充描述后确认记录到反馈池。');
  }
  if (issue.context.errorLogs) {
    parts.push(`**日志摘要**:\n\`\`\`\n${issue.context.errorLogs.slice(0, 300)}\n\`\`\``);
  }
  if (issue.context.recentMessages.length > 0) {
    const lines = [`**最近对话** (${issue.context.recentMessages.length} 条)`];
    for (const msg of issue.context.recentMessages.slice(-3)) {
      const emoji = ROLE_EMOJI[msg.role] ?? '❓';
      const truncated = msg.content.length > 100 ? `${msg.content.slice(0, 100)}...` : msg.content;
      lines.push(`${emoji} ${truncated}`);
    }
    parts.push(lines.join('\n'));
  }

  return parts.join('\n\n') || '已自动采集上下文信息。';
}

// ── Public builders ──────────────────────────────────────────────

/**
 * Build the info card showing collected issue context.
 */
export function buildFrustrationIssueCard(issue: FrustrationIssue): RichCardBlock {
  return {
    id: `frustration-${issue.issueId}`,
    kind: 'card',
    v: 1,
    // F225 猫猫化: title 去掉 emoji 前缀（前端按 meta.signalType 渲染 megaphone/search SVG）。
    title: issue.signalType === 'user_report' ? '你的问题反馈' : '我注意到刚才可能出了问题',
    bodyMarkdown: buildBodyMarkdown(issue),
    tone: 'warning',
    fields: buildSignalFields(issue),
    // signalType 透传给前端选 icon：user_report → megaphone，其余 → search。
    meta: { kind: 'frustration_auto_issue', issueId: issue.issueId, signalType: issue.signalType },
  };
}

/**
 * Build the interactive block for confirm/skip actions.
 * Uses OptionAction callbacks to directly call API endpoints.
 */
export function buildFrustrationIssueInteractive(issue: FrustrationIssue): RichInteractiveBlock {
  return {
    id: `frustration-action-${issue.issueId}`,
    kind: 'interactive',
    v: 1,
    interactiveType: 'confirm',
    title: '要记录这个问题吗？',
    description: '确认后会保存到本地反馈池，供猫猫优先处理。跳过则不会保存。',
    options: [
      {
        id: 'confirm',
        label: '确认记录',
        icon: 'check',
        description: '保存问题报告',
        customInput: true,
        customInputPlaceholder: '补充描述（可选）',
        action: {
          type: 'callback',
          endpoint: `/api/frustration-issues/${issue.issueId}/confirm`,
          payload: { issueId: issue.issueId },
        },
      },
      {
        id: 'skip',
        label: '跳过',
        icon: 'x',
        description: '不需要报告',
        action: {
          type: 'callback',
          endpoint: `/api/frustration-issues/${issue.issueId}/skip`,
          payload: { issueId: issue.issueId },
        },
      },
    ],
  };
}
