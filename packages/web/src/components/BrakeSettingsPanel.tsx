'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useBrakeStore } from '@/stores/brakeStore';
import { HubIcon } from './hub-icons';
import { SettingsResourceToggleSwitch } from './SettingsResourceCard';

export function BrakeSettingsPanel() {
  const { settingsEnabled, settingsThreshold, settingsLoading, loadSettings, saveSettings } = useBrakeStore();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleToggle = useCallback(() => {
    saveSettings({ enabled: !settingsEnabled });
  }, [settingsEnabled, saveSettings]);

  const handleThresholdChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.target.value);
      // Optimistic UI update via store
      useBrakeStore.setState({ settingsThreshold: value });
      // Debounce API save
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        saveSettings({ thresholdMinutes: value });
      }, 500);
    },
    [saveSettings],
  );

  if (settingsLoading) {
    return <p className="text-sm text-cafe-secondary py-4">加载中…</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-cafe flex items-center gap-1.5">
          <HubIcon name="heart-pulse" className="h-4 w-4" /> 健康守护
        </h3>
        <p className="text-sm text-cafe-secondary mt-1">三猫会在你连续工作一段时间后提醒你休息</p>
      </div>

      <div className="console-list-card rounded-2xl p-4 space-y-4 shadow-[var(--console-shadow-soft)]">
        {/* Toggle */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-cafe-secondary">启用健康守护</span>
          <SettingsResourceToggleSwitch enabled={settingsEnabled} onClick={handleToggle} />
        </div>

        {/* Threshold slider */}
        <div className={settingsEnabled ? '' : 'opacity-50 pointer-events-none'}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm text-cafe-secondary">提醒间隔</span>
            <span className="text-sm font-mono font-semibold text-cafe">{settingsThreshold} 分钟</span>
          </div>
          <input
            type="range"
            min={30}
            max={240}
            step={15}
            value={settingsThreshold}
            onChange={handleThresholdChange}
            className="console-range-slider w-full"
            style={{ '--range-fill': `${((settingsThreshold - 30) / (240 - 30)) * 100}%` } as React.CSSProperties}
          />
          <div className="flex justify-between text-xs text-cafe-muted mt-0.5">
            <span>30 min</span>
            <span>240 min</span>
          </div>
        </div>

        {/* Night mode info */}
        <div className="rounded-md bg-cocreator-light/20 border border-cocreator-light/40 px-3 py-2">
          <p className="text-xs text-cocreator-primary flex items-center gap-1">
            <svg
              className="w-3.5 h-3.5 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"
              />
            </svg>
            夜间模式 (23:00–06:00) 自动启用 — 提醒更温柔，配色更柔和
          </p>
        </div>
      </div>
    </div>
  );
}
