const DECISION_NOTIFICATION_RE = /\b(review|lgtm|merge|pr)\b/i;

export function shouldMarkDecisionNotification(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    DECISION_NOTIFICATION_RE.test(content) ||
    content.includes('合入') ||
    content.includes('审批') ||
    content.includes('批准') ||
    content.includes('决策') ||
    content.includes('请确认') ||
    content.includes('是否允许') ||
    lower.includes('can merge')
  );
}
