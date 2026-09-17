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
export const BUBBLE_UNCONFIRMED_NOTICE = '结果未确认，请刷新核实';

type SaveState = 'idle' | 'saved' | 'unsaved' | 'failed' | 'unconfirmed';

/**
 * Which persistence disclosure the response actually supports.
 *
 * Only an explicit `persisted: false` proves the choice did not reach disk, and
 * only an explicit `persisted: true` proves it did. A success response whose
 * body is unreadable or omits the flag proves neither, so it must stay
 * "unconfirmed" rather than borrow the "unsaved" wording.
 */
export async function readPersistOutcome(res: { json: () => Promise<unknown> }): Promise<SaveState> {
  let body: { persisted?: boolean } | null = null;
  try {
    body = (await res.json()) as { persisted?: boolean } | null;
  } catch {
    body = null;
  }
  if (body?.persisted === true) return 'saved';
  if (body?.persisted === false) return 'unsaved';
  return 'unconfirmed';
}

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
    let outcome: SaveState = 'unconfirmed';
    try {
      const res = await apiFetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: configKey, value: next }),
      });
      // A rejected response is the only case where the server told us the
      // update did not happen. Everything else — a lost response, a body we
      // cannot read — leaves the real state unknown.
      outcome = res.ok ? await readPersistOutcome(res) : 'failed';
    } catch {
      outcome = 'unconfirmed';
    }
    setOptimistic(null);
    setSaveState(outcome);
    // Re-read the server so an unknown outcome can be reconciled instead of
    // being left to the user's memory; the notice covers the gap either way.
    onChanged();
    void useChatStore.getState().fetchGlobalBubbleDefaults();
    pendingRef.current = false;
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
      {saveState === 'unconfirmed' ? (
        <output className="mt-1 block">
          <SettingsStatusStrip tone="warn" size="xs" bordered>
            {BUBBLE_UNCONFIRMED_NOTICE}
          </SettingsStatusStrip>
        </output>
      ) : null}
    </div>
  );
}
