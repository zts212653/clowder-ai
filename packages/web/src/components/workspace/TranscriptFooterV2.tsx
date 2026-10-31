'use client';

import { useShellCopy } from '@/components/shell/shell-copy';
import { voiceMeetingCopy } from './voice-meeting.shell-copy';

/**
 * The v2 stats footer shared by the docked panel and the floating window (§1.14: 段数 · 平均延迟 · 实时连接).
 * The mock-ups also show 「16kHz 单声道」; the running contract carries no capture-format fact (gap-list #2),
 * so the v2 footer says nothing about format rather than repeat the hard-coded literal classic still prints.
 */
export function TranscriptFooterV2({
  lineCount,
  avgLatencySeconds,
  connected,
}: {
  lineCount: number;
  /** Real average ASR latency in seconds, already formatted (e.g. "0.95"), or null when unknown. */
  avgLatencySeconds: string | null;
  connected: boolean;
}) {
  const t = useShellCopy(voiceMeetingCopy);
  return (
    <div className="flex items-center gap-3 border-t border-cafe-border px-3 py-1.5 text-micro text-cafe-text-muted">
      <span>{t.footer.chunks(lineCount)}</span>
      <span>{avgLatencySeconds ? t.footer.avgLatency(avgLatencySeconds) : t.footer.noLatency}</span>
      <span className={connected ? 'text-conn-emerald-text' : 'text-conn-red-text'}>
        {connected ? t.footer.connected : t.footer.disconnected}
      </span>
    </div>
  );
}
