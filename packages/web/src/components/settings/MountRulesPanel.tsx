'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-client';

const STANDARD_IDS = ['claude', 'codex', 'gemini', 'kimi'] as const;
type StandardId = (typeof STANDARD_IDS)[number];

interface StandardRule {
  enabled: boolean;
  path: string;
}

interface CustomRule {
  alias: string;
  path: string;
}

interface MountRules {
  version: 1;
  mountPoints: Record<StandardId, StandardRule>;
  customPaths: CustomRule[];
}

interface MountRulesResponse {
  rules: MountRules;
  projectRoot: string;
}

interface MountRulesPanelProps {
  projectPath?: string;
  /** 'project' = per-project rules (default), 'default' = global defaultMountRules */
  scope?: 'project' | 'default';
  onSaved?: () => void | Promise<void>;
}

export function MountRulesPanel({ projectPath, scope = 'project', onSaved }: MountRulesPanelProps) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<MountRules | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newAlias, setNewAlias] = useState('');
  const [newPath, setNewPath] = useState('');

  const fetchRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (scope === 'default') {
        params.set('scope', 'default');
      } else if (projectPath) {
        params.set('projectPath', projectPath);
      }
      const qs = params.toString();
      const url = `/api/mount-rules${qs ? `?${qs}` : ''}`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(`GET /api/mount-rules failed: ${res.status}`);
      const data = (await res.json()) as MountRulesResponse;
      setRules(data.rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, [projectPath, scope]);

  useEffect(() => {
    if (open) void fetchRules();
  }, [open, fetchRules]);

  const saveRules = useCallback(
    async (next: MountRules) => {
      setSaving(true);
      setError(null);
      try {
        const putBody: Record<string, unknown> = { rules: next };
        if (scope === 'default') {
          putBody.scope = 'default';
        } else if (projectPath) {
          putBody.projectPath = projectPath;
        }
        const res = await apiFetch('/api/mount-rules', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(putBody),
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`PUT /api/mount-rules failed: ${res.status} ${txt.slice(0, 120)}`);
        }
        setRules(next);
        await onSaved?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'unknown error');
      } finally {
        setSaving(false);
      }
    },
    [projectPath, scope, onSaved],
  );

  const toggleStandard = useCallback(
    (id: StandardId) => {
      if (!rules) return;
      void saveRules({
        ...rules,
        mountPoints: {
          ...rules.mountPoints,
          [id]: { ...rules.mountPoints[id], enabled: !rules.mountPoints[id].enabled },
        },
      });
    },
    [rules, saveRules],
  );

  const addCustom = useCallback(() => {
    if (!rules) return;
    if (!newAlias.trim() || !newPath.trim()) return;
    if (rules.customPaths.some((cp) => cp.alias === newAlias.trim())) {
      setError(`Alias "${newAlias.trim()}" already exists`);
      return;
    }
    void saveRules({
      ...rules,
      customPaths: [...rules.customPaths, { alias: newAlias.trim(), path: newPath.trim() }],
    });
    setNewAlias('');
    setNewPath('');
  }, [rules, newAlias, newPath, saveRules]);

  const removeCustom = useCallback(
    (alias: string) => {
      if (!rules) return;
      void saveRules({
        ...rules,
        customPaths: rules.customPaths.filter((cp) => cp.alias !== alias),
      });
    },
    [rules, saveRules],
  );

  const summary = rules
    ? `${STANDARD_IDS.filter((id) => rules.mountPoints[id].enabled).length}/4 标准 + ${rules.customPaths.length} 自定义`
    : '点击展开';

  return (
    <div className="rounded-2xl bg-[var(--console-card-bg)] shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <p className="text-sm font-bold text-cafe">{scope === 'default' ? '全局默认 Mount Rules' : 'Mount Rules'}</p>
          <p className="mt-0.5 text-xs text-cafe-secondary">
            {scope === 'default'
              ? '所有项目的默认挂载规则 — 项目可单独覆盖'
              : 'Skill 同步目标 — 4 标准 client + ACP/A2A 自定义路径'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-cafe-muted">{summary}</span>
          <span className="text-xs text-cafe-muted">{open ? '▾' : '▸'}</span>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-3">
          {loading && <p className="text-xs text-cafe-muted">加载中…</p>}
          {error && <p className="text-xs text-conn-red-text">⚠ {error}</p>}
          {rules && !loading && (
            <>
              <p className="mb-2 text-xs font-semibold text-cafe-secondary">标准 Mount Point</p>
              <div className="space-y-1.5">
                {STANDARD_IDS.map((id) => (
                  <label key={id} className="flex items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={rules.mountPoints[id].enabled}
                      disabled={saving}
                      onChange={() => toggleStandard(id)}
                      className="h-4 w-4"
                    />
                    <span className="font-medium text-cafe">{id}</span>
                    <code className="text-xs text-cafe-muted">{rules.mountPoints[id].path}</code>
                  </label>
                ))}
              </div>

              <p className="mb-2 mt-4 text-xs font-semibold text-cafe-secondary">
                自定义路径（ACP / A2A / 未知 client）
              </p>
              {rules.customPaths.length === 0 && <p className="text-xs text-cafe-muted">无 — 通过下方表单添加</p>}
              <div className="space-y-1.5">
                {rules.customPaths.map((cp) => (
                  <div key={cp.alias} className="flex items-center gap-3 text-sm">
                    <span className="font-medium text-cafe">{cp.alias}</span>
                    <code className="flex-1 text-xs text-cafe-muted">{cp.path}</code>
                    <button
                      type="button"
                      onClick={() => removeCustom(cp.alias)}
                      disabled={saving}
                      className="text-xs text-conn-red-text hover:underline"
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  value={newAlias}
                  onChange={(e) => setNewAlias(e.target.value)}
                  placeholder="alias (e.g. opencode)"
                  className="rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-shell-bg)] px-2 py-1 text-xs"
                />
                <input
                  type="text"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder=".opencode/skills"
                  className="flex-1 rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-shell-bg)] px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  onClick={addCustom}
                  disabled={saving || !newAlias.trim() || !newPath.trim()}
                  className="rounded-xl bg-[var(--console-active-bg)] px-3 py-1 text-xs font-semibold text-cafe-interactive disabled:opacity-40"
                >
                  添加
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
