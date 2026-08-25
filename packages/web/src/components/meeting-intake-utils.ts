import type { Thread } from '@/stores/chat-types';
import type { MeetingRepairView } from './MeetingIntakeRepairActions';

export function meetingRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function meetingStatusLabel(needsRepair: boolean): string {
  return needsRepair ? '需要处理' : '等你确认';
}

export function meetingActionReason(needsRepair: boolean): string {
  return needsRepair
    ? '会议资料暂时无法继续整理。处理下面的问题后可以原地继续。'
    : '会议记录已经准备好了。请确认要生成的资料和保存位置。';
}

export function meetingRepairView(value: unknown): MeetingRepairView | null {
  const candidate = meetingRecord(value);
  if (
    typeof candidate.code !== 'string' ||
    (candidate.action !== 'retry' && candidate.action !== 'regrant' && candidate.action !== 'manual_import')
  ) {
    return null;
  }
  return {
    code: candidate.code,
    action: candidate.action,
    ...(typeof candidate.safeDetail === 'string' ? { safeDetail: candidate.safeDetail } : {}),
  };
}

export function meetingSpeakerText(value: unknown): string {
  return Object.entries(meetingRecord(value))
    .map(([speaker, name]) => `${speaker}=${String(name)}`)
    .join('\n');
}

export function parseMeetingSpeakers(value: string): Record<string, string> | null {
  const entries = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      return separator > 0 ? ([line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const) : null;
    });
  if (entries.length === 0 || entries.some((entry) => !entry?.[0] || !entry[1])) return null;
  return Object.fromEntries(entries as ReadonlyArray<readonly [string, string]>);
}

export function meetingErrorMessage(body: unknown, status: number): string {
  const value = meetingRecord(body);
  return typeof value.error === 'string' ? value.error : `操作失败 (${status})`;
}

export function userMeetingThreads(value: Thread[] | unknown): Thread[] {
  return (Array.isArray(value) ? value : []).filter(
    (thread): thread is Thread =>
      typeof thread === 'object' &&
      thread !== null &&
      thread.createdBy !== 'system' &&
      !thread.deletedAt &&
      thread.systemKind === undefined,
  );
}
