export type VisibleSystemInfoVariant = 'info' | 'a2a_followup';

export interface VisibleSystemInfoResult {
  content: string;
  variant: VisibleSystemInfoVariant;
}

function formatPingpongTerminated(parsed: Record<string, unknown>): VisibleSystemInfoResult {
  const fromCatId = typeof parsed.fromCatId === 'string' ? parsed.fromCatId : 'unknown';
  const targetCatId = typeof parsed.targetCatId === 'string' ? parsed.targetCatId : 'unknown';
  const pairCount = typeof parsed.pairCount === 'number' ? parsed.pairCount : undefined;
  const rounds = pairCount ? ` ${pairCount} 轮` : '';
  return {
    content: `🏓 ${fromCatId} ↔ ${targetCatId} 已连续互相 @${rounds}，链路已熔断。`,
    variant: 'info',
  };
}

function formatRoleRejected(parsed: Record<string, unknown>): VisibleSystemInfoResult {
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  const targetCatId = typeof parsed.targetCatId === 'string' ? parsed.targetCatId : 'unknown';
  const action = typeof parsed.action === 'string' ? parsed.action : '当前';
  return {
    content: reason || `⛔ @${targetCatId} 不接受 ${action} 任务。`,
    variant: 'info',
  };
}

export function formatVisibleSystemInfo(parsed: Record<string, unknown>): VisibleSystemInfoResult | null {
  if (parsed?.type === 'a2a_followup_available') {
    const mentions = parsed.mentions as Array<{ catId: string; mentionedBy: string }>;
    return {
      content: mentions.map((m) => `${m.mentionedBy} @了 ${m.catId}`).join('、'),
      variant: 'a2a_followup',
    };
  }

  if (parsed?.type === 'warning') {
    const warningText = typeof parsed.message === 'string' ? parsed.message : '';
    return {
      content: warningText ? `⚠️ ${warningText}` : '⚠️ Warning',
      variant: 'info',
    };
  }

  if (parsed?.type === 'a2a_pingpong_terminated') {
    return formatPingpongTerminated(parsed);
  }

  if (parsed?.type === 'a2a_role_rejected') {
    return formatRoleRejected(parsed);
  }

  return null;
}
