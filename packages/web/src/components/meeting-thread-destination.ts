import type { Thread } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { meetingRecord } from './meeting-intake-utils';

const DESTINATION_PREFIX = 'host:private-thread:';

export function selectedMeetingDestinationId(value: string): string | null {
  return value.startsWith(DESTINATION_PREFIX) ? value.slice(DESTINATION_PREFIX.length) : null;
}

export function meetingDestinationHandle(threadId: string): string {
  return `${DESTINATION_PREFIX}${threadId}`;
}

export function meetingDestinationLabel(thread: Thread): string {
  return thread.title?.trim() || thread.id;
}

export function meetingProjectLabel(projectPath: string): string {
  const normalized = projectPath.replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).at(-1) ?? '默认空间';
}

function createdMeetingThread(value: unknown, fallbackProjectPath: string, now: number): Thread | null {
  const candidate = meetingRecord(value);
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  return {
    id: candidate.id,
    title: typeof candidate.title === 'string' ? candidate.title : null,
    projectPath: typeof candidate.projectPath === 'string' ? candidate.projectPath : fallbackProjectPath,
    createdBy: typeof candidate.createdBy === 'string' ? candidate.createdBy : 'owner',
    participants: Array.isArray(candidate.participants)
      ? candidate.participants.filter((participant): participant is string => typeof participant === 'string')
      : [],
    preferredCats: Array.isArray(candidate.preferredCats)
      ? candidate.preferredCats.filter((catId): catId is string => typeof catId === 'string')
      : [],
    lastActiveAt: typeof candidate.lastActiveAt === 'number' ? candidate.lastActiveAt : now,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : now,
  };
}

export async function createMeetingDestination(title: string, projectPath: string, catId: string): Promise<Thread> {
  if (!catId.trim()) throw new Error('请先选择负责整理的猫猫');
  const response = await apiFetch('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      ...(projectPath && projectPath !== 'default' ? { projectPath } : {}),
      preferredCats: [catId],
      pinned: true,
    }),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = meetingRecord(body);
    throw new Error(typeof detail.error === 'string' ? detail.error : `创建失败 (${response.status})`);
  }
  const thread = createdMeetingThread(body, projectPath, Date.now());
  if (!thread) throw new Error('创建成功，但返回的保存位置信息无效');
  return thread;
}
