'use client';

import type { BrakeMode } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef } from 'react';
import { useBrakeStore } from '@/stores/brakeStore';
import { HubIcon } from './hub-icons';

export function BrakeSettingsPanel() {
  const { settingsEnabled, settingsThreshold, settingsMode, settingsLoading, loadSettings, saveSettings } =
    useBrakeStore();
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

  const handleModeChange = useCallback(
    (mode: BrakeMode) => {
      saveSettings({ mode });
    },
    [saveSettings],
  );

  if (settingsLoading) {
    return <p className="text-sm text-cafe-secondary py-4">加载中...</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-cafe flex items-center gap-1.5">
          <HubIcon name="heart-pulse" className="h-4 w-4" /> 健康守护
        </h3>
        <p className="text-sm text-cafe-secondary mt-1">三猫会在你连续工作一段时间后提醒你休息</p>
      </div>

      <div className="console-list-card rounded-xl bg-[var(--console-card-bg)] p-4 space-y-4 shadow-[var(--shadow-elevation-2)]">
        {/* Toggle */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-cafe-secondary">启用健康守护</span>
          <button
            type="button"
            role="switch"
            aria-checked={settingsEnabled}
            onClick={handleToggle}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
              settingsEnabled ? 'bg-cafe-accent' : 'bg-cafe-surface'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-cafe-surface shadow ring-0 transition-transform duration-200 ${
                settingsEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Settings below — disabled when brake is off */}
        <div className={settingsEnabled ? '' : 'opacity-50 pointer-events-none'}>
          {/* Threshold slider */}
          <div>
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
              className="w-full accent-[var(--cafe-accent)]"
            />
            <div className="flex justify-between text-xs text-cafe-muted mt-0.5">
              <span>30 min</span>
              <span>240 min</span>
            </div>
          </div>

          {/* Phase 6: Mode selector (AC4 + AC5) */}
          <div className="mt-4">
            <span className="text-sm text-cafe-secondary block mb-2">提醒模式</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleModeChange('gentle')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm transition-colors ${
                  settingsMode === 'gentle'
                    ? 'bg-cafe-accent text-[var(--cafe-surface)] font-medium'
                    : 'bg-[var(--console-field-bg,var(--console-card-bg))] text-cafe-secondary hover:bg-cafe-surface'
                }`}
              >
                温柔档
              </button>
              <button
                type="button"
                onClick={() => handleModeChange('hardcore')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm transition-colors ${
                  settingsMode === 'hardcore'
                    ? 'bg-[var(--semantic-warning)] text-[var(--cafe-surface)] font-medium'
                    : 'bg-[var(--console-field-bg,var(--console-card-bg))] text-cafe-secondary hover:bg-cafe-surface'
                }`}
              >
                硬核档
              </button>
            </div>
            <p className="text-xs text-cafe-muted mt-1.5">
              {settingsMode === 'gentle'
                ? '普通提醒，可一键关闭'
                : '强制互动：必须填写理由才能继续，紧急跳过有次数限制'}
            </p>
          </div>

          {/* AC5: Hardcore mode commitment device warning */}
          {settingsMode === 'hardcore' && (
            <div className="mt-3 rounded-[10px] bg-[var(--semantic-warning-surface,var(--console-field-bg))] border border-[var(--semantic-warning)] px-3 py-2">
              <p className="text-xs text-[var(--semantic-warning)] flex items-start gap-1.5">
                <svg
                  className="w-3.5 h-3.5 flex-shrink-0 mt-0.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                  />
                </svg>
                <span>
                  <strong>承诺装置</strong> ——
                  开启后，提醒弹窗无法一键关闭。你需要选择休息、收尾或填写理由才能继续工作。紧急跳过每 4 小时限 2 次，第
                  3 次起将持续提醒直到你休息。
                </span>
              </p>
            </div>
          )}
        </div>

        {/* Night mode info */}
        <div className="rounded-[10px] bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2">
          <p className="text-xs text-cafe-accent flex items-center gap-1">
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
            夜间模式 (23:00-06:00) 自动启用 — 提醒更温柔，配色更柔和
          </p>
        </div>
      </div>
    </div>
  );
}
