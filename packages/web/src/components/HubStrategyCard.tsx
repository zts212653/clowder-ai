'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { CatStrategyEntry, StrategyType } from './hub-strategy-types';
import { SOURCE_LABELS, STRATEGY_LABELS } from './hub-strategy-types';

function SourceBadge({ source }: { source: string }) {
  const isOverride = source === 'runtime_override';
  return (
    <span
      className={`inline-block text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
        isOverride ? 'bg-blue-100 text-blue-700' : 'bg-cafe-surface-elevated text-cafe-secondary'
      }`}
    >
      {SOURCE_LABELS[source] ?? source}
    </span>
  );
}

export function CatStrategyCard({ entry, onSaved }: { entry: CatStrategyEntry; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [strategy, setStrategy] = useState<StrategyType>(entry.effective.strategy);
  const [warnThreshold, setWarnThreshold] = useState(entry.effective.thresholds.warn);
  const [actionThreshold, setActionThreshold] = useState(entry.effective.thresholds.action);
  const [maxCompressions, setMaxCompressions] = useState(entry.effective.hybrid?.maxCompressions ?? 2);

  useEffect(() => {
    setStrategy(entry.effective.strategy);
    setWarnThreshold(entry.effective.thresholds.warn);
    setActionThreshold(entry.effective.thresholds.action);
    setMaxCompressions(entry.effective.hybrid?.maxCompressions ?? 2);
    setEditing(false);
  }, [entry]);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        strategy,
        thresholds: { warn: warnThreshold, action: actionThreshold },
      };
      if (strategy === 'hybrid') {
        body.hybrid = { maxCompressions };
      }
      const res = await apiFetch(`/api/config/session-strategy/${entry.catId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((data.error as string) ?? `保存失败 (${res.status})`);
        return;
      }
      onSaved();
    } catch {
      setError('网络错误');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!entry.hasOverride) return;
    setError(null);
    setSaving(true);
    try {
      const res = await apiFetch(`/api/config/session-strategy/${entry.catId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((data.error as string) ?? `重置失败 (${res.status})`);
        return;
      }
      onSaved();
    } catch {
      setError('网络错误');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setStrategy(entry.effective.strategy);
    setWarnThreshold(entry.effective.thresholds.warn);
    setActionThreshold(entry.effective.thresholds.action);
    setMaxCompressions(entry.effective.hybrid?.maxCompressions ?? 2);
    setEditing(false);
    setError(null);
  };

  return (
    <div className="rounded-lg border border-cafe bg-cafe-surface p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{entry.displayName}</span>
          <span className="text-[10px] text-cafe-muted font-mono">{entry.catId}</span>
          <span className="text-[10px] text-cafe-muted">{entry.clientId}</span>
        </div>
        {entry.sessionChainEnabled ? (
          <SourceBadge source={entry.source} />
        ) : (
          <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-cafe-surface-elevated text-cafe-muted">
            Session Chain 未启用
          </span>
        )}
      </div>

      {!entry.sessionChainEnabled && (
        <p className="text-xs text-cafe-muted">此猫的 session chain 已关闭，策略配置不适用。</p>
      )}

      {entry.sessionChainEnabled && !editing && (
        <div className="space-y-1">
          <div className="text-xs text-cafe-secondary">
            <span className="font-medium">策略:</span> {STRATEGY_LABELS[entry.effective.strategy]}
          </div>
          <div className="text-xs text-cafe-secondary">
            <span className="font-medium">阈值:</span> 警告 {(entry.effective.thresholds.warn * 100).toFixed(0)}% / 行动{' '}
            {(entry.effective.thresholds.action * 100).toFixed(0)}%
            {entry.effective.strategy === 'compress' && (
              <span className="text-[10px] text-amber-600 ml-1">(仅观测，不触发封印)</span>
            )}
          </div>
          {entry.effective.strategy === 'hybrid' && entry.effective.hybrid && (
            <div className="text-xs text-cafe-secondary">
              <span className="font-medium">最大压缩次数:</span> {entry.effective.hybrid.maxCompressions}
            </div>
          )}
          {!entry.hybridCapable && (
            <div className="text-[10px] text-amber-600">Provider {entry.clientId} 不支持 hybrid 策略</div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => setEditing(true)}
              className="text-xs px-2 py-1 rounded bg-cafe-surface-elevated hover:bg-gray-200 text-cafe-secondary transition-colors"
            >
              编辑
            </button>
            {entry.hasOverride && (
              <button
                onClick={handleReset}
                disabled={saving}
                className="text-xs px-2 py-1 rounded bg-red-50 hover:bg-red-100 text-red-600 transition-colors disabled:opacity-40"
              >
                {saving ? '重置中...' : '重置为默认'}
              </button>
            )}
          </div>
        </div>
      )}

      {entry.sessionChainEnabled && editing && (
        <div className="space-y-3 pt-1">
          <div>
            <label className="text-xs font-medium text-cafe-secondary block mb-1">策略</label>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as StrategyType)}
              className="w-full text-xs border border-cafe rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
            >
              <option value="handoff">{STRATEGY_LABELS.handoff}</option>
              <option value="compress">{STRATEGY_LABELS.compress}</option>
              {entry.hybridCapable && <option value="hybrid">{STRATEGY_LABELS.hybrid}</option>}
            </select>
          </div>

          {strategy === 'compress' && (
            <p className="text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-1">
              Compress 策略下，阈值仅用于观测告警，不会触发封印。Session 会在 CLI 压缩后继续存活。
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-cafe-secondary block mb-1">
                {strategy === 'compress' ? '观测 (下限)' : '警告'}阈值: {(warnThreshold * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min="0.3"
                max="0.95"
                step="0.05"
                value={warnThreshold}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setWarnThreshold(v);
                  if (v >= actionThreshold) setActionThreshold(Math.min(v + 0.05, 0.99));
                }}
                className="w-full accent-yellow-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-cafe-secondary block mb-1">
                {strategy === 'compress' ? '观测 (上限)' : '行动'}阈值: {(actionThreshold * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min="0.4"
                max="0.99"
                step="0.05"
                value={actionThreshold}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setActionThreshold(v);
                  if (v <= warnThreshold) setWarnThreshold(Math.max(v - 0.05, 0.1));
                }}
                className="w-full accent-red-500"
              />
            </div>
          </div>

          {strategy === 'hybrid' && (
            <div>
              <label className="text-xs font-medium text-cafe-secondary block mb-1">
                最大压缩次数: {maxCompressions}
              </label>
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                value={maxCompressions}
                onChange={(e) => setMaxCompressions(parseInt(e.target.value, 10))}
                className="w-full accent-purple-500"
              />
            </div>
          )}

          {warnThreshold >= actionThreshold && <p className="text-[10px] text-red-500">警告阈值必须小于行动阈值</p>}

          {error && <p className="text-xs text-red-500 bg-red-50 rounded px-2 py-1">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || warnThreshold >= actionThreshold}
              className="text-xs px-3 py-1.5 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? '保存中...' : '保存'}
            </button>
            <button
              onClick={handleCancel}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded bg-cafe-surface-elevated hover:bg-gray-200 text-cafe-secondary transition-colors disabled:opacity-40"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
