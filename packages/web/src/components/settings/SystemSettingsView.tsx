'use client';

import { useMemo } from 'react';
import type { EnvVar } from './EnvSubComponents';
import { SettingsSection } from './primitives';

/* ------------------------------------------------------------------ */
/*  Settings group definitions (display order)                        */
/* ------------------------------------------------------------------ */

const GROUP_ORDER: readonly string[] = ['network', 'storage', 'lifecycle', 'runtime', 'security'];

const GROUP_LABELS: Record<string, string> = {
  network: '网络 & 端口',
  storage: '存储',
  lifecycle: '数据生命周期',
  runtime: '运行与调用',
  security: '安全 & 访问控制',
};

const GROUP_DESCRIPTIONS: Record<string, string> = {
  lifecycle: '各类数据的自动清理时间。设为 0 表示永久保留（推荐）',
};

/**
 * Determine effective boolean state using per-variable runtime semantics.
 * The `trueWhen` field on booleanSemantics specifies how the actual runtime
 * consumer parses the value — the display must match that behavior.
 */
function isEffectivelyOn(v: EnvVar): boolean {
  const sem = v.booleanSemantics;
  if (!sem) return false;
  if (v.currentValue == null) return sem.defaultOn;
  const raw = v.currentValue;
  const mode = sem.trueWhen ?? 'parseBoolEnv';
  switch (mode) {
    case 'exactTrue':
      return raw === 'true';
    case 'exactOne':
      return raw === '1';
    case 'notZero':
      return raw !== '0';
    default:
      return raw === '1' || raw.toLowerCase() === 'true';
  }
}

function ReadOnlyToggle({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      role="img"
      aria-label={`${label}: ${on ? '开启' : '关闭'}`}
      className={`relative inline-flex h-5 w-9 items-center rounded-full ${
        on ? 'bg-conn-emerald-text' : 'bg-cafe-surface-sunken'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-cafe-white transition-transform ${
          on ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </span>
  );
}

function HelpTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex items-center">
      <span
        className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-cafe text-[0.5625rem] leading-none text-cafe-muted"
        title={text}
      >
        ?
      </span>
      <span
        className="invisible absolute left-1/2 top-full z-50 mt-1.5 w-max max-w-xs -translate-x-1/2 rounded-md border border-cafe bg-cafe-surface-elevated px-2.5 py-1.5 text-xs text-cafe-secondary opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100"
        aria-hidden
      >
        {text}
      </span>
    </span>
  );
}

function SettingItem({ v }: { v: EnvVar }) {
  const label = v.label ?? v.name;
  const displayValue = v.currentValue ?? v.defaultValue;

  return (
    <div className="flex items-start gap-4 py-3 justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cafe">{label}</span>
          {v.description && <HelpTip text={v.description} />}
        </div>
      </div>
      <div className={`text-right ${v.booleanSemantics ? 'shrink-0' : 'min-w-0 max-w-[50%] overflow-hidden'}`}>
        {v.booleanSemantics ? (
          <ReadOnlyToggle on={isEffectivelyOn(v)} label={label} />
        ) : (
          <span className="block truncate text-sm font-mono text-cafe-secondary" title={displayValue}>
            {displayValue}
          </span>
        )}
      </div>
    </div>
  );
}

interface SystemSettingsViewProps {
  variables: EnvVar[];
}

export function SystemSettingsView({ variables }: SystemSettingsViewProps) {
  const groups = useMemo(() => {
    const map = new Map<string, EnvVar[]>();
    for (const v of variables) {
      const key = v.settingsGroup ?? 'other';
      const arr = map.get(key) ?? [];
      arr.push(v);
      map.set(key, arr);
    }
    const ordered: Array<{ key: string; label: string; description?: string; vars: EnvVar[] }> = [];
    for (const key of GROUP_ORDER) {
      const vars = map.get(key);
      if (vars?.length) {
        ordered.push({ key, label: GROUP_LABELS[key] ?? key, description: GROUP_DESCRIPTIONS[key], vars });
        map.delete(key);
      }
    }
    for (const [key, vars] of map) {
      ordered.push({ key, label: GROUP_LABELS[key] ?? key, vars });
    }
    return ordered;
  }, [variables]);

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <SettingsSection key={group.key} title={group.label} description={group.description}>
          <div className="divide-y divide-[var(--console-border-soft)]">
            {group.vars.map((v) => (
              <SettingItem key={v.name} v={v} />
            ))}
          </div>
        </SettingsSection>
      ))}
    </div>
  );
}
