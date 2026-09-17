'use client';

import { useCallback, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { SettingsField, SettingsPillButton, SettingsStatusStrip } from './primitives';

type BubbleDefault = 'expanded' | 'collapsed';

/**
 * PATCH /api/config is best-effort about persistence: the hot update always
 * applies in-process, but the write to the config-root .env can fail (or be
 * skipped for keys that are runtime-only). The server reports that through
 * `persisted`, so the toggle must say so instead of implying the choice will
 * survive a restart.
 */
export const BUBBLE_UNSAVED_NOTICE = '本次生效、未保存（重启后会恢复原值）';
export const BUBBLE_SAVE_FAILED_NOTICE = '更新失败：服务端未接受，设置未改变';

type SaveState = 'idle' | 'saved' | 'unsaved' | 'failed';

export function BubbleToggle({
  label,
  value,
  configKey,
  onChanged,
}: {
  label: string;
  value: BubbleDefault;
  configKey: string;
  onChanged: () => void;
}) {
  const pendingRef = useRef(false);
  const [optimistic, setOptimistic] = useState<BubbleDefault | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const display = optimistic ?? value;

  const toggle = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const next: BubbleDefault = display === 'collapsed' ? 'expanded' : 'collapsed';
    setOptimistic(next);
    setSaveState('idle');
    try {
      const res = await apiFetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: configKey, value: next }),
      });
      if (!res.ok) {
        setOptimistic(null);
        setSaveState('failed');
        return;
      }
      const body = (await res.json().catch(() => null)) as { persisted?: boolean } | null;
      setOptimistic(null);
      // An absent `persisted` field must not be read as success: only an
      // explicit true means the choice survives a restart.
      setSaveState(body?.persisted === true ? 'saved' : 'unsaved');
      onChanged();
      void useChatStore.getState().fetchGlobalBubbleDefaults();
    } catch {
      setOptimistic(null);
      setSaveState('failed');
    } finally {
      pendingRef.current = false;
    }
  }, [display, configKey, onChanged]);

  return (
    <div>
      <SettingsField label={label} inline compact>
        <SettingsPillButton onClick={toggle}>{display === 'expanded' ? '展开' : '折叠'}</SettingsPillButton>
      </SettingsField>
      {saveState === 'unsaved' ? (
        <output className="mt-1 block">
          <SettingsStatusStrip tone="warn" size="xs" bordered>
            {BUBBLE_UNSAVED_NOTICE}
          </SettingsStatusStrip>
        </output>
      ) : null}
      {saveState === 'failed' ? (
        <output className="mt-1 block">
          <SettingsStatusStrip tone="error" size="xs" bordered>
            {BUBBLE_SAVE_FAILED_NOTICE}
          </SettingsStatusStrip>
        </output>
      ) : null}
    </div>
  );
}
