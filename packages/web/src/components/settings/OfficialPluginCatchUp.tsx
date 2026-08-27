import type { OfficialMeetingIntakeHealth } from './OfficialPluginCard';
import { SettingsPrimaryButton } from './primitives/SettingsPrimaryButton';
import { SettingsSecondaryButton } from './primitives/SettingsSecondaryButton';
import { SettingsText } from './primitives/SettingsText';

export type OfficialPluginCatchUpAction = 'preview' | 'future-only' | 'replay';

export function OfficialPluginCatchUp({
  health,
  updateAvailable,
  busy,
  onAction,
}: {
  health: OfficialMeetingIntakeHealth | undefined;
  updateAvailable: boolean;
  busy: boolean;
  onAction: (action: OfficialPluginCatchUpAction, fingerprint?: string) => void;
}) {
  const warning = health?.warning;
  const catchUp = health?.catchUp;
  if (!warning) return null;
  return (
    <div className="mt-3 rounded-md bg-conn-amber-bg px-3 py-2 text-conn-amber-text">
      <SettingsText as="p" tone="amber">
        {warning.message}
      </SettingsText>
      {updateAvailable ? (
        <SettingsText as="p" tone="amber" className="mt-1">
          请先更新到当前安全版本，更新后仍会保持停用，再由你选择恢复方式。
        </SettingsText>
      ) : catchUp?.status === 'previewed' ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <SettingsSecondaryButton disabled={busy} onClick={() => onAction('preview')}>
            {busy ? '正在检查…' : '重新预览'}
          </SettingsSecondaryButton>
          <SettingsSecondaryButton disabled={busy} onClick={() => onAction('future-only', catchUp.fingerprint)}>
            仅恢复以后
          </SettingsSecondaryButton>
          <SettingsPrimaryButton disabled={busy} onClick={() => onAction('replay', catchUp.fingerprint)}>
            {`补抓 ${catchUp.candidateCount} 条并恢复`}
          </SettingsPrimaryButton>
        </div>
      ) : warning.action === 'preview-catch-up' ? (
        <div className="mt-2">
          <SettingsSecondaryButton disabled={busy} onClick={() => onAction('preview')}>
            {busy ? '正在检查…' : '检查并预览缺口'}
          </SettingsSecondaryButton>
        </div>
      ) : null}
    </div>
  );
}
