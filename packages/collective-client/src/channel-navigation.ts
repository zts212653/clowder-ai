import type { CollectiveEventEnvelope, CollectiveParticipant } from './client-types.js';

export function eventChannelId(event: CollectiveEventEnvelope): string | undefined {
  return event.location?.channelId ?? (event.target.kind === 'channel' ? event.target.channelId : undefined);
}

export function channelDestinations(
  events: readonly CollectiveEventEnvelope[],
  participants: readonly CollectiveParticipant[],
) {
  const ids = new Set([
    'general',
    ...events.flatMap((event) => eventChannelId(event) ?? []),
    ...participants.flatMap((member) => member.channelIds),
  ]);
  return [...ids].map((id) => {
    const messages = events.filter((event) => eventChannelId(event) === id);
    const cats = participants.filter((member) => member.availability === 'declared' && member.channelIds.includes(id));
    return { id, messageCount: messages.length, catCount: cats.length, latestSequence: messages.at(-1)?.sequence ?? 0 };
  });
}

export function readChannelPosition(namespace: string): string {
  try {
    const saved = window.localStorage.getItem(`collective-channel:${namespace}`);
    return saved?.trim() && saved.length <= 160 ? saved : 'general';
  } catch {
    return 'general';
  }
}

export function saveChannelPosition(namespace: string, channelId: string) {
  try {
    window.localStorage.setItem(`collective-channel:${namespace}`, channelId);
  } catch {
    /* Navigation still works when browser storage is unavailable. */
  }
}

export function eventDayLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? '今天'
    : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(date);
}
