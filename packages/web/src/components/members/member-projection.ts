import { type RoutingContextReadModelV1, type RoutingSubjectRefV1, routingSignalClosures } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { CLIENT_OPTIONS } from '../hub-cat-editor.model';
import { providerDisplayName } from '../routing-context/team-member-projection';
import type { NativeLoginState } from '../settings/members/native-login-state';

export type MemberStatus = {
  label: string;
  detail: string;
  detailIsNote?: boolean;
  source?: string;
  observedAt?: number;
  evidenceRef?: string;
  note?: string;
  until?: number;
  tone: 'ok' | 'warning' | 'error' | 'unknown';
};
export const SIGNAL_SOURCE_LABELS = {
  manual_cvo: '你手动设置',
  quota_probe: '额度检测',
  provider_error: '服务报错',
  health_probe: '健康检查',
  dispatch_success: '最近一次接活顺利完成',
};
/** Recovery is evidence for availability, rather than a fifth current state. */
export const memberStatusLabel = (status: MemberStatus) => (status.label === '已恢复' ? '可用' : status.label);
export function memberSignalDeadline(signal: { validUntil?: number; resetAt?: number }): number {
  return Math.min(signal.validUntil ?? Infinity, signal.resetAt ?? Infinity);
}
const statusLabels = {
  available: '可用',
  scarce: '额度紧张',
  degraded: '不稳定',
  unavailable: '不可用',
  unknown: '未确认',
};
const reasonLabels: Record<string, string> = {
  weekly_quota_low: '本周额度不足',
  daily_quota_low: '今日额度不足',
  provider_error: '服务报错',
  provider_timeout: '服务响应超时',
  quota_exhausted: '额度已用完',
  authentication_rejected: '登录验证未通过',
  provider_unreachable: '没连上服务',
  dispatch_success_probe: '最近一次接活顺利完成',
  routing_signal_expired: '记录已失效，尚未确认恢复',
  routing_signal_retracted: '限制已撤回',
  routing_signal_recovered: '已恢复',
};
export function memberStatus(
  cat: CatData,
  model: RoutingContextReadModelV1 | null,
  readError?: string | null,
  now = Date.now(),
  login?: NativeLoginState,
): MemberStatus {
  if (cat.roster?.available === false) return { label: '已停用', detail: '', tone: 'unknown' };
  if (cat.configurationSource === 'native_tool' && login?.status === 'login_required')
    return {
      label: '待登录',
      detail: '请先登录对应工具，再刷新',
      tone: 'warning',
    };
  if (cat.configurationSource === 'native_tool' && login?.status === 'not_installed')
    return { label: '未安装', detail: '请先安装对应工具', tone: 'error' };
  if (readError || !model || model.resolution.state !== 'fresh')
    return { label: '未确认', detail: readError ? '当前状态读取失败' : '当前状态暂不可读', tone: 'unknown' };
  const candidate = model.resolution.snapshot.candidates.find((c) => c.binding.catId === cat.id);
  if (!candidate) return { label: '未确认', detail: '没有这个成员的当前记录', tone: 'unknown' };
  const refs = new Set(candidate.reasons.flatMap((reason) => reason.sourceRefs));
  const events = model.signalEvents.filter((event) => refs.has(event.eventId));
  // The owner includes the original assertion in recovery/retraction provenance.
  // Shared owner rules cover explicit closes and successful-probe coverage.
  const closed = routingSignalClosures(model.signalEvents);
  const boundary = events.flatMap((event) =>
    event.eventType === 'asserted' && !closed.has(event.eventId) ? [memberSignalDeadline(event)] : [],
  );
  const expired = boundary.some((until) => until <= now);
  const stale = candidate.freshness !== 'fresh' || expired;
  const reason = candidate.reasons[0];
  const event = events.slice().sort((a, b) => b.observedAt - a.observedAt)[0];
  const successfulRecovery =
    !stale &&
    candidate.availability === 'available' &&
    event?.eventType === 'recovered' &&
    event.source === 'dispatch_success' &&
    event.reasonCode === 'dispatch_success_probe';
  const detail = stale
    ? expired || candidate.freshness === 'stale'
      ? '记录已失效，当前状态未确认'
      : '记录新鲜度未确认'
    : successfulRecovery
      ? '最近一次接活顺利完成'
      : event?.note || (reason && (reasonLabels[reason.code] ?? reasonLabels[reason.summary])) || '';
  const until = boundary.length ? Math.min(...boundary) : null;
  // A first successful call has no earlier constraint to recover, so the owner can legitimately
  // leave candidate.reasons empty. Its durable terminal fact is still authoritative for this cat.
  const success = model.signalEvents.find(
    (item) =>
      item.subjectRef.type === 'cat' &&
      item.subjectRef.catId === cat.id &&
      (item.source === 'dispatch_success' || item.source === 'health_probe') &&
      'state' in item &&
      item.state === 'available' &&
      !closed.has(item.eventId) &&
      item.observedAt <= now,
  );
  const connected = Boolean(success);
  if (!stale && candidate.availability === 'available' && cat.configurationSource === 'native_tool' && !connected)
    return {
      label: '待验证',
      detail: login?.status === 'configured' ? '已检测登录，尚未验证实际连接' : '尚未确认登录与实际连接',
      tone: 'unknown',
    };
  const sourceEvent = event ?? (!stale && candidate.availability === 'available' ? success : undefined);
  return {
    label: stale ? '未确认' : successfulRecovery ? '已恢复' : statusLabels[candidate.availability],
    detail,
    detailIsNote: !stale && !successfulRecovery && Boolean(event?.note),
    source: sourceEvent && SIGNAL_SOURCE_LABELS[sourceEvent.source],
    observedAt: sourceEvent?.observedAt,
    evidenceRef: sourceEvent?.evidenceRef,
    note: successfulRecovery ? event?.note : undefined,
    until: until !== null && Number.isFinite(until) ? until : undefined,
    tone:
      stale || candidate.availability === 'unknown'
        ? 'unknown'
        : candidate.availability === 'available'
          ? 'ok'
          : candidate.availability === 'unavailable'
            ? 'error'
            : 'warning',
  };
}
/** Work outcomes are historical dispatch facts, independent of current availability/recovery. */
export function memberLatestWork(
  catId: string,
  model: RoutingContextReadModelV1 | null,
  now: number,
): Pick<MemberStatus, 'detail' | 'observedAt'> | undefined {
  const event = model?.signalEvents
    .filter(
      (item) =>
        item.subjectRef.type === 'cat' &&
        item.subjectRef.catId === catId &&
        item.observedAt > 0 &&
        item.observedAt <= now &&
        ((item.source === 'dispatch_success' && item.eventType === 'recovered') ||
          (item.source === 'provider_error' && item.eventType === 'asserted')),
    )
    .sort((a, b) => b.observedAt - a.observedAt)[0];
  if (!event) return;
  return {
    detail:
      event.source === 'dispatch_success'
        ? '最近一次接活顺利完成'
        : (reasonLabels[event.reasonCode] ?? '最近一次接活未成功'),
    observedAt: event.observedAt,
  };
}
export function memberTransport(cat: CatData): string {
  if (cat.identityProtection?.kind === 'builtin-cloud') return '云端';
  if (cat.carrier === 'acp') return 'ACP';
  if (cat.carrier === 'app_server') return 'App Server';
  if (cat.carrier === 'sdk') return 'SDK';
  return 'CLI';
}
export function memberClientName(cat: CatData): string {
  if (cat.acp && /dsh|deepseek-harness/i.test(cat.acp.command)) return 'DSH';
  return CLIENT_OPTIONS.find((option) => option.value === cat.clientId)?.label ?? cat.clientId;
}
export function routingSubjectName(
  subject: RoutingSubjectRefV1,
  cats: CatData[],
  poolName = (id: string) => `额度池 ${id}`,
): string {
  if (subject.type === 'cat') {
    const cat = cats.find((c) => c.id === subject.catId);
    const name = cat?.nickname || cat?.displayName || subject.catId;
    const ambiguous = cats.some(
      (other) => other.id !== subject.catId && (other.nickname || other.displayName) === name,
    );
    return ambiguous ? `${name} · ${subject.catId}` : name;
  }
  if (subject.type === 'provider') return providerDisplayName(subject.providerId);
  return poolName(subject.poolId);
}
export function reorderMemberIds(ids: string[], source: string, target: string): string[] {
  if (!ids.includes(source) || !ids.includes(target) || source === target) return ids;
  const next = ids.filter((id) => id !== source);
  next.splice(ids.indexOf(target), 0, source);
  return next;
}
