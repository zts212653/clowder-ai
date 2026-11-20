'use client';
import type {
  WatcherConfig,
  WatcherConfigPatch,
  WatcherMemberCapability,
  WatcherRoutingConfig,
} from '@cat-cafe/shared';
import { watcherRoutingPreference } from '@cat-cafe/shared';
import { SettingsField, SettingsText } from './primitives';

export interface WatcherMemberChoice {
  catId: string;
  displayName: string;
  capability: WatcherMemberCapability;
  accounts?: readonly { id: string; label: string }[];
}

/** Reading old preferences does not persist a migration or enable a watcher. */
export const watcherRoutingChoice = watcherRoutingPreference;

const selectClass = 'w-full max-w-xs rounded-lg border border-cafe bg-cafe-surface px-3 py-2 text-sm text-cafe-primary';

export function WatcherRoutingSettings({
  config,
  members,
  accounts,
  disabled,
  onSave,
}: {
  config: WatcherConfig;
  members: readonly WatcherMemberChoice[];
  accounts: readonly { id: string; label: string }[];
  disabled: boolean;
  onSave(patch: WatcherConfigPatch): void;
}) {
  const routing = watcherRoutingChoice(config);
  const alternate = routing.whenSameFamily.mode === 'member' ? routing.whenSameFamily.member.catId : undefined;
  const sameFamilyValue = alternate ? `member:${alternate}` : routing.whenSameFamily.mode;
  const primary = members.find((member) => member.catId === routing.primary.catId);
  const selectedAccounts = primary?.accounts ?? accounts;
  const alternateChoice = members.find((member) => member.catId === alternate);
  const save = (next: WatcherRoutingConfig) => onSave({ routing: next });
  const memberOptions = () =>
    members.map((member) => (
      <option key={member.catId} value={member.catId} disabled={!member.capability.supported}>
        {member.displayName}
        {member.capability.supported ? '' : ' · 还没接通'}
      </option>
    ));
  return (
    <>
      <SettingsField label="主守望猫">
        <select
          aria-label="主守望猫"
          value={routing.primary.catId}
          disabled={disabled}
          className={selectClass}
          onChange={(event) => save({ ...routing, primary: { catId: event.target.value } })}
        >
          <option value="" disabled>
            选择一只主守望猫
          </option>
          {routing.primary.catId && !primary && (
            <option value={routing.primary.catId} disabled>
              {routing.primary.catId} · 当前不可用
            </option>
          )}
          {memberOptions()}
        </select>
        {!routing.primary.catId && (
          <SettingsText as="p" tone="muted" className="mt-1">
            先选一只主守望猫，再打开总开关。
          </SettingsText>
        )}
        {primary && !primary.capability.supported && (
          <SettingsText as="p" tone="muted" className="mt-1">
            {primary.capability.reason}
          </SettingsText>
        )}
      </SettingsField>
      <SettingsField label="干活的猫和主守望猫同一家时，由谁看">
        <select
          aria-label="同家时由谁看"
          value={sameFamilyValue}
          disabled={disabled || !routing.primary.catId}
          className={selectClass}
          onChange={(event) => {
            const value = event.target.value;
            const whenSameFamily = value.startsWith('member:')
              ? { mode: 'member' as const, member: { catId: value.slice(7) } }
              : { mode: value === 'skip' ? ('skip' as const) : ('primary' as const) };
            save({ ...routing, whenSameFamily });
          }}
        >
          <option value="primary">照样由主守望猫看</option>
          <option value="skip">不看</option>
          {alternate && !alternateChoice && (
            <option value={`member:${alternate}`} disabled>
              {alternate} · 当前不可用
            </option>
          )}
          {members.map((member) => (
            <option key={member.catId} value={`member:${member.catId}`} disabled={!member.capability.supported}>
              {member.displayName}
              {member.capability.supported ? '' : ' · 还没接通'}
            </option>
          ))}
        </select>
        <SettingsText as="p" tone="muted" className="mt-1">
          每轮工作结束后自动判断，不用逐个对话配置。
        </SettingsText>
        {alternateChoice && !alternateChoice.capability.supported && (
          <SettingsText as="p" tone="muted" className="mt-1">
            {alternateChoice.capability.reason}
          </SettingsText>
        )}
      </SettingsField>
      <details className="text-sm text-cafe-secondary">
        <summary className="cursor-pointer">更多设置</summary>
        <div className="mt-3 space-y-4">
          {selectedAccounts.length > 0 && (
            <SettingsField label="主守望猫使用的账号">
              <select
                aria-label="主守望猫使用的账号"
                value={routing.primary.accountRef ?? ''}
                disabled={disabled || !routing.primary.catId}
                className={selectClass}
                onChange={(event) =>
                  save({
                    ...routing,
                    primary: {
                      catId: routing.primary.catId,
                      ...(event.target.value ? { accountRef: event.target.value } : {}),
                    },
                  })
                }
              >
                <option value="">成员自己的账号</option>
                {selectedAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label}
                  </option>
                ))}
              </select>
            </SettingsField>
          )}
          <SettingsField label="同时查看的上限">
            <select
              aria-label="同时查看的上限"
              value={routing.maxConcurrentRuns}
              disabled={disabled || !routing.primary.catId}
              className={selectClass}
              onChange={(event) => save({ ...routing, maxConcurrentRuns: Number(event.target.value) })}
            >
              {Array.from({ length: 12 }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </SettingsField>
        </div>
      </details>
    </>
  );
}
