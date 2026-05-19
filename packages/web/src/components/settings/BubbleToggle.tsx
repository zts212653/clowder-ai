'use client';

import { useCallback, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { SettingsField, SettingsPillButton } from './primitives';

type BubbleDefault = 'expanded' | 'collapsed';

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
  const display = optimistic ?? value;

  const toggle = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const next: BubbleDefault = display === 'collapsed' ? 'expanded' : 'collapsed';
    setOptimistic(next);
    try {
      const res = await apiFetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: configKey, value: next }),
      });
      if (res.ok) {
        setOptimistic(null);
        onChanged();
        void useChatStore.getState().fetchGlobalBubbleDefaults();
      } else setOptimistic(null);
    } catch {
      setOptimistic(null);
    } finally {
      pendingRef.current = false;
    }
  }, [display, configKey, onChanged]);

  return (
    <SettingsField label={label} inline compact>
      <SettingsPillButton onClick={toggle}>{display === 'expanded' ? '展开' : '折叠'}</SettingsPillButton>
    </SettingsField>
  );
}
