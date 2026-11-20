'use client';
import type { WatcherConfig, WatcherConfigPatch } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsField, SettingsSection, SettingsText } from './primitives';
import { WatcherDailyUsage } from './WatcherDailyUsage';
import { WatcherQuietLabels } from './WatcherQuietLabels';
import { type WatcherMemberChoice, WatcherRoutingSettings, watcherRoutingChoice } from './WatcherRoutingSettings';

interface Snapshot {
  config: WatcherConfig;
  quietLabels: string[];
  availableLabels: Array<{ id: string; name: string; color: string }>;
  members: WatcherMemberChoice[];
  rolloutEnabled: boolean;
  panelAccounts?: Array<{ id: string; label: string }>;
}
export function WatcherSettings() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const routing = state ? watcherRoutingChoice(state.config) : undefined;
  const primaryReady =
    state?.members.some((member) => member.catId === routing?.primary.catId && member.capability.supported) ?? false;
  useEffect(() => {
    const abort = new AbortController();
    apiFetch('/api/watcher/config', { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('加载守望猫设置失败');
        const result: Snapshot = await response.json();
        if (!abort.signal.aborted) setState(result);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '加载失败');
      });
    return () => abort.abort();
  }, []);
  async function save(patch: WatcherConfigPatch) {
    if (!state || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await apiFetch('/api/watcher/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: state.config.revision, ...patch }),
      });
      if (response.status === 422)
        throw new Error(((await response.json()) as { error?: string }).error ?? '设置不可用');
      if (!response.ok) throw new Error(response.status === 409 ? '设置已改变，请刷新后重试' : '保存守望猫设置失败');
      setState(await response.json());
      window.dispatchEvent(new Event('watcher-settings-changed'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  return (
    <section id="watcher" data-testid="watcher-settings">
      <SettingsSection
        title="守望猫"
        badge={
          <button
            type="button"
            role="switch"
            aria-label="守望猫总开关"
            aria-checked={state?.config.enabled ?? false}
            disabled={!state || saving || (!state.config.enabled && !primaryReady)}
            onClick={() =>
              void save(state?.config.enabled ? { enabled: false } : { enabled: true, ...(routing ? { routing } : {}) })
            }
            className="inline-flex items-center justify-center"
          >
            <span className="sr-only">守望猫</span>
            <span aria-hidden="true" className={`watcher-switch ${state?.config.enabled ? 'is-on' : ''}`} />
          </button>
        }
      >
        {!state && !error && <SettingsText tone="muted">加载中…</SettingsText>}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {state && (
          <div className="watcher-config-fields space-y-4">
            <WatcherRoutingSettings
              config={state.config}
              members={state.members}
              accounts={state.panelAccounts ?? []}
              disabled={saving}
              onSave={(patch) => void save(patch)}
            />
            <SettingsField label="免打扰">
              <WatcherQuietLabels
                labels={state.availableLabels}
                selected={state.quietLabels}
                disabled={saving}
                onChange={(ids) => void save({ doNotDisturbLabelIds: ids })}
              />
            </SettingsField>
            <WatcherDailyUsage />
            {!state.rolloutEnabled && <SettingsText tone="muted">守望猫尚未开始查看。</SettingsText>}
          </div>
        )}
      </SettingsSection>
    </section>
  );
}
