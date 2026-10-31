'use client';

import { useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from '../config-viewer-types';
import { useShellCopy } from '../shell/shell-copy';
import { executionRecordDefaultCopy } from './execution-record-default.shell-copy';

type ExecutionRecordDefault = 'expanded' | 'collapsed';
type ConfigWithBubbleDefaults = ConfigData & {
  ui: { bubbleDefaults: NonNullable<ConfigData['ui']>['bubbleDefaults'] };
};

interface ExecutionRecordDefaultSettingsProps {
  config: ConfigData | null;
  hasLoadError: boolean;
  onConfigChange: (config: ConfigData) => void;
  onRetry: () => void;
}

function isConfigResponse(value: unknown): value is { config: ConfigWithBubbleDefaults } {
  if (typeof value !== 'object' || value === null) return false;
  const config = (value as { config?: ConfigData }).config;
  const cliOutput = config?.ui?.bubbleDefaults?.cliOutput;
  return cliOutput === 'expanded' || cliOutput === 'collapsed';
}

export function ExecutionRecordDefaultSettings({
  config,
  hasLoadError,
  onConfigChange,
  onRetry,
}: ExecutionRecordDefaultSettingsProps) {
  const t = useShellCopy(executionRecordDefaultCopy);
  const [pending, setPending] = useState<ExecutionRecordDefault | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const stored = config?.ui?.bubbleDefaults?.cliOutput ?? null;
  const displayed = pending ?? stored;

  const save = async (next: ExecutionRecordDefault) => {
    if (pending || next === stored) return;
    setPending(next);
    setSaveFailed(false);
    try {
      const response = await apiFetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'ui.bubble.cliOutput', value: next }),
      });
      if (!response.ok) throw new Error(`save rejected (${response.status})`);
      const payload: unknown = await response.json();
      if (!isConfigResponse(payload)) throw new Error('config response missing bubble defaults');
      onConfigChange(payload.config);
      useChatStore.getState().setGlobalBubbleDefaults(payload.config.ui.bubbleDefaults);
    } catch {
      setSaveFailed(true);
    } finally {
      setPending(null);
    }
  };

  return (
    <section aria-labelledby="execution-record-default-heading" className="space-y-2">
      <div>
        <h3
          id="execution-record-default-heading"
          className="text-sm font-semibold"
          style={{ color: 'var(--shell-ink)' }}
        >
          {t.title}
        </h3>
        <p className="mt-1 text-xs" style={{ color: 'var(--shell-muted)' }}>
          {t.scope}
        </p>
      </div>

      {stored ? (
        <>
          <div
            role="radiogroup"
            aria-labelledby="execution-record-default-heading"
            aria-busy={pending !== null}
            className="flex flex-col gap-1.5"
          >
            {(['collapsed', 'expanded'] as const).map((value) => {
              const copy = t[value];
              const selected = displayed === value;
              return (
                <label
                  key={value}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                    pending ? 'cursor-wait opacity-70' : 'cursor-pointer'
                  }`}
                  style={{
                    background: selected ? 'var(--shell-selected)' : 'var(--shell-paper)',
                    border: '1px solid var(--shell-hairline)',
                    color: 'var(--shell-ink)',
                  }}
                >
                  <input
                    type="radio"
                    name="execution-record-default"
                    checked={selected}
                    data-testid={`execution-record-default-${value}`}
                    disabled={pending !== null}
                    onChange={() => void save(value)}
                    className="shell-focusable h-3.5 w-3.5 flex-none accent-[var(--shell-ink)]"
                  />
                  <span className="flex-1">
                    {copy.label}
                    <span className="ml-2 text-xs" style={{ color: 'var(--shell-muted)' }}>
                      {copy.note}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {pending && (
            <output className="block text-xs" style={{ color: 'var(--shell-muted)' }}>
              {t.saving}
            </output>
          )}
          {saveFailed && (
            <p role="alert" className="text-xs text-conn-rose-text">
              {t.saveFailed}
            </p>
          )}
        </>
      ) : hasLoadError || config ? (
        <div className="flex items-center gap-2 text-xs text-conn-rose-text" role="alert">
          <span>{t.loadFailed}</span>
          <button type="button" onClick={onRetry} className="shell-focusable rounded px-2 py-1 underline">
            {t.retry}
          </button>
        </div>
      ) : (
        <output className="block text-xs" style={{ color: 'var(--shell-muted)' }}>
          {t.loading}
        </output>
      )}
    </section>
  );
}
