import {
  parseWatcherConfig,
  parseWatcherThreadControl,
  type WatcherConfig,
  type WatcherThreadControl,
} from '@cat-cafe/shared';
import type { ILabelStore, IThreadStore, Thread } from '../../cats/services/stores/ports/ThreadStore.js';
import type { IConciergeConfigStore } from '../ConciergeConfigStore.js';

export function effectiveWatcherState(
  config: WatcherConfig,
  thread: Pick<Thread, 'labels' | 'watcher'>,
  quietLabels: readonly string[],
  now = Date.now(),
) {
  const control = parseWatcherThreadControl(thread.watcher);
  const enabled = config.enabled && (config.scope === 'all' ? control.enabled !== false : control.enabled === true);
  const pausedUntil = control.pausedUntil !== undefined && control.pausedUntil > now ? control.pausedUntil : undefined;
  const labelMuted = thread.labels?.some((id) => quietLabels.includes(id)) ?? false;
  return { enabled, maySpeak: enabled && !pausedUntil && !labelMuted, pausedUntil, labelMuted };
}

export async function readWatcherPreferences(configs: IConciergeConfigStore, labels: ILabelStore, userId: string) {
  const [config, availableLabels] = await Promise.all([
    configs.readWatcherConfig
      ? configs.readWatcherConfig(userId)
      : configs.get(userId).then((saved) => parseWatcherConfig(saved.watcher)),
    labels.list(userId),
  ]);
  const quietLabels =
    config.doNotDisturbLabelIds ??
    availableLabels
      .filter((label) => /^(私人|私聊|贴贴|private|personal)$/iu.test(label.name.trim()))
      .map((label) => label.id);
  return { config, quietLabels, availableLabels };
}

/** Direct household instructions only; quotations, examples, fenced code and cat text never enter this parser. */
export function parseWatcherControlIntent(
  text: string,
  now: number,
): { enabled?: boolean; pausedUntil?: number } | null {
  const normalized = text.trim().replace(/[。！!\s]+$/u, '');
  if (normalized === '守望这条') return { enabled: true };
  if (/^(这条|这条对话|这个对话)(别守望了|不要守望了|关闭守望猫)$/u.test(normalized)) return { enabled: false };
  const pause = /^(这)?([一二三四五六七八九十两\d]+)(个)?小时别烦我$/u.exec(normalized);
  if (!pause) return null;
  const numerals: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const hours = numerals[pause[2]!] ?? Number(pause[2]);
  return Number.isInteger(hours) && hours > 0 && hours <= 168 ? { pausedUntil: now + hours * 3_600_000 } : null;
}

export async function applyDirectWatcherControl(
  threads: IThreadStore,
  source: { role: string; content: string; threadId: string; messageId?: string },
  now = Date.now(),
  settledHead?: () => Promise<number>,
): Promise<{
  previous: WatcherThreadControl;
  current: WatcherThreadControl;
  operation: 'open' | 'close' | 'pause';
} | null> {
  if (source.role !== 'user') return null;
  const patch = parseWatcherControlIntent(source.content, now);
  if (!patch) return null;
  const operation = patch.enabled === true ? 'open' : patch.enabled === false ? 'close' : 'pause';
  for (let attempt = 0; attempt < 3; attempt++) {
    const thread = await threads.get(source.threadId);
    if (!thread || thread.deletedAt) return null;
    const previous = parseWatcherThreadControl(thread.watcher);
    if (source.messageId && previous.changedAt !== undefined && previous.changedAt > now) return null;
    if (source.messageId && previous.sourceMessageId === source.messageId)
      return {
        previous: { revision: previous.revision - 1, ...previous.previousControl },
        current: previous,
        operation,
      };
    const current = await threads.updateWatcherControl(thread.id, previous.revision, patch, {
      changedAt: now,
      previousControl: {
        ...(previous.enabled === undefined ? {} : { enabled: previous.enabled }),
        ...(previous.pausedUntil === undefined ? {} : { pausedUntil: previous.pausedUntil }),
      },
      ...(source.messageId ? { sourceMessageId: source.messageId } : {}),
      ...(patch.enabled === true && previous.enabled !== true && settledHead
        ? { startedAfterSequence: await settledHead() }
        : {}),
    });
    if (current) return { previous, current, operation };
  }
  throw new Error('watcher_control_conflict');
}
