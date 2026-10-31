'use client';

import { useEffect, useState } from 'react';
import {
  SettingsResourceToggleSwitch,
  settingsResourceActionGroupClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from './SettingsResourceCard';
import { SettingsSection, SettingsStatusStrip } from './settings/primitives';

export function DesktopUpdateSettingsPanel() {
  const [bridge, setBridge] = useState<DesktopBridge | null>(null);
  const [autoCheck, setAutoCheck] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const desktopBridge = window.desktopBridge;
    if (!desktopBridge) return;
    let active = true;
    setBridge(desktopBridge);
    void desktopBridge
      .getUpdateSettings()
      .then((settings) => {
        if (active) setAutoCheck(settings.autoCheck);
      })
      .catch(() => {
        if (active) setError('无法读取自动更新设置');
      });
    return () => {
      active = false;
    };
  }, []);

  if (!bridge) return null;

  const toggleAutoCheck = async () => {
    if (autoCheck === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const settings = await bridge.setUpdateAutoCheck(!autoCheck);
      setAutoCheck(settings.autoCheck);
    } catch {
      setError('无法保存自动更新设置');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="桌面更新" description="管理桌面应用的自动版本检测。手动“检查更新”始终可用。">
      <div className={settingsResourceCardClass}>
        <div className={settingsResourceRowClass}>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-cafe">自动检测更新</p>
            <p className="mt-1 text-xs leading-5 text-cafe-secondary">
              默认开启；应用启动后检查一次，持续运行时每 24 小时检查一次。关闭不会中断正在进行的检查或下载。
            </p>
          </div>
          <div className={settingsResourceActionGroupClass}>
            <span className="text-xs text-cafe-muted">
              {autoCheck === null ? '读取中…' : autoCheck ? '已开启' : '已关闭'}
            </span>
            <SettingsResourceToggleSwitch
              enabled={autoCheck === true}
              busy={busy}
              disabled={autoCheck === null}
              ariaLabel="自动检测更新"
              ariaPressed={autoCheck === true}
              onClick={() => void toggleAutoCheck()}
            />
          </div>
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <SettingsStatusStrip tone="error">{error}</SettingsStatusStrip>
        </div>
      )}
    </SettingsSection>
  );
}
