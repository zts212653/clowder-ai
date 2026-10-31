'use client';

import { useShellCopy } from '@/components/shell/shell-copy';
import type { AudioStatus, ComponentHealth } from './audio-transcript-contract';
import { voiceMeetingCopy } from './voice-meeting.shell-copy';

type Copy = (typeof voiceMeetingCopy)['zh'];

function toneClass(tone: 'green' | 'amber' | 'red' | 'muted'): string {
  if (tone === 'green') return 'bg-[var(--semantic-success)]/12 text-conn-emerald-text';
  if (tone === 'amber') return 'bg-[var(--semantic-warning-surface)] text-conn-amber-text';
  if (tone === 'red') return 'bg-conn-red-text/10 text-conn-red-text';
  return 'bg-cafe-surface-secondary text-cafe-text-muted';
}

function componentTag(
  t: Copy,
  health: ComponentHealth,
  active: boolean,
): { text: string; tone: 'green' | 'amber' | 'red' | 'muted' } {
  const state = health.state;
  if (state === 'ready') return { text: t.health.ok, tone: active ? 'green' : 'muted' };
  if (state === 'degraded') return { text: t.health.degraded, tone: 'amber' };
  if (state === 'error') return { text: t.health.error, tone: 'red' };
  return { text: t.health.unknown, tone: 'muted' };
}

function Tag({
  label,
  value,
  tone,
  title,
  stale,
}: {
  label: string;
  value: string;
  tone: 'green' | 'amber' | 'red' | 'muted';
  title?: string;
  stale: boolean;
}) {
  const t = useShellCopy(voiceMeetingCopy);
  return (
    <span className={`rounded-full px-2 py-0.5 text-micro ${toneClass(tone)}`} title={title}>
      {stale ? `${t.health.lastPrefix} · ` : ''}
      {label} {value}
    </span>
  );
}

/**
 * §1.14 — the v2 input-health tags (语音识别 正常 / 说话人区分 学习中 / 每一路输入 运行中), driven only by the real
 * `/api/audio/status` health and inputs. 「学习中」 is shown for speaker separation while the session still has
 * provisional (learning) clusters; degraded/error states read 降级/异常. After a stop the tags stay visible but are
 * prefixed 上次 and muted — the distinction the classic strip's `last <state>` already kept (gap-list, health note).
 * Diagnostic reasons are service data: untranslated, in tooltips and (when present) red lines below, as in classic.
 */
export function AudioHealthStripV2({ status }: { status: AudioStatus }) {
  const t = useShellCopy(voiceMeetingCopy);
  const hasDetails = status.health || status.inputs?.length;
  if (!hasDetails) return null;
  const active = status.running;
  const stale = !active;
  const learning = (status.cluster_diagnostics?.provisional ?? 0) > 0;

  return (
    <div className="border-b border-cafe-border px-3 py-1.5">
      <div className="flex flex-wrap gap-1.5" data-testid="audio-health-tags">
        {status.health?.asr && (
          <Tag
            label={t.health.asr}
            value={componentTag(t, status.health.asr, active).text}
            tone={componentTag(t, status.health.asr, active).tone}
            title={status.health.asr.reason ?? status.health.asr.model}
            stale={stale}
          />
        )}
        {status.health?.speaker_separation && (
          <Tag
            label={t.health.speakers}
            value={
              status.health.speaker_separation.state === 'ready' && learning
                ? t.health.learning
                : componentTag(t, status.health.speaker_separation, active).text
            }
            tone={
              status.health.speaker_separation.state === 'ready' && learning && active
                ? 'amber'
                : componentTag(t, status.health.speaker_separation, active).tone
            }
            title={status.health.speaker_separation.reason ?? status.health.speaker_separation.model}
            stale={stale}
          />
        )}
        {status.inputs?.map((input) => {
          const state = !active && (input.state === 'running' || input.state === 'starting') ? 'stopped' : input.state;
          const value =
            state === 'running'
              ? t.health.running
              : state === 'starting'
                ? t.health.starting
                : state === 'failed'
                  ? t.health.failed
                  : state === 'stopped'
                    ? t.health.stopped
                    : t.health.unknown;
          const tone =
            state === 'running' && active
              ? 'green'
              : state === 'starting'
                ? 'amber'
                : state === 'failed'
                  ? 'red'
                  : 'muted';
          const titleParts = [
            input.reason ?? undefined,
            input.deduplicated_chunks ? t.health.echoesRemoved(input.deduplicated_chunks) : undefined,
          ].filter(Boolean);
          return (
            <Tag
              key={input.id}
              label={input.label ?? input.id}
              value={value}
              tone={tone}
              title={titleParts.length ? titleParts.join(' · ') : undefined}
              stale={stale}
            />
          );
        })}
      </div>
      {status.health?.asr?.reason && status.health.asr.state !== 'ready' && (
        <p className="mt-1 text-micro text-conn-red-text">{status.health.asr.reason}</p>
      )}
      {status.health?.speaker_separation?.reason && status.health.speaker_separation.state !== 'ready' && (
        <p className="mt-1 text-micro text-conn-red-text">{status.health.speaker_separation.reason}</p>
      )}
      {status.inputs
        ?.filter((input) => input.reason)
        .map((input) => (
          <p key={`${input.id}-reason`} className="mt-1 text-micro text-conn-red-text">
            {input.reason}
          </p>
        ))}
    </div>
  );
}
