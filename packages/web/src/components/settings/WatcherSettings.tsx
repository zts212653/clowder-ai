'use client';
import type { WatcherCapability, WatcherConfig, WatcherConfigPatch } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsField, SettingsSection, SettingsText } from './primitives';
import { WatcherDailyUsage } from './WatcherDailyUsage';
import { WatcherQuietLabels } from './WatcherQuietLabels';

interface Snapshot {
  config: WatcherConfig;
  quietLabels: string[];
  availableLabels: Array<{ id: string; name: string; color: string }>;
  members: Array<{ catId: string; displayName: string; capability: WatcherCapability }>;
  rolloutEnabled: boolean;
}
export function WatcherSettings() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
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
            disabled={!state || saving}
            onClick={() => void save({ enabled: !state?.config.enabled })}
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
            <SettingsField label="守望哪些对话">
              <select
                aria-label="守望哪些对话"
                value={state.config.scope}
                disabled={saving}
                onChange={(event) => void save({ scope: event.target.value === 'all' ? 'all' : 'selected' })}
                className="w-full max-w-xs rounded-lg border border-cafe bg-cafe-surface px-3 py-2 text-sm text-cafe-primary"
              >
                <option value="all">全部</option>
                <option value="selected">只看我选的</option>
              </select>
            </SettingsField>
            <SettingsField label="成员">
              <select
                aria-label="守望猫成员"
                value={state.config.memberCatId}
                disabled={saving}
                onChange={(event) => void save({ memberCatId: event.target.value })}
                className="w-full max-w-xs rounded-lg border border-cafe bg-cafe-surface px-3 py-2 text-sm text-cafe-primary"
              >
                {!state.members.some((member) => member.catId === state.config.memberCatId) && (
                  <option value={state.config.memberCatId} disabled>
                    {state.config.memberCatId} · 当前不可用
                  </option>
                )}
                {state.members.map((member) => (
                  <option key={member.catId} value={member.catId} disabled={!member.capability.supported}>
                    {member.displayName}
                    {member.capability.supported ? '' : ` · ${member.capability.reason}`}
                  </option>
                ))}
              </select>
            </SettingsField>
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
