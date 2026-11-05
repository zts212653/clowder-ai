import type { DecisionResultStatus } from './ApprovalResultRow';
import type { conversationDecisionCopy } from './conversation-decision.shell-copy';
import type { decisionResultCopy } from './decision-result.shell-copy';

export function conversationResult(
  reason: string | undefined,
  choices: string[],
  copy: typeof conversationDecisionCopy.zh,
  t: typeof decisionResultCopy.zh,
): { status: DecisionResultStatus; label: string } {
  let result: { status: DecisionResultStatus; label: string };
  switch (reason) {
    case 'answered':
      result = { status: 'approved', label: copy.answered };
      break;
    case 'withdrawn':
      result = { status: 'withdrawn', label: copy.withdrawn };
      break;
    case 'superseded':
      result = { status: 'closed', label: copy.superseded };
      break;
    case 'defaulted':
      result = { status: 'closed', label: copy.defaulted };
      break;
    case 'expired':
      result = { status: 'expired', label: copy.expired };
      break;
    default:
      result = { status: 'closed', label: copy.expired };
  }
  const selected =
    choices.length && (reason === 'answered' || reason === 'defaulted') ? t.selected(choices.join(' / ')) : '';
  return {
    status: result.status,
    label: selected && reason === 'defaulted' ? `${selected} · ${result.label}` : selected ? selected : result.label,
  };
}
