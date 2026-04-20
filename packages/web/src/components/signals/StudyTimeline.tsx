import { useCallback, useEffect, useState } from 'react';
import { fetchStudyTimeline, type TimelineEntry } from '@/utils/signals-api';
import { HubIcon } from '../hub-icons';

function formatDate(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return iso;
  return new Date(d).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}

function formatTime(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return '';
  return new Date(d).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function localDateKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function groupByDate(entries: readonly TimelineEntry[]): Map<string, TimelineEntry[]> {
  const groups = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const dateKey = localDateKey(entry.lastStudiedAt);
    const existing = groups.get(dateKey) ?? [];
    existing.push(entry);
    groups.set(dateKey, existing);
  }
  return groups;
}

const ARTIFACT_ICON_NAMES: Record<string, string> = {
  note: 'notebook',
  podcast: 'podcast',
  'research-report': 'bar-chart',
};

interface StudyTimelineProps {
  readonly days?: number;
}

export function StudyTimeline({ days = 7 }: StudyTimelineProps) {
  const [entries, setEntries] = useState<readonly TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDays, setSelectedDays] = useState(days);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchStudyTimeline(selectedDays);
      setEntries(result.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load timeline');
    } finally {
      setLoading(false);
    }
  }, [selectedDays]);

  useEffect(() => {
    void load();
  }, [load]);

  const dateGroups = groupByDate(entries);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-cafe">学习时间线</h3>
        <div className="flex gap-1">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setSelectedDays(d)}
              className={`rounded-full px-2 py-0.5 text-xs ${selectedDays === d ? 'bg-opus-primary text-white' : 'border border-cafe text-cafe-secondary hover:bg-cafe-surface-elevated'}`}
            >
              {d}天
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-xs text-cafe-muted">加载中...</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}

      {!loading && entries.length === 0 && (
        <p className="text-xs text-cafe-muted">最近 {selectedDays} 天没有学习活动。</p>
      )}

      {Array.from(dateGroups.entries()).map(([dateKey, group]) => (
        <div key={dateKey}>
          <div className="mb-2 text-xs font-semibold text-cafe-secondary">{formatDate(group[0].lastStudiedAt)}</div>
          <div className="space-y-2 border-l-2 border-opus-light pl-3">
            {group.map((entry) => (
              <div key={entry.articleId} className="rounded-lg border border-cafe bg-cafe-surface p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <a
                    href={`/signals?article=${encodeURIComponent(entry.articleId)}`}
                    className="text-xs font-medium text-opus-dark hover:underline"
                  >
                    {entry.articleTitle}
                  </a>
                  <span className="shrink-0 text-[10px] text-cafe-muted">{formatTime(entry.lastStudiedAt)}</span>
                </div>
                <span className="text-[10px] text-cafe-muted">{entry.source}</span>
                {entry.artifacts.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {entry.artifacts.map((a) => (
                      <span
                        key={a.id}
                        className="rounded-full bg-cafe-surface-elevated px-1.5 py-0.5 text-[10px] text-cafe-secondary"
                      >
                        <HubIcon name={ARTIFACT_ICON_NAMES[a.kind] ?? 'file-text'} className="inline h-3 w-3" />{' '}
                        {a.kind} · {a.state}
                      </span>
                    ))}
                  </div>
                )}
                {entry.threads.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {entry.threads.map((t) => (
                      <a
                        key={t.threadId}
                        href={`/thread/${encodeURIComponent(t.threadId)}`}
                        className="rounded-full bg-opus-bg px-1.5 py-0.5 text-[10px] text-opus-dark hover:underline"
                      >
                        <HubIcon name="message-circle" className="inline h-3 w-3" /> {t.threadId.slice(0, 12)}...
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
