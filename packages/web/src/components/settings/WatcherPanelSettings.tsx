'use client';
import type { WatcherConfigPatch, WatcherPanelConfig } from '@cat-cafe/shared';
import { SettingsField, SettingsText } from './primitives';

export interface WatcherPanelChoices {
  panel?: WatcherPanelConfig;
  panelDefaults: WatcherPanelConfig;
  panelAccounts: Array<{ id: string; label: string }>;
  members: Array<{ catId: string; displayName: string; panelSupported?: boolean }>;
}

/** F335 experiment: several watchers, each with its own session and optional account. Off by default. */
export function WatcherPanelSettings({
  choices,
  disabled,
  onSave,
}: {
  choices: WatcherPanelChoices;
  disabled: boolean;
  onSave(patch: WatcherConfigPatch): void;
}) {
  const current = choices.panel ?? choices.panelDefaults;
  const enabled = choices.panel?.enabled ?? false;
  const candidates = choices.members.filter((member) => member.panelSupported);
  const save = (next: Partial<WatcherPanelConfig>) => onSave({ panel: { ...current, ...next } });
  const toggleMember = (catId: string) => {
    const chosen = current.members.some((member) => member.catId === catId);
    const members = chosen
      ? current.members.filter((member) => member.catId !== catId)
      : [...current.members, { catId }];
    if (members.length > 0) save({ members });
  };
  const setAccount = (catId: string, accountRef: string) =>
    save({
      members: current.members.map((member) =>
        member.catId === catId ? { catId, ...(accountRef ? { accountRef } : {}) } : member,
      ),
    });
  return (
    <SettingsField label="多只守望（实验）">
      <div className="space-y-3" data-testid="watcher-panel-settings">
        <button
          type="button"
          role="switch"
          aria-label="多只守望开关"
          aria-checked={enabled}
          disabled={disabled}
          onClick={() => save({ enabled: !enabled })}
          className="inline-flex min-h-8 items-center gap-2 rounded-md text-sm text-cafe-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span aria-hidden="true" className={`watcher-switch ${enabled ? 'is-on' : ''}`} />
          {enabled ? '已开启' : '已关闭'}
        </button>
        <SettingsText as="p" tone="muted">
          {enabled
            ? '多只守望替代单只守望，仍由上方总开关控制是否运行。'
            : '尚未启用多只守望。开启后再选择成员和账号，并保持上方总开关打开。'}
        </SettingsText>
        {enabled && (
          <>
            <ul className="space-y-2">
              {candidates.map((member) => {
                const chosen = current.members.find((entry) => entry.catId === member.catId);
                return (
                  <li key={member.catId} className="flex flex-wrap items-center gap-2 text-sm text-cafe-primary">
                    <label className="flex min-w-40 items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label={`守望成员 ${member.displayName}`}
                        checked={Boolean(chosen)}
                        disabled={disabled || (Boolean(chosen) && current.members.length === 1)}
                        onChange={() => toggleMember(member.catId)}
                      />
                      {member.displayName}
                    </label>
                    {chosen && (
                      <select
                        aria-label={`${member.displayName} 用的账号`}
                        value={chosen.accountRef ?? ''}
                        disabled={disabled}
                        onChange={(event) => setAccount(member.catId, event.target.value)}
                        className="rounded-lg border border-cafe bg-cafe-surface px-2 py-1 text-sm text-cafe-primary"
                      >
                        <option value="">成员自己的账号</option>
                        {choices.panelAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </li>
                );
              })}
            </ul>
            <label className="flex items-center gap-2 text-sm text-cafe-primary">
              同时在看的上限
              <select
                aria-label="同时在看的上限"
                value={current.maxConcurrentRuns}
                disabled={disabled}
                onChange={(event) => save({ maxConcurrentRuns: Number(event.target.value) })}
                className="rounded-lg border border-cafe bg-cafe-surface px-2 py-1 text-sm text-cafe-primary"
              >
                {Array.from({ length: 12 }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            {candidates.length === 0 && <SettingsText tone="muted">没有能担任多只守望的成员。</SettingsText>}
          </>
        )}
      </div>
    </SettingsField>
  );
}
