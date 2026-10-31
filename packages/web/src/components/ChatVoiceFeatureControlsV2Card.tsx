'use client';

import { useState } from 'react';
import { FEATURE_SERVICES, readServiceLogDetails, type VoiceFeature } from './voice-feature-services';
import type { voiceMeetingCopy } from './workspace/voice-meeting.shell-copy';

export type VoiceMeetingCopy = (typeof voiceMeetingCopy)['zh'];

export const primaryCardActionClass =
  'shrink-0 rounded-lg bg-cafe-text-primary px-3 py-1.5 text-xs font-medium text-cafe-surface-primary transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40';
export const outlineCardActionClass =
  'shrink-0 rounded-lg border border-cafe-border px-2.5 py-1 text-xs text-cafe-text-primary transition-colors hover:bg-cafe-surface-secondary disabled:cursor-not-allowed disabled:opacity-40';

export interface CompanionCardModel {
  feature: VoiceFeature;
  icon: React.ReactNode;
  title: string;
  status: React.ReactNode;
  action?: React.ReactNode;
  active?: boolean;
  busy?: boolean;
  onTitleClick?: () => void;
  logsFeature?: VoiceFeature;
  label: string;
}

export function cardAction(
  kind: 'primary' | 'outline',
  label: string,
  onClick: () => void,
  testId?: string,
  disabled?: boolean,
): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={kind === 'outline' ? label : undefined}
      data-testid={testId}
      className={kind === 'primary' ? primaryCardActionClass : outlineCardActionClass}
    >
      {label}
    </button>
  );
}

function ServiceLogs({ feature, t }: { feature: VoiceFeature; t: VoiceMeetingCopy }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (logs !== null) return;
    setLoading(true);
    try {
      setLogs((await readServiceLogDetails(FEATURE_SERVICES[feature].serviceId)) ?? '');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-label={open ? t.voice.hideLogs : t.voice.viewLogs}
        className={outlineCardActionClass}
      >
        {open ? t.voice.hideLogs : t.voice.viewLogs}
      </button>
      {open && (
        <pre
          className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-cafe-surface-secondary p-2 font-mono text-micro text-cafe-text-secondary"
          data-testid={`service-logs-${feature}`}
        >
          {loading ? t.voice.loadingLogs : logs ? logs : t.voice.noLogs}
        </pre>
      )}
    </div>
  );
}

export function CompanionCard({ model, t }: { model: CompanionCardModel; t: VoiceMeetingCopy }) {
  return (
    <div
      className={`rounded-xl border px-3.5 py-3 transition-colors ${
        model.active
          ? 'border-[var(--semantic-success)]/30 bg-conn-emerald-bg'
          : 'border-cafe-subtle/75 bg-[var(--console-card-bg)]'
      } ${model.busy ? 'animate-pulse' : ''}`}
      data-testid={`workspace-companion-${model.feature === 'voice-companion' ? 'voice' : 'meeting'}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
            model.active
              ? 'bg-[var(--semantic-success)]/15 text-conn-emerald-text'
              : 'bg-cafe-accent/10 text-cafe-accent'
          }`}
        >
          {model.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            {model.onTitleClick ? (
              <button
                type="button"
                onClick={model.onTitleClick}
                aria-label={model.label}
                className="min-w-0 truncate text-left text-sm font-semibold tracking-tight text-cafe-black hover:underline"
              >
                {model.title}
              </button>
            ) : (
              <span className="min-w-0 truncate text-sm font-semibold tracking-tight text-cafe-black">
                {model.title}
              </span>
            )}
            {model.action}
          </div>
          <div className="mt-0.5 text-micro leading-4">{model.status}</div>
        </div>
      </div>
      {model.logsFeature && <ServiceLogs feature={model.logsFeature} t={t} />}
    </div>
  );
}
