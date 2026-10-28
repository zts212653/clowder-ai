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

export function readSavedChannelPosition(namespace: string): string | undefined {
  try {
    const saved = window.localStorage.getItem(`collective-channel:${namespace}`);
    return saved?.trim() && saved.length <= 160 ? saved : undefined;
  } catch {
    return undefined;
  }
}

export function readChannelPosition(namespace: string): string {
  return readSavedChannelPosition(namespace) ?? 'general';
}

export function readChannelTarget(search?: string) {
  const currentSearch =
    search ??
    (typeof window !== 'undefined' && window.location
      ? window.location.search
      : typeof location !== 'undefined'
        ? location.search
        : '');
  const channelId = new URLSearchParams(currentSearch).get('channelId')?.trim();
  return channelId && channelId.length <= 160 ? channelId : undefined;
}

export function readChannelEntry(namespace: string) {
  const target = readChannelTarget();
  const library =
    typeof window !== 'undefined' && new URLSearchParams(window.location?.search).get('view') === 'artifacts';
  return {
    channelId: target ? target : readChannelPosition(namespace),
    destination: library ? ('library' as const) : target ? ('channel' as const) : ('home' as const),
  };
}

export function writeChannelTarget(channelId?: string) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete('view');
  if (channelId) url.searchParams.set('channelId', channelId);
  else url.searchParams.delete('channelId');
  window.history.replaceState(window.history.state, '', url);
}

export function writeLibraryTarget() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete('channelId');
  url.searchParams.set('view', 'artifacts');
  window.history.replaceState(window.history.state, '', url);
}

export function saveChannelPosition(namespace: string, channelId: string) {
  try {
    window.localStorage.setItem(`collective-channel:${namespace}`, channelId);
  } catch {
    /* Navigation still works when browser storage is unavailable. */
  }
}

export function clearChannelPosition(namespace: string) {
  try {
    window.localStorage.removeItem(`collective-channel:${namespace}`);
  } catch {
    /* Navigation still works when browser storage is unavailable. */
  }
}

export function eventDayLabel(value: string, language: 'zh' | 'en' = 'zh') {
  const date = new Date(value);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? language === 'en'
      ? 'Today'
      : '今天'
    : new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { month: 'long', day: 'numeric' }).format(date);
}
