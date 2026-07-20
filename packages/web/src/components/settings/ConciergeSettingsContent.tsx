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

import { BALL_SIZE_DEFAULT, BALL_SIZE_MAX, BALL_SIZE_MIN } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { RadioOption, RangeSlider, TextInput, ToggleSwitch } from './ConciergeSettingsParts';
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
  skin: 'yarn-ball' | 'ragdoll-v1' | 'yanyan-codex' | 'xianxian-codex';
  ballPosition: { x: number; y: number } | null;
  ballSize: number;
}

/** Skin options — display names now live inline in RadioOption labels (E2 unlock). */

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
        if (!cancelled) setError('加载猫猫球配置失败');
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
      <SettingsSection title="基本设置" description="控制猫猫球的显示与可用性。">
        <div className="space-y-4">
          <SettingsField label="启用猫猫球" hint="关闭后悬浮球不再显示。" inline>
            <ToggleSwitch checked={state.enabled} disabled={saving} onChange={(v) => updateConfig({ enabled: v })} />
          </SettingsField>

          <SettingsField label="静音模式" hint="一键隐藏悬浮球，不影响对话历史。" inline>
            <ToggleSwitch checked={state.muted} disabled={saving} onChange={(v) => updateConfig({ muted: v })} />
          </SettingsField>
        </div>
      </SettingsSection>

      {/* Section 2: 皮肤 (E2: unlocked — was KD-14 locked in Phase A) */}
      <SettingsSection title="皮肤" description="切换猫猫球的外观。">
        <div className="space-y-3">
          <RadioOption
            name="skin"
            value="yanyan-codex"
            checked={state.skin === 'yanyan-codex'}
            disabled={saving}
            label="🐱 砚砚 v1"
            hint="9 态动画精灵图，砚砚专属皮肤。（默认）"
            onChange={() => updateConfig({ skin: 'yanyan-codex' })}
          />
          <RadioOption
            name="skin"
            value="xianxian-codex"
            checked={state.skin === 'xianxian-codex'}
            disabled={saving}
            label="🐱 宪宪 v1"
            hint="9 态动画精灵图，宪宪专属皮肤（视频提取）。"
            onChange={() => updateConfig({ skin: 'xianxian-codex' })}
          />
        </div>
      </SettingsSection>

      {/* Section 3: 身份与人设 (KD-6) */}
      <SettingsSection title="身份与人设" description="自定义猫猫球的名字和性格基调。">
        <div className="space-y-4">
          <SettingsField label="显示名称" hint="猫猫球的名字，最多 50 字。">
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
                  {formatCatName(staleDutyCat)} · {staleDutyCat.id} — 不可用
                </option>
              )}
              {availableCats.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {formatCatName(cat)} · {cat.id}
                </option>
              ))}
            </select>
          </SettingsField>
        </div>
      </SettingsSection>

      {/* Section 5: 主动性 (OQ-4) */}
      <SettingsSection title="主动性策略" description="控制猫猫球何时主动出现。">
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

      {/* Section 6: 球大小 (E3) */}
      <SettingsSection title="猫猫球大小" description="拖拽悬浮球右下角可直接缩放，也可以在这里精确调整。">
        <div className="space-y-4">
          <SettingsField label="大小" hint={`范围 ${BALL_SIZE_MIN}–${BALL_SIZE_MAX}px，默认 ${BALL_SIZE_DEFAULT}px。`}>
            <RangeSlider
              value={state.ballSize ?? BALL_SIZE_DEFAULT}
              min={BALL_SIZE_MIN}
              max={BALL_SIZE_MAX}
              step={4}
              disabled={saving}
              label={(v) => `${v}px`}
              onChange={(v) => updateConfig({ ballSize: v })}
            />
          </SettingsField>
          {(state.ballSize ?? BALL_SIZE_DEFAULT) !== BALL_SIZE_DEFAULT && (
            <SettingsField label="" hint="" inline>
              <SettingsPillButton onClick={() => updateConfig({ ballSize: BALL_SIZE_DEFAULT })}>
                重置大小
              </SettingsPillButton>
            </SettingsField>
          )}
        </div>
      </SettingsSection>

      {/* Section 7: 球位置重置 */}
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
