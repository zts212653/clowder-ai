'use client';

/**
 * F229 PR-A4: Concierge settings page — AC-A5
 *
 * Surfaces ConciergeConfig fields in the Settings shell:
 *   enabled, displayName, personaTone, dutyCatProfileId, proactivePolicy, muted, ballPosition reset.
 *
 * Backend: GET/PUT /api/concierge/config (already implemented in PR-A1).
 * Store: conciergeStore.fetchConfig/setMuted (already wired in PR-A2).
 *
 * Pattern: optimistic UI + PUT partial update, matching BubbleToggle/VoiceSettingsPanel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { RadioOption, TextInput, ToggleSwitch } from './ConciergeSettingsParts';
import { SettingsField, SettingsPillButton, SettingsSection, SettingsText } from './primitives';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConciergeSettingsState {
  enabled: boolean;
  displayName: string;
  personaTone: string;
  dutyCatProfileId: string;
  proactivePolicy: 'ambient' | 'quiet-badge';
  muted: boolean;
  skin: 'yarn-ball' | 'ragdoll-v1';
  ballPosition: { x: number; y: number } | null;
}

/** Skin ID → display label (locked chip in settings) */
const SKIN_DISPLAY_NAMES: Record<string, string> = {
  'yarn-ball': '🧶 毛线球',
  'ragdoll-v1': '🐱 布偶猫 v1',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConciergeSettingsContent() {
  const { cats } = useCatData();
  const [state, setState] = useState<ConciergeSettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pendingRef = useRef(false);

  // Load config on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/concierge/config');
        if (!res.ok) {
          setError(`加载失败 (${res.status})`);
          return;
        }
        const data = (await res.json()) as { config: ConciergeSettingsState };
        if (!cancelled) {
          setState(data.config);
          // P2 fix: sync live store so ConciergeHost picks up correct state
          // even if its own fetchConfig() previously failed (configFailed=true).
          useConciergeStore.setState(data.config);
        }
      } catch {
        if (!cancelled) setError('加载前台猫配置失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Revert optimistic state: try server reload (network may be up), fall back to snapshot
  const revertState = useCallback(async (snapshot: ConciergeSettingsState | null) => {
    try {
      const res = await apiFetch('/api/concierge/config');
      if (res.ok) {
        const data = (await res.json()) as { config: ConciergeSettingsState };
        setState(data.config);
        return;
      }
    } catch {
      /* server unreachable — fall through to snapshot */
    }
    if (snapshot) setState(snapshot);
  }, []);

  // Persist a partial config update with optimistic UI
  const updateConfig = useCallback(
    async (patch: Partial<ConciergeSettingsState>) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setSaving(true);
      setError(null);

      // FIX-5 A4 plan: muted toggle in ball vs settings page = single-writer per-user config.
      // Concurrent writes are last-write-wins — acceptable because both write the full config
      // (partial merge on server), and the user is the only writer of their own config.
      // No state machine or conflict resolution needed (plan §Census).
      // Capture pre-patch snapshot for local rollback (no network dependency)
      let prevSnapshot: ConciergeSettingsState | null = null;
      setState((prev) => {
        prevSnapshot = prev;
        return prev ? { ...prev, ...patch } : prev;
      });

      try {
        const res = await apiFetch('/api/concierge/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `保存失败 (${res.status})`);
          await revertState(prevSnapshot);
        } else {
          // Cloud P2 fix: use the full merged config from the PUT response to sync
          // the live store — not just the patch. If the store diverged (e.g. another
          // tab changed a field, or the host's guarded fetchConfig() failed on mount),
          // patching only the changed field would leave other fields stale.
          const { config } = (await res.json()) as { config: ConciergeSettingsState };
          useConciergeStore.setState(config);
          setState(config);
        }
      } catch {
        setError('保存失败');
        // P2 fix: revert to pre-patch snapshot — no network round-trip needed.
        // Network is likely down (PUT threw), so GET would also fail.
        if (prevSnapshot) setState(prevSnapshot);
      } finally {
        pendingRef.current = false;
        setSaving(false);
      }
    },
    [revertState],
  );

  // Available cats for duty cat selector.
  // If the persisted dutyCatProfileId is no longer in the available roster,
  // include it as a disabled "(不可用)" option so the mismatch is visible
  // and the controlled <select> doesn't silently fall back to the first item.
  const availableCats = cats.filter((c) => c.roster?.available !== false);
  const currentDutyCatMissing = state?.dutyCatProfileId && !availableCats.some((c) => c.id === state.dutyCatProfileId);
  const staleDutyCat = currentDutyCatMissing ? cats.find((c) => c.id === state.dutyCatProfileId) : null;

  if (!state) {
    return (
      <SettingsText as="p" variant="sm" tone="muted">
        {error ?? '加载中...'}
      </SettingsText>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <SettingsText as="p" variant="sm" tone="red">
          {error}
        </SettingsText>
      )}

      {/* Section 1: 基本开关 */}
      <SettingsSection title="基本设置" description="控制前台猫的显示与可用性。">
        <div className="space-y-4">
          <SettingsField label="启用前台猫" hint="关闭后悬浮球不再显示。" inline>
            <ToggleSwitch checked={state.enabled} disabled={saving} onChange={(v) => updateConfig({ enabled: v })} />
          </SettingsField>

          <SettingsField label="静音模式" hint="一键隐藏悬浮球，不影响对话历史。" inline>
            <ToggleSwitch checked={state.muted} disabled={saving} onChange={(v) => updateConfig({ muted: v })} />
          </SettingsField>
        </div>
      </SettingsSection>

      {/* Section 2: 皮肤 (KD-14, Phase A locked) */}
      <SettingsSection title="皮肤" description="前台猫的外观。更多皮肤将在后续版本解锁。">
        <SettingsField label="当前皮肤" hint="Phase E 解锁后可切换四种皮肤。" inline>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.375rem',
              padding: '0.25rem 0.75rem',
              borderRadius: '9999px',
              fontSize: 'var(--console-font-sm, 0.875rem)',
              color: 'var(--cafe-text-secondary)',
              backgroundColor: 'var(--console-card-bg)',
              border: '1px solid var(--cafe-border)',
              opacity: 0.7,
            }}
          >
            {SKIN_DISPLAY_NAMES[state?.skin ?? 'ragdoll-v1'] ?? state?.skin}
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" style={{ width: 12, height: 12 }}>
              <path d="M4 6V4a4 4 0 118 0v2h1a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V7a1 1 0 011-1h1zm2-2a2 2 0 114 0v2H6V4z" />
            </svg>
          </span>
        </SettingsField>
      </SettingsSection>

      {/* Section 3: 身份与人设 (KD-6) */}
      <SettingsSection title="身份与人设" description="自定义前台猫的名字和性格基调。">
        <div className="space-y-4">
          <SettingsField label="显示名称" hint="前台猫的名字，最多 50 字。">
            <TextInput
              value={state.displayName}
              maxLength={50}
              disabled={saving}
              onCommit={(v) => updateConfig({ displayName: v })}
            />
          </SettingsField>

          <SettingsField label="人设基调" hint="一句话描述人设风格，会注入值班猫的 prompt。最多 200 字。">
            <TextInput
              value={state.personaTone}
              maxLength={200}
              disabled={saving}
              onCommit={(v) => updateConfig({ personaTone: v })}
            />
          </SettingsField>
        </div>
      </SettingsSection>

      {/* Section 4: 值班猫 (KD-7) */}
      <SettingsSection title="值班猫" description="选择哪只猫猫负责前台应答。Provider-agnostic，可配置任意已注册的猫。">
        <div className="space-y-4">
          <SettingsField label="值班猫" hint="前台对话由这只猫处理。">
            <select
              value={state.dutyCatProfileId}
              disabled={saving}
              onChange={(e) => updateConfig({ dutyCatProfileId: e.target.value })}
              className="w-full max-w-xs border focus:outline-none focus:ring-1"
              style={{
                borderRadius: '0.5rem',
                borderColor: 'var(--cafe-border)',
                backgroundColor: 'var(--console-card-bg)',
                padding: '0.375rem 0.75rem',
                fontSize: 'var(--console-font-sm, 0.875rem)',
                color: 'var(--cafe-text)',
              }}
            >
              {staleDutyCat && (
                <option key={staleDutyCat.id} value={staleDutyCat.id} disabled>
                  {staleDutyCat.displayName} ({staleDutyCat.id}) — 不可用
                </option>
              )}
              {availableCats.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.displayName} ({cat.id})
                </option>
              ))}
            </select>
          </SettingsField>
        </div>
      </SettingsSection>

      {/* Section 5: 主动性 (OQ-4) */}
      <SettingsSection title="主动性策略" description="控制前台猫何时主动出现。">
        <div className="space-y-3">
          <RadioOption
            name="proactivePolicy"
            value="ambient"
            checked={state.proactivePolicy === 'ambient'}
            disabled={saving}
            label="仅环境感知"
            hint="完全安静，零主动文本弹出。"
            onChange={() => updateConfig({ proactivePolicy: 'ambient' })}
          />
          <RadioOption
            name="proactivePolicy"
            value="quiet-badge"
            checked={state.proactivePolicy === 'quiet-badge'}
            disabled={saving}
            label="安静徽章"
            hint="低优先级事件显示小圆点，hover 才出文字。（默认）"
            onChange={() => updateConfig({ proactivePolicy: 'quiet-badge' })}
          />
        </div>
      </SettingsSection>

      {/* Section 6: 球位置重置 */}
      {state.ballPosition && (
        <SettingsSection title="悬浮球位置" description="拖拽悬浮球可自由放置，这里可以重置到默认位置。">
          <SettingsField
            label="当前位置"
            hint={`x: ${Math.round(state.ballPosition.x)}, y: ${Math.round(state.ballPosition.y)}`}
            inline
          >
            <SettingsPillButton onClick={() => updateConfig({ ballPosition: null })}>重置位置</SettingsPillButton>
          </SettingsField>
        </SettingsSection>
      )}
    </div>
  );
}
